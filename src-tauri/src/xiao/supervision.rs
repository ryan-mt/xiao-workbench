use std::collections::HashSet;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use uuid::Uuid;

use crate::runs::models::RunRecord;

use super::models::{
    AttentionHydrationStatus, AttentionItem, AttentionKind, AttentionSnapshot, AttentionSurface,
    PublicationKind, PublicationRecord, PublicationStatus, TaskStage,
};
use super::repository::{normalize_workspace_path, XiaoRepository};

const MAX_ATTENTION_ITEMS: usize = 1_000;
const MAX_SAFE_SUMMARY_CHARS: usize = 160;

#[derive(Debug)]
struct AttentionCandidate {
    workspace_id: i64,
    task_id: String,
    task_title: String,
    run_id: Option<String>,
    kind: &'static str,
    priority: i64,
    title: String,
    source_occurrence_key: String,
    surface: &'static str,
    created_at: i64,
}

#[derive(Debug)]
struct PublicationRow {
    id: String,
    project_path: String,
    task_id: String,
    source_run_id: String,
    kind: String,
    status: String,
    branch: String,
    remote: Option<String>,
    url: Option<String>,
    pull_request_number: Option<i64>,
    check_state: String,
    created_at: i64,
    updated_at: i64,
}

impl PublicationRow {
    fn decode(self) -> Result<PublicationRecord, String> {
        Ok(PublicationRecord {
            id: self.id,
            project_path: self.project_path,
            task_id: self.task_id,
            source_run_id: self.source_run_id,
            kind: PublicationKind::from_database(&self.kind)?,
            status: PublicationStatus::from_database(&self.status)?,
            branch: self.branch,
            remote: self.remote,
            url: self.url,
            pull_request_number: self.pull_request_number,
            check_state: self.check_state,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

impl XiaoRepository {
    pub fn ensure_task_outcome_publishable(
        &self,
        project_path: &str,
        task_id: &str,
    ) -> Result<(), String> {
        let project_path = normalize_workspace_path(project_path);
        self.with_connection(|connection| {
            let (stage, has_run): (String, bool) = connection
                .query_row(
                    r#"SELECT task.task_stage, EXISTS(
                           SELECT 1 FROM runs run
                           WHERE run.workspace_id = task.workspace_id
                             AND run.task_id = task.task_id
                       )
                       FROM tasks task
                       JOIN workspaces workspace ON workspace.id = task.workspace_id
                       WHERE workspace.workspace_path = ?1 AND task.task_id = ?2"#,
                    params![project_path, task_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|error| {
                    format!("Could not resolve the Task outcome to publish: {error}")
                })?;
            if !has_run {
                return Err("A Task outcome requires a Run before it can be published.".to_owned());
            }
            if !matches!(
                TaskStage::from_database(&stage)?,
                TaskStage::ReadyForReview | TaskStage::Published
            ) {
                return Err(
                    "Only a ready-for-review or published Task outcome can be published."
                        .to_owned(),
                );
            }
            Ok(())
        })
    }

    pub fn list_attention_items(&self) -> Result<AttentionSnapshot, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not refresh Attention Center: {error}"))?;
            let candidates = collect_attention_candidates(&transaction)?;
            let generated_at = now_millis()?;
            let mut current_keys = HashSet::with_capacity(candidates.len());
            for candidate in candidates {
                current_keys.insert(candidate.source_occurrence_key.clone());
                upsert_attention_candidate(&transaction, candidate)?;
            }

            let open = {
                let mut statement = transaction
                    .prepare(
                        "SELECT id, source_occurrence_key FROM attention_occurrences \
                         WHERE resolved_at IS NULL",
                    )
                    .map_err(|error| {
                        format!("Could not prepare Attention reconciliation: {error}")
                    })?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|error| format!("Could not query Attention reconciliation: {error}"))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| {
                        format!("Could not decode Attention reconciliation: {error}")
                    })?;
                rows
            };
            for (id, key) in open {
                if current_keys.contains(&key) {
                    continue;
                }
                transaction
                    .execute(
                        "UPDATE attention_occurrences SET resolved_at = ?1 WHERE id = ?2",
                        params![generated_at, id],
                    )
                    .map_err(|error| format!("Could not resolve Attention occurrence: {error}"))?;
            }

            let (items, truncated) = load_open_attention_items(&transaction)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Attention refresh: {error}"))?;
            Ok(AttentionSnapshot {
                items,
                status: if truncated {
                    AttentionHydrationStatus::Partial
                } else {
                    AttentionHydrationStatus::Live
                },
                generated_at,
            })
        })
    }

    pub fn acknowledge_attention_item(&self, item_id: &str) -> Result<bool, String> {
        let item_id = item_id.trim();
        if item_id.is_empty() {
            return Err("Attention acknowledgement requires an item id.".to_owned());
        }
        self.with_connection(|connection| {
            let changed = connection
                .execute(
                    r#"UPDATE attention_occurrences
                       SET acknowledged_at = ?1
                       WHERE id = ?2 AND resolved_at IS NULL AND acknowledged_at IS NULL"#,
                    params![now_millis()?, item_id],
                )
                .map_err(|error| format!("Could not acknowledge Attention occurrence: {error}"))?;
            Ok(changed == 1)
        })
    }

    pub fn list_task_publications(
        &self,
        project_path: &str,
        task_id: &str,
    ) -> Result<Vec<PublicationRecord>, String> {
        let project_path = normalize_workspace_path(project_path);
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    r#"SELECT publication.id, workspace.workspace_path, publication.task_id,
                              publication.source_run_id, publication.kind, publication.status,
                              publication.branch, publication.remote, publication.url,
                              publication.pull_request_number, publication.check_state,
                              publication.created_at, publication.updated_at
                       FROM publication_records publication
                       JOIN workspaces workspace ON workspace.id = publication.workspace_id
                       WHERE workspace.workspace_path = ?1 AND publication.task_id = ?2
                       ORDER BY publication.created_at DESC, publication.id DESC"#,
                )
                .map_err(|error| format!("Could not prepare publication history: {error}"))?;
            let rows = statement
                .query_map(params![project_path, task_id], decode_publication_row)
                .map_err(|error| format!("Could not query publication history: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Could not decode publication history: {error}"))?;
            rows.into_iter().map(PublicationRow::decode).collect()
        })
    }

    pub fn record_branch_publication(
        &self,
        project_path: &str,
        task_id: &str,
        branch: &str,
        remote: &str,
    ) -> Result<PublicationRecord, String> {
        self.record_publication(
            project_path,
            task_id,
            PublicationKind::Branch,
            branch,
            Some(remote),
            None,
            None,
            None,
        )?
        .ok_or_else(|| "The Task outcome changed while its publication was recorded.".to_owned())
    }

    #[cfg(test)]
    pub fn record_pull_request_publication(
        &self,
        project_path: &str,
        task_id: &str,
        branch: &str,
        url: &str,
        pull_request_number: i64,
    ) -> Result<PublicationRecord, String> {
        self.record_publication(
            project_path,
            task_id,
            PublicationKind::PullRequest,
            branch,
            None,
            Some(url),
            Some(pull_request_number),
            None,
        )?
        .ok_or_else(|| "The Task outcome changed while its publication was recorded.".to_owned())
    }

    pub fn record_discovered_pull_request_publication(
        &self,
        project_path: &str,
        task_id: &str,
        branch: &str,
        url: &str,
        pull_request_number: i64,
        pull_request_state: &str,
    ) -> Result<Option<PublicationRecord>, String> {
        let project_path = normalize_workspace_path(project_path);
        let task_id = task_id.trim();
        if !pull_request_state.eq_ignore_ascii_case("open") {
            return self.with_connection(|connection| {
                let transaction = connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|error| {
                        format!("Could not inspect terminal pull-request publication: {error}")
                    })?;
                let existing = load_latest_pull_request_publication(
                    &transaction,
                    &project_path,
                    task_id,
                    pull_request_number,
                )?
                .map(PublicationRow::decode)
                .transpose()?;
                transaction.commit().map_err(|error| {
                    format!("Could not finish terminal publication lookup: {error}")
                })?;
                Ok(existing)
            });
        }
        let expected_source_run_id = self.with_connection(|connection| {
            connection
                .query_row(
                    r#"SELECT publication.source_run_id
                       FROM publication_records publication
                       JOIN workspaces workspace ON workspace.id = publication.workspace_id
                       WHERE workspace.workspace_path = ?1
                         AND publication.task_id = ?2
                         AND publication.kind = 'branch'
                         AND publication.branch = ?3
                         AND publication.source_run_id = (
                             SELECT run.id FROM runs run
                             WHERE run.workspace_id = publication.workspace_id
                               AND run.task_id = publication.task_id
                             ORDER BY run.queued_at DESC, run.id DESC LIMIT 1
                         )
                       ORDER BY publication.created_at DESC, publication.id DESC LIMIT 1"#,
                    params![project_path, task_id, branch],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| {
                    format!("Could not validate discovered pull-request publication: {error}")
                })
        })?;
        let Some(expected_source_run_id) = expected_source_run_id else {
            return Ok(None);
        };
        self.record_publication(
            &project_path,
            task_id,
            PublicationKind::PullRequest,
            branch,
            None,
            Some(url),
            Some(pull_request_number),
            Some(&expected_source_run_id),
        )
    }

    fn record_publication(
        &self,
        project_path: &str,
        task_id: &str,
        kind: PublicationKind,
        branch: &str,
        remote: Option<&str>,
        url: Option<&str>,
        pull_request_number: Option<i64>,
        expected_source_run_id: Option<&str>,
    ) -> Result<Option<PublicationRecord>, String> {
        let project_path = normalize_workspace_path(project_path);
        let task_id = task_id.trim();
        let branch = branch.trim();
        if task_id.is_empty() || branch.is_empty() {
            return Err("Publication requires a persisted Task and branch.".to_owned());
        }
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start publication record: {error}"))?;
            let (workspace_id, stage, stage_version, source_run_id): (i64, String, i64, String) =
                transaction
                    .query_row(
                        r#"SELECT task.workspace_id, task.task_stage, task.task_stage_version,
                                  run.id
                           FROM tasks task
                           JOIN workspaces workspace ON workspace.id = task.workspace_id
                           JOIN runs run ON run.workspace_id = task.workspace_id
                                        AND run.task_id = task.task_id
                           WHERE workspace.workspace_path = ?1 AND task.task_id = ?2
                           ORDER BY run.queued_at DESC, run.id DESC LIMIT 1"#,
                        params![project_path, task_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .map_err(|error| {
                        format!("Could not resolve the Task outcome to publish: {error}")
                    })?;
            if expected_source_run_id.is_some_and(|expected| expected != source_run_id) {
                transaction
                    .commit()
                    .map_err(|error| format!("Could not finish publication validation: {error}"))?;
                return Ok(None);
            }
            let stage = TaskStage::from_database(&stage)?;
            let idempotency_key = format!(
                "{}:{task_id}:{source_run_id}:{}",
                kind.as_database(),
                pull_request_number
                    .map(|number| number.to_string())
                    .unwrap_or_else(|| format!("{}:{branch}", remote.unwrap_or_default()))
            );
            if let Some(existing) = load_publication_by_key(&transaction, &idempotency_key)?
                .map(PublicationRow::decode)
                .transpose()?
            {
                transaction
                    .commit()
                    .map_err(|error| format!("Could not finish publication lookup: {error}"))?;
                return Ok(Some(existing));
            }

            if !matches!(stage, TaskStage::ReadyForReview | TaskStage::Published) {
                return Err(
                    "Only a ready-for-review or published Task outcome can be published."
                        .to_owned(),
                );
            }

            let timestamp = now_millis()?;
            let record = PublicationRecord {
                id: Uuid::now_v7().to_string(),
                project_path: project_path.clone(),
                task_id: task_id.to_owned(),
                source_run_id: source_run_id.clone(),
                kind,
                status: PublicationStatus::Active,
                branch: branch.to_owned(),
                remote: remote.map(str::to_owned),
                url: url.map(str::to_owned),
                pull_request_number,
                check_state: "unknown".to_owned(),
                created_at: timestamp,
                updated_at: timestamp,
            };
            transaction
                .execute(
                    r#"INSERT INTO publication_records(
                        id, workspace_id, task_id, source_run_id, kind, status, branch,
                        remote, url, pull_request_number, check_state, checks_json,
                        idempotency_key, created_at, updated_at
                    ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9,
                        'unknown', '[]', ?10, ?11, ?11
                    )"#,
                    params![
                        record.id,
                        workspace_id,
                        record.task_id,
                        record.source_run_id,
                        record.kind.as_database(),
                        record.branch,
                        record.remote,
                        record.url,
                        record.pull_request_number,
                        idempotency_key,
                        timestamp,
                    ],
                )
                .map_err(|error| format!("Could not persist publication record: {error}"))?;
            if stage == TaskStage::ReadyForReview {
                transition_task_in_transaction(
                    &transaction,
                    workspace_id,
                    task_id,
                    TaskStage::ReadyForReview,
                    stage_version,
                    TaskStage::Published,
                    "publication",
                    "Current Task outcome was published",
                    Some(&source_run_id),
                    &format!("publication:{}", record.id),
                    timestamp,
                )?;
            }
            transaction
                .commit()
                .map_err(|error| format!("Could not commit publication record: {error}"))?;
            Ok(Some(record))
        })
    }

    pub fn refresh_pull_request_publication(
        &self,
        project_path: &str,
        task_id: &str,
        pull_request_number: i64,
        pull_request_state: &str,
        check_state: &str,
        checks_json: &str,
    ) -> Result<Option<PublicationRecord>, String> {
        self.refresh_pull_request_observation(
            project_path,
            task_id,
            pull_request_number,
            pull_request_state,
            Some((check_state, checks_json)),
        )
    }

    pub fn refresh_pull_request_state(
        &self,
        project_path: &str,
        task_id: &str,
        pull_request_number: i64,
        pull_request_state: &str,
    ) -> Result<Option<PublicationRecord>, String> {
        self.refresh_pull_request_observation(
            project_path,
            task_id,
            pull_request_number,
            pull_request_state,
            None,
        )
    }

    fn refresh_pull_request_observation(
        &self,
        project_path: &str,
        task_id: &str,
        pull_request_number: i64,
        pull_request_state: &str,
        checks: Option<(&str, &str)>,
    ) -> Result<Option<PublicationRecord>, String> {
        let project_path = normalize_workspace_path(project_path);
        let normalized_state = pull_request_state.trim().to_ascii_lowercase();
        let checks = checks
            .map(|(check_state, checks_json)| {
                let normalized_checks = match check_state {
                    "unknown" | "pending" | "passing" | "failing" => check_state,
                    _ => return Err("Unsupported pull-request check state.".to_owned()),
                };
                serde_json::from_str::<serde_json::Value>(checks_json)
                    .map_err(|error| format!("Pull-request checks are invalid JSON: {error}"))?;
                Ok((normalized_checks.to_owned(), checks_json.to_owned()))
            })
            .transpose()?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not refresh publication: {error}"))?;
            let Some(mut row) = load_latest_pull_request_publication(
                &transaction,
                &project_path,
                task_id,
                pull_request_number,
            )?
            else {
                transaction
                    .commit()
                    .map_err(|error| format!("Could not finish publication refresh: {error}"))?;
                return Ok(None);
            };
            let timestamp = now_millis()?;
            let latest_run_id: Option<String> = transaction
                .query_row(
                    r#"SELECT run.id FROM runs run
                       JOIN workspaces workspace ON workspace.id = run.workspace_id
                       WHERE workspace.workspace_path = ?1 AND run.task_id = ?2
                       ORDER BY run.queued_at DESC, run.id DESC LIMIT 1"#,
                    params![project_path, task_id],
                    |result| result.get(0),
                )
                .optional()
                .map_err(|error| {
                    format!("Could not resolve current publication outcome: {error}")
                })?;
            let matching_outcome = latest_run_id.as_deref() == Some(row.source_run_id.as_str());
            let next_status = match normalized_state.as_str() {
                _ if !matching_outcome => "superseded".to_owned(),
                "merged" => "merged".to_owned(),
                "closed" => "closed".to_owned(),
                "open" => "active".to_owned(),
                _ => "unavailable".to_owned(),
            };
            let current_checks_json: String = transaction
                .query_row(
                    "SELECT checks_json FROM publication_records WHERE id = ?1",
                    [&row.id],
                    |result| result.get(0),
                )
                .map_err(|error| format!("Could not load publication checks: {error}"))?;
            let (normalized_checks, checks_json) = checks
                .clone()
                .unwrap_or_else(|| (row.check_state.clone(), current_checks_json.clone()));
            if row.status != next_status
                || row.check_state != normalized_checks
                || current_checks_json != checks_json
            {
                let prior_id = row.id.clone();
                let next_id = Uuid::now_v7().to_string();
                let idempotency_key =
                    format!("publication-refresh:{prior_id}:{next_status}:{normalized_checks}");
                row.status = next_status;
                row.check_state = normalized_checks;
                row.id = next_id;
                row.created_at = timestamp;
                row.updated_at = timestamp;
                transaction
                    .execute(
                        r#"INSERT INTO publication_records(
                            id, workspace_id, task_id, source_run_id, kind, status, branch,
                            remote, url, pull_request_number, check_state, checks_json,
                            idempotency_key, created_at, updated_at
                        )
                        SELECT ?1, workspace_id, task_id, source_run_id, kind, ?2, branch,
                               remote, url, pull_request_number, ?3, ?4, ?5, ?6, ?6
                        FROM publication_records WHERE id = ?7"#,
                        params![
                            row.id,
                            row.status,
                            row.check_state,
                            checks_json,
                            idempotency_key,
                            timestamp,
                            prior_id,
                        ],
                    )
                    .map_err(|error| format!("Could not append publication record: {error}"))?;
            }

            if row.status == "merged" {
                let (workspace_id, current_stage, current_version): (i64, String, i64) =
                    transaction
                        .query_row(
                            r#"SELECT task.workspace_id, task.task_stage, task.task_stage_version
                           FROM tasks task
                           JOIN workspaces workspace ON workspace.id = task.workspace_id
                           WHERE workspace.workspace_path = ?1 AND task.task_id = ?2"#,
                            params![project_path, task_id],
                            |result| Ok((result.get(0)?, result.get(1)?, result.get(2)?)),
                        )
                        .map_err(|error| format!("Could not load merged Task outcome: {error}"))?;
                if TaskStage::from_database(&current_stage)? == TaskStage::Published {
                    transition_task_in_transaction(
                        &transaction,
                        workspace_id,
                        task_id,
                        TaskStage::Published,
                        current_version,
                        TaskStage::Completed,
                        "integration",
                        "Current pull request was merged",
                        Some(&row.source_run_id),
                        &format!("publication-merged:{}", row.id),
                        timestamp,
                    )?;
                }
            }
            let record = row.decode()?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit publication refresh: {error}"))?;
            Ok(Some(record))
        })
    }
}

pub(crate) fn advance_task_after_verification(
    transaction: &Transaction<'_>,
    run: &RunRecord,
    attempt_id: &str,
    timestamp: i64,
) -> Result<(), String> {
    let current_run_id: Option<String> = transaction
        .query_row(
            r#"SELECT id FROM runs
               WHERE workspace_id = ?1 AND task_id = ?2
               ORDER BY queued_at DESC, id DESC LIMIT 1"#,
            params![run.workspace_id, run.task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not resolve the current Task outcome: {error}"))?;
    if current_run_id.as_deref() != Some(run.id.as_str()) {
        return Ok(());
    }
    let (stage, version): (String, i64) = transaction
        .query_row(
            "SELECT task_stage, task_stage_version FROM tasks \
             WHERE workspace_id = ?1 AND task_id = ?2",
            params![run.workspace_id, run.task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("Could not load verified Task stage: {error}"))?;
    let stage = TaskStage::from_database(&stage)?;
    if stage != TaskStage::InProgress {
        return Ok(());
    }
    transition_task_in_transaction(
        transaction,
        run.workspace_id,
        &run.task_id,
        stage,
        version,
        TaskStage::ReadyForReview,
        "verification",
        "Frozen Acceptance Contract passed",
        Some(&run.id),
        &format!("verification-ready:{attempt_id}"),
        timestamp,
    )
}

fn transition_task_in_transaction(
    transaction: &Transaction<'_>,
    workspace_id: i64,
    task_id: &str,
    from_stage: TaskStage,
    expected_version: i64,
    to_stage: TaskStage,
    actor: &str,
    reason: &str,
    source_run_id: Option<&str>,
    idempotency_key: &str,
    timestamp: i64,
) -> Result<(), String> {
    if transaction
        .query_row(
            "SELECT 1 FROM task_stage_transitions WHERE idempotency_key = ?1",
            [idempotency_key],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Could not check outcome transition idempotency: {error}"))?
        .is_some()
    {
        return Ok(());
    }
    let resulting_version = expected_version + 1;
    let changed = transaction
        .execute(
            r#"UPDATE tasks SET task_stage = ?1, task_stage_version = ?2
               WHERE workspace_id = ?3 AND task_id = ?4
                 AND task_stage = ?5 AND task_stage_version = ?6"#,
            params![
                to_stage.as_database(),
                resulting_version,
                workspace_id,
                task_id,
                from_stage.as_database(),
                expected_version,
            ],
        )
        .map_err(|error| format!("Could not advance Task outcome: {error}"))?;
    if changed != 1 {
        return Err("Task outcome changed before its transition committed.".to_owned());
    }
    transaction
        .execute(
            r#"INSERT INTO task_stage_transitions(
                id, workspace_id, task_id, from_stage, to_stage, expected_version,
                resulting_version, actor, reason, source_run_id, idempotency_key, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"#,
            params![
                Uuid::now_v7().to_string(),
                workspace_id,
                task_id,
                from_stage.as_database(),
                to_stage.as_database(),
                expected_version,
                resulting_version,
                actor,
                reason,
                source_run_id,
                idempotency_key,
                timestamp,
            ],
        )
        .map_err(|error| format!("Could not record Task outcome transition: {error}"))?;
    Ok(())
}

fn collect_attention_candidates(
    transaction: &Transaction<'_>,
) -> Result<Vec<AttentionCandidate>, String> {
    let mut candidates = Vec::new();

    {
        let mut statement = transaction
            .prepare(
                r#"SELECT workspace.id, workspace.workspace_path, workspace.display_name,
                          task.task_id, task.title, task.task_stage, task.task_stage_version,
                          run.id, pending.id, pending.kind, pending.opened_at
                   FROM pending_inputs pending
                   JOIN runs run ON run.id = pending.run_id
                   JOIN tasks task ON task.workspace_id = run.workspace_id
                                  AND task.task_id = run.task_id
                   JOIN workspaces workspace ON workspace.id = task.workspace_id
                   WHERE pending.resolved_at IS NULL AND pending.invalidated_at IS NULL
                     AND run.status IN (
                        'queued', 'preparing', 'running', 'waiting_for_input', 'verifying'
                     ) AND task.archived = 0"#,
            )
            .map_err(|error| format!("Could not prepare pending Attention query: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                let kind: String = row.get(9)?;
                Ok(AttentionCandidate {
                    workspace_id: row.get(0)?,
                    task_id: row.get(3)?,
                    task_title: row.get(4)?,
                    run_id: Some(row.get(7)?),
                    kind: "decision",
                    priority: 0,
                    title: pending_title(&kind).to_owned(),
                    source_occurrence_key: format!(
                        "workspace:{}:pending:{}",
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(8)?
                    ),
                    surface: "timeline",
                    created_at: row.get(10)?,
                })
            })
            .map_err(|error| format!("Could not query pending Attention items: {error}"))?;
        candidates.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Could not decode pending Attention item: {error}"))?,
        );
    }

    {
        let mut statement = transaction
            .prepare(
                r#"SELECT workspace.id, workspace.workspace_path, workspace.display_name,
                          task.task_id, task.title, task.task_stage, task.task_stage_version,
                          run.id, run.status, run.verification_outcome,
                          run.latest_verification_attempt_id,
                          COALESCE(run.finished_at, run.started_at, run.queued_at), run.version
                   FROM runs run
                   JOIN tasks task ON task.workspace_id = run.workspace_id
                                  AND task.task_id = run.task_id
                   JOIN workspaces workspace ON workspace.id = task.workspace_id
                   WHERE task.archived = 0
                     AND run.status IN ('needs_attention', 'failed', 'interrupted')
                     AND NOT EXISTS (
                        SELECT 1 FROM runs newer
                        WHERE newer.workspace_id = run.workspace_id
                          AND newer.task_id = run.task_id
                          AND (
                            newer.queued_at > run.queued_at
                            OR (newer.queued_at = run.queued_at AND newer.id > run.id)
                          )
                     )"#,
            )
            .map_err(|error| format!("Could not prepare failed Run Attention query: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                let status: String = row.get(8)?;
                let verification: String = row.get(9)?;
                let attempt_id: Option<String> = row.get(10)?;
                let run_id: String = row.get(7)?;
                let is_verification = matches!(verification.as_str(), "failed" | "blocked");
                Ok(AttentionCandidate {
                    workspace_id: row.get(0)?,
                    task_id: row.get(3)?,
                    task_title: row.get(4)?,
                    run_id: Some(run_id.clone()),
                    kind: if is_verification {
                        "verification"
                    } else {
                        "failure"
                    },
                    priority: 1,
                    title: if verification == "failed" {
                        "Verification failed".to_owned()
                    } else if verification == "blocked" {
                        "Verification blocked".to_owned()
                    } else if status == "interrupted" {
                        "Run interrupted".to_owned()
                    } else {
                        "Run needs attention".to_owned()
                    },
                    source_occurrence_key: if is_verification {
                        format!(
                            "workspace:{}:verification:{}:{}",
                            row.get::<_, i64>(0)?,
                            run_id,
                            attempt_id.unwrap_or_else(|| format!(
                                "run-v{}",
                                row.get::<_, i64>(12).unwrap_or_default()
                            ))
                        )
                    } else {
                        format!(
                            "workspace:{}:run:{run_id}:v{}",
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(12).unwrap_or_default()
                        )
                    },
                    surface: "observatory",
                    created_at: row.get(11)?,
                })
            })
            .map_err(|error| format!("Could not query failed Run Attention items: {error}"))?;
        candidates.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Could not decode failed Run Attention item: {error}"))?,
        );
    }

    {
        let mut statement = transaction
            .prepare(
                r#"SELECT workspace.id, workspace.workspace_path, workspace.display_name,
                          task.task_id, task.title, task.task_stage, task.task_stage_version,
                          (
                              SELECT run.id FROM runs run
                              WHERE run.workspace_id = task.workspace_id
                                AND run.task_id = task.task_id
                              ORDER BY run.queued_at DESC, run.id DESC LIMIT 1
                          ),
                          COALESCE(
                              (
                                  SELECT transition.created_at
                                  FROM task_stage_transitions transition
                                  WHERE transition.workspace_id = task.workspace_id
                                    AND transition.task_id = task.task_id
                                    AND transition.resulting_version = task.task_stage_version
                                    AND transition.to_stage = task.task_stage
                                  ORDER BY transition.created_at DESC, transition.id DESC
                                  LIMIT 1
                              ),
                              task.updated_at
                          )
                   FROM tasks task
                   JOIN workspaces workspace ON workspace.id = task.workspace_id
                   WHERE task.archived = 0
                     AND task.task_stage IN ('ready_for_review', 'published')"#,
            )
            .map_err(|error| format!("Could not prepare review Attention query: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                let stage: String = row.get(5)?;
                let task_id: String = row.get(3)?;
                let version: i64 = row.get(6)?;
                Ok(AttentionCandidate {
                    workspace_id: row.get(0)?,
                    task_id,
                    task_title: row.get(4)?,
                    run_id: row.get(7)?,
                    kind: if stage == "published" {
                        "publication"
                    } else {
                        "review"
                    },
                    priority: 2,
                    title: if stage == "published" {
                        "Published outcome awaits acceptance".to_owned()
                    } else {
                        "Outcome ready for review".to_owned()
                    },
                    source_occurrence_key: format!(
                        "workspace:{}:task-stage:{}:{stage}:{version}",
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(3)?
                    ),
                    surface: if stage == "published" {
                        "changes"
                    } else {
                        "verification"
                    },
                    created_at: row.get(8)?,
                })
            })
            .map_err(|error| format!("Could not query review Attention items: {error}"))?;
        candidates.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Could not decode review Attention item: {error}"))?,
        );
    }

    {
        let mut statement = transaction
            .prepare(
                r#"SELECT workspace.id, workspace.workspace_path, workspace.display_name,
                          task.task_id, task.title, task.task_stage, task.task_stage_version,
                          publication.source_run_id, publication.id, publication.status,
                          publication.check_state, publication.updated_at
                   FROM publication_records publication
                   JOIN tasks task ON task.workspace_id = publication.workspace_id
                                  AND task.task_id = publication.task_id
                   JOIN workspaces workspace ON workspace.id = task.workspace_id
                   WHERE task.archived = 0
                     AND publication.kind = 'pull_request'
                     AND NOT EXISTS (
                         SELECT 1 FROM publication_records newer
                         WHERE newer.workspace_id = publication.workspace_id
                           AND newer.task_id = publication.task_id
                           AND newer.kind = 'pull_request'
                           AND newer.pull_request_number = publication.pull_request_number
                           AND (
                               newer.created_at > publication.created_at
                               OR (
                                   newer.created_at = publication.created_at
                                   AND newer.id > publication.id
                               )
                           )
                     )
                     AND (
                        publication.status IN ('superseded', 'closed', 'unavailable')
                        OR publication.check_state = 'failing'
                   )"#,
            )
            .map_err(|error| format!("Could not prepare publication Attention query: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                let status: String = row.get(9)?;
                let check_state: String = row.get(10)?;
                Ok(AttentionCandidate {
                    workspace_id: row.get(0)?,
                    task_id: row.get(3)?,
                    task_title: row.get(4)?,
                    run_id: Some(row.get(7)?),
                    kind: "publication",
                    priority: 1,
                    title: if check_state == "failing" {
                        "Published checks need attention".to_owned()
                    } else if status == "superseded" {
                        "Publication belongs to an older outcome".to_owned()
                    } else if status == "closed" {
                        "Pull request closed without integration".to_owned()
                    } else {
                        "Publication is unavailable".to_owned()
                    },
                    source_occurrence_key: format!(
                        "workspace:{}:publication:{}:{status}:{check_state}:{}",
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, i64>(11)?
                    ),
                    surface: "changes",
                    created_at: row.get(11)?,
                })
            })
            .map_err(|error| format!("Could not query publication Attention items: {error}"))?;
        candidates
            .extend(rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
                format!("Could not decode publication Attention item: {error}")
            })?);
    }

    {
        let mut statement = transaction
            .prepare(
                r#"SELECT workspace.id, workspace.workspace_path, workspace.display_name,
                          task.task_id, task.title, task.task_stage, task.task_stage_version,
                          routine.id, routine.last_error,
                          (
                              SELECT occurrence.run_id
                              FROM routine_occurrences occurrence
                              WHERE occurrence.routine_id = routine.id
                              ORDER BY occurrence.scheduled_for DESC, occurrence.id DESC
                              LIMIT 1
                          ),
                          routine.updated_at
                   FROM routines routine
                   JOIN tasks task ON task.workspace_id = routine.workspace_id
                                  AND task.task_id = routine.task_id
                   JOIN workspaces workspace ON workspace.id = task.workspace_id
                   WHERE routine.deleted_at IS NULL AND routine.last_error IS NOT NULL
                     AND task.archived = 0"#,
            )
            .map_err(|error| format!("Could not prepare Routine Attention query: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(AttentionCandidate {
                    workspace_id: row.get(0)?,
                    task_id: row.get(3)?,
                    task_title: row.get(4)?,
                    run_id: row.get(9)?,
                    kind: "routine",
                    priority: 1,
                    title: "Routine needs attention".to_owned(),
                    source_occurrence_key: format!(
                        "workspace:{}:routine:{}:{}",
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, i64>(10)?
                    ),
                    surface: "schedule",
                    created_at: row.get(10)?,
                })
            })
            .map_err(|error| format!("Could not query Routine Attention items: {error}"))?;
        candidates.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Could not decode Routine Attention item: {error}"))?,
        );
    }

    {
        let mut statement = transaction
            .prepare(
                r#"SELECT workspace.id, workspace.workspace_path, workspace.display_name,
                          task.task_id, task.title, task.task_stage, task.task_stage_version,
                          task.unread_generation,
                          COALESCE(task.unread_raised_at, task.updated_at)
                   FROM tasks task
                   JOIN workspaces workspace ON workspace.id = task.workspace_id
                   WHERE task.archived = 0 AND task.unread = 1"#,
            )
            .map_err(|error| format!("Could not prepare unread Attention query: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                let task_id: String = row.get(3)?;
                let unread_generation: i64 = row.get(7)?;
                let unread_raised_at: i64 = row.get(8)?;
                Ok(AttentionCandidate {
                    workspace_id: row.get(0)?,
                    task_id: task_id.clone(),
                    task_title: row.get(4)?,
                    run_id: None,
                    kind: "unread",
                    priority: 3,
                    title: "Unread Task outcome".to_owned(),
                    source_occurrence_key: format!(
                        "workspace:{}:unread:{task_id}:{unread_generation}",
                        row.get::<_, i64>(0)?,
                    ),
                    surface: "timeline",
                    created_at: unread_raised_at,
                })
            })
            .map_err(|error| format!("Could not query unread Attention items: {error}"))?;
        candidates.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Could not decode unread Attention item: {error}"))?,
        );
    }

    Ok(candidates)
}

fn upsert_attention_candidate(
    transaction: &Transaction<'_>,
    candidate: AttentionCandidate,
) -> Result<(), String> {
    let safe_summary = bounded_summary(&candidate.task_title);
    transaction
        .execute(
            r#"INSERT INTO attention_occurrences(
                id, workspace_id, task_id, run_id, kind, priority, title, safe_summary,
                source_occurrence_key, surface, created_at, resolved_at, acknowledged_at,
                notification_delivered_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL, NULL)
            ON CONFLICT(source_occurrence_key) DO UPDATE SET
                title = excluded.title,
                safe_summary = excluded.safe_summary,
                priority = excluded.priority,
                surface = excluded.surface"#,
            params![
                Uuid::now_v7().to_string(),
                candidate.workspace_id,
                candidate.task_id,
                candidate.run_id,
                candidate.kind,
                candidate.priority,
                candidate.title,
                safe_summary,
                candidate.source_occurrence_key,
                candidate.surface,
                candidate.created_at,
            ],
        )
        .map_err(|error| format!("Could not persist Attention occurrence: {error}"))?;
    Ok(())
}

fn load_open_attention_items(
    transaction: &Transaction<'_>,
) -> Result<(Vec<AttentionItem>, bool), String> {
    let mut statement = transaction
        .prepare(
            r#"SELECT attention.id, workspace.workspace_path, workspace.display_name,
                      task.task_id, task.title, task.task_stage, task.task_stage_version,
                      attention.run_id, attention.kind, attention.priority, attention.title,
                      attention.safe_summary, attention.source_occurrence_key, attention.surface,
                      attention.created_at, attention.resolved_at, attention.acknowledged_at
               FROM attention_occurrences attention
               JOIN tasks task ON task.workspace_id = attention.workspace_id
                              AND task.task_id = attention.task_id
               JOIN workspaces workspace ON workspace.id = attention.workspace_id
               WHERE attention.resolved_at IS NULL AND attention.acknowledged_at IS NULL
               ORDER BY attention.priority, attention.created_at DESC, attention.id
               LIMIT ?1"#,
        )
        .map_err(|error| format!("Could not prepare Attention Center items: {error}"))?;
    let rows = statement
        .query_map([MAX_ATTENTION_ITEMS as i64 + 1], |row| {
            let project_path: String = row.get(1)?;
            let display_name: Option<String> = row.get(2)?;
            let task_stage: String = row.get(5)?;
            let kind: String = row.get(8)?;
            let surface: String = row.get(13)?;
            Ok((
                row.get::<_, String>(0)?,
                project_path,
                display_name,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                task_stage,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<String>>(7)?,
                kind,
                row.get::<_, i64>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, String>(12)?,
                surface,
                row.get::<_, i64>(14)?,
                row.get::<_, Option<i64>>(15)?,
                row.get::<_, Option<i64>>(16)?,
            ))
        })
        .map_err(|error| format!("Could not query Attention Center items: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not decode Attention Center item: {error}"))?;
    let truncated = rows.len() > MAX_ATTENTION_ITEMS;
    let items = rows
        .into_iter()
        .take(MAX_ATTENTION_ITEMS)
        .map(
            |(
                id,
                project_path,
                display_name,
                task_id,
                task_title,
                task_stage,
                task_stage_version,
                run_id,
                kind,
                priority,
                title,
                safe_summary,
                source_occurrence_key,
                surface,
                created_at,
                resolved_at,
                acknowledged_at,
            )| {
                Ok(AttentionItem {
                    id,
                    project_name: project_display_name(&project_path, display_name.as_deref()),
                    project_path,
                    task_id,
                    task_title,
                    task_stage: TaskStage::from_database(&task_stage)?,
                    task_stage_version,
                    run_id,
                    kind: AttentionKind::from_database(&kind)?,
                    priority,
                    title,
                    safe_summary,
                    source_occurrence_key,
                    surface: AttentionSurface::from_database(&surface)?,
                    created_at,
                    resolved_at,
                    acknowledged_at,
                })
            },
        )
        .collect::<Result<Vec<_>, String>>()?;
    Ok((items, truncated))
}

fn load_publication_by_key(
    transaction: &Transaction<'_>,
    idempotency_key: &str,
) -> Result<Option<PublicationRow>, String> {
    transaction
        .query_row(
            r#"SELECT publication.id, workspace.workspace_path, publication.task_id,
                      publication.source_run_id, publication.kind, publication.status,
                      publication.branch, publication.remote, publication.url,
                      publication.pull_request_number, publication.check_state,
                      publication.created_at, publication.updated_at
               FROM publication_records publication
               JOIN workspaces workspace ON workspace.id = publication.workspace_id
               WHERE publication.idempotency_key = ?1"#,
            [idempotency_key],
            decode_publication_row,
        )
        .optional()
        .map_err(|error| format!("Could not load publication record: {error}"))
}

fn load_latest_pull_request_publication(
    transaction: &Transaction<'_>,
    project_path: &str,
    task_id: &str,
    pull_request_number: i64,
) -> Result<Option<PublicationRow>, String> {
    transaction
        .query_row(
            r#"SELECT publication.id, workspace.workspace_path, publication.task_id,
                      publication.source_run_id, publication.kind, publication.status,
                      publication.branch, publication.remote, publication.url,
                      publication.pull_request_number, publication.check_state,
                      publication.created_at, publication.updated_at
               FROM publication_records publication
               JOIN workspaces workspace ON workspace.id = publication.workspace_id
               WHERE workspace.workspace_path = ?1 AND publication.task_id = ?2
                 AND publication.pull_request_number = ?3
               ORDER BY publication.created_at DESC, publication.id DESC LIMIT 1"#,
            params![project_path, task_id, pull_request_number],
            decode_publication_row,
        )
        .optional()
        .map_err(|error| format!("Could not load pull-request publication: {error}"))
}

fn decode_publication_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PublicationRow> {
    Ok(PublicationRow {
        id: row.get(0)?,
        project_path: row.get(1)?,
        task_id: row.get(2)?,
        source_run_id: row.get(3)?,
        kind: row.get(4)?,
        status: row.get(5)?,
        branch: row.get(6)?,
        remote: row.get(7)?,
        url: row.get(8)?,
        pull_request_number: row.get(9)?,
        check_state: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn pending_title(kind: &str) -> &'static str {
    match kind {
        "command_approval" => "Command approval needed",
        "file_approval" => "File change approval needed",
        "permissions" => "Permission request",
        "question" => "Question from Codex",
        "mcp_elicitation" => "MCP input requested",
        _ => "Operator input needed",
    }
}

fn bounded_summary(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut characters = normalized.chars();
    let prefix = characters
        .by_ref()
        .take(MAX_SAFE_SUMMARY_CHARS)
        .collect::<String>();
    if characters.next().is_some() {
        format!("{}…", prefix.trim_end())
    } else {
        prefix
    }
}

fn project_display_name(path: &str, configured: Option<&str>) -> String {
    configured
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            Path::new(path)
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "Project".to_owned())
}

fn now_millis() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())
        .and_then(|duration| {
            i64::try_from(duration.as_millis()).map_err(|_| "System time is too large.".to_owned())
        })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::agent::models::XiaoHistoryItem;
    use crate::runs::models::NewRun;
    use crate::xiao::models::{
        TaskStageTransitionRequest, XiaoTaskDocument, XiaoWorkspaceMode, XiaoWorkspaceUpdate,
        XIAO_SCHEMA_VERSION,
    };

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "xiao-supervision-{label}-{}-{}",
                std::process::id(),
                NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn task_document(title: &str, updated_at: i64, unread: bool) -> XiaoTaskDocument {
        XiaoTaskDocument {
            id: "task".to_owned(),
            title: title.to_owned(),
            created_at: 1,
            updated_at,
            stage: TaskStage::Draft,
            stage_version: 0,
            codex_profile_id: None,
            workbench_state: json!({}),
            draft_text: String::new(),
            follow_ups: Vec::new(),
            archived: false,
            pinned: false,
            unread,
            model: Some("gpt-test".to_owned()),
            reasoning_effort: Some("medium".to_owned()),
            thread_id: None,
            thread_binding: None,
            mode: "default".to_owned(),
            approval_policy: "on-request".to_owned(),
            sandbox_mode: "workspace-write".to_owned(),
            goal: None,
            acceptance_contract: None,
            timeline: Vec::new(),
            timeline_loaded: true,
            timeline_complete: true,
            timeline_start: 0,
            timeline_entry_count: 0,
            plan: None,
            execution_environment_id: None,
            workspace_mode: XiaoWorkspaceMode::Local,
            managed_worktree_id: None,
        }
    }

    fn save_task_workspace(
        repository: &XiaoRepository,
        workspace: &Path,
        title: &str,
        updated_at: i64,
        unread: bool,
    ) -> String {
        fs::create_dir_all(workspace).unwrap();
        let workspace = normalize_workspace_path(&workspace.to_string_lossy());
        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: workspace.clone(),
                active_task_id: Some("task".to_owned()),
                show_archived: false,
                task_ids: vec!["task".to_owned()],
                tasks: vec![task_document(title, updated_at, unread)],
            })
            .unwrap();
        workspace
    }

    fn repository_with_task(directory: &Path) -> (XiaoRepository, String) {
        let repository = XiaoRepository::open(directory).unwrap();
        let workspace = save_task_workspace(
            &repository,
            &directory.join("workspace"),
            "Supervised task",
            1,
            false,
        );
        (repository, workspace)
    }

    fn new_run(repository: &XiaoRepository, workspace: &str, id: &str, queued_at: i64) -> NewRun {
        let defaults = repository.run_task_defaults(workspace, "task").unwrap();
        let binding = repository
            .task_execution_binding(workspace, "task")
            .unwrap();
        NewRun {
            id: id.to_owned(),
            workspace_id: defaults.workspace_id,
            task_id: "task".to_owned(),
            idempotency_key: format!("enqueue-{id}"),
            parent_run_id: None,
            candidate_group_id: None,
            routine_occurrence_id: None,
            execution_environment_id: binding.environment.id,
            execution_root: workspace.to_owned(),
            managed_worktree_id: None,
            prompt: format!("prompt {id}"),
            input: vec![json!({ "type": "text", "text": id })],
            history: vec![XiaoHistoryItem {
                role: "user".to_owned(),
                text: "history".to_owned(),
            }],
            model: defaults.model,
            reasoning_effort: defaults.reasoning_effort,
            service_tier: None,
            mode: defaults.mode,
            approval_policy: defaults.approval_policy,
            sandbox_mode: defaults.sandbox_mode,
            goal: defaults.goal,
            queued_at,
        }
    }

    fn make_task_ready(
        repository: &XiaoRepository,
        workspace: &str,
        run_id: &str,
        queued_at: i64,
        transition_key: &str,
    ) -> TaskStageTransitionRequest {
        let run = repository
            .enqueue_run(new_run(repository, workspace, run_id, queued_at))
            .unwrap()
            .run;
        repository
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE runs SET status = 'completed', agent_outcome = 'completed', \
                         finished_at = queued_at WHERE id = ?1",
                        [&run.id],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        let stage_version = repository
            .load_workspace(workspace, true)
            .unwrap()
            .unwrap()
            .tasks
            .remove(0)
            .stage_version;
        TaskStageTransitionRequest {
            workspace_path: workspace.to_owned(),
            task_id: "task".to_owned(),
            expected_version: stage_version,
            to_stage: TaskStage::ReadyForReview,
            actor: "operator".to_owned(),
            reason: "Outcome is ready".to_owned(),
            source_run_id: Some(run.id),
            idempotency_key: transition_key.to_owned(),
        }
    }

    #[test]
    fn attention_occurrence_identity_is_scoped_to_its_project() {
        let directory = TestDirectory::new("project-scoped-attention");
        let repository = XiaoRepository::open(&directory.0).unwrap();
        let workspace_a = save_task_workspace(
            &repository,
            &directory.0.join("workspace-a"),
            "Project A task",
            1,
            false,
        );
        let workspace_b = save_task_workspace(
            &repository,
            &directory.0.join("workspace-b"),
            "Project B task",
            1,
            false,
        );
        repository
            .transition_task_stage(make_task_ready(
                &repository,
                &workspace_a,
                "run-a",
                10,
                "ready-a",
            ))
            .unwrap();
        repository
            .transition_task_stage(make_task_ready(
                &repository,
                &workspace_b,
                "run-b",
                20,
                "ready-b",
            ))
            .unwrap();

        let review_items = repository
            .list_attention_items()
            .unwrap()
            .items
            .into_iter()
            .filter(|item| item.kind == AttentionKind::Review)
            .collect::<Vec<_>>();

        assert_eq!(review_items.len(), 2);
        assert_ne!(
            review_items[0].source_occurrence_key,
            review_items[1].source_occurrence_key
        );
        assert!(review_items
            .iter()
            .any(|item| item.project_path == workspace_a && item.task_title == "Project A task"));
        assert!(review_items
            .iter()
            .any(|item| item.project_path == workspace_b && item.task_title == "Project B task"));
    }

    #[test]
    fn acknowledged_unread_attention_survives_unrelated_task_edits() {
        let directory = TestDirectory::new("stable-unread-attention");
        let (repository, workspace) = repository_with_task(&directory.0);
        save_task_workspace(
            &repository,
            Path::new(&workspace),
            "Unread outcome",
            10,
            true,
        );
        let unread = repository
            .list_attention_items()
            .unwrap()
            .items
            .into_iter()
            .find(|item| item.kind == AttentionKind::Unread)
            .unwrap();
        let acknowledged_key = unread.source_occurrence_key.clone();
        assert!(repository.acknowledge_attention_item(&unread.id).unwrap());

        save_task_workspace(
            &repository,
            Path::new(&workspace),
            "Renamed without a new outcome",
            20,
            true,
        );
        assert!(repository
            .list_attention_items()
            .unwrap()
            .items
            .iter()
            .all(|item| item.kind != AttentionKind::Unread));

        save_task_workspace(
            &repository,
            Path::new(&workspace),
            "Renamed without a new outcome",
            21,
            false,
        );
        save_task_workspace(
            &repository,
            Path::new(&workspace),
            "Renamed without a new outcome",
            30,
            true,
        );
        let repeated = repository
            .list_attention_items()
            .unwrap()
            .items
            .into_iter()
            .find(|item| item.kind == AttentionKind::Unread)
            .unwrap();
        assert_ne!(repeated.source_occurrence_key, acknowledged_key);
        assert_eq!(repeated.created_at, 30);
    }

    #[test]
    fn review_attention_uses_the_stage_transition_timestamp() {
        let directory = TestDirectory::new("canonical-review-time");
        let (repository, workspace) = repository_with_task(&directory.0);
        let transition = repository
            .transition_task_stage(make_task_ready(
                &repository,
                &workspace,
                "run-current",
                10,
                "ready-current",
            ))
            .unwrap();

        let review = repository
            .list_attention_items()
            .unwrap()
            .items
            .into_iter()
            .find(|item| item.kind == AttentionKind::Review)
            .unwrap();

        assert_eq!(review.created_at, transition.created_at);
    }

    #[test]
    fn passing_an_older_run_does_not_advance_the_current_task_outcome() {
        let directory = TestDirectory::new("stale-verification");
        let (repository, workspace) = repository_with_task(&directory.0);
        let older = repository
            .enqueue_run(new_run(&repository, &workspace, "run-older", 10))
            .unwrap()
            .run;
        repository
            .enqueue_run(new_run(&repository, &workspace, "run-current", 20))
            .unwrap();

        repository
            .with_connection(|connection| {
                let transaction = connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|error| error.to_string())?;
                advance_task_after_verification(&transaction, &older, "attempt-older", 30)?;
                let (stage, verification_transitions): (String, i64) = transaction
                    .query_row(
                        r#"SELECT task.task_stage,
                                  (
                                      SELECT COUNT(*) FROM task_stage_transitions transition
                                      WHERE transition.workspace_id = task.workspace_id
                                        AND transition.task_id = task.task_id
                                        AND transition.actor = 'verification'
                                  )
                           FROM tasks task WHERE task.task_id = 'task'"#,
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(stage, "in_progress");
                assert_eq!(verification_transitions, 0);
                transaction.commit().map_err(|error| error.to_string())
            })
            .unwrap();
    }

    #[test]
    fn unchanged_publication_refresh_preserves_acknowledged_attention() {
        let directory = TestDirectory::new("stable-publication");
        let (repository, workspace) = repository_with_task(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "run-current", 10))
            .unwrap()
            .run;
        repository
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE runs SET status = 'completed', agent_outcome = 'completed', \
                         finished_at = queued_at WHERE id = ?1",
                        [&run.id],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        repository
            .transition_task_stage(TaskStageTransitionRequest {
                workspace_path: workspace.clone(),
                task_id: "task".to_owned(),
                expected_version: 1,
                to_stage: TaskStage::ReadyForReview,
                actor: "operator".to_owned(),
                reason: "Outcome is ready".to_owned(),
                source_run_id: Some(run.id),
                idempotency_key: "manual-ready".to_owned(),
            })
            .unwrap();
        repository
            .record_pull_request_publication(
                &workspace,
                "task",
                "feature/current",
                "https://github.com/example/xiao/pull/42",
                42,
            )
            .unwrap();

        let checks_json = r#"[{"name":"ci","bucket":"fail"}]"#;
        let first = repository
            .refresh_pull_request_publication(
                &workspace,
                "task",
                42,
                "OPEN",
                "failing",
                checks_json,
            )
            .unwrap()
            .unwrap();
        let attention = repository.list_attention_items().unwrap();
        let failing = attention
            .items
            .iter()
            .find(|item| item.title == "Published checks need attention")
            .unwrap();
        let occurrence_key = failing.source_occurrence_key.clone();
        assert!(repository.acknowledge_attention_item(&failing.id).unwrap());

        std::thread::sleep(Duration::from_millis(2));
        let refreshed = repository
            .refresh_pull_request_publication(
                &workspace,
                "task",
                42,
                "OPEN",
                "failing",
                checks_json,
            )
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.updated_at, first.updated_at);
        assert!(repository
            .list_attention_items()
            .unwrap()
            .items
            .iter()
            .all(|item| item.source_occurrence_key != occurrence_key));
    }

    #[test]
    fn pull_request_state_refresh_preserves_known_check_failure() {
        let directory = TestDirectory::new("publication-state-preserves-checks");
        let (repository, workspace) = repository_with_task(&directory.0);
        repository
            .transition_task_stage(make_task_ready(
                &repository,
                &workspace,
                "run-current",
                10,
                "ready-current",
            ))
            .unwrap();
        repository
            .record_pull_request_publication(
                &workspace,
                "task",
                "feature/current",
                "https://github.com/example/xiao/pull/42",
                42,
            )
            .unwrap();
        repository
            .refresh_pull_request_publication(
                &workspace,
                "task",
                42,
                "OPEN",
                "failing",
                r#"[{"name":"ci","bucket":"fail"}]"#,
            )
            .unwrap();

        let refreshed = repository
            .refresh_pull_request_state(&workspace, "task", 42, "OPEN")
            .unwrap()
            .unwrap();

        assert_eq!(refreshed.check_state, "failing");
        assert!(repository
            .list_attention_items()
            .unwrap()
            .items
            .iter()
            .any(|item| item.title == "Published checks need attention"));
    }

    #[test]
    fn discovered_pull_request_cannot_bind_to_a_newer_unpublished_run() {
        let directory = TestDirectory::new("publication-discovery-run-identity");
        let (repository, workspace) = repository_with_task(&directory.0);
        repository
            .transition_task_stage(make_task_ready(
                &repository,
                &workspace,
                "run-original",
                10,
                "ready-original",
            ))
            .unwrap();
        repository
            .record_branch_publication(&workspace, "task", "feature/upstream", "origin")
            .unwrap();
        assert!(repository
            .record_discovered_pull_request_publication(
                &workspace,
                "task",
                "feature/unrelated",
                "https://github.com/example/xiao/pull/41",
                41,
                "OPEN",
            )
            .unwrap()
            .is_none());
        repository
            .record_discovered_pull_request_publication(
                &workspace,
                "task",
                "feature/upstream",
                "https://github.com/example/xiao/pull/42",
                42,
                "OPEN",
            )
            .unwrap()
            .unwrap();

        repository
            .transition_task_stage(TaskStageTransitionRequest {
                workspace_path: workspace.clone(),
                task_id: "task".to_owned(),
                expected_version: 3,
                to_stage: TaskStage::Completed,
                actor: "operator".to_owned(),
                reason: "Accept original outcome".to_owned(),
                source_run_id: Some("run-original".to_owned()),
                idempotency_key: "accept-original".to_owned(),
            })
            .unwrap();
        assert!(repository
            .record_discovered_pull_request_publication(
                &workspace,
                "task",
                "feature/upstream",
                "https://github.com/example/xiao/pull/42",
                42,
                "OPEN",
            )
            .unwrap()
            .is_some());
        repository
            .transition_task_stage(TaskStageTransitionRequest {
                workspace_path: workspace.clone(),
                task_id: "task".to_owned(),
                expected_version: 4,
                to_stage: TaskStage::InProgress,
                actor: "operator".to_owned(),
                reason: "Reopen for a new outcome".to_owned(),
                source_run_id: Some("run-original".to_owned()),
                idempotency_key: "reopen-new-outcome".to_owned(),
            })
            .unwrap();
        repository
            .transition_task_stage(make_task_ready(
                &repository,
                &workspace,
                "run-new",
                20,
                "ready-new",
            ))
            .unwrap();

        let discovered = repository
            .record_discovered_pull_request_publication(
                &workspace,
                "task",
                "feature/upstream",
                "https://github.com/example/xiao/pull/42",
                42,
                "OPEN",
            )
            .unwrap();
        let refreshed = repository
            .refresh_pull_request_state(&workspace, "task", 42, "OPEN")
            .unwrap()
            .unwrap();
        let raced_association = repository
            .record_publication(
                &workspace,
                "task",
                PublicationKind::PullRequest,
                "feature/upstream",
                None,
                Some("https://github.com/example/xiao/pull/42"),
                Some(42),
                Some("run-original"),
            )
            .unwrap();
        let task = repository
            .load_workspace(&workspace, true)
            .unwrap()
            .unwrap()
            .tasks
            .remove(0);

        assert!(discovered.is_none());
        assert!(raced_association.is_none());
        assert_eq!(refreshed.status, PublicationStatus::Superseded);
        assert_eq!(task.stage, TaskStage::ReadyForReview);
    }

    #[test]
    fn terminal_pull_request_discovery_cannot_complete_a_reused_branch_outcome() {
        let directory = TestDirectory::new("terminal-publication-discovery");
        let (repository, workspace) = repository_with_task(&directory.0);
        repository
            .transition_task_stage(make_task_ready(
                &repository,
                &workspace,
                "run-original",
                10,
                "ready-original",
            ))
            .unwrap();
        repository
            .record_branch_publication(&workspace, "task", "feature/upstream", "origin")
            .unwrap();
        repository
            .record_discovered_pull_request_publication(
                &workspace,
                "task",
                "feature/upstream",
                "https://github.com/example/xiao/pull/42",
                42,
                "OPEN",
            )
            .unwrap()
            .unwrap();
        repository
            .transition_task_stage(TaskStageTransitionRequest {
                workspace_path: workspace.clone(),
                task_id: "task".to_owned(),
                expected_version: 3,
                to_stage: TaskStage::Completed,
                actor: "operator".to_owned(),
                reason: "Accept original outcome".to_owned(),
                source_run_id: Some("run-original".to_owned()),
                idempotency_key: "accept-original-terminal".to_owned(),
            })
            .unwrap();
        repository
            .transition_task_stage(TaskStageTransitionRequest {
                workspace_path: workspace.clone(),
                task_id: "task".to_owned(),
                expected_version: 4,
                to_stage: TaskStage::InProgress,
                actor: "operator".to_owned(),
                reason: "Reopen for a new outcome".to_owned(),
                source_run_id: Some("run-original".to_owned()),
                idempotency_key: "reopen-terminal".to_owned(),
            })
            .unwrap();
        repository
            .transition_task_stage(make_task_ready(
                &repository,
                &workspace,
                "run-new",
                20,
                "ready-new-terminal",
            ))
            .unwrap();
        repository
            .record_branch_publication(&workspace, "task", "feature/local", "origin")
            .unwrap();

        let discovered = repository
            .record_discovered_pull_request_publication(
                &workspace,
                "task",
                "feature/upstream",
                "https://github.com/example/xiao/pull/42",
                42,
                "MERGED",
            )
            .unwrap()
            .unwrap();
        let refreshed = repository
            .refresh_pull_request_state(&workspace, "task", 42, "MERGED")
            .unwrap()
            .unwrap();
        let task = repository
            .load_workspace(&workspace, true)
            .unwrap()
            .unwrap()
            .tasks
            .remove(0);

        assert_eq!(discovered.source_run_id, "run-original");
        assert_eq!(refreshed.status, PublicationStatus::Superseded);
        assert_eq!(task.stage, TaskStage::Published);
    }
}
