use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

use crate::git::models::{WorkspaceCheckpointCapture, WorkspaceRestoreStep};
use crate::git::service::{
    restore_workspace_checkpoints_with_rollback, rollback_workspace_restore,
};
use crate::runs::repository::{append_event, new_uuid_v7};
use crate::xiao::repository::{normalize_workspace_path, XiaoRepository};

use super::models::{RestoreTurnsResult, StoredTurnCheckpoint, TurnCheckpointSummary};

const DEFAULT_CHECKPOINT_LIMIT: usize = 50;
const MAX_CHECKPOINT_LIMIT: usize = 100;
const MAX_TURN_PATCH_BYTES: usize = 8 * 1024 * 1024;

pub(crate) struct TurnCheckpointOwner<'a> {
    pub run_id: &'a str,
    pub workspace_id: i64,
    pub task_id: &'a str,
    pub turn_id: &'a str,
    pub execution_root: &'a str,
}

pub(crate) fn insert_turn_checkpoint(
    connection: &Connection,
    owner: TurnCheckpointOwner<'_>,
    capture: &WorkspaceCheckpointCapture,
) -> Result<(), String> {
    validate_capture(capture)?;
    let patch_sha256 = sha256_hex(capture.patch.as_bytes());
    let id = new_uuid_v7();
    let created_at = now_millis()?;
    let changed = connection
        .execute(
            r#"INSERT INTO turn_checkpoints(
                id, run_id, workspace_id, task_id, turn_id, execution_root, patch,
                patch_sha256, before_fingerprint, after_fingerprint, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(run_id) DO NOTHING"#,
            params![
                id,
                owner.run_id,
                owner.workspace_id,
                owner.task_id,
                owner.turn_id,
                owner.execution_root,
                capture.patch,
                patch_sha256,
                capture.before_fingerprint,
                capture.after_fingerprint,
                created_at,
            ],
        )
        .map_err(|error| format!("Could not persist Xiao turn checkpoint: {error}"))?;
    if changed == 1 {
        return Ok(());
    }

    let existing: (String, String, String, String) = connection
        .query_row(
            r#"SELECT turn_id, patch_sha256, before_fingerprint, after_fingerprint
               FROM turn_checkpoints WHERE run_id = ?1"#,
            [owner.run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| format!("Could not verify Xiao turn checkpoint replay: {error}"))?;
    if existing
        != (
            owner.turn_id.to_owned(),
            patch_sha256,
            capture.before_fingerprint.clone(),
            capture.after_fingerprint.clone(),
        )
    {
        return Err("A different checkpoint is already bound to this Xiao run.".to_owned());
    }
    Ok(())
}

impl XiaoRepository {
    pub(crate) fn record_turn_checkpoint(
        &self,
        run_id: &str,
        turn_id: &str,
        capture: &WorkspaceCheckpointCapture,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let owner = connection
                .query_row(
                    r#"SELECT workspace_id, task_id, turn_id, execution_root
                       FROM runs WHERE id = ?1"#,
                    [run_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .map_err(|error| format!("Could not load Xiao checkpoint owner: {error}"))?;
            if owner.2.as_deref() != Some(turn_id) {
                return Err("The checkpoint turn no longer matches its Xiao run.".to_owned());
            }
            insert_turn_checkpoint(
                connection,
                TurnCheckpointOwner {
                    run_id,
                    workspace_id: owner.0,
                    task_id: &owner.1,
                    turn_id,
                    execution_root: &owner.3,
                },
                capture,
            )
        })
    }

    pub fn list_turn_checkpoints(
        &self,
        workspace_path: &str,
        task_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<TurnCheckpointSummary>, String> {
        let limit = limit
            .unwrap_or(DEFAULT_CHECKPOINT_LIMIT)
            .clamp(1, MAX_CHECKPOINT_LIMIT) as i64;
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    r#"SELECT c.id, c.run_id, c.turn_id, r.prompt, r.status,
                              length(CAST(c.patch AS BLOB)), c.before_fingerprint,
                              c.after_fingerprint, c.created_at, c.restored_at
                       FROM turn_checkpoints c
                       JOIN runs r ON r.id = c.run_id
                       JOIN workspaces w ON w.id = c.workspace_id
                       WHERE w.workspace_path = ?1 AND c.task_id = ?2
                       ORDER BY c.created_at DESC, c.id DESC LIMIT ?3"#,
                )
                .map_err(|error| format!("Could not prepare Xiao checkpoint history: {error}"))?;
            let rows = statement
                .query_map(
                    params![normalize_workspace_path(workspace_path), task_id, limit],
                    |row| {
                        let patch_bytes = row.get::<_, i64>(5)?;
                        Ok(TurnCheckpointSummary {
                            id: row.get(0)?,
                            run_id: row.get(1)?,
                            turn_id: row.get(2)?,
                            prompt: row.get(3)?,
                            run_status: row.get(4)?,
                            patch_bytes: usize::try_from(patch_bytes).unwrap_or(usize::MAX),
                            before_fingerprint: row.get(6)?,
                            after_fingerprint: row.get(7)?,
                            created_at: row.get(8)?,
                            restored_at: row.get(9)?,
                        })
                    },
                )
                .map_err(|error| format!("Could not query Xiao checkpoint history: {error}"))?;
            rows.map(|row| {
                row.map_err(|error| format!("Could not decode Xiao checkpoint history: {error}"))
            })
            .collect()
        })
    }

    pub fn restore_turn_checkpoints(
        &self,
        workspace_path: &str,
        task_id: &str,
        target_checkpoint_id: &str,
        execution_root: &str,
    ) -> Result<RestoreTurnsResult, String> {
        if target_checkpoint_id.trim().is_empty() {
            return Err("Choose a checkpoint to restore.".to_owned());
        }
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao guarded restore: {error}"))?;
            let normalized_workspace = normalize_workspace_path(workspace_path);
            let workspace_id: i64 = transaction
                .query_row(
                    "SELECT id FROM workspaces WHERE workspace_path = ?1",
                    [&normalized_workspace],
                    |row| row.get(0),
                )
                .map_err(|_| "The Xiao workspace is not persisted.".to_owned())?;
            let active_runs: i64 = transaction
                .query_row(
                    r#"SELECT COUNT(*) FROM runs
                       WHERE workspace_id = ?1 AND task_id = ?2
                         AND status IN ('queued', 'preparing', 'running',
                                        'waiting_for_input', 'verifying')"#,
                    params![workspace_id, task_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not inspect active Xiao runs: {error}"))?;
            if active_runs != 0 {
                return Err(
                    "Wait for active runs to settle before restoring earlier turns.".to_owned(),
                );
            }

            let target_exists = transaction
                .query_row(
                    r#"SELECT 1 FROM turn_checkpoints
                       WHERE id = ?1 AND workspace_id = ?2 AND task_id = ?3
                         AND restored_at IS NULL"#,
                    params![target_checkpoint_id, workspace_id, task_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|error| format!("Could not inspect the restore target: {error}"))?
                .is_some();
            if !target_exists {
                return Err("The selected turn is no longer restorable.".to_owned());
            }

            let mut statement = transaction
                .prepare(
                    r#"SELECT id, run_id, execution_root, patch, patch_sha256,
                              before_fingerprint, after_fingerprint
                       FROM turn_checkpoints
                       WHERE workspace_id = ?1 AND task_id = ?2 AND restored_at IS NULL
                       ORDER BY created_at DESC, id DESC"#,
                )
                .map_err(|error| format!("Could not prepare the restore plan: {error}"))?;
            let rows = statement
                .query_map(params![workspace_id, task_id], |row| {
                    Ok(StoredTurnCheckpoint {
                        id: row.get(0)?,
                        run_id: row.get(1)?,
                        execution_root: row.get(2)?,
                        patch: row.get(3)?,
                        patch_sha256: row.get(4)?,
                        before_fingerprint: row.get(5)?,
                        after_fingerprint: row.get(6)?,
                    })
                })
                .map_err(|error| format!("Could not query the restore plan: {error}"))?;
            let mut plan = Vec::new();
            for row in rows {
                let checkpoint =
                    row.map_err(|error| format!("Could not decode the restore plan: {error}"))?;
                let is_target = checkpoint.id == target_checkpoint_id;
                plan.push(checkpoint);
                if is_target {
                    break;
                }
            }
            drop(statement);
            if plan.last().map(|checkpoint| checkpoint.id.as_str()) != Some(target_checkpoint_id) {
                return Err(
                    "The selected checkpoint is outside the active restore lineage.".to_owned(),
                );
            }
            if plan
                .iter()
                .any(|checkpoint| checkpoint.execution_root != execution_root)
            {
                return Err("The restore lineage belongs to a different execution root.".to_owned());
            }
            if plan.iter().any(|checkpoint| {
                sha256_hex(checkpoint.patch.as_bytes()) != checkpoint.patch_sha256
            }) {
                return Err("A durable turn patch failed its integrity check.".to_owned());
            }

            let steps = plan
                .iter()
                .map(|checkpoint| WorkspaceRestoreStep {
                    patch: checkpoint.patch.clone(),
                    before_fingerprint: checkpoint.before_fingerprint.clone(),
                    after_fingerprint: checkpoint.after_fingerprint.clone(),
                })
                .collect::<Vec<_>>();
            let restore = restore_workspace_checkpoints_with_rollback(execution_root, &steps)?;
            let restore_batch_id = new_uuid_v7();
            let restored_at = now_millis()?;
            let persistence = (|| {
                for checkpoint in &plan {
                    let changed = transaction
                        .execute(
                            r#"UPDATE turn_checkpoints
                               SET restored_at = ?1, restore_batch_id = ?2
                               WHERE id = ?3 AND restored_at IS NULL"#,
                            params![restored_at, restore_batch_id, checkpoint.id],
                        )
                        .map_err(|error| {
                            format!("Could not record restored checkpoint: {error}")
                        })?;
                    if changed != 1 {
                        return Err(
                            "The restore lineage changed before it could be recorded.".to_owned()
                        );
                    }
                }
                let target_run_id = plan
                    .last()
                    .map(|checkpoint| checkpoint.run_id.as_str())
                    .ok_or("The restore plan is empty.")?;
                append_event(
                    &transaction,
                    target_run_id,
                    "time_travel.restored",
                    Some(&format!("time-travel:{restore_batch_id}")),
                    &serde_json::json!({
                        "restoreBatchId": restore_batch_id,
                        "restoredTurnCount": plan.len(),
                        "targetFingerprint": restore.target_fingerprint,
                    }),
                )?;
                transaction
                    .commit()
                    .map_err(|error| format!("Could not commit Xiao guarded restore: {error}"))
            })();
            if let Err(error) = persistence {
                return Err(match rollback_workspace_restore(execution_root, &restore) {
                    Ok(()) => {
                        format!("{error} Xiao restored the workspace to its pre-restore state.")
                    }
                    Err(rollback_error) => {
                        format!("{error} Workspace rollback also failed: {rollback_error}")
                    }
                });
            }
            Ok(RestoreTurnsResult {
                restore_batch_id,
                restored_checkpoint_ids: plan
                    .iter()
                    .map(|checkpoint| checkpoint.id.clone())
                    .collect(),
                restored_turn_count: plan.len(),
                target_fingerprint: restore.target_fingerprint,
                restored_at,
            })
        })
    }
}

fn validate_capture(capture: &WorkspaceCheckpointCapture) -> Result<(), String> {
    if capture.patch.len() > MAX_TURN_PATCH_BYTES {
        return Err("The turn patch exceeds the 8 MiB durability limit.".to_owned());
    }
    if !valid_fingerprint(&capture.before_fingerprint)
        || !valid_fingerprint(&capture.after_fingerprint)
    {
        return Err("The turn checkpoint fingerprint is invalid.".to_owned());
    }
    if capture.patch.trim().is_empty() && capture.before_fingerprint != capture.after_fingerprint {
        return Err("An empty turn patch cannot change the workspace fingerprint.".to_owned());
    }
    Ok(())
}

fn valid_fingerprint(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn now_millis() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|_| "System time exceeds Xiao storage limits.".to_owned())
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

    use rusqlite::params;

    use super::*;
    use crate::git::service::{create_workspace_checkpoint, finish_workspace_checkpoint_capture};
    use crate::runs::repository::new_uuid_v7;
    use crate::xiao::models::{
        XiaoTaskDocument, XiaoWorkspaceMode, XiaoWorkspaceUpdate, XIAO_SCHEMA_VERSION,
    };

    static NEXT_TEST: AtomicU64 = AtomicU64::new(1);

    fn test_directory(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "xiao-time-travel-{label}-{}-{}",
            std::process::id(),
            NEXT_TEST.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn task() -> XiaoTaskDocument {
        XiaoTaskDocument {
            id: "task".to_owned(),
            title: "Time travel task".to_owned(),
            created_at: 1,
            updated_at: 1,
            draft_text: String::new(),
            follow_ups: Vec::new(),
            archived: false,
            pinned: false,
            unread: false,
            model: None,
            reasoning_effort: None,
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

    fn read_text(path: &std::path::Path) -> String {
        fs::read_to_string(path).unwrap().replace("\r\n", "\n")
    }

    #[test]
    fn durable_restore_compensates_on_database_failure_then_commits_once() {
        let app_data = test_directory("repo");
        let workspace = test_directory("workspace");
        fs::create_dir_all(&app_data).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("note.txt"), "before\n").unwrap();
        let repository = XiaoRepository::open(&app_data).unwrap();
        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: workspace.to_string_lossy().into_owned(),
                active_task_id: Some("task".to_owned()),
                show_archived: false,
                task_ids: vec!["task".to_owned()],
                tasks: vec![task()],
            })
            .unwrap();

        let token = create_workspace_checkpoint(&workspace.to_string_lossy()).unwrap();
        fs::write(workspace.join("note.txt"), "after\n").unwrap();
        let capture =
            finish_workspace_checkpoint_capture(&workspace.to_string_lossy(), &token).unwrap();
        let run_id = new_uuid_v7();
        let execution_root = normalize_workspace_path(&workspace.to_string_lossy());
        repository
            .with_connection(|connection| {
                let (workspace_id, environment_id): (i64, String) = connection
                    .query_row(
                        r#"SELECT w.id, e.id FROM workspaces w
                           JOIN execution_environments e ON e.workspace_id = w.id
                           WHERE w.workspace_path = ?1"#,
                        [&execution_root],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        r#"INSERT INTO runs(
                            id, workspace_id, task_id, idempotency_key, status,
                            agent_outcome, verification_outcome, execution_root,
                            queued_at, started_at, finished_at, version,
                            execution_environment_id, input_json, history_json, prompt,
                            mode, approval_policy, sandbox_mode, turn_id,
                            verification_baseline_state
                         ) VALUES (
                            ?1, ?2, 'task', ?3, 'completed', 'completed',
                            'not_requested', ?4, 1, 1, 1, 0, ?5, '[]', '[]',
                            'Change note', 'default', 'on-request', 'workspace-write',
                            'turn-1', 'not_required'
                         )"#,
                        params![
                            run_id,
                            workspace_id,
                            format!("test:{run_id}"),
                            execution_root,
                            environment_id
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        repository
            .record_turn_checkpoint(&run_id, "turn-1", &capture)
            .unwrap();
        let checkpoint = repository
            .list_turn_checkpoints(&execution_root, "task", None)
            .unwrap()
            .remove(0);

        repository
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE turn_checkpoints SET patch_sha256 = ?1 WHERE id = ?2",
                        params!["0".repeat(64), checkpoint.id],
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(repository
            .restore_turn_checkpoints(&execution_root, "task", &checkpoint.id, &execution_root,)
            .is_err());
        assert_eq!(read_text(&workspace.join("note.txt")), "after\n");
        repository
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE turn_checkpoints SET patch_sha256 = ?1 WHERE id = ?2",
                        params![sha256_hex(capture.patch.as_bytes()), checkpoint.id],
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        repository
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        r#"CREATE TRIGGER fail_time_travel_event
                           BEFORE INSERT ON run_events
                           WHEN NEW.event_type = 'time_travel.restored'
                           BEGIN SELECT RAISE(ABORT, 'injected restore event failure'); END;"#,
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        let failed = repository.restore_turn_checkpoints(
            &execution_root,
            "task",
            &checkpoint.id,
            &execution_root,
        );
        assert!(failed.is_err());
        assert_eq!(read_text(&workspace.join("note.txt")), "after\n");
        assert_eq!(
            repository
                .list_turn_checkpoints(&execution_root, "task", None)
                .unwrap()[0]
                .restored_at,
            None
        );

        repository
            .with_connection(|connection| {
                connection
                    .execute_batch("DROP TRIGGER fail_time_travel_event;")
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        let restored = repository
            .restore_turn_checkpoints(&execution_root, "task", &checkpoint.id, &execution_root)
            .unwrap();
        assert_eq!(restored.restored_turn_count, 1);
        assert_eq!(read_text(&workspace.join("note.txt")), "before\n");
        assert!(repository
            .list_turn_checkpoints(&execution_root, "task", None)
            .unwrap()[0]
            .restored_at
            .is_some());
        assert_eq!(
            repository
                .list_run_events(&run_id, None, None)
                .unwrap()
                .iter()
                .filter(|event| event.event_type == "time_travel.restored")
                .count(),
            1
        );

        drop(repository);
        fs::remove_dir_all(app_data).unwrap();
        fs::remove_dir_all(workspace).unwrap();
    }
}
