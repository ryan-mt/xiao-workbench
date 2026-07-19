use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::runs::repository::{append_event, new_uuid_v7, now_millis};
use crate::xiao::repository::{normalize_workspace_path, XiaoRepository};

use super::models::{ImportHandoffResult, ValidatedHandoff, HANDOFF_SCHEMA_VERSION};

impl XiaoRepository {
    pub(crate) fn import_handoff_lineage(
        &self,
        workspace_path: &str,
        handoff: ValidatedHandoff,
    ) -> Result<ImportHandoffResult, String> {
        let workspace_path = normalize_workspace_path(workspace_path);
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao handoff import: {error}"))?;
            let workspace = transaction
                .query_row(
                    r#"SELECT w.id, e.id, e.workspace_root
                       FROM workspaces w
                       JOIN execution_environments e ON e.workspace_id = w.id
                       WHERE w.workspace_path = ?1"#,
                    [&workspace_path],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("Could not resolve handoff workspace: {error}"))?
                .ok_or("Persist this Xiao workspace before importing a handoff.")?;
            let (workspace_id, execution_environment_id, execution_root) = workspace;

            if let Some((task_id, run_id, imported_at)) = transaction
                .query_row(
                    r#"SELECT task_id, run_id, imported_at FROM handoff_imports
                       WHERE workspace_id = ?1 AND bundle_sha256 = ?2"#,
                    params![workspace_id, handoff.bundle_sha256],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|error| format!("Could not inspect prior handoff imports: {error}"))?
            {
                transaction
                    .execute(
                        "UPDATE workspaces SET active_task_id = ?1 WHERE id = ?2",
                        params![task_id, workspace_id],
                    )
                    .map_err(|error| format!("Could not reopen imported Xiao task: {error}"))?;
                transaction
                    .commit()
                    .map_err(|error| format!("Could not reopen imported Xiao task: {error}"))?;
                return Ok(ImportHandoffResult {
                    task_id,
                    run_id,
                    bundle_sha256: handoff.bundle_sha256,
                    imported_at,
                    already_imported: true,
                });
            }

            let imported_at = now_millis()?;
            let task_id = new_uuid_v7();
            let run_id = new_uuid_v7();
            let import_id = new_uuid_v7();
            let timeline = imported_timeline(&handoff, imported_at);
            let timeline_bytes = serde_json::to_vec(&timeline)
                .map_err(|error| format!("Could not encode imported timeline: {error}"))?;
            let timeline_sha256 = sha256_hex(&timeline_bytes);
            let goal_json = handoff
                .task
                .goal
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| format!("Could not encode imported goal: {error}"))?;
            let position: i64 = transaction
                .query_row(
                    "SELECT COALESCE(MAX(position), -1) + 1 FROM tasks WHERE workspace_id = ?1",
                    [workspace_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not allocate imported task position: {error}"))?;
            let title = if handoff.task.title.trim().is_empty() {
                "Imported Xiao handoff".to_owned()
            } else {
                format!("{} (imported)", handoff.task.title.trim())
            };

            transaction
                .execute(
                    r#"INSERT INTO tasks(
                        workspace_id, task_id, position, title, created_at, updated_at,
                        draft_text, follow_ups_json, archived, pinned, unread, model,
                        reasoning_effort, thread_binding_json, mode, approval_policy,
                        sandbox_mode, goal_json, plan_json, timeline_sha256,
                        timeline_entry_count, execution_environment_id, workspace_mode,
                        managed_worktree_id, acceptance_contract_version_id
                     ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?5, ?6, '[]', 0, 0, 1, ?7, ?8,
                        NULL, ?9, 'on-request', ?10, ?11, NULL, ?12, ?13, ?14,
                        'local', NULL, NULL
                     )"#,
                    params![
                        workspace_id,
                        task_id,
                        position,
                        title,
                        imported_at,
                        handoff.continuation.suggested_prompt,
                        handoff.task.model,
                        handoff.task.reasoning_effort,
                        safe_mode(&handoff.task.mode),
                        safe_sandbox(&handoff.runtime.sandbox_mode),
                        goal_json,
                        timeline_sha256,
                        i64::try_from(timeline.len())
                            .map_err(|_| "The imported timeline is too large.".to_owned())?,
                        execution_environment_id,
                    ],
                )
                .map_err(|error| format!("Could not create imported Xiao task: {error}"))?;

            {
                let mut statement = transaction
                    .prepare(
                        r#"INSERT INTO task_timeline_entries(
                            workspace_id, task_id, position, entry_json
                         ) VALUES (?1, ?2, ?3, ?4)"#,
                    )
                    .map_err(|error| format!("Could not prepare imported timeline: {error}"))?;
                for (position, entry) in timeline.iter().enumerate() {
                    statement
                        .execute(params![
                            workspace_id,
                            task_id,
                            i64::try_from(position)
                                .map_err(|_| "The imported timeline is too large.".to_owned())?,
                            serde_json::to_string(entry).map_err(|error| format!(
                                "Could not encode imported timeline entry: {error}"
                            ))?,
                        ])
                        .map_err(|error| {
                            format!("Could not store imported timeline entry: {error}")
                        })?;
                }
            }

            transaction
                .execute(
                    r#"INSERT INTO runs(
                        id, workspace_id, task_id, idempotency_key, status,
                        agent_outcome, verification_outcome, execution_root, queued_at,
                        started_at, finished_at, version, execution_environment_id,
                        managed_worktree_id, input_json, history_json, prompt, model,
                        reasoning_effort, service_tier, mode, approval_policy,
                        sandbox_mode, goal_json, thread_id, thread_source, cli_version,
                        runtime_generation, turn_id, cancel_requested,
                        verification_baseline_state
                     ) VALUES (
                        ?1, ?2, ?3, ?4, 'completed', 'completed', 'not_requested',
                        ?5, ?6, ?6, ?6, 0, ?7, NULL, '[]', '[]', ?8, ?9, ?10,
                        ?11, ?12, 'on-request', ?13, ?14, NULL, 'handoff-import',
                        ?15, NULL, NULL, 0, 'not_required'
                     )"#,
                    params![
                        run_id,
                        workspace_id,
                        task_id,
                        format!("handoff:{workspace_id}:{}", handoff.bundle_sha256),
                        execution_root,
                        imported_at,
                        execution_environment_id,
                        handoff.continuation.suggested_prompt,
                        handoff.runtime.model,
                        handoff.runtime.reasoning_effort,
                        handoff.runtime.service_tier,
                        safe_mode(&handoff.runtime.mode),
                        safe_sandbox(&handoff.runtime.sandbox_mode),
                        goal_json,
                        handoff.runtime.cli_version,
                    ],
                )
                .map_err(|error| format!("Could not create imported Xiao run: {error}"))?;

            append_event(
                &transaction,
                &run_id,
                "handoff.imported",
                Some("handoff:imported"),
                &json!({
                    "bundleSha256": handoff.bundle_sha256,
                    "sourceTaskId": handoff.source_task_id,
                    "sourceRunId": handoff.source_run_id,
                    "schemaVersion": HANDOFF_SCHEMA_VERSION,
                }),
            )?;
            transaction
                .execute(
                    r#"INSERT INTO handoff_imports(
                        id, workspace_id, task_id, run_id, bundle_sha256,
                        source_task_id, source_run_id, source_schema_version, imported_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
                    params![
                        import_id,
                        workspace_id,
                        task_id,
                        run_id,
                        handoff.bundle_sha256,
                        handoff.source_task_id,
                        handoff.source_run_id,
                        HANDOFF_SCHEMA_VERSION,
                        imported_at,
                    ],
                )
                .map_err(|error| format!("Could not record Xiao handoff lineage: {error}"))?;
            transaction
                .execute(
                    r#"UPDATE workspaces SET active_task_id = ?1, updated_at = ?2
                       WHERE id = ?3"#,
                    params![task_id, imported_at, workspace_id],
                )
                .map_err(|error| format!("Could not select imported Xiao task: {error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao handoff import: {error}"))?;

            Ok(ImportHandoffResult {
                task_id,
                run_id,
                bundle_sha256: handoff.bundle_sha256,
                imported_at,
                already_imported: false,
            })
        })
    }
}

fn imported_timeline(handoff: &ValidatedHandoff, imported_at: i64) -> Vec<Value> {
    let mut timeline = vec![json!({
        "id": new_uuid_v7(),
        "kind": "brief",
        "title": "Imported Xiao handoff",
        "createdAt": imported_at,
        "body": handoff.continuation.summary,
        "meta": format!("Handoff v{} · read-only lineage", HANDOFF_SCHEMA_VERSION),
        "status": "success",
    })];
    timeline.extend(handoff.transcript.iter().map(|entry| {
        let mut entry = entry.clone();
        if let Some(object) = entry.as_object_mut() {
            object.insert("id".to_owned(), Value::String(new_uuid_v7()));
        }
        entry
    }));
    timeline.push(json!({
        "id": new_uuid_v7(),
        "kind": "brief",
        "title": "Suggested continuation",
        "createdAt": imported_at,
        "body": handoff.continuation.suggested_prompt,
        "meta": "Imported handoff",
        "status": "idle",
    }));
    timeline
}

fn safe_mode(value: &str) -> &str {
    if value == "plan" {
        "plan"
    } else {
        "default"
    }
}

fn safe_sandbox(value: &str) -> &str {
    match value {
        "read-only" | "workspace-write" | "danger-full-access" => value,
        _ => "workspace-write",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde_json::json;

    use super::*;
    use crate::handoff::models::{
        HandoffContinuationPayload, HandoffRuntimePayload, HandoffTaskPayload,
    };
    use crate::xiao::models::{XiaoWorkspaceUpdate, XIAO_SCHEMA_VERSION};

    static NEXT_TEST: AtomicU64 = AtomicU64::new(1);

    fn test_directory(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "xiao-handoff-{label}-{}-{}",
            std::process::id(),
            NEXT_TEST.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn validated_handoff(hash: &str) -> ValidatedHandoff {
        ValidatedHandoff {
            bundle_sha256: hash.to_owned(),
            source_task_id: "source-task".to_owned(),
            source_run_id: Some("source-run".to_owned()),
            task: HandoffTaskPayload {
                source_task_id: "source-task".to_owned(),
                title: "Imported task".to_owned(),
                created_at: 1,
                goal: Some(json!({ "objective": "Continue safely" })),
                model: Some("gpt-test".to_owned()),
                reasoning_effort: Some("medium".to_owned()),
                mode: "default".to_owned(),
            },
            runtime: HandoffRuntimePayload {
                source_run_id: Some("source-run".to_owned()),
                status: Some("completed".to_owned()),
                model: Some("gpt-test".to_owned()),
                reasoning_effort: Some("medium".to_owned()),
                service_tier: None,
                mode: "default".to_owned(),
                sandbox_mode: "workspace-write".to_owned(),
                cli_version: None,
            },
            continuation: HandoffContinuationPayload {
                summary: "Continue safely".to_owned(),
                suggested_prompt: "Verify and continue.".to_owned(),
            },
            transcript: vec![json!({
                "id": "source-entry", "kind": "result", "title": "Done",
                "body": "Sanitized result", "status": "success"
            })],
        }
    }

    #[test]
    fn handoff_import_creates_new_lineage_and_is_idempotent() {
        let app_data = test_directory("repo");
        let workspace = test_directory("workspace");
        let second_workspace = test_directory("second-workspace");
        fs::create_dir_all(&app_data).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&second_workspace).unwrap();
        let repository = XiaoRepository::open(&app_data).unwrap();
        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: workspace.to_string_lossy().into_owned(),
                active_task_id: None,
                show_archived: false,
                task_ids: Vec::new(),
                tasks: Vec::new(),
            })
            .unwrap();
        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: second_workspace.to_string_lossy().into_owned(),
                active_task_id: None,
                show_archived: false,
                task_ids: Vec::new(),
                tasks: Vec::new(),
            })
            .unwrap();

        let hash = "a".repeat(64);
        let first = repository
            .import_handoff_lineage(&workspace.to_string_lossy(), validated_handoff(&hash))
            .unwrap();
        let second = repository
            .import_handoff_lineage(&workspace.to_string_lossy(), validated_handoff(&hash))
            .unwrap();
        assert!(!first.already_imported);
        assert!(second.already_imported);
        assert_eq!(first.task_id, second.task_id);
        assert_eq!(first.run_id, second.run_id);
        let other_workspace = repository
            .import_handoff_lineage(
                &second_workspace.to_string_lossy(),
                validated_handoff(&hash),
            )
            .unwrap();
        assert!(!other_workspace.already_imported);
        assert_ne!(other_workspace.run_id, first.run_id);

        let document = repository
            .load_workspace(&workspace.to_string_lossy(), true)
            .unwrap()
            .unwrap();
        assert_eq!(document.tasks.len(), 1);
        assert_eq!(
            document.active_task_id.as_deref(),
            Some(first.task_id.as_str())
        );
        assert_eq!(document.tasks[0].timeline.len(), 3);
        let counts = repository
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT (SELECT COUNT(*) FROM handoff_imports), (SELECT COUNT(*) FROM runs)",
                        [],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(counts, (2, 2));

        drop(repository);
        fs::remove_dir_all(app_data).unwrap();
        fs::remove_dir_all(workspace).unwrap();
        fs::remove_dir_all(second_workspace).unwrap();
    }
}
