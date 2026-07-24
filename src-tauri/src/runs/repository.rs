use std::path::{Component, Path};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::git::models::WorkspaceCheckpointCapture;
use crate::time_travel::repository::{insert_turn_checkpoint, TurnCheckpointOwner};
use crate::verification::lifecycle::{
    cancel_running_verification_attempt_in_transaction,
    interrupt_running_verification_attempts_in_transaction,
};
use crate::verification::models::{VerificationAttemptStatus, VerificationBaselineState};
use crate::verification::repository::{
    decode_optional_contract_snapshot, encode_optional_contract_snapshot,
    load_optional_acceptance_contract_version_from_connection,
};
use crate::xiao::models::{TaskStage, XiaoThreadBinding, XiaoThreadPersistence};
use crate::xiao::repository::{
    normalize_workspace_path, task_execution_binding_matches, XiaoRepository,
};

use super::models::{
    AgentOutcome, NewPendingInput, NewRun, PendingInputKind, PendingInputSnapshot, RunEventRecord,
    RunRecord, RunStatus, RunTaskDefaults, RuntimeAttachment, VerificationOutcome,
};

const MAX_SAFE_EVENT_BYTES: usize = 64 * 1024;
const MAX_TURN_DIFF_BYTES: usize = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES: usize = 4 * 1024;
const MAX_RUN_INPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_RUN_HISTORY_BYTES: usize = 8 * 1024 * 1024;
const MAX_RUN_PROMPT_BYTES: usize = 64 * 1024;
const MAX_RUN_IDENTITY_BYTES: usize = 512;
const DEFAULT_EVENT_PAGE_SIZE: usize = 200;
const MAX_EVENT_PAGE_SIZE: usize = 200;
const DEFAULT_RUN_PAGE_SIZE: usize = 50;
const MAX_RUN_PAGE_SIZE: usize = 100;

pub(crate) const ACTIVE_STATUSES_SQL: &str =
    "'preparing', 'running', 'waiting_for_input', 'verifying'";
const RUN_OWNERSHIP_STATUSES_SQL: &str =
    "'queued', 'preparing', 'running', 'waiting_for_input', 'verifying'";
const TERMINAL_STATUSES_SQL: &str =
    "'completed', 'needs_attention', 'failed', 'cancelled', 'interrupted'";
const RUNTIME_ACTIVE_STATUSES_SQL: &str = "'preparing', 'running', 'waiting_for_input'";

pub(crate) fn execution_roots_overlap(left: &str, right: &str) -> bool {
    execution_root_starts_with(left, right) || execution_root_starts_with(right, left)
}

fn execution_root_starts_with(path: &str, ancestor: &str) -> bool {
    let mut path_components = Path::new(path).components();
    Path::new(ancestor).components().all(|ancestor_component| {
        path_components
            .next()
            .is_some_and(|path_component| path_components_equal(path_component, ancestor_component))
    })
}

fn path_components_equal(left: Component<'_>, right: Component<'_>) -> bool {
    #[cfg(windows)]
    {
        left.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub(crate) struct CorrelatedRunEvent<'a> {
    pub generation: u64,
    pub thread_id: &'a str,
    pub turn_id: Option<&'a str>,
    pub event_type: &'a str,
    pub event_key: Option<&'a str>,
    pub payload: &'a Value,
}

pub(crate) struct RuntimeTurnSettlement<'a> {
    pub run_id: &'a str,
    pub generation: u64,
    pub thread_id: &'a str,
    pub turn_id: &'a str,
    pub runtime_status: RunStatus,
    pub payload: &'a Value,
    pub checkpoint: Option<&'a WorkspaceCheckpointCapture>,
}

const RUN_SELECT: &str = r#"
SELECT
    r.id, r.workspace_id, w.workspace_path, r.task_id, r.idempotency_key,
    r.parent_run_id, r.candidate_group_id, r.status, r.agent_outcome,
    r.verification_outcome, r.execution_environment_id, r.execution_root,
    r.managed_worktree_id, r.prompt, r.input_json, r.history_json, r.model,
    r.reasoning_effort, r.service_tier, r.mode, r.approval_policy,
    r.sandbox_mode, r.goal_json, r.thread_id, r.thread_source, r.cli_version,
    r.runtime_generation, r.turn_id, r.cancel_requested, r.queued_at,
    r.started_at, r.finished_at, r.version, r.routine_occurrence_id,
    r.acceptance_contract_source_version_id, r.acceptance_contract_snapshot_json,
    r.acceptance_contract_snapshot_sha256, r.verification_baseline_state,
    r.verification_baseline_artifact_id, r.verification_baseline_diagnostic,
    r.latest_verification_attempt_id, r.codex_profile_id,
    r.capability_snapshot_json, r.policy_snapshot_json, r.workspace_snapshot_json
FROM runs r
JOIN workspaces w ON w.id = r.workspace_id
"#;

#[derive(Debug, Clone)]
pub(crate) struct RunMutation {
    pub run: RunRecord,
    pub event: Option<RunEventRecord>,
}

#[derive(Debug, Clone)]
pub(crate) enum CancelDisposition {
    Settled(RunMutation),
    Interrupt {
        run: RunRecord,
        event: Option<RunEventRecord>,
    },
    Verification {
        run: RunRecord,
        event: Option<RunEventRecord>,
    },
}

pub(crate) fn task_binding_has_run_owners(
    connection: &Connection,
    workspace_id: i64,
    task_id: &str,
) -> Result<bool, String> {
    let count: i64 = connection
        .query_row(
            &format!(
                r#"SELECT COUNT(*) FROM runs
                   WHERE workspace_id = ?1 AND task_id = ?2
                     AND status IN ({RUN_OWNERSHIP_STATUSES_SQL})"#
            ),
            params![workspace_id, task_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect Xiao run binding ownership: {error}"))?;
    Ok(count != 0)
}

impl XiaoRepository {
    pub(crate) fn allocate_runtime_generation(&self, environment_id: &str) -> Result<u64, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| {
                    format!("Could not start runtime generation allocation: {error}")
                })?;
            transaction
                .execute(
                    r#"INSERT INTO runtime_generations(execution_environment_id, generation)
                     VALUES (?1, 0) ON CONFLICT(execution_environment_id) DO NOTHING"#,
                    [environment_id],
                )
                .map_err(|error| format!("Could not initialize runtime generation: {error}"))?;
            let generation: i64 = transaction
                .query_row(
                    r#"UPDATE runtime_generations SET generation = generation + 1
                     WHERE execution_environment_id = ?1 RETURNING generation"#,
                    [environment_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not allocate runtime generation: {error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit runtime generation: {error}"))?;
            u64::try_from(generation)
                .map_err(|_| "The allocated runtime generation is invalid.".to_owned())
        })
    }

    pub(crate) fn task_has_run_owners(
        &self,
        workspace_path: &str,
        task_id: &str,
    ) -> Result<bool, String> {
        let workspace_path = normalize_workspace_path(workspace_path);
        self.with_connection(|connection| {
            let count: i64 = connection
                .query_row(
                    &format!(
                        r#"SELECT COUNT(*) FROM runs r
                           JOIN workspaces w ON w.id = r.workspace_id
                           WHERE w.workspace_path = ?1 AND r.task_id = ?2
                             AND r.status IN ({RUN_OWNERSHIP_STATUSES_SQL})"#
                    ),
                    params![workspace_path, task_id],
                    |row| row.get(0),
                )
                .map_err(|error| {
                    format!("Could not inspect Xiao run binding ownership: {error}")
                })?;
            Ok(count != 0)
        })
    }

    pub(crate) fn has_active_runs(&self) -> Result<bool, String> {
        self.with_connection(|connection| {
            let count: i64 = connection
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM runs WHERE status IN ({RUN_OWNERSHIP_STATUSES_SQL})"
                    ),
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not inspect active Xiao runs: {error}"))?;
            Ok(count != 0)
        })
    }

    pub(crate) fn has_active_runtime_generation(
        &self,
        environment_id: &str,
        generation: u64,
    ) -> Result<bool, String> {
        let generation = generation_to_i64(generation)?;
        self.with_connection(|connection| {
            let count: i64 = connection
                .query_row(
                    &format!(
                        r#"SELECT COUNT(*) FROM runs
                           WHERE execution_environment_id = ?1
                             AND runtime_generation = ?2
                             AND status IN ({RUNTIME_ACTIVE_STATUSES_SQL})"#
                    ),
                    params![environment_id, generation],
                    |row| row.get(0),
                )
                .map_err(|error| {
                    format!("Could not inspect active Xiao environment Runs: {error}")
                })?;
            Ok(count != 0)
        })
    }

    pub(crate) fn run_task_defaults(
        &self,
        workspace_path: &str,
        task_id: &str,
    ) -> Result<RunTaskDefaults, String> {
        let workspace_path = normalize_workspace_path(workspace_path);
        self.with_connection(|connection| {
            connection
                .query_row(
                    r#"SELECT w.id, t.model, t.reasoning_effort, t.mode,
                        t.approval_policy, t.sandbox_mode, t.goal_json,
                        t.thread_binding_json
                     FROM workspaces w
                     JOIN tasks t ON t.workspace_id = w.id
                     WHERE w.workspace_path = ?1 AND t.task_id = ?2"#,
                    params![workspace_path, task_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, Option<String>>(6)?,
                            row.get::<_, Option<String>>(7)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("Could not load Xiao run defaults: {error}"))?
                .ok_or_else(|| format!("Xiao task `{task_id}` was not found."))
                .and_then(
                    |(
                        workspace_id,
                        model,
                        reasoning_effort,
                        mode,
                        approval_policy,
                        sandbox_mode,
                        goal_json,
                        thread_binding_json,
                    )| {
                        Ok(RunTaskDefaults {
                            workspace_id,
                            model,
                            reasoning_effort,
                            mode,
                            approval_policy,
                            sandbox_mode,
                            goal: parse_optional_json(goal_json.as_deref(), "task goal")?,
                            thread_binding: parse_optional_json(
                                thread_binding_json.as_deref(),
                                "thread binding",
                            )?,
                        })
                    },
                )
        })
    }

    pub(crate) fn enqueue_run(&self, run: NewRun) -> Result<RunMutation, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao run enqueue: {error}"))?;
            let mutation = Self::enqueue_run_in_transaction(&transaction, &run)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao run enqueue: {error}"))?;
            Ok(mutation)
        })
    }

    pub(crate) fn enqueue_run_in_transaction(
        transaction: &Transaction<'_>,
        run: &NewRun,
    ) -> Result<RunMutation, String> {
        validate_new_run(run)?;
        if let Some(existing) = load_run_by_idempotency(transaction, &run.idempotency_key)? {
            if existing.workspace_id != run.workspace_id || existing.task_id != run.task_id {
                return Err("The Xiao run idempotency key belongs to another task.".to_owned());
            }
            return Ok(RunMutation {
                run: existing,
                event: None,
            });
        }

        let binding_matches = task_execution_binding_matches(
            transaction,
            run.workspace_id,
            &run.task_id,
            &run.execution_environment_id,
            run.managed_worktree_id.as_deref(),
        )?
        .ok_or("The Xiao run task no longer exists.")?;
        if !binding_matches {
            return Err("The Xiao run execution binding changed before enqueue.".to_owned());
        }
        let (task_stage, task_stage_version, bound_profile_id) = transaction
            .query_row(
                r#"SELECT task_stage, task_stage_version, codex_profile_id
                   FROM tasks WHERE workspace_id = ?1 AND task_id = ?2"#,
                params![run.workspace_id, run.task_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .map_err(|error| format!("Could not load Task stage before Run enqueue: {error}"))?;
        let task_stage = TaskStage::from_database(&task_stage)?;
        if task_stage == TaskStage::Completed {
            return Err(
                "A completed Task must be reopened before starting another Run.".to_owned(),
            );
        }
        let profile_was_unbound = bound_profile_id.is_none();
        let profile_id = bound_profile_id.unwrap_or_else(|| "default".to_owned());
        let (capabilities_json, profile_availability, profile_diagnostic) = transaction
            .query_row(
                r#"SELECT capabilities_json, availability, diagnostic
                   FROM codex_profiles WHERE id = ?1"#,
                [&profile_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .map_err(|error| format!("Could not snapshot Task Codex profile: {error}"))?;
        if matches!(
            profile_availability.as_str(),
            "unavailable" | "incompatible"
        ) {
            return Err(profile_diagnostic
                .unwrap_or_else(|| format!("The Task Codex profile is {profile_availability}.")));
        }
        if profile_was_unbound {
            transaction
                .execute(
                    r#"UPDATE tasks SET codex_profile_id = ?1
                       WHERE workspace_id = ?2 AND task_id = ?3
                         AND codex_profile_id IS NULL"#,
                    params![profile_id, run.workspace_id, run.task_id],
                )
                .map_err(|error| format!("Could not bind the default Task profile: {error}"))?;
        }
        let contract = resolve_run_acceptance_contract(transaction, run)?;
        let (
            contract_source_version_id,
            contract_snapshot,
            contract_snapshot_sha256,
            verification_outcome,
            verification_baseline_state,
        ) = match contract {
            Some(record) => {
                let summary = record.summary;
                let snapshot = summary.snapshot();
                let baseline_state = if snapshot.requires_diff_baseline() {
                    VerificationBaselineState::Pending
                } else {
                    VerificationBaselineState::NotRequired
                };
                (
                    Some(summary.version_id),
                    Some(snapshot),
                    Some(summary.hash),
                    VerificationOutcome::Pending,
                    baseline_state,
                )
            }
            None => (
                None,
                None,
                None,
                VerificationOutcome::NotRequested,
                VerificationBaselineState::NotRequired,
            ),
        };
        let input_json = json_string(&run.input, "run input")?;
        let history_json = json_string(&run.history, "run history")?;
        let goal_json = optional_json_string(run.goal.as_ref(), "run goal")?;
        let contract_snapshot_json = encode_optional_contract_snapshot(
            contract_snapshot.as_ref(),
            contract_snapshot_sha256.as_deref(),
        )?;
        let policy_snapshot_json = json_string(
            &json!({
                "model": run.model,
                "reasoningEffort": run.reasoning_effort,
                "serviceTier": run.service_tier,
                "mode": run.mode,
                "approvalPolicy": run.approval_policy,
                "sandboxMode": run.sandbox_mode,
            }),
            "Run policy snapshot",
        )?;
        let workspace_snapshot_json = json_string(
            &json!({
                "executionEnvironmentId": run.execution_environment_id,
                "executionRoot": run.execution_root,
                "managedWorktreeId": run.managed_worktree_id,
            }),
            "Run workspace snapshot",
        )?;
        transaction
            .execute(
                r#"INSERT INTO runs(
                    id, workspace_id, task_id, idempotency_key, parent_run_id,
                    candidate_group_id, status, agent_outcome, verification_outcome,
                    execution_root, queued_at, started_at, finished_at, version,
                    execution_environment_id, managed_worktree_id, input_json,
                    history_json, prompt, model, reasoning_effort, service_tier,
                    mode, approval_policy, sandbox_mode, goal_json, thread_id,
                    thread_source, cli_version, runtime_generation, turn_id,
                    cancel_requested, routine_occurrence_id,
                    acceptance_contract_source_version_id,
                    acceptance_contract_snapshot_json,
                    acceptance_contract_snapshot_sha256, verification_baseline_state,
                    codex_profile_id, capability_snapshot_json, policy_snapshot_json,
                    workspace_snapshot_json
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, 'queued', 'pending',
                    ?26, ?7, ?8, NULL, NULL, 0, ?9, ?10, ?11,
                    ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                    NULL, NULL, NULL, NULL, NULL, 0, ?21, ?22, ?23, ?24, ?25,
                    ?27, ?28, ?29, ?30
                 )"#,
                params![
                    run.id,
                    run.workspace_id,
                    run.task_id,
                    run.idempotency_key,
                    run.parent_run_id,
                    run.candidate_group_id,
                    run.execution_root,
                    run.queued_at,
                    run.execution_environment_id,
                    run.managed_worktree_id,
                    input_json,
                    history_json,
                    run.prompt,
                    run.model,
                    run.reasoning_effort,
                    run.service_tier,
                    run.mode,
                    run.approval_policy,
                    run.sandbox_mode,
                    goal_json,
                    run.routine_occurrence_id,
                    contract_source_version_id,
                    contract_snapshot_json,
                    contract_snapshot_sha256,
                    verification_baseline_state.as_database(),
                    verification_outcome.as_database(),
                    profile_id,
                    capabilities_json,
                    policy_snapshot_json,
                    workspace_snapshot_json,
                ],
            )
            .map_err(|error| format!("Could not enqueue Xiao run: {error}"))?;
        if task_stage != TaskStage::InProgress {
            let resulting_version = task_stage_version + 1;
            let changed = transaction
                .execute(
                    r#"UPDATE tasks
                       SET task_stage = 'in_progress', task_stage_version = ?1
                       WHERE workspace_id = ?2 AND task_id = ?3
                         AND task_stage = ?4 AND task_stage_version = ?5"#,
                    params![
                        resulting_version,
                        run.workspace_id,
                        run.task_id,
                        task_stage.as_database(),
                        task_stage_version
                    ],
                )
                .map_err(|error| format!("Could not advance Task for Run enqueue: {error}"))?;
            if changed != 1 {
                return Err("Task stage changed before the Run could be enqueued.".to_owned());
            }
            let transition_key = format!("run-start:{}", run.id);
            transaction
                .execute(
                    r#"INSERT INTO task_stage_transitions(
                        id, workspace_id, task_id, from_stage, to_stage, expected_version,
                        resulting_version, actor, reason, source_run_id, idempotency_key,
                        created_at
                    ) VALUES (
                        ?1, ?2, ?3, ?4, 'in_progress', ?5, ?6, 'codex',
                        'Run started', ?7, ?8, ?9
                    )"#,
                    params![
                        Uuid::now_v7().to_string(),
                        run.workspace_id,
                        run.task_id,
                        task_stage.as_database(),
                        task_stage_version,
                        resulting_version,
                        run.id,
                        transition_key,
                        run.queued_at
                    ],
                )
                .map_err(|error| format!("Could not record Task Run transition: {error}"))?;
        }
        let event = append_event(
            transaction,
            &run.id,
            "run.queued",
            Some("lifecycle:queued"),
            &json!({
                "idempotencyKey": run.idempotency_key,
                "routineOccurrenceId": run.routine_occurrence_id,
            }),
        )?;
        let record = load_run(transaction, &run.id)?;
        Ok(RunMutation {
            run: record,
            event: Some(event),
        })
    }

    pub(crate) fn get_run(&self, run_id: &str) -> Result<RunRecord, String> {
        self.with_connection(|connection| load_run(connection, run_id))
    }

    pub(crate) fn list_runs(
        &self,
        workspace_path: &str,
        task_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<RunRecord>, String> {
        let workspace_path = normalize_workspace_path(workspace_path);
        let limit = limit
            .unwrap_or(DEFAULT_RUN_PAGE_SIZE)
            .clamp(1, MAX_RUN_PAGE_SIZE) as i64;
        self.with_connection(|connection| {
            let sql = if task_id.is_some() {
                format!(
                    r#"{RUN_SELECT}
                       WHERE w.workspace_path = ?1 AND r.task_id = ?2
                         AND (
                           r.status NOT IN ({TERMINAL_STATUSES_SQL})
                           OR r.id IN (
                             SELECT recent.id FROM runs recent
                             WHERE recent.workspace_id = r.workspace_id
                               AND recent.task_id = r.task_id
                               AND recent.status IN ({TERMINAL_STATUSES_SQL})
                             ORDER BY recent.queued_at DESC, recent.id DESC LIMIT ?3
                           )
                         )
                       ORDER BY r.queued_at DESC, r.id DESC"#
                )
            } else {
                format!(
                    r#"{RUN_SELECT}
                       WHERE w.workspace_path = ?1
                         AND (
                           r.status NOT IN ({TERMINAL_STATUSES_SQL})
                           OR r.id IN (
                             SELECT recent.id FROM runs recent
                             WHERE recent.workspace_id = r.workspace_id
                               AND recent.status IN ({TERMINAL_STATUSES_SQL})
                             ORDER BY recent.queued_at DESC, recent.id DESC LIMIT ?2
                           )
                         )
                       ORDER BY r.queued_at DESC, r.id DESC"#
                )
            };
            let mut statement = connection
                .prepare(&sql)
                .map_err(|error| format!("Could not prepare Xiao run list: {error}"))?;
            let rows = match task_id {
                Some(task_id) => statement
                    .query_map(params![workspace_path, task_id, limit], run_from_row)
                    .map_err(|error| format!("Could not query Xiao runs: {error}"))?,
                None => statement
                    .query_map(params![workspace_path, limit], run_from_row)
                    .map_err(|error| format!("Could not query Xiao runs: {error}"))?,
            };
            rows.map(|row| {
                row.map_err(|error| format!("Could not decode Xiao run: {error}"))?
                    .decode()
            })
            .collect()
        })
    }

    pub(crate) fn list_run_events(
        &self,
        run_id: &str,
        after_sequence: Option<i64>,
        limit: Option<usize>,
    ) -> Result<Vec<RunEventRecord>, String> {
        let limit = limit
            .unwrap_or(DEFAULT_EVENT_PAGE_SIZE)
            .clamp(1, MAX_EVENT_PAGE_SIZE) as i64;
        self.with_connection(|connection| {
            let exists = connection
                .query_row("SELECT 1 FROM runs WHERE id = ?1", [run_id], |_| Ok(()))
                .optional()
                .map_err(|error| format!("Could not find Xiao run events: {error}"))?
                .is_some();
            if !exists {
                return Err("The Xiao run was not found.".to_owned());
            }
            let (sql, after) = match after_sequence {
                Some(after) => (
                    r#"SELECT run_id, sequence, timestamp, event_type, event_key,
                        safe_payload_json FROM run_events
                     WHERE run_id = ?1 AND sequence > ?2
                     ORDER BY sequence ASC LIMIT ?3"#,
                    after,
                ),
                None => (
                    r#"SELECT run_id, sequence, timestamp, event_type, event_key,
                        safe_payload_json FROM (
                          SELECT run_id, sequence, timestamp, event_type, event_key,
                              safe_payload_json FROM run_events
                          WHERE run_id = ?1 AND sequence > ?2
                          ORDER BY sequence DESC LIMIT ?3
                     ) ORDER BY sequence ASC"#,
                    -1,
                ),
            };
            let mut statement = connection
                .prepare(sql)
                .map_err(|error| format!("Could not prepare Xiao run events: {error}"))?;
            let rows = statement
                .query_map(params![run_id, after, limit], event_from_row)
                .map_err(|error| format!("Could not query Xiao run events: {error}"))?;
            rows.map(|row| {
                row.map_err(|error| format!("Could not decode Xiao run event: {error}"))?
                    .decode()
            })
            .collect()
        })
    }

    pub(crate) fn claim_next_eligible_run(
        &self,
        concurrency_limit: usize,
    ) -> Result<Option<RunMutation>, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao queue claim: {error}"))?;
            let active: i64 = transaction
                .query_row(
                    &format!("SELECT COUNT(*) FROM runs WHERE status IN ({ACTIVE_STATUSES_SQL})"),
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not count active Xiao runs: {error}"))?;
            if active >= i64::try_from(concurrency_limit).unwrap_or(i64::MAX) {
                transaction.commit().map_err(|error| {
                    format!("Could not finish Xiao queue capacity check: {error}")
                })?;
                return Ok(None);
            }
            let active_bindings = {
                let mut statement = transaction
                    .prepare(&format!(
                        r#"SELECT execution_root, execution_environment_id, codex_profile_id
                           FROM runs WHERE status IN ({ACTIVE_STATUSES_SQL})"#
                    ))
                    .map_err(|error| {
                        format!("Could not prepare active Xiao execution bindings: {error}")
                    })?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    })
                    .map_err(|error| {
                        format!("Could not query active Xiao execution bindings: {error}")
                    })?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
                    format!("Could not decode active Xiao execution bindings: {error}")
                })?
            };
            let run_id = {
                let mut statement = transaction
                    .prepare(
                        r#"SELECT id, execution_root, execution_environment_id, codex_profile_id
                           FROM runs WHERE status = 'queued'
                           ORDER BY queued_at ASC, id ASC"#,
                    )
                    .map_err(|error| format!("Could not prepare the Xiao run queue: {error}"))?;
                let candidates = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    })
                    .map_err(|error| format!("Could not query the Xiao run queue: {error}"))?;
                let mut eligible = None;
                for candidate in candidates {
                    let (
                        candidate_id,
                        candidate_root,
                        candidate_environment_id,
                        candidate_profile_id,
                    ) = candidate
                        .map_err(|error| format!("Could not decode a queued Xiao run: {error}"))?;
                    if active_bindings.iter().all(
                        |(active_root, active_environment_id, active_profile_id)| {
                            !execution_roots_overlap(active_root, &candidate_root)
                                && (active_environment_id != &candidate_environment_id
                                    || active_profile_id == &candidate_profile_id)
                        },
                    ) {
                        eligible = Some(candidate_id);
                        break;
                    }
                }
                eligible
            };
            let Some(run_id) = run_id else {
                transaction
                    .commit()
                    .map_err(|error| format!("Could not finish empty Xiao queue claim: {error}"))?;
                return Ok(None);
            };
            let mutation = transition(
                &transaction,
                &run_id,
                None,
                RunStatus::Preparing,
                "run.preparing",
                Some("lifecycle:preparing"),
                &json!({}),
            )?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao queue claim: {error}"))?;
            Ok(Some(mutation))
        })
    }

    pub(crate) fn attach_run_runtime(
        &self,
        run_id: &str,
        attachment: &RuntimeAttachment,
    ) -> Result<RunMutation, String> {
        let generation = generation_to_i64(attachment.generation)?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao runtime attachment: {error}"))?;
            let current = load_run(&transaction, run_id)?;
            if current.status != RunStatus::Preparing {
                return Err("Only a preparing Xiao run can attach a runtime.".to_owned());
            }
            if current.cancel_requested {
                return Err("The Xiao run was cancelled during preparation.".to_owned());
            }
            let changed = transaction
                .execute(
                    r#"UPDATE runs SET runtime_generation = ?1, thread_id = ?2,
                        thread_source = ?3, cli_version = ?4, version = version + 1
                     WHERE id = ?5 AND version = ?6 AND status = 'preparing'"#,
                    params![
                        generation,
                        attachment.thread_id,
                        attachment.thread_source,
                        attachment.cli_version,
                        run_id,
                        current.version
                    ],
                )
                .map_err(|error| format!("Could not attach Xiao run runtime: {error}"))?;
            if changed != 1 {
                return Err("The Xiao run changed during runtime attachment.".to_owned());
            }
            let binding = XiaoThreadBinding {
                thread_id: attachment.thread_id.clone(),
                persistence: XiaoThreadPersistence::Ephemeral,
                materialized: attachment.materialized,
                thread_source: Some(attachment.thread_source.clone()),
                cli_version: Some(attachment.cli_version.clone()),
            };
            transaction
                .execute(
                    r#"UPDATE tasks SET thread_binding_json = ?1
                     WHERE workspace_id = ?2 AND task_id = ?3"#,
                    params![
                        json_string(&binding, "Xiao thread binding")?,
                        current.workspace_id,
                        current.task_id
                    ],
                )
                .map_err(|error| format!("Could not persist Xiao thread binding: {error}"))?;
            let key = format!("runtime:{generation}:{}", attachment.thread_id);
            let event = append_event(
                &transaction,
                run_id,
                "run.runtime_attached",
                Some(&key),
                &json!({
                    "runtimeGeneration": attachment.generation,
                    "threadId": attachment.thread_id,
                    "threadSource": attachment.thread_source,
                    "cliVersion": attachment.cli_version,
                }),
            )?;
            let run = load_run(&transaction, run_id)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao runtime attachment: {error}"))?;
            Ok(RunMutation {
                run,
                event: Some(event),
            })
        })
    }

    pub(crate) fn mark_run_running(
        &self,
        run_id: &str,
        generation: u64,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<RunMutation, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao running transition: {error}"))?;
            let current = load_run(&transaction, run_id)?;
            require_runtime_route(&current, generation, thread_id, None)?;
            if current.status != RunStatus::Preparing {
                if current.status == RunStatus::Running
                    && current.turn_id.as_deref() == Some(turn_id)
                {
                    transaction.commit().map_err(|error| {
                        format!("Could not finish duplicate Xiao running event: {error}")
                    })?;
                    return Ok(RunMutation {
                        run: current,
                        event: None,
                    });
                }
                if current.status == RunStatus::Running
                    && current
                        .goal
                        .as_ref()
                        .and_then(|goal| goal.get("status"))
                        .and_then(Value::as_str)
                        == Some("active")
                {
                    let changed = transaction
                        .execute(
                            r#"UPDATE runs SET turn_id = ?1, version = version + 1
                               WHERE id = ?2 AND version = ?3 AND status = 'running'"#,
                            params![turn_id, run_id, current.version],
                        )
                        .map_err(|error| {
                            format!("Could not bind Xiao goal continuation: {error}")
                        })?;
                    if changed != 1 {
                        return Err("The Xiao run changed before its goal continuation.".to_owned());
                    }
                    let key = format!("{generation}/{thread_id}/{turn_id}/started");
                    let event = append_event(
                        &transaction,
                        run_id,
                        "run.goal_continued",
                        Some(&key),
                        &json!({
                            "runtimeGeneration": generation,
                            "threadId": thread_id,
                            "turnId": turn_id,
                        }),
                    )?;
                    let run = load_run(&transaction, run_id)?;
                    mark_task_thread_materialized(&transaction, &run)?;
                    transaction.commit().map_err(|error| {
                        format!("Could not commit Xiao goal continuation: {error}")
                    })?;
                    return Ok(RunMutation {
                        run,
                        event: Some(event),
                    });
                }
                return Err("Only a preparing Xiao run can start a turn.".to_owned());
            }
            if current.cancel_requested {
                return Err("The Xiao run was cancelled before turn start.".to_owned());
            }
            let changed = transaction
                .execute(
                    r#"UPDATE runs SET turn_id = ?1 WHERE id = ?2 AND version = ?3
                       AND status = 'preparing'"#,
                    params![turn_id, run_id, current.version],
                )
                .map_err(|error| format!("Could not bind Xiao run turn: {error}"))?;
            if changed != 1 {
                return Err("The Xiao run changed before turn start.".to_owned());
            }
            let key = format!("{generation}/{thread_id}/{turn_id}/started");
            let mutation = transition(
                &transaction,
                run_id,
                Some(current.version),
                RunStatus::Running,
                "run.running",
                Some(&key),
                &json!({
                    "runtimeGeneration": generation,
                    "threadId": thread_id,
                    "turnId": turn_id,
                }),
            )?;
            mark_task_thread_materialized(&transaction, &mutation.run)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao running transition: {error}"))?;
            Ok(mutation)
        })
    }

    pub(crate) fn transition_run(
        &self,
        run_id: &str,
        target: RunStatus,
        event_type: &str,
        event_key: Option<&str>,
        payload: &Value,
    ) -> Result<RunMutation, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao run transition: {error}"))?;
            let mutation = transition(
                &transaction,
                run_id,
                None,
                target,
                event_type,
                event_key,
                payload,
            )?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao run transition: {error}"))?;
            Ok(mutation)
        })
    }

    #[cfg(test)]
    pub(crate) fn settle_runtime_turn(
        &self,
        run_id: &str,
        generation: u64,
        thread_id: &str,
        turn_id: &str,
        runtime_status: RunStatus,
        payload: &Value,
    ) -> Result<RunMutation, String> {
        self.settle_runtime_turn_with_checkpoint(RuntimeTurnSettlement {
            run_id,
            generation,
            thread_id,
            turn_id,
            runtime_status,
            payload,
            checkpoint: None,
        })
    }

    pub(crate) fn settle_runtime_turn_with_checkpoint(
        &self,
        settlement: RuntimeTurnSettlement<'_>,
    ) -> Result<RunMutation, String> {
        let RuntimeTurnSettlement {
            run_id,
            generation,
            thread_id,
            turn_id,
            runtime_status,
            payload,
            checkpoint,
        } = settlement;
        if !matches!(
            runtime_status,
            RunStatus::Completed | RunStatus::Failed | RunStatus::Interrupted
        ) {
            return Err("The runtime reported an invalid terminal Xiao status.".to_owned());
        }
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao terminal settlement: {error}"))?;
            let current = load_run(&transaction, run_id)?;
            require_runtime_route(&current, generation, thread_id, Some(turn_id))?;
            if let Some(checkpoint) = checkpoint {
                insert_turn_checkpoint(
                    &transaction,
                    TurnCheckpointOwner {
                        run_id: &current.id,
                        workspace_id: current.workspace_id,
                        task_id: &current.task_id,
                        turn_id,
                        execution_root: &current.execution_root,
                    },
                    checkpoint,
                )?;
            }
            if current.status.is_terminal() {
                transaction.commit().map_err(|error| {
                    format!("Could not finish idempotent Xiao terminal settlement: {error}")
                })?;
                return Ok(RunMutation {
                    run: current,
                    event: None,
                });
            }
            let target = if current.cancel_requested {
                RunStatus::Cancelled
            } else if runtime_status == RunStatus::Completed
                && current.acceptance_contract_snapshot.is_some()
            {
                RunStatus::Verifying
            } else {
                runtime_status
            };
            let event_type = match target {
                RunStatus::Completed => "run.completed",
                RunStatus::Verifying => "run.verifying",
                RunStatus::Cancelled => "run.cancelled",
                RunStatus::Interrupted => "run.interrupted",
                _ => "run.failed",
            };
            let key = format!(
                "{generation}/{thread_id}/{turn_id}/{}",
                target.as_database()
            );
            let mutation = transition(
                &transaction,
                run_id,
                Some(current.version),
                target,
                event_type,
                Some(&key),
                payload,
            )?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao terminal settlement: {error}"))?;
            Ok(mutation)
        })
    }

    pub(crate) fn record_run_event(
        &self,
        run_id: &str,
        correlated: CorrelatedRunEvent<'_>,
    ) -> Result<RunMutation, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao run event: {error}"))?;
            let run = load_run(&transaction, run_id)?;
            require_runtime_route(
                &run,
                correlated.generation,
                correlated.thread_id,
                correlated.turn_id,
            )?;
            if run.status.is_terminal() {
                transaction
                    .commit()
                    .map_err(|error| format!("Could not finish late Xiao run event: {error}"))?;
                return Ok(RunMutation { run, event: None });
            }
            if let Some(key) = correlated.event_key {
                if existing_event_by_key(&transaction, run_id, key)?.is_some() {
                    transaction.commit().map_err(|error| {
                        format!("Could not finish duplicate Xiao run event: {error}")
                    })?;
                    return Ok(RunMutation { run, event: None });
                }
            }
            let event = append_event(
                &transaction,
                run_id,
                correlated.event_type,
                correlated.event_key,
                correlated.payload,
            )?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao run event: {error}"))?;
            Ok(RunMutation {
                run,
                event: Some(event),
            })
        })
    }

    pub(crate) fn update_runtime_goal(
        &self,
        run_id: &str,
        goal: Option<&Value>,
        event_type: &str,
    ) -> Result<RunMutation, String> {
        if let Some(goal) = goal {
            validate_safe_payload(goal)?;
        }
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao goal update: {error}"))?;
            let current = load_run(&transaction, run_id)?;
            if current.status.is_terminal() {
                return Err("A terminal Xiao run cannot update its goal.".to_owned());
            }
            let goal_json = optional_json_string(goal, "runtime goal")?;
            let changed = transaction
                .execute(
                    r#"UPDATE runs SET goal_json = ?1, version = version + 1
                       WHERE id = ?2 AND version = ?3"#,
                    params![goal_json, run_id, current.version],
                )
                .map_err(|error| format!("Could not update Xiao run goal: {error}"))?;
            if changed != 1 {
                return Err("The Xiao run changed before its goal update.".to_owned());
            }
            transaction
                .execute(
                    r#"UPDATE tasks SET goal_json = ?1
                       WHERE workspace_id = ?2 AND task_id = ?3"#,
                    params![goal_json, current.workspace_id, current.task_id],
                )
                .map_err(|error| format!("Could not update Xiao task goal: {error}"))?;
            let event = append_event(
                &transaction,
                run_id,
                event_type,
                None,
                &json!({ "goal": goal }),
            )?;
            let run = load_run(&transaction, run_id)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao goal update: {error}"))?;
            Ok(RunMutation {
                run,
                event: Some(event),
            })
        })
    }

    pub(crate) fn update_task_goal_from_run(
        &self,
        run_id: &str,
        goal: Option<&Value>,
    ) -> Result<(), String> {
        if let Some(goal) = goal {
            validate_safe_payload(goal)?;
        }
        self.with_connection(|connection| {
            let current = load_run(connection, run_id)?;
            connection
                .execute(
                    r#"UPDATE tasks SET goal_json = ?1
                       WHERE workspace_id = ?2 AND task_id = ?3"#,
                    params![
                        optional_json_string(goal, "runtime task goal")?,
                        current.workspace_id,
                        current.task_id,
                    ],
                )
                .map_err(|error| format!("Could not update idle Xiao task goal: {error}"))?;
            Ok(())
        })
    }

    pub(crate) fn find_active_run_route(
        &self,
        environment_id: &str,
        generation: u64,
        thread_id: &str,
    ) -> Result<Option<RunRecord>, String> {
        let generation = generation_to_i64(generation)?;
        self.with_connection(|connection| {
            let sql = format!(
                "{RUN_SELECT} WHERE r.execution_environment_id = ?1 AND r.runtime_generation = ?2 AND r.thread_id = ?3 AND r.status IN ({ACTIVE_STATUSES_SQL}) ORDER BY r.queued_at ASC"
            );
            let mut statement = connection
                .prepare(&sql)
                .map_err(|error| format!("Could not prepare Xiao runtime route: {error}"))?;
            let rows = statement
                .query_map(params![environment_id, generation, thread_id], run_from_row)
                .map_err(|error| format!("Could not query Xiao runtime route: {error}"))?;
            let records = rows
                .map(|row| {
                    row.map_err(|error| format!("Could not decode Xiao runtime route: {error}"))?
                        .decode()
                })
                .collect::<Result<Vec<_>, String>>()?;
            match records.as_slice() {
                [] => Ok(None),
                [record] => Ok(Some(record.clone())),
                _ => Err("Multiple active Xiao runs share one runtime thread.".to_owned()),
            }
        })
    }

    pub(crate) fn find_latest_runtime_thread_run(
        &self,
        environment_id: &str,
        generation: u64,
        thread_id: &str,
    ) -> Result<Option<RunRecord>, String> {
        let generation = generation_to_i64(generation)?;
        self.with_connection(|connection| {
            connection
                .query_row(
                    &format!(
                        "{RUN_SELECT} WHERE r.execution_environment_id = ?1 AND r.runtime_generation = ?2 AND r.thread_id = ?3 ORDER BY r.queued_at DESC, r.id DESC LIMIT 1"
                    ),
                    params![environment_id, generation, thread_id],
                    run_from_row,
                )
                .optional()
                .map_err(|error| format!("Could not query Xiao runtime thread owner: {error}"))?
                .map(StoredRunRow::decode)
                .transpose()
        })
    }

    pub(crate) fn adopt_runtime_goal_turn(
        &self,
        run: NewRun,
        attachment: &RuntimeAttachment,
        turn_id: &str,
    ) -> Result<RunMutation, String> {
        let generation = generation_to_i64(attachment.generation)?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao goal turn adoption: {error}"))?;
            let queued = Self::enqueue_run_in_transaction(&transaction, &run)?;
            if queued.event.is_none() {
                if queued.run.status == RunStatus::Running
                    && queued.run.turn_id.as_deref() == Some(turn_id)
                {
                    transaction.commit().map_err(|error| {
                        format!("Could not finish duplicate Xiao goal turn adoption: {error}")
                    })?;
                    return Ok(RunMutation {
                        run: queued.run,
                        event: None,
                    });
                }
                return Err("The Xiao goal turn idempotency key is already in use.".to_owned());
            }
            let preparing = transition(
                &transaction,
                &run.id,
                Some(queued.run.version),
                RunStatus::Preparing,
                "run.preparing",
                Some("lifecycle:preparing"),
                &json!({ "source": "goalContinuation" }),
            )?;
            let changed = transaction
                .execute(
                    r#"UPDATE runs SET runtime_generation = ?1, thread_id = ?2,
                        thread_source = ?3, cli_version = ?4, version = version + 1
                       WHERE id = ?5 AND version = ?6 AND status = 'preparing'"#,
                    params![
                        generation,
                        attachment.thread_id,
                        attachment.thread_source,
                        attachment.cli_version,
                        run.id,
                        preparing.run.version,
                    ],
                )
                .map_err(|error| format!("Could not attach adopted Xiao goal turn: {error}"))?;
            if changed != 1 {
                return Err("The Xiao goal turn changed during runtime attachment.".to_owned());
            }
            let binding = XiaoThreadBinding {
                thread_id: attachment.thread_id.clone(),
                persistence: XiaoThreadPersistence::Ephemeral,
                materialized: attachment.materialized,
                thread_source: Some(attachment.thread_source.clone()),
                cli_version: Some(attachment.cli_version.clone()),
            };
            transaction
                .execute(
                    r#"UPDATE tasks SET thread_binding_json = ?1
                       WHERE workspace_id = ?2 AND task_id = ?3"#,
                    params![
                        json_string(&binding, "Xiao thread binding")?,
                        run.workspace_id,
                        run.task_id,
                    ],
                )
                .map_err(|error| format!("Could not persist adopted goal thread: {error}"))?;
            append_event(
                &transaction,
                &run.id,
                "run.runtime_attached",
                Some(&format!("runtime:{generation}:{}", attachment.thread_id)),
                &json!({
                    "runtimeGeneration": attachment.generation,
                    "threadId": attachment.thread_id,
                    "threadSource": attachment.thread_source,
                    "cliVersion": attachment.cli_version,
                }),
            )?;
            let attached = load_run(&transaction, &run.id)?;
            transaction
                .execute(
                    r#"UPDATE runs SET turn_id = ?1 WHERE id = ?2 AND version = ?3
                       AND status = 'preparing'"#,
                    params![turn_id, run.id, attached.version],
                )
                .map_err(|error| format!("Could not bind adopted Xiao goal turn: {error}"))?;
            let key = format!(
                "{}/{}/{turn_id}/started",
                attachment.generation, attachment.thread_id
            );
            let mutation = transition(
                &transaction,
                &run.id,
                Some(attached.version),
                RunStatus::Running,
                "run.running",
                Some(&key),
                &json!({
                    "runtimeGeneration": attachment.generation,
                    "threadId": attachment.thread_id,
                    "turnId": turn_id,
                    "source": "goalContinuation",
                }),
            )?;
            mark_task_thread_materialized(&transaction, &mutation.run)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao goal turn adoption: {error}"))?;
            Ok(mutation)
        })
    }

    pub(crate) fn open_pending_input(
        &self,
        input: NewPendingInput,
    ) -> Result<(RunMutation, PendingInputSnapshot), String> {
        validate_safe_payload(&input.safe_summary)?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao pending input: {error}"))?;
            let run = load_run(&transaction, &input.run_id)?;
            require_runtime_route(
                &run,
                input.runtime_generation,
                &input.thread_id,
                Some(&input.turn_id),
            )?;
            if !matches!(run.status, RunStatus::Running | RunStatus::WaitingForInput) {
                return Err("The Xiao run cannot accept input in its current state.".to_owned());
            }
            if run.cancel_requested {
                return Err("The Xiao run cannot open input after cancellation.".to_owned());
            }
            if let Some(existing) = find_pending_input(
                &transaction,
                &input.run_id,
                input.runtime_generation,
                &input.request_id,
                &input.thread_id,
                &input.turn_id,
                &input.item_id,
            )? {
                transaction.commit().map_err(|error| {
                    format!("Could not finish duplicate Xiao pending input: {error}")
                })?;
                return Ok((RunMutation { run, event: None }, existing));
            }
            let pending = PendingInputSnapshot {
                id: new_uuid_v7(),
                run_id: input.run_id.clone(),
                runtime_generation: input.runtime_generation,
                request_id: input.request_id.clone(),
                thread_id: input.thread_id.clone(),
                turn_id: input.turn_id.clone(),
                item_id: input.item_id.clone(),
                kind: input.kind,
                safe_summary: input.safe_summary.clone(),
                opened_at: now_millis()?,
                resolved_at: None,
                invalidated_at: None,
            };
            transaction
                .execute(
                    r#"INSERT INTO pending_inputs(
                        id, run_id, runtime_generation, request_id, thread_id,
                        turn_id, item_id, kind, safe_summary_json, opened_at,
                        resolved_at, invalidated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL)"#,
                    params![
                        pending.id,
                        pending.run_id,
                        generation_to_i64(pending.runtime_generation)?,
                        pending.request_id,
                        pending.thread_id,
                        pending.turn_id,
                        pending.item_id,
                        pending.kind.as_database(),
                        json_string(&pending.safe_summary, "pending input summary")?,
                        pending.opened_at,
                    ],
                )
                .map_err(|error| format!("Could not persist Xiao pending input: {error}"))?;
            let key = format!(
                "{}/{}/{}/{}/input-opened",
                input.runtime_generation, input.thread_id, input.turn_id, input.item_id
            );
            let mutation = if run.status == RunStatus::Running {
                transition(
                    &transaction,
                    &input.run_id,
                    Some(run.version),
                    RunStatus::WaitingForInput,
                    "run.waiting_for_input",
                    Some(&key),
                    &json!({
                        "pendingInputId": pending.id,
                        "kind": pending.kind,
                        "threadId": pending.thread_id,
                        "turnId": pending.turn_id,
                        "itemId": pending.item_id,
                    }),
                )?
            } else {
                let event = append_event(
                    &transaction,
                    &input.run_id,
                    "run.input_opened",
                    Some(&key),
                    &json!({
                        "pendingInputId": pending.id,
                        "kind": pending.kind,
                        "threadId": pending.thread_id,
                        "turnId": pending.turn_id,
                        "itemId": pending.item_id,
                    }),
                )?;
                RunMutation {
                    run,
                    event: Some(event),
                }
            };
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao pending input: {error}"))?;
            Ok((mutation, pending))
        })
    }

    pub(crate) fn list_pending_inputs(
        &self,
        workspace_path: &str,
        task_id: Option<&str>,
    ) -> Result<Vec<PendingInputSnapshot>, String> {
        let workspace_path = normalize_workspace_path(workspace_path);
        self.with_connection(|connection| {
            let sql = if task_id.is_some() {
                r#"SELECT p.id, p.run_id, p.runtime_generation, p.request_id,
                    p.thread_id, p.turn_id, p.item_id, p.kind,
                    p.safe_summary_json, p.opened_at, p.resolved_at, p.invalidated_at
                 FROM pending_inputs p
                 JOIN runs r ON r.id = p.run_id
                 JOIN workspaces w ON w.id = r.workspace_id
                 WHERE w.workspace_path = ?1 AND r.task_id = ?2
                   AND p.resolved_at IS NULL AND p.invalidated_at IS NULL
                 ORDER BY p.opened_at ASC"#
            } else {
                r#"SELECT p.id, p.run_id, p.runtime_generation, p.request_id,
                    p.thread_id, p.turn_id, p.item_id, p.kind,
                    p.safe_summary_json, p.opened_at, p.resolved_at, p.invalidated_at
                 FROM pending_inputs p
                 JOIN runs r ON r.id = p.run_id
                 JOIN workspaces w ON w.id = r.workspace_id
                 WHERE w.workspace_path = ?1
                   AND p.resolved_at IS NULL AND p.invalidated_at IS NULL
                 ORDER BY p.opened_at ASC"#
            };
            let mut statement = connection
                .prepare(sql)
                .map_err(|error| format!("Could not prepare Xiao pending-input list: {error}"))?;
            let rows = match task_id {
                Some(task_id) => statement
                    .query_map(params![workspace_path, task_id], pending_input_from_row)
                    .map_err(|error| format!("Could not query Xiao pending inputs: {error}"))?,
                None => statement
                    .query_map([workspace_path], pending_input_from_row)
                    .map_err(|error| format!("Could not query Xiao pending inputs: {error}"))?,
            };
            rows.map(|row| {
                row.map_err(|error| format!("Could not decode Xiao pending input: {error}"))?
                    .decode()
            })
            .collect()
        })
    }

    pub(crate) fn get_pending_input(
        &self,
        pending_input_id: &str,
    ) -> Result<PendingInputSnapshot, String> {
        self.with_connection(|connection| load_pending_input(connection, pending_input_id))
    }

    pub(crate) fn resolve_pending_input(
        &self,
        pending_input_id: &str,
    ) -> Result<(RunMutation, PendingInputSnapshot), String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao input resolution: {error}"))?;
            let mut pending = load_pending_input(&transaction, pending_input_id)?;
            if pending.invalidated_at.is_some() {
                return Err(
                    "This Xiao input request is no longer attached to a live runtime.".to_owned(),
                );
            }
            if pending.resolved_at.is_some() {
                let run = load_run(&transaction, &pending.run_id)?;
                transaction.commit().map_err(|error| {
                    format!("Could not finish idempotent Xiao input resolution: {error}")
                })?;
                return Ok((RunMutation { run, event: None }, pending));
            }
            let run = load_run(&transaction, &pending.run_id)?;
            require_runtime_route(
                &run,
                pending.runtime_generation,
                &pending.thread_id,
                Some(&pending.turn_id),
            )?;
            if run.cancel_requested {
                return Err("The Xiao input request was cancelled before resolution.".to_owned());
            }
            let resolved_at = now_millis()?;
            transaction
                .execute(
                    r#"UPDATE pending_inputs SET resolved_at = ?1
                     WHERE id = ?2 AND resolved_at IS NULL AND invalidated_at IS NULL"#,
                    params![resolved_at, pending_input_id],
                )
                .map_err(|error| format!("Could not resolve Xiao pending input: {error}"))?;
            pending.resolved_at = Some(resolved_at);
            let remaining: i64 = transaction
                .query_row(
                    r#"SELECT COUNT(*) FROM pending_inputs
                     WHERE run_id = ?1 AND resolved_at IS NULL AND invalidated_at IS NULL"#,
                    [&pending.run_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not count Xiao pending inputs: {error}"))?;
            let key = format!("pending-input:{pending_input_id}:resolved");
            let mutation = if run.status == RunStatus::WaitingForInput && remaining == 0 {
                transition(
                    &transaction,
                    &pending.run_id,
                    Some(run.version),
                    RunStatus::Running,
                    "run.input_resolved",
                    Some(&key),
                    &json!({ "pendingInputId": pending_input_id }),
                )?
            } else {
                let event = append_event(
                    &transaction,
                    &pending.run_id,
                    "run.input_resolved",
                    Some(&key),
                    &json!({ "pendingInputId": pending_input_id }),
                )?;
                RunMutation {
                    run,
                    event: Some(event),
                }
            };
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao input resolution: {error}"))?;
            Ok((mutation, pending))
        })
    }

    pub(crate) fn request_run_cancel(&self, run_id: &str) -> Result<CancelDisposition, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao run cancellation: {error}"))?;
            let current = load_run(&transaction, run_id)?;
            if current.status.is_terminal() {
                transaction.commit().map_err(|error| {
                    format!("Could not finish idempotent Xiao cancellation: {error}")
                })?;
                return Ok(CancelDisposition::Settled(RunMutation {
                    run: current,
                    event: None,
                }));
            }
            if current.status == RunStatus::Verifying {
                let event = if current.cancel_requested {
                    None
                } else {
                    let changed = transaction
                        .execute(
                            r#"UPDATE runs SET cancel_requested = 1, version = version + 1
                             WHERE id = ?1 AND version = ?2 AND status = 'verifying'"#,
                            params![run_id, current.version],
                        )
                        .map_err(|error| {
                            format!("Could not record verification cancellation: {error}")
                        })?;
                    if changed != 1 {
                        return Err(
                            "The Xiao run changed during verification cancellation.".to_owned()
                        );
                    }
                    Some(append_event(
                        &transaction,
                        run_id,
                        "run.cancel_requested",
                        Some("lifecycle:cancel-requested"),
                        &json!({ "verification": true }),
                    )?)
                };
                let run = load_run(&transaction, run_id)?;
                transaction.commit().map_err(|error| {
                    format!("Could not commit verification cancellation intent: {error}")
                })?;
                return Ok(CancelDisposition::Verification { run, event });
            }
            if matches!(current.status, RunStatus::Queued | RunStatus::Preparing) {
                let mutation = transition(
                    &transaction,
                    run_id,
                    Some(current.version),
                    RunStatus::Cancelled,
                    "run.cancelled",
                    Some("lifecycle:cancelled"),
                    &json!({ "beforeTurnStart": true }),
                )?;
                transaction.commit().map_err(|error| {
                    format!("Could not commit queued Xiao cancellation: {error}")
                })?;
                return Ok(CancelDisposition::Settled(mutation));
            }
            let event = if current.cancel_requested {
                None
            } else {
                let changed = transaction
                    .execute(
                        r#"UPDATE runs SET cancel_requested = 1, version = version + 1
                         WHERE id = ?1 AND version = ?2"#,
                        params![run_id, current.version],
                    )
                    .map_err(|error| {
                        format!("Could not record Xiao cancellation intent: {error}")
                    })?;
                if changed != 1 {
                    return Err("The Xiao run changed during cancellation.".to_owned());
                }
                Some(append_event(
                    &transaction,
                    run_id,
                    "run.cancel_requested",
                    Some("lifecycle:cancel-requested"),
                    &json!({}),
                )?)
            };
            let run = load_run(&transaction, run_id)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao cancellation intent: {error}"))?;
            Ok(CancelDisposition::Interrupt { run, event })
        })
    }

    pub(crate) fn finish_run_cancel(&self, run_id: &str) -> Result<RunMutation, String> {
        self.finish_run_cancel_inner(run_id, false)
    }

    #[cfg(test)]
    pub(crate) fn finish_run_cancel_with_failpoint(
        &self,
        run_id: &str,
    ) -> Result<RunMutation, String> {
        self.finish_run_cancel_inner(run_id, true)
    }

    fn finish_run_cancel_inner(
        &self,
        run_id: &str,
        fail_before_commit: bool,
    ) -> Result<RunMutation, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao cancellation settlement: {error}"))?;
            let current = load_run(&transaction, run_id)?;
            if current.status.is_terminal() {
                transaction.commit().map_err(|error| {
                    format!("Could not finish idempotent Xiao cancellation settlement: {error}")
                })?;
                return Ok(RunMutation {
                    run: current,
                    event: None,
                });
            }
            if !current.cancel_requested {
                return Err("The Xiao run has no cancellation intent.".to_owned());
            }
            let mut mutation = if current.status == RunStatus::Verifying {
                let timestamp = now_millis()?;
                let cancellation_settlement =
                    cancel_running_verification_attempt_in_transaction(
                        &transaction,
                        run_id,
                        timestamp,
                    )?;
                let payload = json!({
                    "verification": true,
                    "attemptId": cancellation_settlement
                        .as_ref()
                        .map(|settlement| settlement.attempt_id.as_str()),
                    "status": cancellation_settlement
                        .as_ref()
                        .map(|settlement| settlement.status),
                });
                match cancellation_settlement.as_ref() {
                    Some(settlement)
                        if settlement.status == VerificationAttemptStatus::Failed =>
                    {
                        transition_failed_verification(
                            &transaction,
                            &current,
                            &settlement.attempt_id,
                            &payload,
                        )?
                    }
                    _ => {
                        let event_key = cancellation_settlement
                            .as_ref()
                            .map(|settlement| {
                                format!("verification:{}:settled", settlement.attempt_id)
                            })
                            .unwrap_or_else(|| "verification:cancelled".to_owned());
                        transition(
                            &transaction,
                            run_id,
                            Some(current.version),
                            RunStatus::NeedsAttention,
                            "verification.cancelled",
                            Some(&event_key),
                            &payload,
                        )?
                    }
                }
            } else {
                transition(
                    &transaction,
                    run_id,
                    Some(current.version),
                    RunStatus::Cancelled,
                    "run.cancelled",
                    Some("lifecycle:cancelled"),
                    &json!({ "interruptedRuntime": true }),
                )?
            };
            if mutation.run.cancel_requested {
                let cleared = transaction
                    .execute(
                        "UPDATE runs SET cancel_requested = 0, version = version + 1 WHERE id = ?1 AND version = ?2",
                        params![run_id, mutation.run.version],
                    )
                    .map_err(|error| {
                        format!("Could not clear settled Xiao cancellation intent: {error}")
                    })?;
                if cleared != 1 {
                    return Err(
                        "The Xiao run changed while cancellation settlement completed.".to_owned(),
                    );
                }
                mutation.run = load_run(&transaction, run_id)?;
            }
            if fail_before_commit {
                return Err(
                    "Injected failure before Xiao cancellation settlement commit.".to_owned(),
                );
            }
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao cancellation settlement: {error}"))?;
            Ok(mutation)
        })
    }

    pub(crate) fn retry_run(
        &self,
        source_run_id: &str,
        idempotency_key: &str,
    ) -> Result<RunMutation, String> {
        if idempotency_key.trim().is_empty() || idempotency_key.len() > MAX_RUN_IDENTITY_BYTES {
            return Err("A valid retry idempotency key is required.".to_owned());
        }
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao run retry: {error}"))?;
            if let Some(existing) = load_run_by_idempotency(&transaction, idempotency_key)? {
                if existing.parent_run_id.as_deref() != Some(source_run_id) {
                    return Err("The Xiao retry idempotency key belongs to another run.".to_owned());
                }
                transaction
                    .commit()
                    .map_err(|error| format!("Could not finish idempotent Xiao retry: {error}"))?;
                return Ok(RunMutation {
                    run: existing,
                    event: None,
                });
            }
            let source = load_run(&transaction, source_run_id)?;
            if !matches!(source.status, RunStatus::Failed | RunStatus::Interrupted) {
                return Err("Only failed or interrupted Xiao runs can be retried.".to_owned());
            }
            let binding_matches = task_execution_binding_matches(
                &transaction,
                source.workspace_id,
                &source.task_id,
                &source.execution_environment_id,
                source.managed_worktree_id.as_deref(),
            )?
            .unwrap_or(false);
            if !binding_matches {
                return Err("The Xiao retry execution binding is no longer available.".to_owned());
            }
            let id = new_uuid_v7();
            transaction
                .execute(
                    r#"INSERT INTO runs(
                        id, workspace_id, task_id, idempotency_key, parent_run_id,
                        candidate_group_id, status, agent_outcome, verification_outcome,
                        execution_root, queued_at, started_at, finished_at, version,
                        execution_environment_id, managed_worktree_id, input_json,
                        history_json, prompt, model, reasoning_effort, service_tier,
                        mode, approval_policy, sandbox_mode, goal_json, thread_id,
                        thread_source, cli_version, runtime_generation, turn_id,
                        cancel_requested, routine_occurrence_id,
                        acceptance_contract_source_version_id,
                        acceptance_contract_snapshot_json,
                        acceptance_contract_snapshot_sha256, verification_baseline_state,
                        verification_baseline_artifact_id, verification_baseline_diagnostic,
                        latest_verification_attempt_id
                     ) SELECT
                        ?1, workspace_id, task_id, ?2, id, candidate_group_id,
                        'queued', 'pending',
                        CASE WHEN acceptance_contract_snapshot_json IS NULL
                            THEN 'not_requested' ELSE 'pending' END,
                        execution_root, ?3, NULL, NULL, 0, execution_environment_id,
                        managed_worktree_id, input_json, history_json, prompt, model,
                        reasoning_effort, service_tier, mode, approval_policy,
                        sandbox_mode, goal_json, NULL, NULL, NULL, NULL, NULL, 0, NULL,
                        acceptance_contract_source_version_id,
                        acceptance_contract_snapshot_json,
                        acceptance_contract_snapshot_sha256,
                        CASE WHEN verification_baseline_state = 'not_required'
                            THEN 'not_required' ELSE 'pending' END,
                        NULL, NULL, NULL
                     FROM runs WHERE id = ?4"#,
                    params![id, idempotency_key, now_millis()?, source_run_id],
                )
                .map_err(|error| format!("Could not create Xiao retry run: {error}"))?;
            let event = append_event(
                &transaction,
                &id,
                "run.queued",
                Some("lifecycle:queued"),
                &json!({ "parentRunId": source_run_id, "retry": true }),
            )?;
            let run = load_run(&transaction, &id)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao run retry: {error}"))?;
            Ok(RunMutation {
                run,
                event: Some(event),
            })
        })
    }

    pub(crate) fn reconcile_in_flight_runs(&self) -> Result<Vec<RunMutation>, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao run reconciliation: {error}"))?;
            let run_ids = {
                let mut statement = transaction
                    .prepare(&format!(
                        "SELECT id FROM runs WHERE status IN ({ACTIVE_STATUSES_SQL}) ORDER BY queued_at, id"
                    ))
                    .map_err(|error| format!("Could not prepare Xiao reconciliation: {error}"))?;
                let rows = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(|error| format!("Could not query Xiao reconciliation: {error}"))?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|error| format!("Could not decode Xiao reconciliation: {error}"))?
            };
            let timestamp = now_millis()?;
            interrupt_running_verification_attempts_in_transaction(
                &transaction,
                timestamp,
            )?;
            transaction
                .execute(
                    r#"UPDATE pending_inputs SET invalidated_at = ?1
                     WHERE resolved_at IS NULL AND invalidated_at IS NULL"#,
                    [timestamp],
                )
                .map_err(|error| format!("Could not invalidate stale Xiao inputs: {error}"))?;
            let mut mutations = Vec::with_capacity(run_ids.len());
            for run_id in run_ids {
                let current = load_run(&transaction, &run_id)?;
                let failed_attempt_id = if current.status == RunStatus::Verifying {
                    current
                        .latest_verification_attempt_id
                        .as_deref()
                        .map(|attempt_id| {
                            transaction
                                .query_row(
                                    r#"SELECT id FROM verification_attempts
                                       WHERE id = ?1 AND run_id = ?2 AND status = 'failed'"#,
                                    params![attempt_id, run_id],
                                    |row| row.get::<_, String>(0),
                                )
                                .optional()
                                .map_err(|error| {
                                    format!(
                                        "Could not inspect failed verification recovery: {error}"
                                    )
                                })
                        })
                        .transpose()?
                        .flatten()
                } else {
                    None
                };
                let mutation = if let Some(attempt_id) = failed_attempt_id {
                    transition_failed_verification(
                        &transaction,
                        &current,
                        &attempt_id,
                        &json!({
                            "reason": "process_restart",
                            "attemptId": attempt_id,
                            "status": VerificationAttemptStatus::Failed,
                        }),
                    )?
                } else {
                    transition(
                        &transaction,
                        &run_id,
                        Some(current.version),
                        RunStatus::Interrupted,
                        "run.interrupted",
                        Some("reconciliation:interrupted"),
                        &json!({ "reason": "process_restart" }),
                    )?
                };
                let mut mutation = mutation;
                if mutation.run.cancel_requested {
                    let cleared = transaction
                        .execute(
                            "UPDATE runs SET cancel_requested = 0, version = version + 1 WHERE id = ?1 AND version = ?2",
                            params![run_id, mutation.run.version],
                        )
                        .map_err(|error| {
                            format!(
                                "Could not clear reconciled Xiao cancellation intent: {error}"
                            )
                        })?;
                    if cleared != 1 {
                        return Err(
                            "The Xiao run changed while restart reconciliation completed."
                                .to_owned(),
                        );
                    }
                    mutation.run = load_run(&transaction, &run_id)?;
                }
                mutations.push(mutation);
            }
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao run reconciliation: {error}"))?;
            Ok(mutations)
        })
    }

    pub(crate) fn interrupt_runtime_generation(
        &self,
        environment_id: &str,
        generation: u64,
        reason: &str,
    ) -> Result<Vec<RunMutation>, String> {
        let generation_i64 = generation_to_i64(generation)?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao runtime interruption: {error}"))?;
            let run_ids = {
                let mut statement = transaction
                    .prepare(&format!(
                        "SELECT id FROM runs WHERE execution_environment_id = ?1 AND runtime_generation = ?2 AND status IN ({RUNTIME_ACTIVE_STATUSES_SQL}) ORDER BY queued_at, id"
                    ))
                    .map_err(|error| format!("Could not prepare runtime interruption: {error}"))?;
                let rows = statement
                    .query_map(params![environment_id, generation_i64], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(|error| format!("Could not query runtime interruption: {error}"))?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|error| format!("Could not decode runtime interruption: {error}"))?
            };
            let timestamp = now_millis()?;
            transaction
                .execute(
                    r#"UPDATE pending_inputs SET invalidated_at = ?1
                     WHERE runtime_generation = ?2 AND resolved_at IS NULL
                       AND invalidated_at IS NULL AND run_id IN (
                         SELECT id FROM runs WHERE execution_environment_id = ?3
                       )"#,
                    params![timestamp, generation_i64, environment_id],
                )
                .map_err(|error| format!("Could not invalidate runtime inputs: {error}"))?;
            let mut mutations = Vec::with_capacity(run_ids.len());
            for run_id in run_ids {
                let current = load_run(&transaction, &run_id)?;
                let target = if current.cancel_requested {
                    RunStatus::Cancelled
                } else {
                    RunStatus::Interrupted
                };
                let event_type = if target == RunStatus::Cancelled {
                    "run.cancelled"
                } else {
                    "run.interrupted"
                };
                let event_key = format!("runtime:{generation}:stopped");
                mutations.push(transition(
                    &transaction,
                    &run_id,
                    Some(current.version),
                    target,
                    event_type,
                    Some(&event_key),
                    &json!({ "reason": bounded_diagnostic(reason) }),
                )?);
            }
            transaction
                .commit()
                .map_err(|error| format!("Could not commit runtime interruption: {error}"))?;
            Ok(mutations)
        })
    }
}

fn resolve_run_acceptance_contract(
    connection: &Connection,
    run: &NewRun,
) -> Result<Option<crate::verification::models::AcceptanceContractVersionRecord>, String> {
    let version_id = match run.routine_occurrence_id.as_deref() {
        Some(occurrence_id) => {
            let (workspace_id, task_id, version_id) = connection
                .query_row(
                    r#"SELECT r.workspace_id, r.task_id, r.acceptance_contract_version_id
                     FROM routine_occurrences o JOIN routines r ON r.id = o.routine_id
                     WHERE o.id = ?1"#,
                    [occurrence_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("Could not load routine run contract: {error}"))?
                .ok_or("The Xiao routine occurrence no longer exists.")?;
            if workspace_id != run.workspace_id || task_id != run.task_id {
                return Err("The Xiao routine occurrence belongs to another task.".to_owned());
            }
            version_id
        }
        None => connection
            .query_row(
                r#"SELECT acceptance_contract_version_id FROM tasks
                 WHERE workspace_id = ?1 AND task_id = ?2"#,
                params![run.workspace_id, run.task_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .map_err(|error| format!("Could not load task run contract: {error}"))?,
    };
    load_optional_acceptance_contract_version_from_connection(
        connection,
        run.workspace_id,
        version_id.as_deref(),
    )
}

fn validate_new_run(run: &NewRun) -> Result<(), String> {
    if run.id.trim().is_empty()
        || run.task_id.trim().is_empty()
        || run.idempotency_key.trim().is_empty()
        || run.execution_environment_id.trim().is_empty()
        || run.execution_root.trim().is_empty()
        || run.prompt.trim().is_empty()
        || run.input.is_empty()
    {
        return Err("A Xiao run requires identity, task, execution context and input.".to_owned());
    }
    if run.id.len() > MAX_RUN_IDENTITY_BYTES
        || run.task_id.len() > MAX_RUN_IDENTITY_BYTES
        || run.idempotency_key.len() > MAX_RUN_IDENTITY_BYTES
        || run
            .routine_occurrence_id
            .as_ref()
            .is_some_and(|id| id.len() > MAX_RUN_IDENTITY_BYTES)
        || run.execution_environment_id.len() > MAX_RUN_IDENTITY_BYTES
    {
        return Err("Xiao run identity exceeds the 512-byte limit.".to_owned());
    }
    if run.prompt.len() > MAX_RUN_PROMPT_BYTES {
        return Err("Xiao run prompt exceeds the 64 KiB limit.".to_owned());
    }
    let input = serde_json::to_vec(&run.input)
        .map_err(|error| format!("Could not serialize Xiao run input: {error}"))?;
    if input.len() > MAX_RUN_INPUT_BYTES {
        return Err("Xiao run input exceeds the 16 MiB durability limit.".to_owned());
    }
    let history = serde_json::to_vec(&run.history)
        .map_err(|error| format!("Could not serialize Xiao run history: {error}"))?;
    if history.len() > MAX_RUN_HISTORY_BYTES {
        return Err("Xiao run history exceeds the 8 MiB durability limit.".to_owned());
    }
    Ok(())
}

fn transition(
    transaction: &Transaction<'_>,
    run_id: &str,
    expected_version: Option<i64>,
    target: RunStatus,
    event_type: &str,
    event_key: Option<&str>,
    payload: &Value,
) -> Result<RunMutation, String> {
    let current = load_run(transaction, run_id)?;
    if let Some(expected_version) = expected_version {
        if current.version != expected_version {
            return Err("The Xiao run changed before its state transition.".to_owned());
        }
    }
    if current.status == target {
        if let Some(key) = event_key {
            if existing_event_by_key(transaction, run_id, key)?.is_some() {
                return Ok(RunMutation {
                    run: current,
                    event: None,
                });
            }
        }
        return Err(format!(
            "Xiao run is already in state `{}` without a matching idempotent event.",
            target.as_database()
        ));
    }
    if !can_transition(current.status, target) {
        return Err(format!(
            "Invalid Xiao run transition from `{}` to `{}`.",
            current.status.as_database(),
            target.as_database()
        ));
    }
    validate_safe_payload(payload)?;
    let timestamp = now_millis()?;
    let started_at = if current.started_at.is_none() && target == RunStatus::Preparing {
        Some(timestamp)
    } else {
        current.started_at
    };
    let finished_at = if target.is_terminal() {
        Some(timestamp)
    } else {
        None
    };
    let (agent_outcome, verification_outcome) = outcomes_for_transition(
        current.status,
        target,
        current.agent_outcome,
        current.verification_outcome,
    );
    if target.is_terminal() {
        transaction
            .execute(
                r#"UPDATE pending_inputs SET invalidated_at = ?1
                 WHERE run_id = ?2 AND resolved_at IS NULL AND invalidated_at IS NULL"#,
                params![timestamp, run_id],
            )
            .map_err(|error| format!("Could not invalidate terminal Xiao inputs: {error}"))?;
    }
    let changed = transaction
        .execute(
            r#"UPDATE runs SET status = ?1, agent_outcome = ?2,
                verification_outcome = ?3, started_at = ?4, finished_at = ?5,
                version = version + 1
             WHERE id = ?6 AND version = ?7"#,
            params![
                target.as_database(),
                agent_outcome.as_database(),
                verification_outcome.as_database(),
                started_at,
                finished_at,
                run_id,
                current.version,
            ],
        )
        .map_err(|error| format!("Could not transition Xiao run: {error}"))?;
    if changed != 1 {
        return Err("The Xiao run changed during its state transition.".to_owned());
    }
    let event = append_event(transaction, run_id, event_type, event_key, payload)?;
    Ok(RunMutation {
        run: load_run(transaction, run_id)?,
        event: Some(event),
    })
}

fn transition_failed_verification(
    transaction: &Transaction<'_>,
    current: &RunRecord,
    attempt_id: &str,
    payload: &Value,
) -> Result<RunMutation, String> {
    let event_key = format!("verification:{attempt_id}:settled");
    let mut mutation = transition(
        transaction,
        &current.id,
        Some(current.version),
        RunStatus::NeedsAttention,
        "verification.failed",
        Some(&event_key),
        payload,
    )?;
    let changed = transaction
        .execute(
            r#"UPDATE runs SET verification_outcome = 'failed', version = version + 1
               WHERE id = ?1 AND version = ?2 AND status = 'needs_attention'"#,
            params![current.id, mutation.run.version],
        )
        .map_err(|error| format!("Could not preserve failed verification: {error}"))?;
    if changed != 1 {
        return Err("The Xiao run changed while failed verification settled.".to_owned());
    }
    mutation.run = load_run(transaction, &current.id)?;
    Ok(mutation)
}

fn can_transition(from: RunStatus, to: RunStatus) -> bool {
    match from {
        RunStatus::Queued => matches!(to, RunStatus::Preparing | RunStatus::Cancelled),
        RunStatus::Preparing => matches!(
            to,
            RunStatus::Running | RunStatus::Failed | RunStatus::Cancelled | RunStatus::Interrupted
        ),
        RunStatus::Running => matches!(
            to,
            RunStatus::WaitingForInput
                | RunStatus::Verifying
                | RunStatus::Completed
                | RunStatus::Failed
                | RunStatus::Cancelled
                | RunStatus::Interrupted
        ),
        RunStatus::WaitingForInput => matches!(
            to,
            RunStatus::Running | RunStatus::Failed | RunStatus::Cancelled | RunStatus::Interrupted
        ),
        RunStatus::Verifying => matches!(
            to,
            RunStatus::Completed
                | RunStatus::NeedsAttention
                | RunStatus::Failed
                | RunStatus::Cancelled
                | RunStatus::Interrupted
        ),
        RunStatus::NeedsAttention => to == RunStatus::Verifying,
        RunStatus::Completed
        | RunStatus::Failed
        | RunStatus::Cancelled
        | RunStatus::Interrupted => false,
    }
}

fn outcomes_for_transition(
    source: RunStatus,
    target: RunStatus,
    current_agent: AgentOutcome,
    current_verification: VerificationOutcome,
) -> (AgentOutcome, VerificationOutcome) {
    match target {
        RunStatus::Completed => (AgentOutcome::Completed, current_verification),
        RunStatus::Failed => (AgentOutcome::Failed, current_verification),
        RunStatus::Cancelled if source == RunStatus::Verifying => {
            (AgentOutcome::Completed, VerificationOutcome::Blocked)
        }
        RunStatus::Cancelled => (AgentOutcome::Cancelled, current_verification),
        RunStatus::Interrupted if source == RunStatus::Verifying => {
            (AgentOutcome::Completed, VerificationOutcome::Blocked)
        }
        RunStatus::Interrupted => (AgentOutcome::Interrupted, current_verification),
        RunStatus::NeedsAttention => (AgentOutcome::Completed, VerificationOutcome::Blocked),
        RunStatus::Verifying => (AgentOutcome::Completed, VerificationOutcome::Pending),
        _ => (current_agent, current_verification),
    }
}

pub(crate) fn append_event(
    transaction: &Transaction<'_>,
    run_id: &str,
    event_type: &str,
    event_key: Option<&str>,
    payload: &Value,
) -> Result<RunEventRecord, String> {
    if event_type.trim().is_empty() || event_type.len() > 128 {
        return Err("Xiao run event type is invalid.".to_owned());
    }
    if event_key.is_some_and(|key| key.is_empty() || key.len() > 512) {
        return Err("Xiao run event idempotency key is invalid.".to_owned());
    }
    validate_safe_payload(payload)?;
    if let Some(key) = event_key {
        if let Some(existing) = existing_event_by_key(transaction, run_id, key)? {
            return Ok(existing);
        }
    }
    let sequence: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), -1) + 1 FROM run_events WHERE run_id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not allocate Xiao run event sequence: {error}"))?;
    let timestamp = now_millis()?;
    transaction
        .execute(
            r#"INSERT INTO run_events(
                run_id, sequence, timestamp, event_type, safe_payload_json, event_key
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
            params![
                run_id,
                sequence,
                timestamp,
                event_type,
                json_string(payload, "safe run event")?,
                event_key,
            ],
        )
        .map_err(|error| format!("Could not append Xiao run event: {error}"))?;
    Ok(RunEventRecord {
        run_id: run_id.to_owned(),
        sequence,
        timestamp,
        event_type: event_type.to_owned(),
        event_key: event_key.map(str::to_owned),
        safe_payload: payload.clone(),
    })
}

fn existing_event_by_key(
    connection: &Connection,
    run_id: &str,
    event_key: &str,
) -> Result<Option<RunEventRecord>, String> {
    connection
        .query_row(
            r#"SELECT run_id, sequence, timestamp, event_type, event_key,
                safe_payload_json FROM run_events
             WHERE run_id = ?1 AND event_key = ?2"#,
            params![run_id, event_key],
            event_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not inspect Xiao run event idempotency: {error}"))?
        .map(StoredEventRow::decode)
        .transpose()
}

fn validate_safe_payload(payload: &Value) -> Result<(), String> {
    if let Some(payload) = payload.as_object().filter(|payload| {
        payload.len() == 2 && payload.contains_key("protocol") && payload.contains_key("turnDiff")
    }) {
        validate_safe_payload_size(&payload["protocol"])?;
        return match &payload["turnDiff"] {
            Value::Null => Ok(()),
            Value::String(turn_diff) if turn_diff.len() <= MAX_TURN_DIFF_BYTES => Ok(()),
            Value::String(_) => {
                Err("Xiao turn diff exceeds the 8 MiB durability limit.".to_owned())
            }
            _ => Err("Xiao terminal run event has an invalid turn diff.".to_owned()),
        };
    }
    validate_safe_payload_size(payload)
}

fn validate_safe_payload_size(payload: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(payload)
        .map_err(|error| format!("Could not serialize safe Xiao run event: {error}"))?;
    if bytes.len() > MAX_SAFE_EVENT_BYTES {
        return Err("Xiao run event exceeds the 64 KiB safe payload limit.".to_owned());
    }
    Ok(())
}

pub(crate) fn bounded_diagnostic(value: &str) -> String {
    if value.len() <= MAX_DIAGNOSTIC_BYTES {
        return value.to_owned();
    }
    let mut end = MAX_DIAGNOSTIC_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn require_runtime_route(
    run: &RunRecord,
    generation: u64,
    thread_id: &str,
    turn_id: Option<&str>,
) -> Result<(), String> {
    if run.runtime_generation != Some(generation) || run.thread_id.as_deref() != Some(thread_id) {
        return Err(
            "The runtime event belongs to a stale Xiao run generation or thread.".to_owned(),
        );
    }
    if let (Some(expected), Some(actual)) = (run.turn_id.as_deref(), turn_id) {
        if expected != actual {
            return Err("The runtime event belongs to another Xiao turn.".to_owned());
        }
    }
    Ok(())
}

fn mark_task_thread_materialized(
    transaction: &Transaction<'_>,
    run: &RunRecord,
) -> Result<(), String> {
    let Some(thread_id) = run.thread_id.as_ref() else {
        return Err("A running Xiao run has no thread binding.".to_owned());
    };
    let binding = XiaoThreadBinding {
        thread_id: thread_id.clone(),
        persistence: XiaoThreadPersistence::Ephemeral,
        materialized: true,
        thread_source: run.thread_source.clone(),
        cli_version: run.cli_version.clone(),
    };
    transaction
        .execute(
            r#"UPDATE tasks SET thread_binding_json = ?1
             WHERE workspace_id = ?2 AND task_id = ?3"#,
            params![
                json_string(&binding, "materialized thread binding")?,
                run.workspace_id,
                run.task_id
            ],
        )
        .map_err(|error| format!("Could not materialize Xiao thread binding: {error}"))?;
    Ok(())
}

pub(crate) fn load_run(connection: &Connection, run_id: &str) -> Result<RunRecord, String> {
    let sql = format!("{RUN_SELECT} WHERE r.id = ?1");
    connection
        .query_row(&sql, [run_id], run_from_row)
        .optional()
        .map_err(|error| format!("Could not load Xiao run: {error}"))?
        .ok_or_else(|| format!("Xiao run `{run_id}` was not found."))?
        .decode()
}

fn load_run_by_idempotency(
    connection: &Connection,
    idempotency_key: &str,
) -> Result<Option<RunRecord>, String> {
    let sql = format!("{RUN_SELECT} WHERE r.idempotency_key = ?1");
    connection
        .query_row(&sql, [idempotency_key], run_from_row)
        .optional()
        .map_err(|error| format!("Could not inspect Xiao run idempotency: {error}"))?
        .map(StoredRunRow::decode)
        .transpose()
}

struct StoredRunRow {
    id: String,
    workspace_id: i64,
    workspace_path: String,
    task_id: String,
    idempotency_key: String,
    parent_run_id: Option<String>,
    candidate_group_id: Option<String>,
    status: String,
    agent_outcome: String,
    verification_outcome: String,
    execution_environment_id: Option<String>,
    execution_root: String,
    managed_worktree_id: Option<String>,
    prompt: String,
    input_json: String,
    history_json: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    mode: String,
    approval_policy: String,
    sandbox_mode: String,
    goal_json: Option<String>,
    thread_id: Option<String>,
    thread_source: Option<String>,
    cli_version: Option<String>,
    runtime_generation: Option<i64>,
    turn_id: Option<String>,
    cancel_requested: bool,
    queued_at: i64,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    version: i64,
    routine_occurrence_id: Option<String>,
    acceptance_contract_source_version_id: Option<String>,
    acceptance_contract_snapshot_json: Option<String>,
    acceptance_contract_snapshot_sha256: Option<String>,
    verification_baseline_state: String,
    verification_baseline_artifact_id: Option<String>,
    verification_baseline_diagnostic: Option<String>,
    latest_verification_attempt_id: Option<String>,
    codex_profile_id: Option<String>,
    capability_snapshot_json: String,
    policy_snapshot_json: String,
    workspace_snapshot_json: String,
}

impl StoredRunRow {
    fn decode(self) -> Result<RunRecord, String> {
        let acceptance_contract_snapshot = decode_optional_contract_snapshot(
            self.acceptance_contract_snapshot_json.as_deref(),
            self.acceptance_contract_snapshot_sha256.as_deref(),
        )?;
        if self.acceptance_contract_source_version_id.is_some()
            != acceptance_contract_snapshot.is_some()
        {
            return Err(
                "The stored Xiao run contract source and snapshot are inconsistent.".to_owned(),
            );
        }
        Ok(RunRecord {
            id: self.id,
            workspace_id: self.workspace_id,
            workspace_path: self.workspace_path,
            task_id: self.task_id,
            idempotency_key: self.idempotency_key,
            parent_run_id: self.parent_run_id,
            candidate_group_id: self.candidate_group_id,
            status: RunStatus::from_database(&self.status)?,
            agent_outcome: AgentOutcome::from_database(&self.agent_outcome)?,
            verification_outcome: VerificationOutcome::from_database(&self.verification_outcome)?,
            execution_environment_id: self
                .execution_environment_id
                .ok_or("The Xiao run has no execution environment. Upgrade/retry this run.")?,
            execution_root: self.execution_root,
            managed_worktree_id: self.managed_worktree_id,
            prompt: self.prompt,
            input: parse_json(&self.input_json, "run input")?,
            history: parse_json(&self.history_json, "run history")?,
            model: self.model,
            reasoning_effort: self.reasoning_effort,
            service_tier: self.service_tier,
            mode: self.mode,
            approval_policy: self.approval_policy,
            sandbox_mode: self.sandbox_mode,
            goal: parse_optional_json(self.goal_json.as_deref(), "run goal")?,
            thread_id: self.thread_id,
            thread_source: self.thread_source,
            cli_version: self.cli_version,
            runtime_generation: self
                .runtime_generation
                .map(|value| {
                    u64::try_from(value)
                        .map_err(|_| "The Xiao runtime generation is invalid.".to_owned())
                })
                .transpose()?,
            turn_id: self.turn_id,
            cancel_requested: self.cancel_requested,
            queued_at: self.queued_at,
            started_at: self.started_at,
            finished_at: self.finished_at,
            version: self.version,
            routine_occurrence_id: self.routine_occurrence_id,
            acceptance_contract_source_version_id: self.acceptance_contract_source_version_id,
            acceptance_contract_snapshot,
            acceptance_contract_snapshot_sha256: self.acceptance_contract_snapshot_sha256,
            verification_baseline_state: VerificationBaselineState::from_database(
                &self.verification_baseline_state,
            )?,
            verification_baseline_artifact_id: self.verification_baseline_artifact_id,
            verification_baseline_diagnostic: self.verification_baseline_diagnostic,
            latest_verification_attempt_id: self.latest_verification_attempt_id,
            codex_profile_id: self.codex_profile_id,
            capability_snapshot: parse_json(
                &self.capability_snapshot_json,
                "Run capability snapshot",
            )?,
            policy_snapshot: parse_json(&self.policy_snapshot_json, "Run policy snapshot")?,
            workspace_snapshot: parse_json(
                &self.workspace_snapshot_json,
                "Run workspace snapshot",
            )?,
        })
    }
}

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<StoredRunRow> {
    Ok(StoredRunRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        workspace_path: row.get(2)?,
        task_id: row.get(3)?,
        idempotency_key: row.get(4)?,
        parent_run_id: row.get(5)?,
        candidate_group_id: row.get(6)?,
        status: row.get(7)?,
        agent_outcome: row.get(8)?,
        verification_outcome: row.get(9)?,
        execution_environment_id: row.get(10)?,
        execution_root: row.get(11)?,
        managed_worktree_id: row.get(12)?,
        prompt: row.get(13)?,
        input_json: row.get(14)?,
        history_json: row.get(15)?,
        model: row.get(16)?,
        reasoning_effort: row.get(17)?,
        service_tier: row.get(18)?,
        mode: row.get(19)?,
        approval_policy: row.get(20)?,
        sandbox_mode: row.get(21)?,
        goal_json: row.get(22)?,
        thread_id: row.get(23)?,
        thread_source: row.get(24)?,
        cli_version: row.get(25)?,
        runtime_generation: row.get(26)?,
        turn_id: row.get(27)?,
        cancel_requested: row.get::<_, i64>(28)? != 0,
        queued_at: row.get(29)?,
        started_at: row.get(30)?,
        finished_at: row.get(31)?,
        version: row.get(32)?,
        routine_occurrence_id: row.get(33)?,
        acceptance_contract_source_version_id: row.get(34)?,
        acceptance_contract_snapshot_json: row.get(35)?,
        acceptance_contract_snapshot_sha256: row.get(36)?,
        verification_baseline_state: row.get(37)?,
        verification_baseline_artifact_id: row.get(38)?,
        verification_baseline_diagnostic: row.get(39)?,
        latest_verification_attempt_id: row.get(40)?,
        codex_profile_id: row.get(41)?,
        capability_snapshot_json: row.get(42)?,
        policy_snapshot_json: row.get(43)?,
        workspace_snapshot_json: row.get(44)?,
    })
}

struct StoredEventRow {
    run_id: String,
    sequence: i64,
    timestamp: i64,
    event_type: String,
    event_key: Option<String>,
    safe_payload_json: String,
}

impl StoredEventRow {
    fn decode(self) -> Result<RunEventRecord, String> {
        Ok(RunEventRecord {
            run_id: self.run_id,
            sequence: self.sequence,
            timestamp: self.timestamp,
            event_type: self.event_type,
            event_key: self.event_key,
            safe_payload: parse_json(&self.safe_payload_json, "safe run event")?,
        })
    }
}

fn event_from_row(row: &Row<'_>) -> rusqlite::Result<StoredEventRow> {
    Ok(StoredEventRow {
        run_id: row.get(0)?,
        sequence: row.get(1)?,
        timestamp: row.get(2)?,
        event_type: row.get(3)?,
        event_key: row.get(4)?,
        safe_payload_json: row.get(5)?,
    })
}

fn find_pending_input(
    connection: &Connection,
    run_id: &str,
    generation: u64,
    request_id: &str,
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
) -> Result<Option<PendingInputSnapshot>, String> {
    connection
        .query_row(
            r#"SELECT id, run_id, runtime_generation, request_id, thread_id,
                turn_id, item_id, kind, safe_summary_json, opened_at,
                resolved_at, invalidated_at
             FROM pending_inputs
             WHERE run_id = ?1 AND runtime_generation = ?2 AND request_id = ?3
               AND thread_id = ?4 AND turn_id = ?5 AND item_id = ?6"#,
            params![
                run_id,
                generation_to_i64(generation)?,
                request_id,
                thread_id,
                turn_id,
                item_id
            ],
            pending_input_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not inspect Xiao pending input: {error}"))?
        .map(StoredPendingInputRow::decode)
        .transpose()
}

fn load_pending_input(
    connection: &Connection,
    pending_input_id: &str,
) -> Result<PendingInputSnapshot, String> {
    connection
        .query_row(
            r#"SELECT id, run_id, runtime_generation, request_id, thread_id,
                turn_id, item_id, kind, safe_summary_json, opened_at,
                resolved_at, invalidated_at
             FROM pending_inputs WHERE id = ?1"#,
            [pending_input_id],
            pending_input_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not load Xiao pending input: {error}"))?
        .ok_or("The Xiao pending input was not found.".to_owned())?
        .decode()
}

struct StoredPendingInputRow {
    id: String,
    run_id: String,
    runtime_generation: i64,
    request_id: String,
    thread_id: String,
    turn_id: String,
    item_id: String,
    kind: String,
    safe_summary_json: String,
    opened_at: i64,
    resolved_at: Option<i64>,
    invalidated_at: Option<i64>,
}

impl StoredPendingInputRow {
    fn decode(self) -> Result<PendingInputSnapshot, String> {
        Ok(PendingInputSnapshot {
            id: self.id,
            run_id: self.run_id,
            runtime_generation: u64::try_from(self.runtime_generation)
                .map_err(|_| "The pending input runtime generation is invalid.".to_owned())?,
            request_id: self.request_id,
            thread_id: self.thread_id,
            turn_id: self.turn_id,
            item_id: self.item_id,
            kind: PendingInputKind::from_database(&self.kind)?,
            safe_summary: parse_json(&self.safe_summary_json, "pending input summary")?,
            opened_at: self.opened_at,
            resolved_at: self.resolved_at,
            invalidated_at: self.invalidated_at,
        })
    }
}

fn pending_input_from_row(row: &Row<'_>) -> rusqlite::Result<StoredPendingInputRow> {
    Ok(StoredPendingInputRow {
        id: row.get(0)?,
        run_id: row.get(1)?,
        runtime_generation: row.get(2)?,
        request_id: row.get(3)?,
        thread_id: row.get(4)?,
        turn_id: row.get(5)?,
        item_id: row.get(6)?,
        kind: row.get(7)?,
        safe_summary_json: row.get(8)?,
        opened_at: row.get(9)?,
        resolved_at: row.get(10)?,
        invalidated_at: row.get(11)?,
    })
}

fn generation_to_i64(generation: u64) -> Result<i64, String> {
    i64::try_from(generation).map_err(|_| "The runtime generation is too large.".to_owned())
}

fn json_string<T: serde::Serialize>(value: &T, label: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("Could not serialize {label}: {error}"))
}

fn optional_json_string<T: serde::Serialize>(
    value: Option<&T>,
    label: &str,
) -> Result<Option<String>, String> {
    value.map(|value| json_string(value, label)).transpose()
}

fn parse_json<T: serde::de::DeserializeOwned>(value: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|error| format!("Could not deserialize {label}: {error}"))
}

fn parse_optional_json<T: serde::de::DeserializeOwned>(
    value: Option<&str>,
    label: &str,
) -> Result<Option<T>, String> {
    value.map(|value| parse_json(value, label)).transpose()
}

pub(crate) fn new_uuid_v7() -> String {
    Uuid::now_v7().to_string()
}

pub(crate) fn now_millis() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|_| "Current timestamp is too large.".to_owned())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::agent::models::XiaoHistoryItem;
    use crate::verification::models::{
        AcceptanceContractDraft, AcceptanceGate, ArtifactRecord, ArtifactRetentionClass,
        EvidenceRecord, EvidenceRedactionState, GateResultRecord, VerificationAttemptStatus,
        VerificationAttemptTrigger, VerificationBaselineState, VerificationGateOutcome,
    };
    use crate::xiao::models::{
        XiaoTaskDocument, XiaoWorkspaceDocument, XiaoWorkspaceMode, XiaoWorkspaceUpdate,
        XIAO_SCHEMA_VERSION,
    };

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "xiao-m3-{label}-{}-{}",
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

    fn task(id: &str) -> XiaoTaskDocument {
        XiaoTaskDocument {
            id: id.to_owned(),
            title: id.to_owned(),
            created_at: 1,
            updated_at: 1,
            stage: crate::xiao::models::TaskStage::Draft,
            stage_version: 0,
            codex_profile_id: None,
            workbench_state: serde_json::json!({}),
            draft_text: String::new(),
            follow_ups: Vec::new(),
            archived: false,
            pinned: false,
            unread: false,
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

    fn repository_with_tasks(directory: &Path, task_ids: &[&str]) -> XiaoRepository {
        let repository = XiaoRepository::open(directory).unwrap();
        let workspace = directory.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let tasks = task_ids.iter().map(|id| task(id)).collect::<Vec<_>>();
        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: workspace.to_string_lossy().into_owned(),
                active_task_id: task_ids.first().map(|id| (*id).to_owned()),
                show_archived: false,
                task_ids: task_ids.iter().map(|id| (*id).to_owned()).collect(),
                tasks,
            })
            .unwrap();
        repository
    }

    fn workspace_path(directory: &Path) -> String {
        normalize_workspace_path(&directory.join("workspace").to_string_lossy())
    }

    fn isolated_execution_root(directory: &Path, label: &str) -> String {
        let root = directory.join(label);
        fs::create_dir_all(&root).unwrap();
        normalize_workspace_path(&root.to_string_lossy())
    }

    fn new_run(repository: &XiaoRepository, workspace: &str, task_id: &str, key: &str) -> NewRun {
        let defaults = repository.run_task_defaults(workspace, task_id).unwrap();
        let binding = repository
            .task_execution_binding(workspace, task_id)
            .unwrap();
        NewRun {
            id: new_uuid_v7(),
            workspace_id: defaults.workspace_id,
            task_id: task_id.to_owned(),
            idempotency_key: key.to_owned(),
            parent_run_id: None,
            candidate_group_id: None,
            routine_occurrence_id: None,
            execution_environment_id: binding.environment.id,
            execution_root: workspace.to_owned(),
            managed_worktree_id: None,
            prompt: format!("prompt {task_id}"),
            input: vec![json!({ "type": "text", "text": task_id })],
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
            queued_at: now_millis().unwrap(),
        }
    }

    fn verifying_run_with_gates(
        repository: &XiaoRepository,
        workspace: &str,
        task_id: &str,
        key: &str,
        gates: Vec<AcceptanceGate>,
    ) -> RunRecord {
        verifying_run_with_gates_at_root(repository, workspace, task_id, key, workspace, gates)
    }

    fn verifying_run_with_gates_at_root(
        repository: &XiaoRepository,
        workspace: &str,
        task_id: &str,
        key: &str,
        execution_root: &str,
        gates: Vec<AcceptanceGate>,
    ) -> RunRecord {
        repository
            .save_task_acceptance_contract(
                workspace,
                task_id,
                None,
                Some(&AcceptanceContractDraft {
                    name: "Verification lifecycle".to_owned(),
                    gates,
                }),
            )
            .unwrap();
        let mut input = new_run(repository, workspace, task_id, key);
        input.execution_root = execution_root.to_owned();
        let run = repository.enqueue_run(input).unwrap().run;
        let thread_id = format!("verification-thread-{}", run.id);
        let turn_id = format!("verification-turn-{}", run.id);
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 1,
                    thread_id: thread_id.clone(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "test".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 1, &thread_id, &turn_id)
            .unwrap();
        repository
            .settle_runtime_turn(
                &run.id,
                1,
                &thread_id,
                &turn_id,
                RunStatus::Completed,
                &json!({ "protocol": { "method": "turn/completed" } }),
            )
            .unwrap()
            .run
    }

    fn persist_gate_outcome(
        repository: &XiaoRepository,
        run_id: &str,
        attempt_id: &str,
        gate_index: usize,
        gate: &AcceptanceGate,
        outcome: VerificationGateOutcome,
    ) {
        let gate_result_id = new_uuid_v7();
        let artifact_id = new_uuid_v7();
        let artifact = ArtifactRecord {
            id: artifact_id.clone(),
            run_id: run_id.to_owned(),
            verification_attempt_id: Some(attempt_id.to_owned()),
            relative_storage_path: format!(
                "runs/{run_id}/attempts/{attempt_id}/{artifact_id}.json"
            ),
            media_type: "application/vnd.xiao.verification-gate+json".to_owned(),
            byte_length: 2,
            sha256: "a".repeat(64),
            retention_class: ArtifactRetentionClass::RunEvidence,
            created_at: 2,
        };
        let gate_result = GateResultRecord {
            id: gate_result_id.clone(),
            verification_attempt_id: attempt_id.to_owned(),
            gate_index,
            gate_type: gate.gate_type(),
            outcome,
            duration_ms: 1,
            exit_code: None,
            diagnostic: None,
            started_at: 1,
            finished_at: 2,
        };
        let evidence = EvidenceRecord {
            id: new_uuid_v7(),
            run_id: run_id.to_owned(),
            verification_attempt_id: Some(attempt_id.to_owned()),
            gate_result_id: Some(gate_result_id),
            evidence_type: gate.gate_type().as_database().to_owned(),
            summary: json!({ "outcome": outcome }),
            artifact_id: Some(artifact_id),
            redaction_state: EvidenceRedactionState::Safe,
            created_at: 2,
        };
        repository
            .persist_verification_gate(&gate_result, &artifact, &evidence)
            .unwrap();
    }

    fn failed_verification_run_at_root(
        repository: &XiaoRepository,
        workspace: &str,
        task_id: &str,
        key: &str,
        execution_root: &str,
    ) -> RunRecord {
        let gate = AcceptanceGate::Cleanliness {
            allow_staged: true,
            allow_unstaged: true,
            allow_untracked: true,
        };
        let verifying = verifying_run_with_gates_at_root(
            repository,
            workspace,
            task_id,
            key,
            execution_root,
            vec![gate.clone()],
        );
        let initial = repository
            .begin_verification_attempt(
                &verifying.id,
                "overlap-initial",
                VerificationAttemptTrigger::Initial,
            )
            .unwrap();
        persist_gate_outcome(
            repository,
            &verifying.id,
            &initial.attempt.id,
            0,
            &gate,
            VerificationGateOutcome::Failed,
        );
        repository
            .settle_verification_attempt(&initial.attempt.id)
            .unwrap()
            .mutation
            .run
    }

    #[test]
    fn active_run_guard_includes_queued_work() {
        let directory = TestDirectory::new("active-run-guard");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);

        assert!(!repository.has_active_runs().unwrap());
        repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "queued"))
            .unwrap();
        assert!(repository.has_active_runs().unwrap());
    }

    #[test]
    fn runtime_generation_is_durable_and_monotonic_per_environment() {
        let directory = TestDirectory::new("runtime-generation");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let environment_id = repository
            .task_execution_binding(&workspace, "task-a")
            .unwrap()
            .environment
            .id;
        assert_eq!(
            repository
                .allocate_runtime_generation(&environment_id)
                .unwrap(),
            1
        );
        assert_eq!(
            repository
                .allocate_runtime_generation(&environment_id)
                .unwrap(),
            2
        );
        drop(repository);

        let reopened = XiaoRepository::open(&directory.0).unwrap();
        assert_eq!(
            reopened
                .allocate_runtime_generation(&environment_id)
                .unwrap(),
            3
        );
    }

    #[test]
    fn duplicate_enqueue_returns_one_run_and_event() {
        let directory = TestDirectory::new("idempotency");
        let repository = repository_with_tasks(&directory.0, &["task-a", "task-b"]);
        let workspace = workspace_path(&directory.0);
        let run = new_run(&repository, &workspace, "task-a", "same-key");
        let first = repository.enqueue_run(run.clone()).unwrap();
        let second = repository.enqueue_run(run).unwrap();
        assert!(repository
            .enqueue_run(new_run(&repository, &workspace, "task-b", "same-key"))
            .is_err());

        assert_eq!(first.run.id, second.run.id);
        assert!(first.event.is_some());
        assert!(second.event.is_none());
        assert_eq!(
            repository
                .list_run_events(&first.run.id, None, None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn run_lifecycle_starts_a_task_but_terminal_status_never_completes_it() {
        let directory = TestDirectory::new("run-task-stage");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let stage = || {
            repository
                .with_connection(|connection| {
                    connection
                        .query_row(
                            "SELECT task_stage FROM tasks WHERE task_id = 'task-a'",
                            [],
                            |row| row.get::<_, String>(0),
                        )
                        .map_err(|error| error.to_string())
                })
                .unwrap()
        };
        assert_eq!(stage(), "draft");

        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "first-run"))
            .unwrap()
            .run;
        assert_eq!(stage(), "in_progress");

        repository.request_run_cancel(&run.id).unwrap();
        assert_eq!(
            repository.get_run(&run.id).unwrap().status,
            RunStatus::Cancelled
        );
        assert_eq!(stage(), "in_progress");
    }

    #[test]
    fn run_contract_snapshot_round_trips_with_hash_and_safe_verification_metadata() {
        let directory = TestDirectory::new("contract-snapshot");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let draft = AcceptanceContractDraft {
            name: "Verify".to_owned(),
            gates: vec![AcceptanceGate::Cleanliness {
                allow_staged: false,
                allow_unstaged: false,
                allow_untracked: false,
            }],
        };
        let normalized = draft.normalize().unwrap();
        let saved = repository
            .save_task_acceptance_contract(&workspace, "task-a", None, Some(&draft))
            .unwrap()
            .unwrap();

        let stored = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "contract-run"))
            .unwrap()
            .run;
        assert_eq!(
            stored.acceptance_contract_source_version_id.as_deref(),
            Some(saved.version_id.as_str())
        );
        assert_eq!(
            stored.acceptance_contract_snapshot.as_ref(),
            Some(&normalized.snapshot)
        );
        assert_eq!(
            stored.acceptance_contract_snapshot_sha256.as_deref(),
            Some(normalized.content_sha256.as_str())
        );
        assert_eq!(
            stored.verification_baseline_state,
            VerificationBaselineState::NotRequired
        );
        assert_eq!(stored.verification_outcome, VerificationOutcome::Pending);
        assert_eq!(stored.latest_verification_attempt_id, None);
        let snapshot = stored.snapshot();
        assert_eq!(
            snapshot.acceptance_contract_source_version_id.as_deref(),
            Some(saved.version_id.as_str())
        );
        assert_eq!(
            snapshot.acceptance_contract_snapshot,
            Some(normalized.snapshot.clone())
        );
        assert_eq!(snapshot.verification_baseline_artifact_id, None);

        let changed = AcceptanceContractDraft {
            name: "Verify changed".to_owned(),
            gates: draft.gates.clone(),
        };
        let changed = repository
            .save_task_acceptance_contract(
                &workspace,
                "task-a",
                Some(&saved.version_id),
                Some(&changed),
            )
            .unwrap()
            .unwrap();
        assert_ne!(changed.version_id, saved.version_id);
        let reloaded = repository.get_run(&stored.id).unwrap();
        assert_eq!(
            reloaded.acceptance_contract_source_version_id,
            stored.acceptance_contract_source_version_id
        );
        assert_eq!(
            reloaded.acceptance_contract_snapshot,
            stored.acceptance_contract_snapshot
        );
        assert_eq!(
            reloaded.acceptance_contract_snapshot_sha256,
            stored.acceptance_contract_snapshot_sha256
        );
    }

    #[test]
    fn run_freezes_profile_capabilities_policy_and_workspace() {
        let directory = TestDirectory::new("run-profile-snapshot");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let save_default = |expected_version, steering| {
            repository
                .save_codex_profile(crate::xiao::models::CodexProfileUpdate {
                    id: "default".to_owned(),
                    display_name: "Default Codex".to_owned(),
                    codex_home: None,
                    authentication_home: None,
                    environment: json!({}),
                    availability: "available".to_owned(),
                    authenticated_identity: Some(json!({"email": "operator@example.com"})),
                    models: json!(["gpt-test"]),
                    capabilities: json!({"steering": steering}),
                    usage: None,
                    rate_limits: None,
                    diagnostic: None,
                    expected_version: Some(expected_version),
                })
                .unwrap()
        };
        save_default(0, true);

        let run = new_run(&repository, &workspace, "task-a", "profile-run");
        let run_id = run.id.clone();
        let expected_root = run.execution_root.clone();
        repository.enqueue_run(run).unwrap();
        save_default(1, false);

        let (profile_id, capabilities, policy, workspace_snapshot) = repository
            .with_connection(|connection| {
                connection
                    .query_row(
                        r#"SELECT codex_profile_id, capability_snapshot_json,
                                  policy_snapshot_json, workspace_snapshot_json
                           FROM runs WHERE id = ?1"#,
                        [&run_id],
                        |row| {
                            Ok((
                                row.get::<_, Option<String>>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                            ))
                        },
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(profile_id.as_deref(), Some("default"));
        assert_eq!(
            serde_json::from_str::<Value>(&capabilities).unwrap()["steering"],
            true
        );
        let policy = serde_json::from_str::<Value>(&policy).unwrap();
        assert_eq!(policy["approvalPolicy"], "on-request");
        assert_eq!(policy["sandboxMode"], "workspace-write");
        assert_eq!(
            serde_json::from_str::<Value>(&workspace_snapshot).unwrap()["executionRoot"],
            expected_root
        );
    }

    #[test]
    fn enqueue_rejects_unavailable_or_incompatible_task_profile() {
        let directory = TestDirectory::new("run-profile-availability");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let save_default = |expected_version, availability: &str| {
            repository
                .save_codex_profile(crate::xiao::models::CodexProfileUpdate {
                    id: "default".to_owned(),
                    display_name: "Default Codex".to_owned(),
                    codex_home: None,
                    authentication_home: None,
                    environment: json!({}),
                    availability: availability.to_owned(),
                    authenticated_identity: None,
                    models: json!(["gpt-test"]),
                    capabilities: json!({}),
                    usage: None,
                    rate_limits: None,
                    diagnostic: Some(format!("profile is {availability}")),
                    expected_version: Some(expected_version),
                })
                .unwrap();
        };

        save_default(0, "unavailable");
        let unavailable = repository
            .enqueue_run(new_run(
                &repository,
                &workspace,
                "task-a",
                "unavailable-profile",
            ))
            .unwrap_err();
        assert_eq!(unavailable, "profile is unavailable");

        save_default(1, "incompatible");
        let incompatible = repository
            .enqueue_run(new_run(
                &repository,
                &workspace,
                "task-a",
                "incompatible-profile",
            ))
            .unwrap_err();
        assert_eq!(incompatible, "profile is incompatible");
        assert!(repository
            .list_runs(&workspace, None, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn enqueue_derives_verification_state_from_native_task_contract() {
        let directory = TestDirectory::new("contract-state");
        let repository = repository_with_tasks(&directory.0, &["plain", "diff"]);
        let workspace = workspace_path(&directory.0);

        let plain = repository
            .enqueue_run(new_run(
                &repository,
                &workspace,
                "plain",
                "plain-contract-state",
            ))
            .unwrap()
            .run;
        assert_eq!(
            plain.verification_outcome,
            VerificationOutcome::NotRequested
        );
        assert_eq!(
            plain.verification_baseline_state,
            VerificationBaselineState::NotRequired
        );
        assert_eq!(plain.acceptance_contract_source_version_id, None);
        assert_eq!(plain.acceptance_contract_snapshot, None);

        let draft = AcceptanceContractDraft {
            name: "Diff scope".to_owned(),
            gates: vec![AcceptanceGate::DiffScope {
                allowed_patterns: vec!["src/**".to_owned()],
                denied_patterns: Vec::new(),
            }],
        };
        let saved = repository
            .save_task_acceptance_contract(&workspace, "diff", None, Some(&draft))
            .unwrap()
            .unwrap();
        let diff = repository
            .enqueue_run(new_run(
                &repository,
                &workspace,
                "diff",
                "diff-contract-state",
            ))
            .unwrap()
            .run;
        assert_eq!(diff.verification_outcome, VerificationOutcome::Pending);
        assert_eq!(
            diff.verification_baseline_state,
            VerificationBaselineState::Pending
        );
        assert_eq!(
            diff.acceptance_contract_source_version_id.as_deref(),
            Some(saved.version_id.as_str())
        );
    }

    #[test]
    fn run_listing_keeps_all_nonterminal_runs_beyond_the_history_limit() {
        let directory = TestDirectory::new("run-list-active");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let enqueue = |key: &str, queued_at: i64| {
            let mut run = new_run(&repository, &workspace, "task-a", key);
            run.queued_at = queued_at;
            repository.enqueue_run(run).unwrap().run
        };
        let first = enqueue("active-a", 1);
        let second = enqueue("active-b", 2);
        let older_terminal = enqueue("terminal-old", 3);
        let newest_terminal = enqueue("terminal-new", 4);
        repository.request_run_cancel(&older_terminal.id).unwrap();
        repository.request_run_cancel(&newest_terminal.id).unwrap();

        for task_id in [None, Some("task-a")] {
            let listed = repository.list_runs(&workspace, task_id, Some(1)).unwrap();
            let ids = listed.iter().map(|run| run.id.as_str()).collect::<Vec<_>>();
            assert_eq!(listed.len(), 3);
            assert!(ids.contains(&first.id.as_str()));
            assert!(ids.contains(&second.id.as_str()));
            assert!(ids.contains(&newest_terminal.id.as_str()));
            assert!(!ids.contains(&older_terminal.id.as_str()));
        }
    }

    #[test]
    fn lifecycle_and_pending_input_are_atomic() {
        let directory = TestDirectory::new("lifecycle");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let queued = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "lifecycle"))
            .unwrap()
            .run;
        let preparing = repository.claim_next_eligible_run(2).unwrap().unwrap().run;
        assert_eq!(preparing.status, RunStatus::Preparing);
        let attachment = RuntimeAttachment {
            generation: 1,
            thread_id: "thread-a".to_owned(),
            thread_source: "xiao-workbench".to_owned(),
            cli_version: "codex-test".to_owned(),
            materialized: false,
        };
        repository
            .attach_run_runtime(&queued.id, &attachment)
            .unwrap();
        let running = repository
            .mark_run_running(&queued.id, 1, "thread-a", "turn-a")
            .unwrap()
            .run;
        assert_eq!(running.status, RunStatus::Running);

        let (waiting, pending) = repository
            .open_pending_input(NewPendingInput {
                run_id: queued.id.clone(),
                runtime_generation: 1,
                request_id: "7".to_owned(),
                thread_id: "thread-a".to_owned(),
                turn_id: "turn-a".to_owned(),
                item_id: "item-a".to_owned(),
                kind: PendingInputKind::Question,
                safe_summary: json!({ "question": "Continue?" }),
            })
            .unwrap();
        assert_eq!(waiting.run.status, RunStatus::WaitingForInput);
        let (resumed, resolved) = repository.resolve_pending_input(&pending.id).unwrap();
        assert_eq!(resumed.run.status, RunStatus::Running);
        assert!(resolved.resolved_at.is_some());

        let completed = repository
            .transition_run(
                &queued.id,
                RunStatus::Completed,
                "run.completed",
                Some("1/thread-a/turn-a/completed"),
                &json!({}),
            )
            .unwrap();
        assert_eq!(completed.run.status, RunStatus::Completed);
        assert_eq!(completed.run.agent_outcome, AgentOutcome::Completed);
        assert!(repository
            .transition_run(&queued.id, RunStatus::Running, "invalid", None, &json!({}))
            .is_err());
    }

    #[test]
    fn late_started_event_cannot_bind_a_reused_thread_to_a_new_run() {
        let directory = TestDirectory::new("late-turn-started");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let first = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "first"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        let first_attachment = RuntimeAttachment {
            generation: 1,
            thread_id: "thread-a".to_owned(),
            thread_source: "xiao-workbench".to_owned(),
            cli_version: "codex-test".to_owned(),
            materialized: false,
        };
        repository
            .attach_run_runtime(&first.id, &first_attachment)
            .unwrap();
        repository
            .mark_run_running(&first.id, 1, "thread-a", "turn-old")
            .unwrap();
        repository
            .transition_run(
                &first.id,
                RunStatus::Completed,
                "run.completed",
                Some("1/thread-a/turn-old/completed"),
                &json!({}),
            )
            .unwrap();

        let second = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "second"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &second.id,
                &RuntimeAttachment {
                    materialized: true,
                    ..first_attachment
                },
            )
            .unwrap();

        assert!(repository
            .mark_run_running(&second.id, 1, "thread-a", "turn-old")
            .is_err());
        let unchanged = repository.get_run(&second.id).unwrap();
        assert_eq!(unchanged.status, RunStatus::Preparing);
        assert!(unchanged.turn_id.is_none());
    }

    #[test]
    fn active_goal_rebinds_the_same_run_to_automatic_continuation_turns() {
        let directory = TestDirectory::new("goal-continuation");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let mut input = new_run(&repository, &workspace, "task-a", "goal");
        input.goal = Some(json!({
            "objective": "Finish the goal",
            "status": "active",
        }));
        let run = repository.enqueue_run(input).unwrap().run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 3,
                    thread_id: "thread-goal".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "codex-test".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 3, "thread-goal", "turn-1")
            .unwrap();

        let continued = repository
            .mark_run_running(&run.id, 3, "thread-goal", "turn-2")
            .unwrap();
        assert_eq!(continued.run.status, RunStatus::Running);
        assert_eq!(continued.run.turn_id.as_deref(), Some("turn-2"));
        assert_eq!(continued.event.unwrap().event_type, "run.goal_continued");

        repository
            .update_runtime_goal(
                &run.id,
                Some(&json!({
                    "objective": "Finish the goal",
                    "status": "paused",
                })),
                "agent.thread/goal/updated",
            )
            .unwrap();
        assert!(repository
            .mark_run_running(&run.id, 3, "thread-goal", "turn-3")
            .is_err());
    }

    #[test]
    fn idle_goal_turn_is_adopted_as_a_running_xiao_run() {
        let directory = TestDirectory::new("goal-adoption");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let mut first_input = new_run(&repository, &workspace, "task-a", "first");
        first_input.goal = Some(json!({
            "objective": "Finish the goal",
            "status": "active",
        }));
        let first = repository.enqueue_run(first_input).unwrap().run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        let attachment = RuntimeAttachment {
            generation: 4,
            thread_id: "thread-goal".to_owned(),
            thread_source: "xiao-workbench".to_owned(),
            cli_version: "codex-test".to_owned(),
            materialized: true,
        };
        repository
            .attach_run_runtime(&first.id, &attachment)
            .unwrap();
        repository
            .mark_run_running(&first.id, 4, "thread-goal", "turn-1")
            .unwrap();
        repository
            .transition_run(
                &first.id,
                RunStatus::Completed,
                "run.completed",
                Some("4/thread-goal/turn-1/completed"),
                &json!({}),
            )
            .unwrap();

        let mut adopted_input = new_run(&repository, &workspace, "task-a", "goal-adopted");
        adopted_input.parent_run_id = Some(first.id.clone());
        adopted_input.goal = Some(json!({
            "objective": "Finish the goal",
            "status": "active",
        }));
        let adopted = repository
            .adopt_runtime_goal_turn(adopted_input, &attachment, "turn-2")
            .unwrap();

        assert_eq!(adopted.run.status, RunStatus::Running);
        assert_eq!(
            adopted.run.parent_run_id.as_deref(),
            Some(first.id.as_str())
        );
        assert_eq!(adopted.run.turn_id.as_deref(), Some("turn-2"));
        assert_eq!(
            repository
                .find_active_run_route(&first.execution_environment_id, 4, "thread-goal")
                .unwrap()
                .unwrap()
                .id,
            adopted.run.id
        );
    }

    #[test]
    fn queued_runs_own_task_bindings_without_consuming_claim_capacity() {
        let directory = TestDirectory::new("queued-binding-owner");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let queued = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "local-owner"))
            .unwrap()
            .run;

        assert!(repository
            .task_has_run_owners(&workspace, "task-a")
            .unwrap());
        let binding = repository
            .task_execution_binding(&workspace, "task-a")
            .unwrap();
        let worktree_id = new_uuid_v7();
        let record = crate::execution::models::NewManagedWorktreeRecord {
            id: worktree_id.clone(),
            workspace_id: binding.workspace_id,
            task_id: "task-a".to_owned(),
            repository_root: workspace.clone(),
            repository_common_dir_sha256: "common".to_owned(),
            checkout_path: isolated_execution_root(&directory.0, "checkout"),
            execution_root: isolated_execution_root(&directory.0, "execution"),
            branch: "xiao/task-a".to_owned(),
            base_commit: "base".to_owned(),
            owner_marker_path: isolated_execution_root(&directory.0, "marker"),
            created_at: now_millis().unwrap(),
        };
        let blocked = repository
            .begin_managed_worktree(record.clone())
            .unwrap_err();
        assert!(blocked.contains("queued or active"));
        assert_eq!(
            repository
                .claim_next_eligible_run(1)
                .unwrap()
                .unwrap()
                .run
                .id,
            queued.id
        );
        repository.request_run_cancel(&queued.id).unwrap();
        assert!(!repository
            .task_has_run_owners(&workspace, "task-a")
            .unwrap());

        repository.begin_managed_worktree(record).unwrap();
        let local_snapshot = repository
            .enqueue_run(new_run(
                &repository,
                &workspace,
                "task-a",
                "activation-owner",
            ))
            .unwrap()
            .run;
        let blocked = repository
            .activate_managed_worktree(
                &worktree_id,
                &isolated_execution_root(&directory.0, "checkout"),
                &isolated_execution_root(&directory.0, "execution"),
                &isolated_execution_root(&directory.0, "marker"),
            )
            .unwrap_err();
        assert!(blocked.contains("queued or active"));
        let unchanged = repository
            .task_execution_binding(&workspace, "task-a")
            .unwrap();
        assert_eq!(unchanged.workspace_mode, XiaoWorkspaceMode::Local);
        assert_eq!(local_snapshot.execution_root, workspace);
        assert!(local_snapshot.managed_worktree_id.is_none());
        repository.request_run_cancel(&local_snapshot.id).unwrap();

        let checkout = isolated_execution_root(&directory.0, "checkout");
        let execution = isolated_execution_root(&directory.0, "execution");
        let marker = isolated_execution_root(&directory.0, "marker");
        repository
            .activate_managed_worktree(&worktree_id, &checkout, &execution, &marker)
            .unwrap();
        let mut managed_input = new_run(&repository, &workspace, "task-a", "removal-owner");
        managed_input.execution_root = execution.clone();
        managed_input.managed_worktree_id = Some(worktree_id.clone());
        let managed_snapshot = repository.enqueue_run(managed_input).unwrap().run;
        let blocked = repository
            .begin_managed_worktree_removal(&workspace, "task-a", &worktree_id)
            .unwrap_err();
        assert!(blocked.contains("queued or active"));
        assert_eq!(managed_snapshot.execution_root, execution);
        assert_eq!(
            managed_snapshot.managed_worktree_id.as_deref(),
            Some(worktree_id.as_str())
        );
        assert_eq!(
            repository
                .claim_next_eligible_run(1)
                .unwrap()
                .unwrap()
                .run
                .id,
            managed_snapshot.id
        );
        repository
            .transition_run(
                &managed_snapshot.id,
                RunStatus::Interrupted,
                "run.interrupted",
                Some("test:managed-settled"),
                &json!({}),
            )
            .unwrap();

        repository
            .begin_managed_worktree_removal(&workspace, "task-a", &worktree_id)
            .unwrap();
        let retry_error = repository
            .retry_run(&managed_snapshot.id, "stale-managed-retry")
            .unwrap_err();
        assert!(retry_error.contains("binding is no longer available"));
        repository
            .finish_managed_worktree_removal(&worktree_id)
            .unwrap();
        let restored = repository
            .task_execution_binding(&workspace, "task-a")
            .unwrap();
        assert_eq!(restored.workspace_mode, XiaoWorkspaceMode::Local);
        assert!(restored.managed_worktree.is_none());
    }

    #[test]
    fn queue_is_fifo_and_serial_per_execution_root() {
        let directory = TestDirectory::new("queue");
        let repository = repository_with_tasks(&directory.0, &["task-a", "task-b", "task-c"]);
        let workspace = workspace_path(&directory.0);
        let first = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "a-1"))
            .unwrap()
            .run;
        let mut second_a = new_run(&repository, &workspace, "task-a", "a-2");
        second_a.queued_at += 1;
        repository.enqueue_run(second_a).unwrap();
        let mut second = new_run(&repository, &workspace, "task-b", "b-1");
        second.queued_at += 2;
        repository.enqueue_run(second).unwrap();
        let mut third = new_run(&repository, &workspace, "task-c", "c-1");
        third.queued_at += 3;
        repository.enqueue_run(third).unwrap();

        assert_eq!(
            repository
                .claim_next_eligible_run(2)
                .unwrap()
                .unwrap()
                .run
                .id,
            first.id
        );
        assert!(repository.claim_next_eligible_run(2).unwrap().is_none());
    }

    #[test]
    fn queue_serializes_different_profiles_in_one_execution_environment() {
        let directory = TestDirectory::new("queue-environment-profiles");
        let repository = repository_with_tasks(&directory.0, &["task-a", "task-b"]);
        let workspace = workspace_path(&directory.0);
        for profile_id in ["profile-a", "profile-b"] {
            repository
                .save_codex_profile(crate::xiao::models::CodexProfileUpdate {
                    id: profile_id.to_owned(),
                    display_name: profile_id.to_owned(),
                    codex_home: None,
                    authentication_home: None,
                    environment: json!({}),
                    availability: "available".to_owned(),
                    authenticated_identity: None,
                    models: json!(["gpt-test"]),
                    capabilities: json!({}),
                    usage: None,
                    rate_limits: None,
                    diagnostic: None,
                    expected_version: None,
                })
                .unwrap();
        }
        repository
            .bind_task_codex_profile(&workspace, "task-a", "profile-a", 0, false)
            .unwrap();
        repository
            .bind_task_codex_profile(&workspace, "task-b", "profile-b", 0, false)
            .unwrap();

        let mut first_input = new_run(&repository, &workspace, "task-a", "profile-a-run");
        first_input.execution_root = isolated_execution_root(&directory.0, "root-a");
        first_input.queued_at = 1;
        let first = repository.enqueue_run(first_input).unwrap().run;
        let mut second_input = new_run(&repository, &workspace, "task-b", "profile-b-run");
        second_input.execution_root = isolated_execution_root(&directory.0, "root-b");
        second_input.queued_at = 2;
        repository.enqueue_run(second_input).unwrap();

        assert_eq!(
            repository
                .claim_next_eligible_run(2)
                .unwrap()
                .unwrap()
                .run
                .id,
            first.id
        );
        assert!(repository.claim_next_eligible_run(2).unwrap().is_none());
    }

    #[test]
    fn execution_root_overlap_is_component_and_host_case_aware() {
        assert!(execution_roots_overlap("C:/repo", "C:/repo/sub"));
        assert!(execution_roots_overlap("C:/repo/sub", "C:/repo"));
        assert!(!execution_roots_overlap("C:/repo", "C:/repo2"));

        #[cfg(windows)]
        assert!(execution_roots_overlap("C:/Repo", "c:/repo/sub"));
        #[cfg(not(windows))]
        assert!(!execution_roots_overlap("/repo", "/Repo/sub"));
    }

    #[test]
    fn queue_serializes_ancestor_roots_and_skips_to_the_first_fifo_sibling() {
        for child_is_active in [false, true] {
            let label = if child_is_active {
                "queue-child-active"
            } else {
                "queue-parent-active"
            };
            let directory = TestDirectory::new(label);
            let repository =
                repository_with_tasks(&directory.0, &["task-a", "task-b", "task-c", "task-d"]);
            let workspace = workspace_path(&directory.0);
            let parent_root = isolated_execution_root(&directory.0, "repo");
            let child_root = isolated_execution_root(&directory.0, "repo/sub");
            let sibling_root = isolated_execution_root(&directory.0, "repo2");
            let (active_root, blocked_root) = if child_is_active {
                (&child_root, &parent_root)
            } else {
                (&parent_root, &child_root)
            };

            let mut active_input = new_run(&repository, &workspace, "task-a", "active");
            active_input.execution_root = active_root.clone();
            active_input.queued_at = 1;
            let active = repository.enqueue_run(active_input).unwrap().run;

            let mut blocked_input = new_run(&repository, &workspace, "task-b", "blocked");
            blocked_input.execution_root = blocked_root.clone();
            blocked_input.queued_at = 2;
            let blocked = repository.enqueue_run(blocked_input).unwrap().run;

            let mut exact_input = new_run(&repository, &workspace, "task-c", "exact");
            exact_input.execution_root = active_root.clone();
            exact_input.queued_at = 3;
            let exact = repository.enqueue_run(exact_input).unwrap().run;

            let mut sibling_input = new_run(&repository, &workspace, "task-d", "sibling");
            sibling_input.execution_root = sibling_root.clone();
            sibling_input.queued_at = 4;
            let sibling = repository.enqueue_run(sibling_input).unwrap().run;

            assert_eq!(
                repository
                    .claim_next_eligible_run(2)
                    .unwrap()
                    .unwrap()
                    .run
                    .id,
                active.id
            );
            assert_eq!(
                repository
                    .claim_next_eligible_run(2)
                    .unwrap()
                    .unwrap()
                    .run
                    .id,
                sibling.id
            );
            assert_eq!(
                repository.get_run(&blocked.id).unwrap().status,
                RunStatus::Queued
            );
            assert_eq!(
                repository.get_run(&exact.id).unwrap().status,
                RunStatus::Queued
            );
            assert!(repository.claim_next_eligible_run(2).unwrap().is_none());
        }
    }

    #[test]
    fn fake_runtime_interleaving_respects_slots_waiting_input_and_routes() {
        let directory = TestDirectory::new("fake-runtime");
        let repository = repository_with_tasks(&directory.0, &["task-a", "task-b", "task-c"]);
        let workspace = workspace_path(&directory.0);
        let run_a = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "fake-a"))
            .unwrap()
            .run;
        let mut run_b_input = new_run(&repository, &workspace, "task-b", "fake-b");
        run_b_input.execution_root = isolated_execution_root(&directory.0, "root-b");
        run_b_input.queued_at += 1;
        let run_b = repository.enqueue_run(run_b_input).unwrap().run;
        let mut run_c_input = new_run(&repository, &workspace, "task-c", "fake-c");
        run_c_input.queued_at += 2;
        run_c_input.execution_root = isolated_execution_root(&directory.0, "root-c");
        let run_c = repository.enqueue_run(run_c_input).unwrap().run;

        assert_eq!(
            repository
                .claim_next_eligible_run(2)
                .unwrap()
                .unwrap()
                .run
                .id,
            run_a.id
        );
        assert_eq!(
            repository
                .claim_next_eligible_run(2)
                .unwrap()
                .unwrap()
                .run
                .id,
            run_b.id
        );
        for (run, thread, turn) in [
            (&run_a, "thread-a", "turn-a"),
            (&run_b, "thread-b", "turn-b"),
        ] {
            repository
                .attach_run_runtime(
                    &run.id,
                    &RuntimeAttachment {
                        generation: 7,
                        thread_id: thread.to_owned(),
                        thread_source: "xiao-workbench".to_owned(),
                        cli_version: "fake-codex".to_owned(),
                        materialized: true,
                    },
                )
                .unwrap();
            repository
                .mark_run_running(&run.id, 7, thread, turn)
                .unwrap();
        }

        let (waiting, pending) = repository
            .open_pending_input(NewPendingInput {
                run_id: run_a.id.clone(),
                runtime_generation: 7,
                request_id: "41".to_owned(),
                thread_id: "thread-a".to_owned(),
                turn_id: "turn-a".to_owned(),
                item_id: "approval-a".to_owned(),
                kind: PendingInputKind::CommandApproval,
                safe_summary: json!({ "reason": "fake approval" }),
            })
            .unwrap();
        assert_eq!(waiting.run.status, RunStatus::WaitingForInput);
        assert!(repository.claim_next_eligible_run(2).unwrap().is_none());
        assert_eq!(
            repository
                .find_active_run_route(&run_a.execution_environment_id, 7, "thread-a")
                .unwrap()
                .unwrap()
                .id,
            run_a.id
        );
        assert!(repository
            .record_run_event(
                &run_a.id,
                CorrelatedRunEvent {
                    generation: 6,
                    thread_id: "thread-a",
                    turn_id: Some("turn-a"),
                    event_type: "agent.fake",
                    event_key: Some("stale"),
                    payload: &json!({}),
                },
            )
            .is_err());

        repository
            .transition_run(
                &run_b.id,
                RunStatus::Completed,
                "run.completed",
                Some("7/thread-b/turn-b/completed"),
                &json!({}),
            )
            .unwrap();
        assert_eq!(
            repository
                .claim_next_eligible_run(2)
                .unwrap()
                .unwrap()
                .run
                .id,
            run_c.id
        );
        repository.resolve_pending_input(&pending.id).unwrap();
        assert_eq!(
            repository.get_run(&run_a.id).unwrap().status,
            RunStatus::Running
        );
    }

    #[test]
    fn verifying_transition_is_reserved_but_valid() {
        let directory = TestDirectory::new("verifying");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "verify"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 1,
                    thread_id: "thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "fake".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 1, "thread", "turn")
            .unwrap();
        let verifying = repository
            .transition_run(
                &run.id,
                RunStatus::Verifying,
                "run.verifying",
                Some("verifying"),
                &json!({}),
            )
            .unwrap()
            .run;
        assert_eq!(verifying.status, RunStatus::Verifying);
        assert_eq!(verifying.verification_outcome, VerificationOutcome::Pending);
        assert_eq!(verifying.agent_outcome, AgentOutcome::Completed);
    }

    #[test]
    fn initial_event_page_returns_the_latest_bounded_window() {
        let directory = TestDirectory::new("event-page");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "events"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 1,
                    thread_id: "thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "fake".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 1, "thread", "turn")
            .unwrap();
        for index in 0..250 {
            repository
                .record_run_event(
                    &run.id,
                    CorrelatedRunEvent {
                        generation: 1,
                        thread_id: "thread",
                        turn_id: Some("turn"),
                        event_type: "agent.fake",
                        event_key: Some(&format!("fake-{index}")),
                        payload: &json!({ "index": index }),
                    },
                )
                .unwrap();
        }
        let page = repository
            .list_run_events(&run.id, None, Some(200))
            .unwrap();
        assert_eq!(page.len(), 200);
        assert_eq!(page.last().unwrap().safe_payload["index"], 249);
        assert!(page.first().unwrap().sequence > 0);
    }

    #[test]
    fn reconciled_pending_input_is_invalidated_and_cannot_resolve() {
        let directory = TestDirectory::new("stale-input");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "stale-input"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 1,
                    thread_id: "thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "fake".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 1, "thread", "turn")
            .unwrap();
        let (_, pending) = repository
            .open_pending_input(NewPendingInput {
                run_id: run.id.clone(),
                runtime_generation: 1,
                request_id: "1".to_owned(),
                thread_id: "thread".to_owned(),
                turn_id: "turn".to_owned(),
                item_id: "item".to_owned(),
                kind: PendingInputKind::Question,
                safe_summary: json!({ "questions": [] }),
            })
            .unwrap();
        repository.reconcile_in_flight_runs().unwrap();
        assert!(repository
            .get_pending_input(&pending.id)
            .unwrap()
            .invalidated_at
            .is_some());
        assert!(repository.resolve_pending_input(&pending.id).is_err());
    }

    #[test]
    fn startup_reconciliation_interrupts_once_without_touching_queue() {
        let directory = TestDirectory::new("reconcile");
        let repository = repository_with_tasks(&directory.0, &["task-a", "task-b"]);
        let workspace = workspace_path(&directory.0);
        let active = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "active"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        let queued = repository
            .enqueue_run(new_run(&repository, &workspace, "task-b", "queued"))
            .unwrap()
            .run;

        let first = repository.reconcile_in_flight_runs().unwrap();
        let second = repository.reconcile_in_flight_runs().unwrap();

        assert_eq!(first.len(), 1);
        assert!(second.is_empty());
        assert_eq!(
            repository.get_run(&active.id).unwrap().status,
            RunStatus::Interrupted
        );
        assert_eq!(
            repository.get_run(&queued.id).unwrap().status,
            RunStatus::Queued
        );
    }

    #[test]
    fn stale_generation_and_oversized_event_cannot_mutate_run() {
        let directory = TestDirectory::new("stale");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "stale"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 2,
                    thread_id: "thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "test".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 2, "thread", "turn")
            .unwrap();

        assert!(repository
            .record_run_event(
                &run.id,
                CorrelatedRunEvent {
                    generation: 1,
                    thread_id: "thread",
                    turn_id: Some("turn"),
                    event_type: "agent.item",
                    event_key: None,
                    payload: &json!({}),
                },
            )
            .is_err());
        assert!(repository
            .record_run_event(
                &run.id,
                CorrelatedRunEvent {
                    generation: 2,
                    thread_id: "thread",
                    turn_id: Some("turn"),
                    event_type: "agent.item",
                    event_key: None,
                    payload: &json!({ "text": "x".repeat(MAX_SAFE_EVENT_BYTES) }),
                },
            )
            .is_err());
    }

    #[test]
    fn running_cancel_targets_only_the_exact_run_and_is_idempotent() {
        let directory = TestDirectory::new("running-cancel");
        let repository = repository_with_tasks(&directory.0, &["task-a", "task-b"]);
        let workspace = workspace_path(&directory.0);
        let run_a = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "cancel-a"))
            .unwrap()
            .run;
        let mut run_b_input = new_run(&repository, &workspace, "task-b", "cancel-b");
        run_b_input.queued_at += 1;
        run_b_input.execution_root = isolated_execution_root(&directory.0, "cancel-root-b");
        let run_b = repository.enqueue_run(run_b_input).unwrap().run;
        for (run, thread, turn) in [
            (&run_a, "thread-a", "turn-a"),
            (&run_b, "thread-b", "turn-b"),
        ] {
            repository.claim_next_eligible_run(2).unwrap().unwrap();
            repository
                .attach_run_runtime(
                    &run.id,
                    &RuntimeAttachment {
                        generation: 3,
                        thread_id: thread.to_owned(),
                        thread_source: "xiao-workbench".to_owned(),
                        cli_version: "fake".to_owned(),
                        materialized: true,
                    },
                )
                .unwrap();
            repository
                .mark_run_running(&run.id, 3, thread, turn)
                .unwrap();
        }

        let requested = repository.request_run_cancel(&run_a.id).unwrap();
        let CancelDisposition::Interrupt { run, event } = requested else {
            panic!("running cancellation must request a runtime interrupt");
        };
        assert!(run.cancel_requested);
        assert!(event.is_some());
        for _failed_stage in ["task_lookup", "generation_lookup", "interrupt_request"] {
            let replay = repository.request_run_cancel(&run_a.id).unwrap();
            let CancelDisposition::Interrupt { run, event } = replay else {
                panic!("runtime cancellation intent must remain replayable");
            };
            assert!(run.cancel_requested);
            assert!(event.is_none());
        }
        assert_eq!(
            repository
                .list_run_events(&run_a.id, None, None)
                .unwrap()
                .into_iter()
                .filter(|event| event.event_type == "run.cancel_requested")
                .count(),
            1
        );
        let error = repository
            .finish_run_cancel_with_failpoint(&run_a.id)
            .unwrap_err();
        assert!(error.contains("Injected failure"));
        let unsettled = repository.get_run(&run_a.id).unwrap();
        assert_eq!(unsettled.status, RunStatus::Running);
        assert!(unsettled.cancel_requested);
        repository.finish_run_cancel(&run_a.id).unwrap();
        let repeated = repository.request_run_cancel(&run_a.id).unwrap();
        assert!(matches!(repeated, CancelDisposition::Settled(_)));
        assert_eq!(
            repository.get_run(&run_a.id).unwrap().status,
            RunStatus::Cancelled
        );
        assert_eq!(
            repository.get_run(&run_b.id).unwrap().status,
            RunStatus::Running
        );
    }

    #[test]
    fn terminal_turn_event_persists_large_diff_without_relaxing_its_protocol_limit() {
        let directory = TestDirectory::new("large-terminal-turn-diff");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "large-diff"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 1,
                    thread_id: "thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "fake".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 1, "thread", "turn")
            .unwrap();
        let turn_diff = format!(
            "diff --git a/large.txt b/large.txt\n{}",
            "+durable undo line\n".repeat(4_096)
        );
        assert!(turn_diff.len() > MAX_SAFE_EVENT_BYTES);

        repository
            .settle_runtime_turn(
                &run.id,
                1,
                "thread",
                "turn",
                RunStatus::Completed,
                &json!({
                    "protocol": { "method": "turn/completed" },
                    "turnDiff": turn_diff,
                }),
            )
            .unwrap();

        let events = repository
            .list_run_events(&run.id, None, Some(200))
            .unwrap();
        let completion = events
            .iter()
            .find(|event| event.event_type == "run.completed")
            .unwrap();
        assert_eq!(
            completion.safe_payload["turnDiff"].as_str(),
            Some(turn_diff.as_str())
        );

        let oversized = "x".repeat(MAX_TURN_DIFF_BYTES + 1);
        let error = validate_safe_payload(&json!({
            "protocol": { "method": "turn/completed" },
            "turnDiff": oversized,
        }))
        .unwrap_err();
        assert!(error.contains("8 MiB"));

        let oversized_protocol = "x".repeat(MAX_SAFE_EVENT_BYTES + 1);
        let error = validate_safe_payload(&json!({
            "protocol": { "text": oversized_protocol },
            "turnDiff": "",
        }))
        .unwrap_err();
        assert!(error.contains("64 KiB"));
    }

    #[test]
    fn committed_cancel_intent_wins_over_runtime_completion() {
        let directory = TestDirectory::new("cancel-completion-race");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "race"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 4,
                    thread_id: "thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "fake".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 4, "thread", "turn")
            .unwrap();
        repository.request_run_cancel(&run.id).unwrap();

        let settled = repository
            .settle_runtime_turn(
                &run.id,
                4,
                "thread",
                "turn",
                RunStatus::Completed,
                &json!({ "protocol": { "method": "turn/completed" } }),
            )
            .unwrap();

        assert_eq!(settled.run.status, RunStatus::Cancelled);
        assert_eq!(settled.event.unwrap().event_type, "run.cancelled");
    }

    #[test]
    fn pending_input_cannot_resolve_after_cancel_intent_commits() {
        let directory = TestDirectory::new("cancel-input-race");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "input-race"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 5,
                    thread_id: "thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "fake".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 5, "thread", "turn")
            .unwrap();
        let (_, pending) = repository
            .open_pending_input(NewPendingInput {
                run_id: run.id.clone(),
                runtime_generation: 5,
                request_id: "9".to_owned(),
                thread_id: "thread".to_owned(),
                turn_id: "turn".to_owned(),
                item_id: "item".to_owned(),
                kind: PendingInputKind::CommandApproval,
                safe_summary: json!({ "reason": "test" }),
            })
            .unwrap();
        repository.request_run_cancel(&run.id).unwrap();

        assert!(repository
            .open_pending_input(NewPendingInput {
                run_id: run.id.clone(),
                runtime_generation: 5,
                request_id: "10".to_owned(),
                thread_id: "thread".to_owned(),
                turn_id: "turn".to_owned(),
                item_id: "late-item".to_owned(),
                kind: PendingInputKind::CommandApproval,
                safe_summary: json!({ "reason": "late" }),
            })
            .is_err());
        assert!(repository.resolve_pending_input(&pending.id).is_err());
        assert!(repository
            .get_pending_input(&pending.id)
            .unwrap()
            .resolved_at
            .is_none());
    }

    #[test]
    fn queued_cancel_and_retry_are_idempotent() {
        let directory = TestDirectory::new("cancel-retry");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "cancel"))
            .unwrap()
            .run;
        let first = repository.request_run_cancel(&run.id).unwrap();
        let second = repository.request_run_cancel(&run.id).unwrap();
        assert!(matches!(first, CancelDisposition::Settled(_)));
        assert!(matches!(second, CancelDisposition::Settled(_)));
        assert_eq!(
            repository.get_run(&run.id).unwrap().status,
            RunStatus::Cancelled
        );

        let failed = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "failed"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .transition_run(
                &failed.id,
                RunStatus::Failed,
                "run.failed",
                Some("failed"),
                &json!({}),
            )
            .unwrap();
        let retry = repository.retry_run(&failed.id, "retry-key").unwrap();
        let duplicate = repository.retry_run(&failed.id, "retry-key").unwrap();
        assert!(repository.retry_run(&run.id, "retry-key").is_err());
        assert_eq!(retry.run.id, duplicate.run.id);
        assert_eq!(retry.run.parent_run_id.as_deref(), Some(failed.id.as_str()));
    }

    #[test]
    fn retry_preserves_the_source_contract_and_resets_its_diff_baseline() {
        let directory = TestDirectory::new("contracted-retry");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        repository
            .save_task_acceptance_contract(
                &workspace,
                "task-a",
                None,
                Some(&AcceptanceContractDraft {
                    name: "Original contract".to_owned(),
                    gates: vec![AcceptanceGate::DiffScope {
                        allowed_patterns: vec!["src/**".to_owned()],
                        denied_patterns: Vec::new(),
                    }],
                }),
            )
            .unwrap();
        let source = repository
            .enqueue_run(new_run(
                &repository,
                &workspace,
                "task-a",
                "contracted-source",
            ))
            .unwrap()
            .run;
        assert_eq!(
            source.verification_baseline_state,
            VerificationBaselineState::Pending
        );
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        let baseline = ArtifactRecord {
            id: new_uuid_v7(),
            run_id: source.id.clone(),
            verification_attempt_id: None,
            relative_storage_path: format!("runs/{}/baseline.json", source.id),
            media_type: "application/vnd.xiao.git-state+json".to_owned(),
            byte_length: 2,
            sha256: "b".repeat(64),
            retention_class: ArtifactRetentionClass::VerificationBaseline,
            created_at: 1,
        };
        repository
            .persist_verification_baseline(&source.id, &baseline)
            .unwrap();
        repository
            .transition_run(
                &source.id,
                RunStatus::Failed,
                "run.failed",
                Some("contracted-source-failed"),
                &json!({}),
            )
            .unwrap();
        repository
            .save_task_acceptance_contract(
                &workspace,
                "task-a",
                source.acceptance_contract_source_version_id.as_deref(),
                Some(&AcceptanceContractDraft {
                    name: "New task contract".to_owned(),
                    gates: vec![AcceptanceGate::Cleanliness {
                        allow_staged: true,
                        allow_unstaged: true,
                        allow_untracked: true,
                    }],
                }),
            )
            .unwrap();

        let retry = repository
            .retry_run(&source.id, "contracted-retry")
            .unwrap()
            .run;
        assert_eq!(
            retry.acceptance_contract_source_version_id,
            source.acceptance_contract_source_version_id
        );
        assert_eq!(
            retry.acceptance_contract_snapshot,
            source.acceptance_contract_snapshot
        );
        assert_eq!(
            retry.acceptance_contract_snapshot_sha256,
            source.acceptance_contract_snapshot_sha256
        );
        assert_eq!(retry.verification_outcome, VerificationOutcome::Pending);
        assert_eq!(
            retry.verification_baseline_state,
            VerificationBaselineState::Pending
        );
        assert_eq!(retry.verification_baseline_artifact_id, None);
        assert_eq!(retry.verification_baseline_diagnostic, None);
        assert_eq!(retry.latest_verification_attempt_id, None);
    }

    #[test]
    fn native_ephemeral_binding_survives_stale_workspace_save() {
        let directory = TestDirectory::new("thread-authority");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "binding"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 1,
                    thread_id: "runtime-thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "test".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();

        let mut document: XiaoWorkspaceDocument = repository
            .load_workspace(&workspace, true)
            .unwrap()
            .unwrap();
        document.tasks[0].thread_binding = Some(XiaoThreadBinding {
            thread_id: "stale-renderer".to_owned(),
            persistence: XiaoThreadPersistence::Ephemeral,
            materialized: false,
            thread_source: None,
            cli_version: None,
        });
        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: document.schema_version,
                workspace_path: document.workspace_path.clone(),
                active_task_id: document.active_task_id.clone(),
                show_archived: document.show_archived,
                task_ids: document.tasks.iter().map(|task| task.id.clone()).collect(),
                tasks: document.tasks,
            })
            .unwrap();
        let defaults = repository.run_task_defaults(&workspace, "task-a").unwrap();
        let binding = defaults.thread_binding.unwrap();
        assert_eq!(binding.thread_id, "runtime-thread");
        assert_eq!(binding.persistence, XiaoThreadPersistence::Ephemeral);
    }

    #[test]
    fn verification_baseline_is_attached_once_before_the_agent_turn() {
        let directory = TestDirectory::new("verification-baseline");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        repository
            .save_task_acceptance_contract(
                &workspace,
                "task-a",
                None,
                Some(&AcceptanceContractDraft {
                    name: "Diff verification".to_owned(),
                    gates: vec![AcceptanceGate::DiffScope {
                        allowed_patterns: vec!["src/**".to_owned()],
                        denied_patterns: Vec::new(),
                    }],
                }),
            )
            .unwrap();
        let run = repository
            .enqueue_run(new_run(
                &repository,
                &workspace,
                "task-a",
                "verification-baseline",
            ))
            .unwrap()
            .run;
        assert_eq!(
            run.verification_baseline_state,
            VerificationBaselineState::Pending
        );
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        let artifact = ArtifactRecord {
            id: new_uuid_v7(),
            run_id: run.id.clone(),
            verification_attempt_id: None,
            relative_storage_path: format!("runs/{}/baseline.json", run.id),
            media_type: "application/vnd.xiao.git-state+json".to_owned(),
            byte_length: 2,
            sha256: "b".repeat(64),
            retention_class: ArtifactRetentionClass::VerificationBaseline,
            created_at: 1,
        };
        let attached = repository
            .persist_verification_baseline(&run.id, &artifact)
            .unwrap();
        assert_eq!(
            attached.run.verification_baseline_state,
            VerificationBaselineState::Ready
        );
        assert_eq!(
            attached.run.verification_baseline_artifact_id.as_deref(),
            Some(artifact.id.as_str())
        );
        assert!(attached.event.is_some());
        let duplicate = repository
            .persist_verification_baseline(&run.id, &artifact)
            .unwrap();
        assert!(duplicate.event.is_none());
        assert_eq!(
            repository
                .load_verification_baseline_artifact(&run.id)
                .unwrap(),
            Some(artifact)
        );
    }

    #[test]
    fn verification_pass_requires_a_complete_atomic_gate_set_and_reruns_without_a_model_turn() {
        let directory = TestDirectory::new("verification-settlement");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let gates = vec![
            AcceptanceGate::Cleanliness {
                allow_staged: true,
                allow_unstaged: true,
                allow_untracked: true,
            },
            AcceptanceGate::Cleanliness {
                allow_staged: true,
                allow_unstaged: true,
                allow_untracked: true,
            },
        ];
        let verifying = verifying_run_with_gates(
            &repository,
            &workspace,
            "task-a",
            "verification-settlement",
            gates.clone(),
        );
        assert_eq!(verifying.status, RunStatus::Verifying);
        assert_eq!(verifying.agent_outcome, AgentOutcome::Completed);

        let initial = repository
            .begin_verification_attempt(
                &verifying.id,
                "initial-request",
                VerificationAttemptTrigger::Initial,
            )
            .unwrap();
        persist_gate_outcome(
            &repository,
            &verifying.id,
            &initial.attempt.id,
            0,
            &gates[0],
            VerificationGateOutcome::Passed,
        );
        let incomplete = repository
            .settle_verification_attempt(&initial.attempt.id)
            .unwrap();
        assert_eq!(
            incomplete.attempt.status,
            VerificationAttemptStatus::Blocked
        );
        assert_eq!(incomplete.mutation.run.status, RunStatus::NeedsAttention);
        assert_eq!(
            incomplete.mutation.run.verification_outcome,
            VerificationOutcome::Blocked
        );

        let rerun = repository
            .begin_verification_attempt(
                &verifying.id,
                "rerun-request",
                VerificationAttemptTrigger::Rerun,
            )
            .unwrap();
        let duplicate = repository
            .begin_verification_attempt(
                &verifying.id,
                "rerun-request",
                VerificationAttemptTrigger::Rerun,
            )
            .unwrap();
        assert!(rerun.created);
        assert!(!duplicate.created);
        assert_eq!(rerun.attempt.id, duplicate.attempt.id);
        assert_eq!(rerun.mutation.run.thread_id, verifying.thread_id);
        assert_eq!(rerun.mutation.run.turn_id, verifying.turn_id);

        for (index, gate) in gates.iter().enumerate() {
            persist_gate_outcome(
                &repository,
                &verifying.id,
                &rerun.attempt.id,
                index,
                gate,
                VerificationGateOutcome::Passed,
            );
        }
        let passed = repository
            .settle_verification_attempt(&rerun.attempt.id)
            .unwrap();
        assert_eq!(passed.attempt.status, VerificationAttemptStatus::Passed);
        assert_eq!(passed.mutation.run.status, RunStatus::Completed);
        assert_eq!(
            passed.mutation.run.verification_outcome,
            VerificationOutcome::Passed
        );
        assert_eq!(passed.mutation.run.agent_outcome, AgentOutcome::Completed);
        let history = repository
            .list_verification_evidence(&verifying.id, None)
            .unwrap();
        assert_eq!(history.attempts.len(), 2);
        assert!(!history.has_more);
        assert_eq!(history.attempts[0].attempt.id, rerun.attempt.id);
        assert_eq!(history.attempts[0].gates.len(), 2);
        assert!(history.attempts[0]
            .gates
            .iter()
            .all(|gate| gate.evidence.len() == 1 && gate.evidence[0].artifact.is_some()));
    }

    #[test]
    fn deleting_a_task_removes_its_cascaded_run_artifact_files() {
        let directory = TestDirectory::new("artifact-cascade-cleanup");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let gate = AcceptanceGate::Cleanliness {
            allow_staged: true,
            allow_unstaged: true,
            allow_untracked: true,
        };
        let verifying = verifying_run_with_gates(
            &repository,
            &workspace,
            "task-a",
            "artifact-cascade",
            vec![gate.clone()],
        );
        let attempt = repository
            .begin_verification_attempt(
                &verifying.id,
                "artifact-cascade-attempt",
                VerificationAttemptTrigger::Initial,
            )
            .unwrap();
        persist_gate_outcome(
            &repository,
            &verifying.id,
            &attempt.attempt.id,
            0,
            &gate,
            VerificationGateOutcome::Failed,
        );
        repository
            .settle_verification_attempt(&attempt.attempt.id)
            .unwrap();
        let relative_storage_path = repository
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT relative_storage_path FROM artifacts WHERE run_id = ?1",
                        [&verifying.id],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        let artifact_path = directory
            .0
            .join("verification-artifacts")
            .join(relative_storage_path);
        fs::create_dir_all(artifact_path.parent().unwrap()).unwrap();
        fs::write(&artifact_path, b"{}").unwrap();

        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: workspace,
                active_task_id: None,
                show_archived: false,
                task_ids: Vec::new(),
                tasks: Vec::new(),
            })
            .unwrap();

        assert!(!artifact_path.exists());
        assert!(repository.get_run(&verifying.id).is_err());
    }

    #[test]
    fn verification_attempt_history_is_bounded_per_run() {
        let directory = TestDirectory::new("verification-attempt-bound");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let gate = AcceptanceGate::Cleanliness {
            allow_staged: true,
            allow_unstaged: true,
            allow_untracked: true,
        };
        let verifying = verifying_run_with_gates(
            &repository,
            &workspace,
            "task-a",
            "verification-attempt-bound",
            vec![gate.clone()],
        );

        for attempt_index in 0..20 {
            let request_key = format!("bounded-attempt-{attempt_index}");
            let trigger = if attempt_index == 0 {
                VerificationAttemptTrigger::Initial
            } else {
                VerificationAttemptTrigger::Rerun
            };
            let attempt = repository
                .begin_verification_attempt(&verifying.id, &request_key, trigger)
                .unwrap();
            persist_gate_outcome(
                &repository,
                &verifying.id,
                &attempt.attempt.id,
                0,
                &gate,
                VerificationGateOutcome::Failed,
            );
            let failed = repository
                .settle_verification_attempt(&attempt.attempt.id)
                .unwrap();
            assert_eq!(failed.attempt.status, VerificationAttemptStatus::Failed);
            if attempt_index == 9 {
                let page = repository
                    .list_verification_evidence(&verifying.id, Some(10))
                    .unwrap();
                assert_eq!(page.attempts.len(), 10);
                assert!(!page.has_more);
            } else if attempt_index == 10 {
                let page = repository
                    .list_verification_evidence(&verifying.id, Some(10))
                    .unwrap();
                assert_eq!(page.attempts.len(), 10);
                assert!(page.has_more);
            }
        }

        let idempotent = repository
            .begin_verification_attempt(
                &verifying.id,
                "bounded-attempt-19",
                VerificationAttemptTrigger::Rerun,
            )
            .unwrap();
        assert!(!idempotent.created);
        assert_eq!(idempotent.attempt.status, VerificationAttemptStatus::Failed);
        let error = repository
            .begin_verification_attempt(
                &verifying.id,
                "bounded-attempt-overflow",
                VerificationAttemptTrigger::Rerun,
            )
            .unwrap_err();
        assert!(error.contains("bounded history limit of 20"));
        let page = repository
            .list_verification_evidence(&verifying.id, Some(usize::MAX))
            .unwrap();
        assert_eq!(page.attempts.len(), 20);
        assert!(!page.has_more);
    }

    #[test]
    fn verification_rerun_respects_global_run_capacity() {
        let directory = TestDirectory::new("verification-rerun-capacity");
        let repository = repository_with_tasks(&directory.0, &["task-a", "task-b", "task-c"]);
        let workspace = workspace_path(&directory.0);
        let gate = AcceptanceGate::Cleanliness {
            allow_staged: true,
            allow_unstaged: true,
            allow_untracked: true,
        };
        let verifying = verifying_run_with_gates(
            &repository,
            &workspace,
            "task-a",
            "verification-rerun-capacity",
            vec![gate.clone()],
        );
        let initial = repository
            .begin_verification_attempt(
                &verifying.id,
                "capacity-initial",
                VerificationAttemptTrigger::Initial,
            )
            .unwrap();
        persist_gate_outcome(
            &repository,
            &verifying.id,
            &initial.attempt.id,
            0,
            &gate,
            VerificationGateOutcome::Failed,
        );
        repository
            .settle_verification_attempt(&initial.attempt.id)
            .unwrap();

        for (task_id, key, root) in [
            ("task-b", "capacity-b", "capacity-root-b"),
            ("task-c", "capacity-c", "capacity-root-c"),
        ] {
            let mut run = new_run(&repository, &workspace, task_id, key);
            run.execution_root = isolated_execution_root(&directory.0, root);
            repository.enqueue_run(run).unwrap();
            repository.claim_next_eligible_run(2).unwrap().unwrap();
        }
        let error = repository
            .begin_verification_attempt(
                &verifying.id,
                "capacity-rerun",
                VerificationAttemptTrigger::Rerun,
            )
            .unwrap_err();
        assert!(error.contains("global run capacity"));
        assert_eq!(
            repository.get_run(&verifying.id).unwrap().status,
            RunStatus::NeedsAttention
        );
    }

    #[test]
    fn verification_rerun_admission_uses_component_overlap_in_both_directions() {
        for scenario in 0..4 {
            let directory = TestDirectory::new(&format!("verification-rerun-overlap-{scenario}"));
            let repository = repository_with_tasks(&directory.0, &["task-a", "task-b"]);
            let workspace = workspace_path(&directory.0);
            let parent_root = isolated_execution_root(&directory.0, "repo");
            let child_root = isolated_execution_root(&directory.0, "repo/sub");
            let sibling_root = isolated_execution_root(&directory.0, "repo2");
            let (verification_root, active_root, should_conflict) = match scenario {
                0 => (&parent_root, &child_root, true),
                1 => (&child_root, &parent_root, true),
                2 => (&parent_root, &parent_root, true),
                _ => (&parent_root, &sibling_root, false),
            };
            let gate = AcceptanceGate::Cleanliness {
                allow_staged: true,
                allow_unstaged: true,
                allow_untracked: true,
            };
            let verifying = verifying_run_with_gates_at_root(
                &repository,
                &workspace,
                "task-a",
                "verification-rerun-overlap",
                verification_root,
                vec![gate.clone()],
            );
            let initial = repository
                .begin_verification_attempt(
                    &verifying.id,
                    "overlap-initial",
                    VerificationAttemptTrigger::Initial,
                )
                .unwrap();
            persist_gate_outcome(
                &repository,
                &verifying.id,
                &initial.attempt.id,
                0,
                &gate,
                VerificationGateOutcome::Failed,
            );
            let failed = repository
                .settle_verification_attempt(&initial.attempt.id)
                .unwrap();
            assert_eq!(failed.mutation.run.status, RunStatus::NeedsAttention);

            let mut active_input = new_run(&repository, &workspace, "task-b", "overlapping-run");
            active_input.execution_root = active_root.clone();
            let active = repository.enqueue_run(active_input).unwrap().run;
            assert_eq!(
                repository
                    .claim_next_eligible_run(2)
                    .unwrap()
                    .unwrap()
                    .run
                    .id,
                active.id
            );

            let rerun = repository.begin_verification_attempt(
                &verifying.id,
                "overlap-rerun",
                VerificationAttemptTrigger::Rerun,
            );
            if should_conflict {
                let error = rerun.unwrap_err();
                assert!(error.contains("already owns this execution root"));
                let unchanged = repository.get_run(&verifying.id).unwrap();
                assert_eq!(unchanged.status, RunStatus::NeedsAttention);
                assert_eq!(unchanged.verification_outcome, VerificationOutcome::Failed);
                assert_eq!(
                    unchanged.latest_verification_attempt_id,
                    Some(initial.attempt.id)
                );
            } else {
                let admitted = rerun.unwrap();
                assert!(admitted.created);
                assert_eq!(admitted.mutation.run.status, RunStatus::Verifying);
                assert_eq!(
                    repository.get_run(&active.id).unwrap().status,
                    RunStatus::Preparing
                );
            }
        }
    }

    #[test]
    fn admitted_verification_reruns_reserve_overlapping_trees() {
        for child_is_admitted in [false, true] {
            let label = if child_is_admitted {
                "rerun-reservation-child"
            } else {
                "rerun-reservation-parent"
            };
            let directory = TestDirectory::new(label);
            let repository = repository_with_tasks(&directory.0, &["task-a", "task-b", "task-c"]);
            let workspace = workspace_path(&directory.0);
            let parent_root = isolated_execution_root(&directory.0, "repo");
            let child_root = isolated_execution_root(&directory.0, "repo/sub");
            let sibling_root = isolated_execution_root(&directory.0, "repo2");
            let (admitted_root, blocked_root) = if child_is_admitted {
                (&child_root, &parent_root)
            } else {
                (&parent_root, &child_root)
            };
            let admitted = failed_verification_run_at_root(
                &repository,
                &workspace,
                "task-a",
                "admitted",
                admitted_root,
            );
            let blocked = failed_verification_run_at_root(
                &repository,
                &workspace,
                "task-b",
                "blocked",
                blocked_root,
            );
            let sibling = failed_verification_run_at_root(
                &repository,
                &workspace,
                "task-c",
                "sibling",
                &sibling_root,
            );

            let first = repository
                .begin_verification_attempt(
                    &admitted.id,
                    "admitted-rerun",
                    VerificationAttemptTrigger::Rerun,
                )
                .unwrap();
            assert_eq!(first.mutation.run.status, RunStatus::Verifying);
            let error = repository
                .begin_verification_attempt(
                    &blocked.id,
                    "blocked-rerun",
                    VerificationAttemptTrigger::Rerun,
                )
                .unwrap_err();
            assert!(error.contains("already owns this execution root"));
            let concurrent = repository
                .begin_verification_attempt(
                    &sibling.id,
                    "sibling-rerun",
                    VerificationAttemptTrigger::Rerun,
                )
                .unwrap();
            assert_eq!(concurrent.mutation.run.status, RunStatus::Verifying);
        }
    }

    #[test]
    fn verification_settlement_failpoint_rolls_back_attempt_run_and_event() {
        let directory = TestDirectory::new("verification-settlement-failpoint");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let gate = AcceptanceGate::Cleanliness {
            allow_staged: true,
            allow_unstaged: true,
            allow_untracked: true,
        };
        let verifying = verifying_run_with_gates(
            &repository,
            &workspace,
            "task-a",
            "verification-settlement-failpoint",
            vec![gate.clone()],
        );
        let initial = repository
            .begin_verification_attempt(
                &verifying.id,
                "failpoint-initial",
                VerificationAttemptTrigger::Initial,
            )
            .unwrap();
        persist_gate_outcome(
            &repository,
            &verifying.id,
            &initial.attempt.id,
            0,
            &gate,
            VerificationGateOutcome::Passed,
        );

        let error = repository
            .settle_verification_attempt_with_failpoint(&initial.attempt.id)
            .unwrap_err();
        assert!(error.contains("Injected failure"));
        let unchanged = repository.get_run(&verifying.id).unwrap();
        assert_eq!(unchanged.status, RunStatus::Verifying);
        assert_eq!(unchanged.verification_outcome, VerificationOutcome::Pending);
        let duplicate = repository
            .begin_verification_attempt(
                &verifying.id,
                "failpoint-initial",
                VerificationAttemptTrigger::Initial,
            )
            .unwrap();
        assert!(!duplicate.created);
        assert_eq!(duplicate.attempt.status, VerificationAttemptStatus::Running);
        let evidence = repository
            .list_verification_evidence(&verifying.id, None)
            .unwrap();
        assert_eq!(evidence.attempts.len(), 1);
        assert_eq!(
            evidence.attempts[0].attempt.status,
            VerificationAttemptStatus::Running
        );
        assert_eq!(evidence.attempts[0].gates.len(), 1);

        let passed = repository
            .settle_verification_attempt(&initial.attempt.id)
            .unwrap();
        assert_eq!(passed.attempt.status, VerificationAttemptStatus::Passed);
        assert_eq!(passed.mutation.run.status, RunStatus::Completed);
        assert_eq!(
            passed.mutation.run.verification_outcome,
            VerificationOutcome::Passed
        );
    }

    #[test]
    fn verification_failure_wins_over_late_cancellation() {
        let directory = TestDirectory::new("verification-failure-cancel-race");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let gate = AcceptanceGate::Cleanliness {
            allow_staged: true,
            allow_unstaged: true,
            allow_untracked: true,
        };
        let verifying = verifying_run_with_gates(
            &repository,
            &workspace,
            "task-a",
            "verification-failure-cancel-race",
            vec![gate.clone()],
        );
        let initial = repository
            .begin_verification_attempt(
                &verifying.id,
                "failure-cancel-initial",
                VerificationAttemptTrigger::Initial,
            )
            .unwrap();
        persist_gate_outcome(
            &repository,
            &verifying.id,
            &initial.attempt.id,
            0,
            &gate,
            VerificationGateOutcome::Failed,
        );

        let requested = repository.request_run_cancel(&verifying.id).unwrap();
        let CancelDisposition::Verification { run, event } = requested else {
            panic!("verification cancellation must remain active until its worker stops");
        };
        assert_eq!(run.status, RunStatus::Verifying);
        assert!(run.cancel_requested);
        assert_eq!(
            event.as_ref().map(|event| event.event_type.as_str()),
            Some("run.cancel_requested")
        );
        let deferred = repository
            .settle_verification_attempt(&initial.attempt.id)
            .unwrap();
        assert_eq!(deferred.attempt.status, VerificationAttemptStatus::Running);
        assert_eq!(deferred.mutation.run.status, RunStatus::Verifying);
        assert!(deferred.mutation.event.is_none());

        let cancelled = repository.finish_run_cancel(&verifying.id).unwrap();
        assert_eq!(cancelled.run.status, RunStatus::NeedsAttention);
        assert_eq!(cancelled.run.agent_outcome, AgentOutcome::Completed);
        assert_eq!(
            cancelled.run.verification_outcome,
            VerificationOutcome::Failed
        );
        assert_eq!(
            cancelled
                .event
                .as_ref()
                .map(|event| event.event_type.as_str()),
            Some("verification.failed")
        );
        let settled = repository
            .settle_verification_attempt(&initial.attempt.id)
            .unwrap();
        assert_eq!(settled.attempt.status, VerificationAttemptStatus::Failed);
        assert!(settled.mutation.event.is_none());
        let evidence = repository
            .list_verification_evidence(&verifying.id, None)
            .unwrap();
        assert_eq!(evidence.attempts.len(), 1);
        assert_eq!(
            evidence.attempts[0].attempt.status,
            VerificationAttemptStatus::Failed
        );
        assert_eq!(evidence.attempts[0].gates.len(), 1);
        assert_eq!(
            evidence.attempts[0].gates[0].result.outcome,
            VerificationGateOutcome::Failed
        );
    }

    #[test]
    fn verification_cancel_holds_root_replays_and_cannot_race_to_passed() {
        let directory = TestDirectory::new("verification-cancel");
        let repository = repository_with_tasks(&directory.0, &["task-a", "task-b"]);
        let workspace = workspace_path(&directory.0);
        let gate = AcceptanceGate::Cleanliness {
            allow_staged: true,
            allow_unstaged: true,
            allow_untracked: true,
        };
        let verifying = verifying_run_with_gates(
            &repository,
            &workspace,
            "task-a",
            "verification-cancel",
            vec![gate.clone()],
        );
        let initial = repository
            .begin_verification_attempt(
                &verifying.id,
                "cancel-initial",
                VerificationAttemptTrigger::Initial,
            )
            .unwrap();
        let queued = repository
            .enqueue_run(new_run(
                &repository,
                &workspace,
                "task-b",
                "same-root-after-cancel",
            ))
            .unwrap()
            .run;

        let requested = repository.request_run_cancel(&verifying.id).unwrap();
        let CancelDisposition::Verification { run, event } = requested else {
            panic!("verification cancellation must remain active until its worker stops");
        };
        assert_eq!(run.status, RunStatus::Verifying);
        assert!(run.cancel_requested);
        assert!(event.is_some());

        for _failed_stage in ["worker_stop_signal", "worker_stop_timeout"] {
            let replay = repository.request_run_cancel(&verifying.id).unwrap();
            let CancelDisposition::Verification { run, event } = replay else {
                panic!("durable cancellation intent must remain replayable");
            };
            assert_eq!(run.status, RunStatus::Verifying);
            assert!(run.cancel_requested);
            assert!(event.is_none());
        }
        let cancel_request_events = repository
            .list_run_events(&verifying.id, None, None)
            .unwrap()
            .into_iter()
            .filter(|event| event.event_type == "run.cancel_requested")
            .count();
        assert_eq!(cancel_request_events, 1);
        assert!(repository.claim_next_eligible_run(2).unwrap().is_none());

        persist_gate_outcome(
            &repository,
            &verifying.id,
            &initial.attempt.id,
            0,
            &gate,
            VerificationGateOutcome::Passed,
        );
        let deferred = repository
            .settle_verification_attempt(&initial.attempt.id)
            .unwrap();
        assert_eq!(deferred.attempt.status, VerificationAttemptStatus::Running);
        assert_eq!(deferred.mutation.run.status, RunStatus::Verifying);
        assert!(deferred.mutation.event.is_none());
        assert!(repository.claim_next_eligible_run(2).unwrap().is_none());

        let error = repository
            .finish_run_cancel_with_failpoint(&verifying.id)
            .unwrap_err();
        assert!(error.contains("Injected failure"));
        let still_stopping = repository.get_run(&verifying.id).unwrap();
        assert_eq!(still_stopping.status, RunStatus::Verifying);
        assert!(still_stopping.cancel_requested);
        assert!(repository.claim_next_eligible_run(2).unwrap().is_none());

        let cancelled = repository.finish_run_cancel(&verifying.id).unwrap();
        assert_eq!(cancelled.run.status, RunStatus::NeedsAttention);
        assert_eq!(
            cancelled.run.verification_outcome,
            VerificationOutcome::Blocked
        );
        assert!(!cancelled.run.cancel_requested);
        assert_eq!(
            cancelled
                .event
                .as_ref()
                .map(|event| event.event_type.as_str()),
            Some("verification.cancelled")
        );
        let repeated = repository.finish_run_cancel(&verifying.id).unwrap();
        assert_eq!(repeated.run.status, RunStatus::NeedsAttention);
        assert!(repeated.event.is_none());
        assert_eq!(
            repository
                .claim_next_eligible_run(2)
                .unwrap()
                .unwrap()
                .run
                .id,
            queued.id
        );

        let duplicate = repository
            .begin_verification_attempt(
                &verifying.id,
                "cancel-initial",
                VerificationAttemptTrigger::Initial,
            )
            .unwrap();
        assert_eq!(
            duplicate.attempt.status,
            VerificationAttemptStatus::Cancelled
        );
        assert_eq!(duplicate.attempt.id, initial.attempt.id);
    }

    #[test]
    fn persisted_verification_failure_wins_over_process_restart() {
        let directory = TestDirectory::new("verification-failure-restart");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let gate = AcceptanceGate::Cleanliness {
            allow_staged: true,
            allow_unstaged: true,
            allow_untracked: true,
        };
        let verifying = verifying_run_with_gates(
            &repository,
            &workspace,
            "task-a",
            "verification-failure-restart",
            vec![gate.clone()],
        );
        let initial = repository
            .begin_verification_attempt(
                &verifying.id,
                "failure-restart-initial",
                VerificationAttemptTrigger::Initial,
            )
            .unwrap();
        persist_gate_outcome(
            &repository,
            &verifying.id,
            &initial.attempt.id,
            0,
            &gate,
            VerificationGateOutcome::Failed,
        );

        let reconciled = repository.reconcile_in_flight_runs().unwrap();
        assert_eq!(reconciled.len(), 1);
        assert_eq!(reconciled[0].run.status, RunStatus::NeedsAttention);
        assert_eq!(reconciled[0].run.agent_outcome, AgentOutcome::Completed);
        assert_eq!(
            reconciled[0].run.verification_outcome,
            VerificationOutcome::Failed
        );
        assert_eq!(
            reconciled[0]
                .event
                .as_ref()
                .map(|event| event.event_type.as_str()),
            Some("verification.failed")
        );
        let evidence = repository
            .list_verification_evidence(&verifying.id, None)
            .unwrap();
        assert_eq!(evidence.attempts.len(), 1);
        assert_eq!(
            evidence.attempts[0].attempt.status,
            VerificationAttemptStatus::Failed
        );
        assert_eq!(evidence.attempts[0].gates.len(), 1);
        assert_eq!(
            evidence.attempts[0].gates[0].result.outcome,
            VerificationGateOutcome::Failed
        );
    }

    #[test]
    fn restart_interrupts_verification_attempt_and_preserves_verification_only_rerun() {
        let directory = TestDirectory::new("verification-restart");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let gate = AcceptanceGate::Cleanliness {
            allow_staged: true,
            allow_unstaged: true,
            allow_untracked: true,
        };
        let verifying = verifying_run_with_gates(
            &repository,
            &workspace,
            "task-a",
            "verification-restart",
            vec![gate.clone(), gate.clone()],
        );
        let initial = repository
            .begin_verification_attempt(
                &verifying.id,
                "restart-initial",
                VerificationAttemptTrigger::Initial,
            )
            .unwrap();
        persist_gate_outcome(
            &repository,
            &verifying.id,
            &initial.attempt.id,
            0,
            &gate,
            VerificationGateOutcome::Passed,
        );
        let reconciled = repository.reconcile_in_flight_runs().unwrap();
        assert_eq!(reconciled.len(), 1);
        assert_eq!(reconciled[0].run.status, RunStatus::Interrupted);
        assert_eq!(reconciled[0].run.agent_outcome, AgentOutcome::Completed);
        assert_eq!(
            reconciled[0].run.verification_outcome,
            VerificationOutcome::Blocked
        );
        let interrupted = repository
            .begin_verification_attempt(
                &verifying.id,
                "restart-initial",
                VerificationAttemptTrigger::Initial,
            )
            .unwrap();
        assert_eq!(interrupted.attempt.id, initial.attempt.id);
        assert_eq!(
            interrupted.attempt.status,
            VerificationAttemptStatus::Interrupted
        );
        let evidence = repository
            .list_verification_evidence(&verifying.id, None)
            .unwrap();
        assert_eq!(evidence.attempts.len(), 1);
        assert_eq!(
            evidence.attempts[0].attempt.status,
            VerificationAttemptStatus::Interrupted
        );
        assert_eq!(evidence.attempts[0].gates.len(), 1);
        assert!(evidence.attempts[0].gates[0].evidence[0].artifact.is_some());
        assert!(repository
            .list_run_events(&verifying.id, None, None)
            .unwrap()
            .iter()
            .all(|event| event.event_type != "verification.passed"));
        let rerun = repository
            .begin_verification_attempt(
                &verifying.id,
                "restart-rerun",
                VerificationAttemptTrigger::Rerun,
            )
            .unwrap();
        assert!(rerun.created);
        assert_eq!(rerun.mutation.run.thread_id, verifying.thread_id);
        assert_eq!(rerun.mutation.run.turn_id, verifying.turn_id);
    }

    #[test]
    fn restart_consumes_verification_cancel_intent_and_allows_rerun() {
        let directory = TestDirectory::new("verification-cancel-restart");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let gate = AcceptanceGate::Cleanliness {
            allow_staged: true,
            allow_unstaged: true,
            allow_untracked: true,
        };
        let verifying = verifying_run_with_gates(
            &repository,
            &workspace,
            "task-a",
            "verification-cancel-restart",
            vec![gate.clone(), gate.clone()],
        );
        let initial = repository
            .begin_verification_attempt(
                &verifying.id,
                "cancel-restart-initial",
                VerificationAttemptTrigger::Initial,
            )
            .unwrap();
        persist_gate_outcome(
            &repository,
            &verifying.id,
            &initial.attempt.id,
            0,
            &gate,
            VerificationGateOutcome::Passed,
        );

        let requested = repository.request_run_cancel(&verifying.id).unwrap();
        let CancelDisposition::Verification { run, event } = requested else {
            panic!("verification cancellation must persist until its worker stops");
        };
        assert!(run.cancel_requested);
        assert_eq!(
            event.as_ref().map(|event| event.event_type.as_str()),
            Some("run.cancel_requested")
        );

        let first = repository.reconcile_in_flight_runs().unwrap();
        let second = repository.reconcile_in_flight_runs().unwrap();
        assert_eq!(first.len(), 1);
        assert!(second.is_empty());
        assert_eq!(first[0].run.status, RunStatus::Interrupted);
        assert_eq!(first[0].run.agent_outcome, AgentOutcome::Completed);
        assert_eq!(
            first[0].run.verification_outcome,
            VerificationOutcome::Blocked
        );
        assert!(!first[0].run.cancel_requested);

        let recovered = repository.get_run(&verifying.id).unwrap();
        assert_eq!(recovered.status, RunStatus::Interrupted);
        assert_eq!(recovered.verification_outcome, VerificationOutcome::Blocked);
        assert!(!recovered.cancel_requested);
        let evidence = repository
            .list_verification_evidence(&verifying.id, None)
            .unwrap();
        assert_eq!(evidence.attempts.len(), 1);
        assert_eq!(
            evidence.attempts[0].attempt.status,
            VerificationAttemptStatus::Interrupted
        );
        assert_eq!(evidence.attempts[0].gates.len(), 1);
        assert_eq!(
            evidence.attempts[0].gates[0].result.outcome,
            VerificationGateOutcome::Passed
        );
        assert!(evidence.attempts[0].gates[0].evidence[0].artifact.is_some());

        let events = repository
            .list_run_events(&verifying.id, None, None)
            .unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event_type == "run.interrupted")
                .count(),
            1
        );
        assert!(events
            .iter()
            .all(|event| event.event_type != "verification.passed"));

        let terminal_cancel = repository.request_run_cancel(&verifying.id).unwrap();
        let CancelDisposition::Settled(terminal_cancel) = terminal_cancel else {
            panic!("terminal cancellation must remain idempotent");
        };
        assert_eq!(terminal_cancel.run.status, RunStatus::Interrupted);
        assert!(!terminal_cancel.run.cancel_requested);
        assert!(terminal_cancel.event.is_none());

        let rerun = repository
            .begin_verification_attempt(
                &verifying.id,
                "cancel-restart-rerun",
                VerificationAttemptTrigger::Rerun,
            )
            .unwrap();
        assert!(rerun.created);
        assert_eq!(rerun.mutation.run.status, RunStatus::Verifying);
        assert_eq!(
            rerun.mutation.run.verification_outcome,
            VerificationOutcome::Pending
        );
        assert_eq!(rerun.mutation.run.thread_id, verifying.thread_id);
        assert_eq!(rerun.mutation.run.turn_id, verifying.turn_id);
    }
}
