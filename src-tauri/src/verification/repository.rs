use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

use crate::runs::repository::{new_uuid_v7, now_millis};
use crate::xiao::repository::{normalize_workspace_path, XiaoRepository};

use super::models::{
    AcceptanceContractDraft, AcceptanceContractSnapshot, AcceptanceContractVersionRecord,
    AcceptanceContractVersionSummary, NormalizedAcceptanceContract,
};

pub(crate) const TASK_ACCEPTANCE_CONTRACT_CONFLICT: &str =
    "The Xiao task acceptance contract changed. Refresh and try again.";

impl XiaoRepository {
    pub(crate) fn load_routine_acceptance_contract(
        &self,
        routine_id: &str,
    ) -> Result<Option<AcceptanceContractVersionSummary>, String> {
        self.with_connection(|connection| {
            let (workspace_id, version_id) = connection
                .query_row(
                    r#"SELECT workspace_id, acceptance_contract_version_id
                     FROM routines WHERE id = ?1 AND deleted_at IS NULL"#,
                    [routine_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()
                .map_err(|error| format!("Could not load Xiao routine contract: {error}"))?
                .ok_or("The Xiao routine was not found.")?;
            load_optional_acceptance_contract_version_from_connection(
                connection,
                workspace_id,
                version_id.as_deref(),
            )
            .map(|record| record.map(|record| record.summary))
        })
    }

    pub(crate) fn save_task_acceptance_contract(
        &self,
        workspace_path: &str,
        task_id: &str,
        expected_current_version_id: Option<&str>,
        draft: Option<&AcceptanceContractDraft>,
    ) -> Result<Option<AcceptanceContractVersionSummary>, String> {
        let workspace_path = normalize_workspace_path(workspace_path);
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start task contract save: {error}"))?;
            let (workspace_id, current_version_id) =
                task_contract_binding(&transaction, &workspace_path, task_id)?;
            if current_version_id.as_deref() != expected_current_version_id {
                return Err(TASK_ACCEPTANCE_CONTRACT_CONFLICT.to_owned());
            }
            let saved = save_or_clear_acceptance_contract_in_transaction(
                &transaction,
                workspace_id,
                current_version_id.as_deref(),
                draft,
                now_millis()?,
            )?;
            let saved_version_id = saved
                .as_ref()
                .map(|record| record.summary.version_id.as_str());
            let changed = transaction
                .execute(
                    r#"UPDATE tasks SET acceptance_contract_version_id = ?1
                     WHERE workspace_id = ?2 AND task_id = ?3
                       AND acceptance_contract_version_id IS ?4"#,
                    params![
                        saved_version_id,
                        workspace_id,
                        task_id,
                        expected_current_version_id
                    ],
                )
                .map_err(|error| format!("Could not bind task acceptance contract: {error}"))?;
            if changed != 1 {
                return Err(TASK_ACCEPTANCE_CONTRACT_CONFLICT.to_owned());
            }
            transaction
                .commit()
                .map_err(|error| format!("Could not commit task contract save: {error}"))?;
            Ok(saved.map(|record| record.summary))
        })
    }
}

pub(crate) fn save_or_clear_acceptance_contract_in_transaction(
    transaction: &Transaction<'_>,
    workspace_id: i64,
    current_version_id: Option<&str>,
    draft: Option<&AcceptanceContractDraft>,
    timestamp: i64,
) -> Result<Option<AcceptanceContractVersionRecord>, String> {
    let current = current_version_id
        .map(|version_id| {
            load_acceptance_contract_version_for_workspace(transaction, workspace_id, version_id)
        })
        .transpose()?;
    let Some(draft) = draft else {
        return Ok(None);
    };
    let normalized = draft.normalize()?;
    if let Some(current) = current.as_ref() {
        if current.summary.hash == normalized.content_sha256
            && current.summary.snapshot() == normalized.snapshot
        {
            return Ok(Some(current.clone()));
        }
    }

    let contract_id = current
        .as_ref()
        .map(|record| record.summary.contract_id.clone())
        .unwrap_or_else(new_uuid_v7);
    let next_version: i64 = transaction
        .query_row(
            r#"SELECT COALESCE(MAX(version), 0) + 1
             FROM acceptance_contract_versions WHERE contract_id = ?1"#,
            [&contract_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not allocate acceptance contract version: {error}"))?;
    let next_version = u32::try_from(next_version)
        .map_err(|_| "The acceptance contract version is invalid.".to_owned())?;
    insert_acceptance_contract_version(
        transaction,
        workspace_id,
        contract_id,
        next_version,
        normalized,
        timestamp,
    )
    .map(Some)
}

pub(crate) fn load_optional_acceptance_contract_version_from_connection(
    connection: &Connection,
    workspace_id: i64,
    version_id: Option<&str>,
) -> Result<Option<AcceptanceContractVersionRecord>, String> {
    version_id
        .map(|version_id| {
            load_acceptance_contract_version_for_workspace(connection, workspace_id, version_id)
        })
        .transpose()
}

pub(crate) fn load_acceptance_contract_version_from_connection(
    connection: &Connection,
    version_id: &str,
) -> Result<AcceptanceContractVersionRecord, String> {
    let stored = connection
        .query_row(
            r#"SELECT version_id, contract_id, workspace_id, version, schema_version,
                name, gates_json, content_sha256, created_at, updated_at
             FROM acceptance_contract_versions WHERE version_id = ?1"#,
            [version_id],
            |row| {
                Ok(StoredAcceptanceContractVersion {
                    version_id: row.get(0)?,
                    contract_id: row.get(1)?,
                    workspace_id: row.get(2)?,
                    version: row.get(3)?,
                    schema: row.get(4)?,
                    name: row.get(5)?,
                    gates_json: row.get(6)?,
                    hash: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Could not load acceptance contract version: {error}"))?
        .ok_or("The acceptance contract version was not found.")?;
    stored.decode()
}

pub(crate) fn encode_optional_contract_snapshot(
    snapshot: Option<&AcceptanceContractSnapshot>,
    expected_sha256: Option<&str>,
) -> Result<Option<String>, String> {
    match (snapshot, expected_sha256) {
        (None, None) => Ok(None),
        (Some(snapshot), Some(expected_sha256)) => {
            let normalized = snapshot.validate_canonical()?;
            if normalized.content_sha256 != expected_sha256 {
                return Err(
                    "The acceptance contract snapshot hash does not match its content.".to_owned(),
                );
            }
            Ok(Some(normalized.canonical_json))
        }
        _ => Err("Acceptance contract snapshots and hashes must be stored together.".to_owned()),
    }
}

pub(crate) fn decode_optional_contract_snapshot(
    snapshot_json: Option<&str>,
    expected_sha256: Option<&str>,
) -> Result<Option<AcceptanceContractSnapshot>, String> {
    match (snapshot_json, expected_sha256) {
        (None, None) => Ok(None),
        (Some(snapshot_json), Some(expected_sha256)) => {
            let snapshot: AcceptanceContractSnapshot = serde_json::from_str(snapshot_json)
                .map_err(|error| {
                    format!("Could not decode acceptance contract snapshot: {error}")
                })?;
            let normalized = snapshot.validate_canonical()?;
            if normalized.canonical_json != snapshot_json {
                return Err("The stored acceptance contract snapshot is not canonical.".to_owned());
            }
            if normalized.content_sha256 != expected_sha256 {
                return Err("The stored acceptance contract snapshot hash is invalid.".to_owned());
            }
            Ok(Some(snapshot))
        }
        _ => {
            Err("Stored acceptance contract snapshots and hashes must appear together.".to_owned())
        }
    }
}

fn task_contract_binding(
    connection: &Connection,
    workspace_path: &str,
    task_id: &str,
) -> Result<(i64, Option<String>), String> {
    connection
        .query_row(
            r#"SELECT w.id, t.acceptance_contract_version_id
             FROM workspaces w JOIN tasks t ON t.workspace_id = w.id
             WHERE w.workspace_path = ?1 AND t.task_id = ?2"#,
            params![workspace_path, task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("Could not load Xiao task contract binding: {error}"))?
        .ok_or_else(|| format!("Xiao task `{task_id}` was not found."))
}

fn load_acceptance_contract_version_for_workspace(
    connection: &Connection,
    workspace_id: i64,
    version_id: &str,
) -> Result<AcceptanceContractVersionRecord, String> {
    let record = load_acceptance_contract_version_from_connection(connection, version_id)?;
    if record.workspace_id != workspace_id {
        return Err("The acceptance contract belongs to another workspace.".to_owned());
    }
    Ok(record)
}

fn insert_acceptance_contract_version(
    transaction: &Transaction<'_>,
    workspace_id: i64,
    contract_id: String,
    version: u32,
    normalized: NormalizedAcceptanceContract,
    timestamp: i64,
) -> Result<AcceptanceContractVersionRecord, String> {
    let version_id = new_uuid_v7();
    let gates_json = serde_json::to_string(&normalized.snapshot.gates)
        .map_err(|error| format!("Could not serialize acceptance contract gates: {error}"))?;
    transaction
        .execute(
            r#"INSERT INTO acceptance_contract_versions(
                version_id, contract_id, workspace_id, version, schema_version,
                name, gates_json, content_sha256, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)"#,
            params![
                version_id,
                contract_id,
                workspace_id,
                version,
                normalized.snapshot.schema_version,
                normalized.snapshot.name,
                gates_json,
                normalized.content_sha256,
                timestamp,
            ],
        )
        .map_err(|error| format!("Could not save acceptance contract version: {error}"))?;
    load_acceptance_contract_version_from_connection(transaction, &version_id)
}

struct StoredAcceptanceContractVersion {
    version_id: String,
    contract_id: String,
    workspace_id: i64,
    version: i64,
    schema: i64,
    name: String,
    gates_json: String,
    hash: String,
    created_at: i64,
    updated_at: i64,
}

impl StoredAcceptanceContractVersion {
    fn decode(self) -> Result<AcceptanceContractVersionRecord, String> {
        let version = u32::try_from(self.version)
            .map_err(|_| "The acceptance contract version is invalid.".to_owned())?;
        let schema = u32::try_from(self.schema)
            .map_err(|_| "The acceptance contract schema is invalid.".to_owned())?;
        let gates = serde_json::from_str(&self.gates_json)
            .map_err(|error| format!("Could not decode acceptance contract gates: {error}"))?;
        let snapshot = AcceptanceContractSnapshot {
            schema_version: schema,
            name: self.name.clone(),
            gates,
        };
        let normalized = snapshot.validate_canonical()?;
        let canonical_gates = serde_json::to_string(&snapshot.gates)
            .map_err(|error| format!("Could not validate acceptance contract gates: {error}"))?;
        if canonical_gates != self.gates_json || normalized.content_sha256 != self.hash {
            return Err("The stored acceptance contract content hash is invalid.".to_owned());
        }
        Ok(AcceptanceContractVersionRecord {
            workspace_id: self.workspace_id,
            summary: AcceptanceContractVersionSummary {
                version_id: self.version_id,
                contract_id: self.contract_id,
                version,
                schema,
                name: self.name,
                gates: snapshot.gates,
                hash: self.hash,
                created_at: self.created_at,
                updated_at: self.updated_at,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::verification::models::AcceptanceGate;
    use crate::xiao::models::{
        XiaoTaskDocument, XiaoWorkspaceMode, XiaoWorkspaceUpdate, XIAO_SCHEMA_VERSION,
    };

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "xiao-m5-contract-{label}-{}-{}",
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

    fn save_workspace(
        repository: &XiaoRepository,
        root: &Path,
        directory_name: &str,
        task_id: &str,
    ) -> String {
        let workspace = root.join(directory_name);
        fs::create_dir_all(&workspace).unwrap();
        let workspace_path = workspace.to_string_lossy().into_owned();
        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: workspace_path.clone(),
                active_task_id: Some(task_id.to_owned()),
                show_archived: false,
                task_ids: vec![task_id.to_owned()],
                tasks: vec![task(task_id)],
            })
            .unwrap();
        normalize_workspace_path(&workspace_path)
    }

    fn command_contract(
        name: &str,
        executable: &str,
        expected_exit_codes: Vec<i32>,
    ) -> AcceptanceContractDraft {
        AcceptanceContractDraft {
            name: name.to_owned(),
            gates: vec![AcceptanceGate::Command {
                executable: executable.to_owned(),
                argv: vec!["test".to_owned()],
                timeout_ms: 30_000,
                expected_exit_codes,
            }],
        }
    }

    fn load_task_contract(
        repository: &XiaoRepository,
        workspace_path: &str,
        task_id: &str,
    ) -> Result<Option<AcceptanceContractVersionSummary>, String> {
        repository.with_connection(|connection| {
            let (workspace_id, version_id) =
                task_contract_binding(connection, workspace_path, task_id)?;
            load_optional_acceptance_contract_version_from_connection(
                connection,
                workspace_id,
                version_id.as_deref(),
            )
            .map(|record| record.map(|record| record.summary))
        })
    }

    #[test]
    fn task_contract_versions_are_immutable_reused_and_preserved_after_clear() {
        let directory = TestDirectory::new("versions");
        let repository = XiaoRepository::open(&directory.0).unwrap();
        let workspace = save_workspace(&repository, &directory.0, "workspace", "task");
        let original_draft = command_contract(" Verify ", " cargo ", vec![1, 0, 1]);
        let original_snapshot = original_draft.normalize().unwrap().snapshot;

        let version_one = repository
            .save_task_acceptance_contract(&workspace, "task", None, Some(&original_draft))
            .unwrap()
            .unwrap();
        assert_eq!(version_one.version, 1);
        assert_eq!(version_one.snapshot(), original_snapshot);
        assert_eq!(
            load_task_contract(&repository, &workspace, "task").unwrap(),
            Some(version_one.clone())
        );

        let identical = command_contract("Verify", "cargo", vec![0, 1]);
        let reused = repository
            .save_task_acceptance_contract(
                &workspace,
                "task",
                Some(&version_one.version_id),
                Some(&identical),
            )
            .unwrap()
            .unwrap();
        assert_eq!(reused, version_one);

        let changed_draft = command_contract("Verify changed", "cargo", vec![0, 1]);
        let version_two = repository
            .save_task_acceptance_contract(
                &workspace,
                "task",
                Some(&version_one.version_id),
                Some(&changed_draft),
            )
            .unwrap()
            .unwrap();
        assert_eq!(version_two.version, 2);
        assert_eq!(version_two.contract_id, version_one.contract_id);
        assert_ne!(version_two.version_id, version_one.version_id);
        assert_eq!(
            repository
                .with_connection(|connection| {
                    load_acceptance_contract_version_from_connection(
                        connection,
                        &version_one.version_id,
                    )
                    .map(|record| record.summary)
                })
                .unwrap(),
            version_one
        );

        assert_eq!(
            repository
                .save_task_acceptance_contract(
                    &workspace,
                    "task",
                    Some(&version_two.version_id),
                    None,
                )
                .unwrap(),
            None
        );
        assert_eq!(
            load_task_contract(&repository, &workspace, "task").unwrap(),
            None
        );
        let stored_versions = repository
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM acceptance_contract_versions WHERE contract_id = ?1",
                        [&version_two.contract_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(stored_versions, 2);
    }

    #[test]
    fn stale_task_contract_update_and_clear_conflict_without_orphan_versions() {
        let directory = TestDirectory::new("stale-cas");
        let repository = XiaoRepository::open(&directory.0).unwrap();
        let workspace = save_workspace(&repository, &directory.0, "workspace", "task");
        let version_one = repository
            .save_task_acceptance_contract(
                &workspace,
                "task",
                None,
                Some(&command_contract("Version one", "cargo", vec![0])),
            )
            .unwrap()
            .unwrap();
        let version_two = repository
            .save_task_acceptance_contract(
                &workspace,
                "task",
                Some(&version_one.version_id),
                Some(&command_contract("Version two", "cargo", vec![0])),
            )
            .unwrap()
            .unwrap();

        let stale_update = repository
            .save_task_acceptance_contract(
                &workspace,
                "task",
                Some(&version_one.version_id),
                Some(&command_contract("Orphan candidate", "cargo", vec![0])),
            )
            .unwrap_err();
        let stale_clear = repository
            .save_task_acceptance_contract(&workspace, "task", Some(&version_one.version_id), None)
            .unwrap_err();

        assert_eq!(stale_update, TASK_ACCEPTANCE_CONTRACT_CONFLICT);
        assert_eq!(stale_clear, TASK_ACCEPTANCE_CONTRACT_CONFLICT);
        assert_eq!(
            load_task_contract(&repository, &workspace, "task").unwrap(),
            Some(version_two.clone())
        );
        let stored_versions = repository
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM acceptance_contract_versions WHERE contract_id = ?1",
                        [&version_two.contract_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(stored_versions, 2);
    }

    #[test]
    fn task_contract_binding_fails_closed_across_workspaces() {
        let directory = TestDirectory::new("cross-workspace");
        let repository = XiaoRepository::open(&directory.0).unwrap();
        let workspace_a = save_workspace(&repository, &directory.0, "workspace-a", "task-a");
        let workspace_b = save_workspace(&repository, &directory.0, "workspace-b", "task-b");
        let draft = command_contract("Verify", "cargo", vec![0]);
        let version = repository
            .save_task_acceptance_contract(&workspace_a, "task-a", None, Some(&draft))
            .unwrap()
            .unwrap();

        repository
            .with_connection(|connection| {
                connection
                    .execute(
                        r#"UPDATE tasks SET acceptance_contract_version_id = ?1
                           WHERE workspace_id = (
                               SELECT id FROM workspaces WHERE workspace_path = ?2
                           ) AND task_id = 'task-b'"#,
                        params![version.version_id, workspace_b],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        assert!(load_task_contract(&repository, &workspace_b, "task-b").is_err());
        assert!(repository
            .save_task_acceptance_contract(
                &workspace_b,
                "task-b",
                Some(&version.version_id),
                Some(&draft),
            )
            .is_err());
    }

    #[test]
    fn contract_snapshot_repository_boundary_rejects_hash_mismatch() {
        let normalized = AcceptanceContractDraft {
            name: "Verify".to_owned(),
            gates: vec![AcceptanceGate::Cleanliness {
                allow_staged: false,
                allow_unstaged: false,
                allow_untracked: false,
            }],
        }
        .normalize()
        .unwrap();

        assert!(encode_optional_contract_snapshot(
            Some(&normalized.snapshot),
            Some(&"0".repeat(64))
        )
        .is_err());
        let encoded = encode_optional_contract_snapshot(
            Some(&normalized.snapshot),
            Some(&normalized.content_sha256),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            decode_optional_contract_snapshot(Some(&encoded), Some(&normalized.content_sha256))
                .unwrap(),
            Some(normalized.snapshot)
        );
    }
}
