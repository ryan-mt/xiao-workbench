use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::models::{
    XiaoLegacyStore, XiaoProjectSummary, XiaoTaskDocument, XiaoThreadBinding,
    XiaoThreadPersistence, XiaoTimelinePage, XiaoWorkspaceDocument, XiaoWorkspaceUpdate,
    XIAO_DATABASE_SCHEMA_VERSION, XIAO_SCHEMA_VERSION,
};

const DATABASE_FILE_NAME: &str = "xiao-state.sqlite3";
const LEGACY_STORE_FILE_NAME: &str = "xiao-state-v1.json";
const INITIAL_TIMELINE_PAGE_SIZE: usize = 200;
const DEFAULT_TIMELINE_PAGE_SIZE: usize = 200;
const MAX_TIMELINE_PAGE_SIZE: usize = 200;

const MIGRATION_1_SQL: &str = r#"
CREATE TABLE legacy_imports (
    source_name TEXT PRIMARY KEY,
    source_sha256 TEXT NOT NULL,
    backup_name TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    workspace_count INTEGER NOT NULL,
    task_count INTEGER NOT NULL,
    timeline_entry_count INTEGER NOT NULL
);

CREATE TABLE workspaces (
    id INTEGER PRIMARY KEY,
    workspace_path TEXT NOT NULL UNIQUE,
    active_task_id TEXT,
    show_archived INTEGER NOT NULL CHECK (show_archived IN (0, 1)),
    updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tasks (
    workspace_id INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    draft_text TEXT NOT NULL,
    follow_ups_json TEXT NOT NULL CHECK (json_valid(follow_ups_json)),
    archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
    unread INTEGER NOT NULL CHECK (unread IN (0, 1)),
    model TEXT,
    reasoning_effort TEXT,
    thread_binding_json TEXT CHECK (
        thread_binding_json IS NULL OR json_valid(thread_binding_json)
    ),
    mode TEXT NOT NULL,
    approval_policy TEXT NOT NULL,
    sandbox_mode TEXT NOT NULL,
    goal_json TEXT CHECK (goal_json IS NULL OR json_valid(goal_json)),
    plan_json TEXT CHECK (plan_json IS NULL OR json_valid(plan_json)),
    timeline_sha256 TEXT,
    timeline_entry_count INTEGER NOT NULL DEFAULT 0 CHECK (timeline_entry_count >= 0),
    PRIMARY KEY (workspace_id, task_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX tasks_by_workspace_position
    ON tasks(workspace_id, position);
CREATE INDEX tasks_by_updated_at
    ON tasks(updated_at DESC);

CREATE TABLE task_timeline_entries (
    workspace_id INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    entry_json TEXT NOT NULL CHECK (json_valid(entry_json)),
    PRIMARY KEY (workspace_id, task_id, position),
    FOREIGN KEY (workspace_id, task_id)
        REFERENCES tasks(workspace_id, task_id) ON DELETE CASCADE
);

CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    parent_run_id TEXT,
    candidate_group_id TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'preparing', 'running', 'waiting_for_input', 'verifying',
        'completed', 'needs_attention', 'failed', 'cancelled', 'interrupted'
    )),
    agent_outcome TEXT NOT NULL CHECK (agent_outcome IN (
        'pending', 'completed', 'failed', 'interrupted', 'cancelled'
    )),
    verification_outcome TEXT NOT NULL CHECK (verification_outcome IN (
        'not_requested', 'pending', 'passed', 'failed', 'blocked'
    )),
    execution_root TEXT NOT NULL,
    queued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    FOREIGN KEY (workspace_id, task_id)
        REFERENCES tasks(workspace_id, task_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_run_id) REFERENCES runs(id) ON DELETE SET NULL
);

CREATE INDEX runs_by_task_time
    ON runs(workspace_id, task_id, queued_at DESC);
CREATE INDEX runs_by_status_time
    ON runs(status, queued_at);

CREATE TABLE run_events (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    timestamp INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    safe_payload_json TEXT NOT NULL CHECK (json_valid(safe_payload_json)),
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
"#;

pub struct XiaoRepository {
    state: Mutex<RepositoryState>,
}

struct RepositoryState {
    connection: Option<Connection>,
    initialization_error: Option<String>,
}

#[derive(Clone, Copy, Default)]
struct RepositoryOpenOptions {
    fail_legacy_before_commit: bool,
}

impl XiaoRepository {
    pub fn initialize(app_data_dir: PathBuf) -> Self {
        match open_connection(&app_data_dir, RepositoryOpenOptions::default()) {
            Ok(connection) => Self {
                state: Mutex::new(RepositoryState {
                    connection: Some(connection),
                    initialization_error: None,
                }),
            },
            Err(error) => Self {
                state: Mutex::new(RepositoryState {
                    connection: None,
                    initialization_error: Some(error),
                }),
            },
        }
    }

    #[cfg(test)]
    fn open(app_data_dir: &Path) -> Result<Self, String> {
        Self::open_with_options(app_data_dir, RepositoryOpenOptions::default())
    }

    #[cfg(test)]
    fn open_with_options(
        app_data_dir: &Path,
        options: RepositoryOpenOptions,
    ) -> Result<Self, String> {
        let connection = open_connection(app_data_dir, options)?;
        Ok(Self {
            state: Mutex::new(RepositoryState {
                connection: Some(connection),
                initialization_error: None,
            }),
        })
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if let Some(error) = &state.initialization_error {
            return Err(error.clone());
        }
        let connection = state
            .connection
            .as_mut()
            .ok_or("Xiao state database is unavailable.")?;
        operation(connection)
    }

    pub fn load_workspace(
        &self,
        workspace_path: &str,
        include_active_timeline: bool,
    ) -> Result<Option<XiaoWorkspaceDocument>, String> {
        self.with_connection(|connection| {
            load_workspace_from_connection(
                connection,
                &normalize_workspace_path(workspace_path),
                include_active_timeline,
                false,
            )
        })
    }

    pub fn load_timeline_page(
        &self,
        workspace_path: &str,
        task_id: &str,
        before: Option<usize>,
        limit: Option<usize>,
    ) -> Result<XiaoTimelinePage, String> {
        self.with_connection(|connection| {
            load_timeline_page_from_connection(
                connection,
                &normalize_workspace_path(workspace_path),
                task_id,
                before,
                limit,
            )
        })
    }

    pub fn save_workspace(&self, update: XiaoWorkspaceUpdate) -> Result<(), String> {
        self.with_connection(|connection| save_workspace_update(connection, update, false))
    }

    #[cfg(test)]
    fn save_workspace_failing_before_commit(
        &self,
        update: XiaoWorkspaceUpdate,
    ) -> Result<(), String> {
        self.with_connection(|connection| save_workspace_update(connection, update, true))
    }

    pub fn list_projects(&self) -> Result<Vec<XiaoProjectSummary>, String> {
        self.with_connection(list_projects_from_connection)
    }
}

fn open_connection(
    app_data_dir: &Path,
    options: RepositoryOpenOptions,
) -> Result<Connection, String> {
    fs::create_dir_all(app_data_dir).map_err(|error| {
        format!(
            "Could not create Xiao state directory {}: {error}",
            app_data_dir.display()
        )
    })?;
    let database_path = app_data_dir.join(DATABASE_FILE_NAME);
    let mut connection = Connection::open(&database_path).map_err(|error| {
        format!(
            "Could not open Xiao state database {}: {error}",
            database_path.display()
        )
    })?;
    configure_connection(&mut connection)?;
    apply_migrations(&mut connection)?;
    migrate_legacy_store(
        &mut connection,
        app_data_dir,
        options.fail_legacy_before_commit,
    )?;
    Ok(connection)
}

fn configure_connection(connection: &mut Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Could not configure Xiao database busy timeout: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("Could not enable Xiao database foreign keys: {error}"))?;
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(|error| format!("Could not enable Xiao database WAL mode: {error}"))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(format!(
            "Xiao database did not enter WAL mode (reported `{journal_mode}`)."
        ));
    }
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| format!("Could not enable full Xiao database sync: {error}"))?;
    Ok(())
}

fn apply_migrations(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at INTEGER NOT NULL
            );"#,
        )
        .map_err(|error| format!("Could not initialize Xiao database migrations: {error}"))?;

    let newest: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not read Xiao database schema version: {error}"))?;
    if newest > XIAO_DATABASE_SCHEMA_VERSION {
        return Err(format!(
            "Xiao state database schema {newest} is newer than this app supports ({}).",
            XIAO_DATABASE_SCHEMA_VERSION
        ));
    }

    let migrations = [(1_i64, "durable_workspace_and_run_store", MIGRATION_1_SQL)];
    for (version, name, sql) in migrations {
        let already_applied = connection
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE version = ?1",
                [version],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| format!("Could not inspect Xiao migration {version}: {error}"))?
            .is_some();
        if already_applied {
            continue;
        }

        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Could not start Xiao migration {version}: {error}"))?;
        let applied_while_waiting = transaction
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE version = ?1",
                [version],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| format!("Could not recheck Xiao migration {version}: {error}"))?
            .is_some();
        if applied_while_waiting {
            transaction.commit().map_err(|error| {
                format!("Could not finish Xiao migration {version} check: {error}")
            })?;
            continue;
        }
        transaction
            .execute_batch(sql)
            .map_err(|error| format!("Could not apply Xiao migration {version}: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![version, name, now_millis()?],
            )
            .map_err(|error| format!("Could not record Xiao migration {version}: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit Xiao migration {version}: {error}"))?;
    }
    Ok(())
}

fn migrate_legacy_store(
    connection: &mut Connection,
    app_data_dir: &Path,
    fail_before_commit: bool,
) -> Result<(), String> {
    let already_imported = connection
        .query_row(
            "SELECT 1 FROM legacy_imports WHERE source_name = ?1",
            [LEGACY_STORE_FILE_NAME],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Could not inspect Xiao legacy migration marker: {error}"))?
        .is_some();
    if already_imported {
        return Ok(());
    }

    let legacy_path = app_data_dir.join(LEGACY_STORE_FILE_NAME);
    if !legacy_path.exists() {
        return Ok(());
    }

    let source_bytes = fs::read(&legacy_path).map_err(|error| {
        format!(
            "Could not read legacy Xiao state {}: {error}",
            legacy_path.display()
        )
    })?;
    let source_sha256 = sha256_hex(&source_bytes);
    let mut store: XiaoLegacyStore = serde_json::from_slice(&source_bytes)
        .map_err(|error| format!("Invalid legacy Xiao state file: {error}"))?;
    normalize_legacy_store(&mut store)?;

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start legacy Xiao migration: {error}"))?;
    let imported_while_waiting = transaction
        .query_row(
            "SELECT 1 FROM legacy_imports WHERE source_name = ?1",
            [LEGACY_STORE_FILE_NAME],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Could not recheck Xiao legacy migration marker: {error}"))?
        .is_some();
    if imported_while_waiting {
        return transaction
            .commit()
            .map_err(|error| format!("Could not finish Xiao legacy migration check: {error}"));
    }
    let existing_workspaces: i64 = transaction
        .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
        .map_err(|error| format!("Could not inspect Xiao state before migration: {error}"))?;
    if existing_workspaces != 0 {
        return Err(
            "Xiao found legacy JSON beside a non-empty unmarked database and refused to merge them automatically."
                .to_owned(),
        );
    }

    let backup_path = ensure_legacy_backup(app_data_dir, &source_bytes, &source_sha256)?;
    let backup_name = backup_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Legacy Xiao backup file name is invalid.")?
        .to_owned();

    let workspace_count = store.workspaces.len();
    let task_count = store
        .workspaces
        .iter()
        .map(|workspace| workspace.tasks.len())
        .sum::<usize>();
    let timeline_entry_count = store
        .workspaces
        .iter()
        .flat_map(|workspace| &workspace.tasks)
        .map(|task| task.timeline.len())
        .sum::<usize>();
    let expected_hashes = store
        .workspaces
        .iter()
        .map(|workspace| {
            Ok((
                workspace.workspace_path.clone(),
                canonical_document_hash(workspace)?,
            ))
        })
        .collect::<Result<HashMap<_, _>, String>>()?;

    for workspace in &store.workspaces {
        apply_workspace_update(&transaction, document_as_update(workspace.clone()))?;
    }
    verify_legacy_import(
        &transaction,
        workspace_count,
        task_count,
        timeline_entry_count,
        &expected_hashes,
    )?;
    transaction
        .execute(
            r#"INSERT INTO legacy_imports(
                source_name, source_sha256, backup_name, imported_at,
                workspace_count, task_count, timeline_entry_count
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
            params![
                LEGACY_STORE_FILE_NAME,
                source_sha256,
                backup_name,
                now_millis()?,
                to_i64(workspace_count, "workspace count")?,
                to_i64(task_count, "task count")?,
                to_i64(timeline_entry_count, "timeline entry count")?,
            ],
        )
        .map_err(|error| format!("Could not record legacy Xiao migration: {error}"))?;
    #[cfg(debug_assertions)]
    if let Some(pause_ms) = std::env::var_os("XIAO_TEST_MIGRATION_PAUSE_MS")
        .and_then(|value| value.to_string_lossy().parse::<u64>().ok())
        .filter(|value| *value > 0 && *value <= 60_000)
    {
        std::thread::sleep(Duration::from_millis(pause_ms));
    }
    if fail_before_commit {
        return Err("Injected failure before legacy migration commit.".to_owned());
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not commit legacy Xiao migration: {error}"))
}

fn ensure_legacy_backup(
    app_data_dir: &Path,
    source_bytes: &[u8],
    source_sha256: &str,
) -> Result<PathBuf, String> {
    let backup_name = format!(
        "{LEGACY_STORE_FILE_NAME}.{}.pre-sqlite.bak",
        &source_sha256[..16]
    );
    let backup_path = app_data_dir.join(&backup_name);
    if backup_path.exists() {
        verify_legacy_backup(&backup_path, source_bytes)?;
        return Ok(backup_path);
    }

    let temporary_path = app_data_dir.join(format!(".{backup_name}.tmp"));
    if temporary_path.exists() {
        fs::remove_file(&temporary_path).map_err(|error| {
            format!(
                "Could not remove interrupted Xiao backup {}: {error}",
                temporary_path.display()
            )
        })?;
    }
    let result = (|| {
        let mut backup = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|error| {
                format!(
                    "Could not create temporary Xiao backup {}: {error}",
                    temporary_path.display()
                )
            })?;
        backup.write_all(source_bytes).map_err(|error| {
            format!(
                "Could not write temporary Xiao backup {}: {error}",
                temporary_path.display()
            )
        })?;
        backup.sync_all().map_err(|error| {
            format!(
                "Could not sync temporary Xiao backup {}: {error}",
                temporary_path.display()
            )
        })?;
        drop(backup);
        fs::rename(&temporary_path, &backup_path).map_err(|error| {
            format!(
                "Could not finalize legacy Xiao backup {}: {error}",
                backup_path.display()
            )
        })?;
        sync_directory(app_data_dir)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    Ok(backup_path)
}

fn verify_legacy_backup(backup_path: &Path, source_bytes: &[u8]) -> Result<(), String> {
    let existing = fs::read(backup_path).map_err(|error| {
        format!(
            "Could not verify legacy Xiao backup {}: {error}",
            backup_path.display()
        )
    })?;
    if existing != source_bytes {
        return Err(format!(
            "Legacy Xiao backup {} exists with different contents.",
            backup_path.display()
        ));
    }
    Ok(())
}

fn verify_legacy_import(
    connection: &Connection,
    expected_workspaces: usize,
    expected_tasks: usize,
    expected_timeline_entries: usize,
    expected_hashes: &HashMap<String, String>,
) -> Result<(), String> {
    let workspace_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
        .map_err(|error| format!("Could not verify migrated workspaces: {error}"))?;
    let task_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
        .map_err(|error| format!("Could not verify migrated tasks: {error}"))?;
    let timeline_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM task_timeline_entries", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Could not verify migrated timeline entries: {error}"))?;
    if workspace_count != to_i64(expected_workspaces, "workspace count")?
        || task_count != to_i64(expected_tasks, "task count")?
        || timeline_count != to_i64(expected_timeline_entries, "timeline entry count")?
    {
        return Err("Legacy Xiao migration count verification failed.".to_owned());
    }

    for (workspace_path, expected_hash) in expected_hashes {
        let document = load_workspace_from_connection(connection, workspace_path, true, true)?
            .ok_or_else(|| format!("Migrated workspace `{workspace_path}` was not found."))?;
        let actual_hash = canonical_document_hash(&document)?;
        if &actual_hash != expected_hash {
            return Err(format!(
                "Legacy Xiao migration field verification failed for `{workspace_path}`."
            ));
        }
    }
    Ok(())
}

fn normalize_legacy_store(store: &mut XiaoLegacyStore) -> Result<(), String> {
    if store.schema_version != XIAO_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported legacy Xiao state schema version {}.",
            store.schema_version
        ));
    }

    let mut workspaces: Vec<XiaoWorkspaceDocument> = Vec::new();
    for mut document in std::mem::take(&mut store.workspaces) {
        document.workspace_path = normalize_workspace_path(&document.workspace_path);
        prepare_legacy_document(&mut document);
        remove_empty_bootstrap_tasks(&mut document);
        if let Some(existing) = workspaces
            .iter_mut()
            .find(|workspace| workspace.workspace_path == document.workspace_path)
        {
            merge_workspace_documents(existing, document);
            remove_empty_bootstrap_tasks(existing);
        } else {
            workspaces.push(document);
        }
    }
    for document in &workspaces {
        validate_document(document)?;
    }
    store.workspaces = workspaces;
    Ok(())
}

fn prepare_legacy_document(document: &mut XiaoWorkspaceDocument) {
    for task in &mut document.tasks {
        let legacy_thread_id = task.thread_id.take();
        if task.thread_binding.is_none() {
            task.thread_binding = legacy_thread_id.map(|thread_id| XiaoThreadBinding {
                thread_id,
                persistence: XiaoThreadPersistence::LegacyUntrusted,
                materialized: false,
                thread_source: None,
                cli_version: None,
            });
        }
        task.timeline_loaded = true;
        task.timeline_complete = true;
        task.timeline_start = 0;
        task.timeline_entry_count = task.timeline.len();
    }
}

fn save_workspace_update(
    connection: &mut Connection,
    update: XiaoWorkspaceUpdate,
    fail_before_commit: bool,
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start Xiao workspace update: {error}"))?;
    apply_workspace_update(&transaction, update)?;
    if fail_before_commit {
        return Err("Injected failure before Xiao workspace commit.".to_owned());
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not commit Xiao workspace update: {error}"))
}

fn apply_workspace_update(
    transaction: &Transaction<'_>,
    mut update: XiaoWorkspaceUpdate,
) -> Result<(), String> {
    update.workspace_path = normalize_workspace_path(&update.workspace_path);
    validate_update(&update)?;

    transaction
        .execute(
            r#"INSERT INTO workspaces(workspace_path, active_task_id, show_archived, updated_at)
             VALUES (?1, NULL, ?2, 0)
             ON CONFLICT(workspace_path) DO NOTHING"#,
            params![update.workspace_path, bool_to_i64(update.show_archived)],
        )
        .map_err(|error| format!("Could not create Xiao workspace record: {error}"))?;
    let workspace_id = workspace_id(transaction, &update.workspace_path)?;
    let existing_task_ids = task_ids(transaction, workspace_id)?;

    for task in &mut update.tasks {
        prepare_task_for_save(task)?;
        let existed = existing_task_ids.contains(&task.id);
        if !task.timeline_complete && !existed {
            return Err(format!(
                "New Xiao task `{}` cannot be saved with partial timeline data.",
                task.id
            ));
        }
        upsert_task(transaction, workspace_id, task)?;
        if task.timeline_complete {
            replace_task_timeline_if_changed(transaction, workspace_id, task)?;
        }
    }

    let desired_ids = update.task_ids.iter().cloned().collect::<HashSet<_>>();
    for existing_id in existing_task_ids.difference(&desired_ids) {
        transaction
            .execute(
                "DELETE FROM tasks WHERE workspace_id = ?1 AND task_id = ?2",
                params![workspace_id, existing_id],
            )
            .map_err(|error| format!("Could not remove Xiao task `{existing_id}`: {error}"))?;
    }

    for (position, task_id) in update.task_ids.iter().enumerate() {
        let changed = transaction
            .execute(
                "UPDATE tasks SET position = ?1 WHERE workspace_id = ?2 AND task_id = ?3",
                params![to_i64(position, "task position")?, workspace_id, task_id],
            )
            .map_err(|error| format!("Could not order Xiao task `{task_id}`: {error}"))?;
        if changed != 1 {
            return Err(format!(
                "Xiao workspace update did not include data for new task `{task_id}`."
            ));
        }
    }

    let task_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM tasks WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not verify Xiao workspace task count: {error}"))?;
    if task_count != to_i64(update.task_ids.len(), "task count")? {
        return Err("Xiao workspace task count verification failed.".to_owned());
    }

    let updated_at: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(updated_at), 0) FROM tasks WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not calculate Xiao workspace update time: {error}"))?;
    transaction
        .execute(
            r#"UPDATE workspaces SET active_task_id = ?1, show_archived = ?2, updated_at = ?3
             WHERE id = ?4"#,
            params![
                update.active_task_id,
                bool_to_i64(update.show_archived),
                updated_at,
                workspace_id
            ],
        )
        .map_err(|error| format!("Could not update Xiao workspace record: {error}"))?;
    Ok(())
}

fn validate_update(update: &XiaoWorkspaceUpdate) -> Result<(), String> {
    if update.schema_version != XIAO_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Xiao workspace schema version {}.",
            update.schema_version
        ));
    }
    if update.workspace_path.trim().is_empty() {
        return Err("Xiao workspace path cannot be empty.".to_owned());
    }

    let mut task_ids = HashSet::new();
    for task_id in &update.task_ids {
        if task_id.trim().is_empty() || !task_ids.insert(task_id) {
            return Err("Xiao workspace task ids must be non-empty and unique.".to_owned());
        }
    }
    if update
        .active_task_id
        .as_ref()
        .is_some_and(|id| !task_ids.contains(id))
    {
        return Err("The active Xiao task does not exist in this workspace.".to_owned());
    }

    let mut changed_ids = HashSet::new();
    for task in &update.tasks {
        validate_task(task)?;
        if !task_ids.contains(&task.id) {
            return Err(format!(
                "Updated Xiao task `{}` is not present in taskIds.",
                task.id
            ));
        }
        if !changed_ids.insert(&task.id) {
            return Err(format!("Duplicate updated Xiao task `{}`.", task.id));
        }
    }
    Ok(())
}

fn validate_document(document: &XiaoWorkspaceDocument) -> Result<(), String> {
    validate_update(&document_as_update(document.clone()))
}

fn validate_task(task: &XiaoTaskDocument) -> Result<(), String> {
    if task.id.trim().is_empty() || task.title.trim().is_empty() {
        return Err("Xiao task ids and titles cannot be empty.".to_owned());
    }
    if let Some(binding) = &task.thread_binding {
        if binding.thread_id.trim().is_empty() {
            return Err("Xiao thread binding id cannot be empty.".to_owned());
        }
    }
    if task.timeline_complete && task.timeline_start != 0 {
        return Err(format!(
            "Complete Xiao task `{}` timeline must start at zero.",
            task.id
        ));
    }
    Ok(())
}

fn prepare_task_for_save(task: &mut XiaoTaskDocument) -> Result<(), String> {
    if task.thread_binding.is_none() {
        task.thread_binding = task.thread_id.take().map(|thread_id| XiaoThreadBinding {
            thread_id,
            persistence: XiaoThreadPersistence::Ephemeral,
            materialized: false,
            thread_source: Some("xiao-workbench".to_owned()),
            cli_version: None,
        });
    } else {
        task.thread_id = None;
    }
    if task.timeline_complete {
        task.timeline_loaded = true;
        task.timeline_start = 0;
        task.timeline_entry_count = task.timeline.len();
    }
    validate_task(task)
}

fn upsert_task(
    connection: &Connection,
    workspace_id: i64,
    task: &XiaoTaskDocument,
) -> Result<(), String> {
    let follow_ups_json = json_string(&task.follow_ups, "task follow-ups")?;
    let thread_binding_json = optional_json_string(task.thread_binding.as_ref(), "thread binding")?;
    let goal_json = optional_json_string(task.goal.as_ref(), "task goal")?;
    let plan_json = optional_json_string(task.plan.as_ref(), "task plan")?;
    connection
        .execute(
            r#"INSERT INTO tasks(
                workspace_id, task_id, position, title, created_at, updated_at, draft_text,
                follow_ups_json, archived, pinned, unread, model, reasoning_effort,
                thread_binding_json, mode, approval_policy, sandbox_mode, goal_json, plan_json
             ) VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(workspace_id, task_id) DO UPDATE SET
                title = excluded.title, created_at = excluded.created_at,
                updated_at = excluded.updated_at, draft_text = excluded.draft_text,
                follow_ups_json = excluded.follow_ups_json, archived = excluded.archived,
                pinned = excluded.pinned, unread = excluded.unread, model = excluded.model,
                reasoning_effort = excluded.reasoning_effort,
                thread_binding_json = excluded.thread_binding_json, mode = excluded.mode,
                approval_policy = excluded.approval_policy, sandbox_mode = excluded.sandbox_mode,
                goal_json = excluded.goal_json, plan_json = excluded.plan_json"#,
            params![
                workspace_id,
                task.id,
                task.title,
                task.created_at,
                task.updated_at,
                task.draft_text,
                follow_ups_json,
                bool_to_i64(task.archived),
                bool_to_i64(task.pinned),
                bool_to_i64(task.unread),
                task.model,
                task.reasoning_effort,
                thread_binding_json,
                task.mode,
                task.approval_policy,
                task.sandbox_mode,
                goal_json,
                plan_json,
            ],
        )
        .map_err(|error| format!("Could not save Xiao task `{}`: {error}", task.id))?;
    Ok(())
}

fn replace_task_timeline_if_changed(
    connection: &Connection,
    workspace_id: i64,
    task: &XiaoTaskDocument,
) -> Result<(), String> {
    let timeline_bytes = serde_json::to_vec(&task.timeline)
        .map_err(|error| format!("Could not serialize Xiao task timeline: {error}"))?;
    let desired_hash = sha256_hex(&timeline_bytes);
    let desired_count = to_i64(task.timeline.len(), "timeline entry count")?;
    let (current_hash, current_count): (Option<String>, i64) = connection
        .query_row(
            r#"SELECT timeline_sha256, timeline_entry_count FROM tasks
             WHERE workspace_id = ?1 AND task_id = ?2"#,
            params![workspace_id, task.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("Could not inspect Xiao task timeline: {error}"))?;
    if current_hash.as_deref() == Some(desired_hash.as_str()) && current_count == desired_count {
        return Ok(());
    }

    connection
        .execute(
            "DELETE FROM task_timeline_entries WHERE workspace_id = ?1 AND task_id = ?2",
            params![workspace_id, task.id],
        )
        .map_err(|error| format!("Could not replace Xiao task timeline: {error}"))?;
    let mut statement = connection
        .prepare(
            r#"INSERT INTO task_timeline_entries(workspace_id, task_id, position, entry_json)
             VALUES (?1, ?2, ?3, ?4)"#,
        )
        .map_err(|error| format!("Could not prepare Xiao timeline write: {error}"))?;
    for (position, entry) in task.timeline.iter().enumerate() {
        statement
            .execute(params![
                workspace_id,
                task.id,
                to_i64(position, "timeline position")?,
                json_string(entry, "timeline entry")?,
            ])
            .map_err(|error| format!("Could not save Xiao timeline entry: {error}"))?;
    }
    drop(statement);
    connection
        .execute(
            r#"UPDATE tasks SET timeline_sha256 = ?1, timeline_entry_count = ?2
             WHERE workspace_id = ?3 AND task_id = ?4"#,
            params![desired_hash, desired_count, workspace_id, task.id],
        )
        .map_err(|error| format!("Could not record Xiao timeline identity: {error}"))?;
    Ok(())
}

fn load_workspace_from_connection(
    connection: &Connection,
    workspace_path: &str,
    include_active_timeline: bool,
    include_all_timelines: bool,
) -> Result<Option<XiaoWorkspaceDocument>, String> {
    let workspace = connection
        .query_row(
            "SELECT id, active_task_id, show_archived FROM workspaces WHERE workspace_path = ?1",
            [workspace_path],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not load Xiao workspace: {error}"))?;
    let Some((workspace_id, active_task_id, show_archived)) = workspace else {
        return Ok(None);
    };

    let mut tasks = load_task_metadata(connection, workspace_id)?;
    for task in &mut tasks {
        let should_load = include_all_timelines
            || (include_active_timeline && active_task_id.as_deref() == Some(task.id.as_str()));
        if should_load {
            let page = load_timeline_page_by_id(
                connection,
                workspace_id,
                &task.id,
                None,
                if include_all_timelines {
                    usize::MAX
                } else {
                    INITIAL_TIMELINE_PAGE_SIZE
                },
            )?;
            task.timeline = page.entries;
            task.timeline_loaded = true;
            task.timeline_complete = !page.has_more;
            task.timeline_start = page.start;
            task.timeline_entry_count = page.total;
        } else if task.timeline_entry_count == 0 {
            task.timeline_loaded = true;
            task.timeline_complete = true;
            task.timeline_start = 0;
        }
    }

    Ok(Some(XiaoWorkspaceDocument {
        schema_version: XIAO_SCHEMA_VERSION,
        workspace_path: workspace_path.to_owned(),
        active_task_id,
        show_archived,
        tasks,
    }))
}

fn load_task_metadata(
    connection: &Connection,
    workspace_id: i64,
) -> Result<Vec<XiaoTaskDocument>, String> {
    let mut statement = connection
        .prepare(
            r#"SELECT
                t.task_id, t.title, t.created_at, t.updated_at, t.draft_text,
                t.follow_ups_json, t.archived, t.pinned, t.unread, t.model,
                t.reasoning_effort, t.thread_binding_json, t.mode, t.approval_policy,
                t.sandbox_mode, t.goal_json, t.plan_json, t.timeline_entry_count
             FROM tasks t WHERE t.workspace_id = ?1 ORDER BY t.position ASC"#,
        )
        .map_err(|error| format!("Could not prepare Xiao task load: {error}"))?;
    let rows = statement
        .query_map([workspace_id], |row| {
            Ok(StoredTaskRow {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                draft_text: row.get(4)?,
                follow_ups_json: row.get(5)?,
                archived: row.get::<_, i64>(6)? != 0,
                pinned: row.get::<_, i64>(7)? != 0,
                unread: row.get::<_, i64>(8)? != 0,
                model: row.get(9)?,
                reasoning_effort: row.get(10)?,
                thread_binding_json: row.get(11)?,
                mode: row.get(12)?,
                approval_policy: row.get(13)?,
                sandbox_mode: row.get(14)?,
                goal_json: row.get(15)?,
                plan_json: row.get(16)?,
                timeline_entry_count: row.get(17)?,
            })
        })
        .map_err(|error| format!("Could not query Xiao tasks: {error}"))?;

    rows.map(|row| {
        row.map_err(|error| format!("Could not decode Xiao task row: {error}"))?
            .into_document()
    })
    .collect()
}

struct StoredTaskRow {
    id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
    draft_text: String,
    follow_ups_json: String,
    archived: bool,
    pinned: bool,
    unread: bool,
    model: Option<String>,
    reasoning_effort: Option<String>,
    thread_binding_json: Option<String>,
    mode: String,
    approval_policy: String,
    sandbox_mode: String,
    goal_json: Option<String>,
    plan_json: Option<String>,
    timeline_entry_count: i64,
}

impl StoredTaskRow {
    fn into_document(self) -> Result<XiaoTaskDocument, String> {
        let timeline_entry_count = to_usize(self.timeline_entry_count, "timeline entry count")?;
        Ok(XiaoTaskDocument {
            id: self.id,
            title: self.title,
            created_at: self.created_at,
            updated_at: self.updated_at,
            draft_text: self.draft_text,
            follow_ups: parse_json(&self.follow_ups_json, "task follow-ups")?,
            archived: self.archived,
            pinned: self.pinned,
            unread: self.unread,
            model: self.model,
            reasoning_effort: self.reasoning_effort,
            thread_id: None,
            thread_binding: parse_optional_json(
                self.thread_binding_json.as_deref(),
                "thread binding",
            )?,
            mode: self.mode,
            approval_policy: self.approval_policy,
            sandbox_mode: self.sandbox_mode,
            goal: parse_optional_json(self.goal_json.as_deref(), "task goal")?,
            timeline: Vec::new(),
            timeline_loaded: false,
            timeline_complete: false,
            timeline_start: timeline_entry_count,
            timeline_entry_count,
            plan: parse_optional_json(self.plan_json.as_deref(), "task plan")?,
        })
    }
}

fn load_timeline_page_from_connection(
    connection: &Connection,
    workspace_path: &str,
    task_id: &str,
    before: Option<usize>,
    limit: Option<usize>,
) -> Result<XiaoTimelinePage, String> {
    let workspace_id = connection
        .query_row(
            "SELECT id FROM workspaces WHERE workspace_path = ?1",
            [workspace_path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not find Xiao workspace for timeline: {error}"))?
        .ok_or("Xiao workspace was not found.")?;
    let exists = connection
        .query_row(
            "SELECT 1 FROM tasks WHERE workspace_id = ?1 AND task_id = ?2",
            params![workspace_id, task_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Could not find Xiao task timeline: {error}"))?
        .is_some();
    if !exists {
        return Err(format!("Xiao task `{task_id}` was not found."));
    }
    load_timeline_page_by_id(
        connection,
        workspace_id,
        task_id,
        before,
        limit
            .unwrap_or(DEFAULT_TIMELINE_PAGE_SIZE)
            .clamp(1, MAX_TIMELINE_PAGE_SIZE),
    )
}

fn load_timeline_page_by_id(
    connection: &Connection,
    workspace_id: i64,
    task_id: &str,
    before: Option<usize>,
    limit: usize,
) -> Result<XiaoTimelinePage, String> {
    let total: i64 = connection
        .query_row(
            r#"SELECT COUNT(*) FROM task_timeline_entries
             WHERE workspace_id = ?1 AND task_id = ?2"#,
            params![workspace_id, task_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not count Xiao timeline entries: {error}"))?;
    let total = to_usize(total, "timeline entry count")?;
    let before = before.unwrap_or(total).min(total);
    let start = before.saturating_sub(limit);
    let mut statement = connection
        .prepare(
            r#"SELECT entry_json FROM task_timeline_entries
             WHERE workspace_id = ?1 AND task_id = ?2 AND position >= ?3 AND position < ?4
             ORDER BY position ASC"#,
        )
        .map_err(|error| format!("Could not prepare Xiao timeline page: {error}"))?;
    let rows = statement
        .query_map(
            params![
                workspace_id,
                task_id,
                to_i64(start, "timeline start")?,
                to_i64(before, "timeline end")?
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("Could not query Xiao timeline page: {error}"))?;
    let entries = rows
        .map(|row| {
            let json =
                row.map_err(|error| format!("Could not decode Xiao timeline row: {error}"))?;
            parse_json(&json, "timeline entry")
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(XiaoTimelinePage {
        entries,
        start,
        total,
        has_more: start > 0,
    })
}

fn list_projects_from_connection(
    connection: &mut Connection,
) -> Result<Vec<XiaoProjectSummary>, String> {
    let mut statement = connection
        .prepare(
            r#"SELECT workspace_path, updated_at FROM workspaces
             ORDER BY updated_at DESC, workspace_path ASC"#,
        )
        .map_err(|error| format!("Could not prepare Xiao project list: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| format!("Could not query Xiao projects: {error}"))?;
    rows.map(|row| {
        let (path, updated_at) =
            row.map_err(|error| format!("Could not decode Xiao project: {error}"))?;
        let name = PathBuf::from(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(&path)
            .to_owned();
        Ok(XiaoProjectSummary {
            path,
            name,
            updated_at,
        })
    })
    .collect()
}

fn workspace_id(connection: &Connection, workspace_path: &str) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT id FROM workspaces WHERE workspace_path = ?1",
            [workspace_path],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not resolve Xiao workspace record: {error}"))
}

fn task_ids(connection: &Connection, workspace_id: i64) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare("SELECT task_id FROM tasks WHERE workspace_id = ?1")
        .map_err(|error| format!("Could not prepare Xiao task identity query: {error}"))?;
    let rows = statement
        .query_map([workspace_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not query Xiao task identities: {error}"))?;
    rows.map(|row| row.map_err(|error| format!("Could not decode Xiao task id: {error}")))
        .collect()
}

fn document_as_update(document: XiaoWorkspaceDocument) -> XiaoWorkspaceUpdate {
    XiaoWorkspaceUpdate {
        schema_version: document.schema_version,
        workspace_path: document.workspace_path,
        active_task_id: document.active_task_id,
        show_archived: document.show_archived,
        task_ids: document.tasks.iter().map(|task| task.id.clone()).collect(),
        tasks: document.tasks,
    }
}

fn canonical_document_hash(document: &XiaoWorkspaceDocument) -> Result<String, String> {
    let mut document = document.clone();
    for task in &mut document.tasks {
        task.thread_id = None;
        task.timeline_loaded = true;
        task.timeline_complete = true;
        task.timeline_start = 0;
        task.timeline_entry_count = task.timeline.len();
    }
    let bytes = serde_json::to_vec(&document)
        .map_err(|error| format!("Could not hash Xiao workspace document: {error}"))?;
    Ok(sha256_hex(&bytes))
}

fn remove_empty_bootstrap_tasks(document: &mut XiaoWorkspaceDocument) {
    let bootstrap_ids = document
        .tasks
        .iter()
        .filter(|task| {
            task.title == "New task"
                && !task.archived
                && !task.pinned
                && !task.unread
                && task.model.is_none()
                && task.reasoning_effort.is_none()
                && task.thread_binding.as_ref().is_none_or(|binding| {
                    binding.persistence == XiaoThreadPersistence::LegacyUntrusted
                })
                && task.mode == "default"
                && task.approval_policy == "on-request"
                && task.sandbox_mode == "workspace-write"
                && task.goal.is_none()
                && task.draft_text.trim().is_empty()
                && task.follow_ups.is_empty()
                && task.timeline.is_empty()
                && task.plan.is_none()
        })
        .map(|task| task.id.clone())
        .collect::<Vec<_>>();
    if bootstrap_ids.is_empty() {
        return;
    }
    document
        .tasks
        .retain(|task| !bootstrap_ids.contains(&task.id));
    if document
        .active_task_id
        .as_ref()
        .is_some_and(|id| bootstrap_ids.contains(id))
    {
        document.active_task_id = document
            .tasks
            .iter()
            .find(|task| !task.archived)
            .map(|task| task.id.clone());
    }
}

fn merge_workspace_documents(
    existing: &mut XiaoWorkspaceDocument,
    incoming: XiaoWorkspaceDocument,
) {
    let existing_updated_at = existing
        .tasks
        .iter()
        .map(|task| task.updated_at)
        .max()
        .unwrap_or_default();
    let incoming_updated_at = incoming
        .tasks
        .iter()
        .map(|task| task.updated_at)
        .max()
        .unwrap_or_default();

    for task in incoming.tasks {
        if let Some(current) = existing.tasks.iter_mut().find(|item| item.id == task.id) {
            if task.updated_at > current.updated_at {
                *current = task;
            }
        } else {
            existing.tasks.push(task);
        }
    }

    let incoming_active_exists = incoming
        .active_task_id
        .as_ref()
        .is_none_or(|id| existing.tasks.iter().any(|task| task.id == *id));
    if incoming_updated_at >= existing_updated_at && incoming_active_exists {
        existing.active_task_id = incoming.active_task_id;
        existing.show_archived = incoming.show_archived;
    }
}

pub(crate) fn normalize_workspace_path(path: &str) -> String {
    let path = PathBuf::from(path);
    let value = path
        .canonicalize()
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    {
        if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{path}");
        }
        if let Some(path) = value.strip_prefix(r"\\?\") {
            return path.to_owned();
        }
    }
    value
}

fn optional_json_string<T: Serialize>(
    value: Option<&T>,
    label: &str,
) -> Result<Option<String>, String> {
    value.map(|value| json_string(value, label)).transpose()
}

fn json_string<T: Serialize>(value: &T, label: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("Could not serialize {label}: {error}"))
}

fn parse_optional_json<T: serde::de::DeserializeOwned>(
    value: Option<&str>,
    label: &str,
) -> Result<Option<T>, String> {
    value.map(|value| parse_json(value, label)).transpose()
}

fn parse_json<T: serde::de::DeserializeOwned>(value: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|error| format!("Could not deserialize {label}: {error}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn to_i64(value: usize, label: &str) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| format!("Xiao {label} is too large."))
}

fn to_usize(value: i64, label: &str) -> Result<usize, String> {
    usize::try_from(value).map_err(|_| format!("Xiao {label} is invalid."))
}

fn now_millis() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|_| "Current timestamp is too large.".to_owned())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync Xiao state directory: {error}"))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    use serde_json::Value;

    use super::*;

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "xiao-{label}-{}-{}-{}",
                std::process::id(),
                now_millis().unwrap(),
                TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn workspace(&self, name: &str) -> PathBuf {
            let path = self.path.join(name);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            for _ in 0..10 {
                if fs::remove_dir_all(&self.path).is_ok() || !self.path.exists() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }

    fn timeline_entry(index: usize) -> Value {
        serde_json::json!({
            "id": format!("entry-{index}"),
            "kind": if index.is_multiple_of(2) { "user" } else { "result" },
            "title": format!("Entry {index}"),
            "body": format!("Body {index}"),
            "createdAt": index,
        })
    }

    fn task(id: &str, timeline_len: usize) -> XiaoTaskDocument {
        let timeline = (0..timeline_len).map(timeline_entry).collect::<Vec<_>>();
        XiaoTaskDocument {
            id: id.to_owned(),
            title: format!("Task {id}"),
            created_at: 10,
            updated_at: 20,
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
            timeline,
            timeline_loaded: true,
            timeline_complete: true,
            timeline_start: 0,
            timeline_entry_count: timeline_len,
            plan: None,
        }
    }

    fn document(path: &Path, tasks: Vec<XiaoTaskDocument>) -> XiaoWorkspaceDocument {
        XiaoWorkspaceDocument {
            schema_version: XIAO_SCHEMA_VERSION,
            workspace_path: path.to_string_lossy().into_owned(),
            active_task_id: tasks.first().map(|task| task.id.clone()),
            show_archived: false,
            tasks,
        }
    }

    fn update(document: XiaoWorkspaceDocument) -> XiaoWorkspaceUpdate {
        document_as_update(document)
    }

    fn legacy_bytes(workspaces: Vec<XiaoWorkspaceDocument>) -> Vec<u8> {
        let mut value = serde_json::to_value(XiaoLegacyStore {
            schema_version: XIAO_SCHEMA_VERSION,
            workspaces,
        })
        .unwrap();
        for workspace in value["workspaces"].as_array_mut().unwrap() {
            for task in workspace["tasks"].as_array_mut().unwrap() {
                let task = task.as_object_mut().unwrap();
                task.remove("threadBinding");
                task.remove("timelineLoaded");
                task.remove("timelineComplete");
                task.remove("timelineStart");
                task.remove("timelineEntryCount");
            }
        }
        serde_json::to_vec_pretty(&value).unwrap()
    }

    fn write_legacy(directory: &TestDirectory, workspaces: Vec<XiaoWorkspaceDocument>) -> Vec<u8> {
        let bytes = legacy_bytes(workspaces);
        fs::write(directory.path.join(LEGACY_STORE_FILE_NAME), &bytes).unwrap();
        bytes
    }

    fn backup_path(directory: &TestDirectory, source: &[u8]) -> PathBuf {
        directory.path.join(format!(
            "{LEGACY_STORE_FILE_NAME}.{}.pre-sqlite.bak",
            &sha256_hex(source)[..16]
        ))
    }

    fn full_workspace(repository: &XiaoRepository, path: &Path) -> XiaoWorkspaceDocument {
        repository
            .with_connection(|connection| {
                load_workspace_from_connection(
                    connection,
                    &normalize_workspace_path(&path.to_string_lossy()),
                    true,
                    true,
                )
            })
            .unwrap()
            .unwrap()
    }

    #[test]
    fn fresh_database_applies_schema_and_pragmas_once() {
        let directory = TestDirectory::new("fresh-database");
        {
            let repository = XiaoRepository::open(&directory.path).unwrap();
            repository
                .with_connection(|connection| {
                    let migration_count: i64 = connection
                        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                            row.get(0)
                        })
                        .map_err(|error| error.to_string())?;
                    let foreign_keys: i64 = connection
                        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                        .map_err(|error| error.to_string())?;
                    let journal_mode: String = connection
                        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                        .map_err(|error| error.to_string())?;
                    let synchronous: i64 = connection
                        .query_row("PRAGMA synchronous", [], |row| row.get(0))
                        .map_err(|error| error.to_string())?;
                    assert_eq!(migration_count, 1);
                    assert_eq!(foreign_keys, 1);
                    assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
                    assert_eq!(synchronous, 2);
                    Ok(())
                })
                .unwrap();
        }

        let reopened = XiaoRepository::open(&directory.path).unwrap();
        reopened
            .with_connection(|connection| {
                let migration_count: i64 = connection
                    .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error.to_string())?;
                assert_eq!(migration_count, 1);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn newer_database_schema_is_rejected_without_mutation() {
        let directory = TestDirectory::new("newer-schema");
        {
            let connection = Connection::open(directory.path.join(DATABASE_FILE_NAME)).unwrap();
            connection
                .execute_batch(
                    r#"CREATE TABLE schema_migrations (
                        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
                    );
                    INSERT INTO schema_migrations(version, name, applied_at) VALUES (99, 'future', 1);"#,
                )
                .unwrap();
        }

        let error = match XiaoRepository::open(&directory.path) {
            Ok(_) => panic!("newer schema unexpectedly opened"),
            Err(error) => error,
        };
        assert!(error.contains("newer than this app supports"));
        let connection = Connection::open(directory.path.join(DATABASE_FILE_NAME)).unwrap();
        let version: i64 = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, 99);
    }

    #[test]
    fn task_fields_and_thread_binding_round_trip() {
        let directory = TestDirectory::new("task-round-trip");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        let mut stored_task = task("all-fields", 3);
        stored_task.draft_text = "unsent draft".to_owned();
        stored_task.follow_ups = vec![serde_json::json!({
            "id": "follow-up",
            "prompt": "Continue",
            "attachments": [],
            "createdAt": 30
        })];
        stored_task.archived = true;
        stored_task.pinned = true;
        stored_task.unread = true;
        stored_task.model = Some("gpt-test".to_owned());
        stored_task.reasoning_effort = Some("high".to_owned());
        stored_task.thread_id = Some("ephemeral-thread".to_owned());
        stored_task.mode = "plan".to_owned();
        stored_task.approval_policy = "untrusted".to_owned();
        stored_task.sandbox_mode = "read-only".to_owned();
        stored_task.goal = Some(serde_json::json!({
            "objective": "Preserve every field",
            "status": "active"
        }));
        stored_task.plan = Some(serde_json::json!({
            "explanation": "Test",
            "steps": [{ "step": "Round trip", "status": "inProgress" }]
        }));
        repository
            .save_workspace(update(document(&workspace, vec![stored_task])))
            .unwrap();

        let loaded = full_workspace(&repository, &workspace);
        let loaded_task = &loaded.tasks[0];
        assert_eq!(loaded_task.draft_text, "unsent draft");
        assert_eq!(loaded_task.follow_ups.len(), 1);
        assert!(loaded_task.archived);
        assert!(loaded_task.pinned);
        assert!(loaded_task.unread);
        assert_eq!(loaded_task.model.as_deref(), Some("gpt-test"));
        assert_eq!(loaded_task.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(loaded_task.thread_id, None);
        assert_eq!(
            loaded_task.thread_binding,
            Some(XiaoThreadBinding {
                thread_id: "ephemeral-thread".to_owned(),
                persistence: XiaoThreadPersistence::Ephemeral,
                materialized: false,
                thread_source: Some("xiao-workbench".to_owned()),
                cli_version: None,
            })
        );
        assert_eq!(loaded_task.mode, "plan");
        assert_eq!(loaded_task.approval_policy, "untrusted");
        assert_eq!(loaded_task.sandbox_mode, "read-only");
        assert!(loaded_task.goal.is_some());
        assert!(loaded_task.plan.is_some());
        assert_eq!(loaded_task.timeline.len(), 3);
        assert!(loaded_task.timeline_complete);
        assert_eq!(loaded_task.timeline_entry_count, 3);
    }

    #[test]
    fn partial_timeline_save_cannot_truncate_complete_history() {
        let directory = TestDirectory::new("partial-timeline");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        repository
            .save_workspace(update(document(&workspace, vec![task("task", 650)])))
            .unwrap();

        let mut partial = repository
            .load_workspace(&workspace.to_string_lossy(), true)
            .unwrap()
            .unwrap();
        assert_eq!(partial.tasks[0].timeline.len(), INITIAL_TIMELINE_PAGE_SIZE);
        assert_eq!(partial.tasks[0].timeline_start, 450);
        assert_eq!(partial.tasks[0].timeline_entry_count, 650);
        assert!(!partial.tasks[0].timeline_complete);
        partial.tasks[0].title = "Metadata changed".to_owned();
        repository.save_workspace(update(partial)).unwrap();

        let full = full_workspace(&repository, &workspace);
        assert_eq!(full.tasks[0].title, "Metadata changed");
        assert_eq!(full.tasks[0].timeline.len(), 650);
        assert_eq!(full.tasks[0].timeline[0]["id"], "entry-0");
        assert_eq!(full.tasks[0].timeline[649]["id"], "entry-649");

        repository
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        r#"CREATE TABLE timeline_delete_audit(count INTEGER NOT NULL);
                         INSERT INTO timeline_delete_audit(count) VALUES (0);
                         CREATE TRIGGER count_timeline_delete AFTER DELETE ON task_timeline_entries
                         BEGIN UPDATE timeline_delete_audit SET count = count + 1; END;"#,
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        repository.save_workspace(update(full.clone())).unwrap();
        repository
            .with_connection(|connection| {
                let deletes: i64 = connection
                    .query_row("SELECT count FROM timeline_delete_audit", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error.to_string())?;
                assert_eq!(deletes, 0, "unchanged timeline must not be rewritten");
                Ok(())
            })
            .unwrap();

        let bounded = repository
            .load_timeline_page(&workspace.to_string_lossy(), "task", Some(450), Some(100))
            .unwrap();
        assert_eq!(bounded.entries.len(), 100);
        assert_eq!(bounded.start, 350);
        assert_eq!(bounded.entries[0]["id"], "entry-350");
        assert!(bounded.has_more);
        let clamped = repository
            .load_timeline_page(&workspace.to_string_lossy(), "task", None, Some(50_000))
            .unwrap();
        assert_eq!(clamped.entries.len(), MAX_TIMELINE_PAGE_SIZE);

        let replacement = task("task", 2);
        repository
            .save_workspace(update(document(&workspace, vec![replacement])))
            .unwrap();
        let replaced = full_workspace(&repository, &workspace);
        assert_eq!(replaced.tasks[0].timeline.len(), 2);
        assert_eq!(replaced.tasks[0].timeline[1]["id"], "entry-1");
        repository
            .with_connection(|connection| {
                let deletes: i64 = connection
                    .query_row("SELECT count FROM timeline_delete_audit", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error.to_string())?;
                assert_eq!(
                    deletes, 650,
                    "changed timeline must replace old rows exactly once"
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn partial_task_update_preserves_unchanged_tasks_and_reorders_atomically() {
        let directory = TestDirectory::new("partial-task-update");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        repository
            .save_workspace(update(document(
                &workspace,
                vec![task("first", 2), task("second", 3)],
            )))
            .unwrap();

        let mut second = full_workspace(&repository, &workspace).tasks.remove(1);
        second.title = "Second changed".to_owned();
        second.timeline.clear();
        second.timeline_loaded = false;
        second.timeline_complete = false;
        second.timeline_start = second.timeline_entry_count;
        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: workspace.to_string_lossy().into_owned(),
                active_task_id: Some("second".to_owned()),
                show_archived: false,
                task_ids: vec!["second".to_owned(), "first".to_owned()],
                tasks: vec![second],
            })
            .unwrap();

        let loaded = full_workspace(&repository, &workspace);
        assert_eq!(loaded.active_task_id.as_deref(), Some("second"));
        assert_eq!(loaded.tasks[0].id, "second");
        assert_eq!(loaded.tasks[0].title, "Second changed");
        assert_eq!(loaded.tasks[0].timeline.len(), 3);
        assert_eq!(loaded.tasks[1].id, "first");
        assert_eq!(loaded.tasks[1].timeline.len(), 2);
    }

    #[test]
    fn new_task_requires_complete_timeline_data() {
        let directory = TestDirectory::new("partial-new-task");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        let mut partial = task("new", 0);
        partial.timeline_loaded = false;
        partial.timeline_complete = false;

        let error = repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: workspace.to_string_lossy().into_owned(),
                active_task_id: Some("new".to_owned()),
                show_archived: false,
                task_ids: vec!["new".to_owned()],
                tasks: vec![partial],
            })
            .unwrap_err();
        assert!(error.contains("cannot be saved with partial timeline data"));
        assert!(repository
            .load_workspace(&workspace.to_string_lossy(), true)
            .unwrap()
            .is_none());
    }

    #[test]
    fn failed_workspace_transaction_preserves_previous_commit() {
        let directory = TestDirectory::new("transaction-rollback");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        let baseline = document(&workspace, vec![task("task", 2)]);
        repository.save_workspace(update(baseline)).unwrap();

        let mut changed = full_workspace(&repository, &workspace);
        changed.tasks[0].title = "Must roll back".to_owned();
        let error = repository
            .save_workspace_failing_before_commit(update(changed))
            .unwrap_err();
        assert!(error.contains("Injected failure"));

        let loaded = full_workspace(&repository, &workspace);
        assert_eq!(loaded.tasks[0].title, "Task task");
        assert_eq!(loaded.tasks[0].timeline.len(), 2);
    }

    #[test]
    fn concurrent_initialization_migrates_legacy_state_once() {
        let directory = TestDirectory::new("concurrent-initialize");
        let workspace = directory.workspace("workspace");
        write_legacy(
            &directory,
            vec![document(&workspace, vec![task("task", 2)])],
        );
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let path = directory.path.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                XiaoRepository::open(&path)
            }));
        }
        for worker in workers {
            worker.join().unwrap().unwrap();
        }

        let repository = XiaoRepository::open(&directory.path).unwrap();
        assert_eq!(repository.list_projects().unwrap().len(), 1);
        repository
            .with_connection(|connection| {
                let markers: i64 = connection
                    .query_row("SELECT COUNT(*) FROM legacy_imports", [], |row| row.get(0))
                    .map_err(|error| error.to_string())?;
                assert_eq!(markers, 1);
                Ok(())
            })
            .unwrap();
        let backups = fs::read_dir(&directory.path)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".pre-sqlite.bak")
            })
            .count();
        assert_eq!(backups, 1);
    }

    #[test]
    fn repository_serializes_concurrent_connection_access() {
        let directory = TestDirectory::new("concurrent-access");
        let repository = std::sync::Arc::new(XiaoRepository::open(&directory.path).unwrap());
        let mut workers = Vec::new();
        for index in 0..8 {
            let repository = std::sync::Arc::clone(&repository);
            let workspace = directory.workspace(&format!("workspace-{index}"));
            workers.push(std::thread::spawn(move || {
                repository
                    .save_workspace(update(document(
                        &workspace,
                        vec![task(&format!("task-{index}"), 1)],
                    )))
                    .unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(repository.list_projects().unwrap().len(), 8);
    }

    #[test]
    fn removing_a_task_cascades_timeline_run_and_events() {
        let directory = TestDirectory::new("cascade-delete");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        repository
            .save_workspace(update(document(&workspace, vec![task("task", 2)])))
            .unwrap();
        repository
            .with_connection(|connection| {
                let workspace_id = workspace_id(connection, &normalize_workspace_path(&workspace.to_string_lossy()))?;
                connection
                    .execute(
                        r#"INSERT INTO runs(
                            id, workspace_id, task_id, idempotency_key, status, agent_outcome,
                            verification_outcome, execution_root, queued_at, version
                         ) VALUES ('run', ?1, 'task', 'key', 'queued', 'pending',
                            'not_requested', ?2, 1, 0)"#,
                        params![workspace_id, workspace.to_string_lossy()],
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        r#"INSERT INTO run_events(run_id, sequence, timestamp, event_type, safe_payload_json)
                         VALUES ('run', 0, 1, 'queued', '{}')"#,
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

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
            .with_connection(|connection| {
                for table in ["tasks", "task_timeline_entries", "runs", "run_events"] {
                    let count: i64 = connection
                        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                            row.get(0)
                        })
                        .map_err(|error| error.to_string())?;
                    assert_eq!(count, 0, "{table} should be empty");
                }
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn valid_legacy_state_migrates_once_with_immutable_backup() {
        let directory = TestDirectory::new("legacy-valid");
        let workspace = directory.workspace("workspace");
        let mut legacy_task = task("legacy", 4);
        legacy_task.draft_text = "draft".to_owned();
        legacy_task.pinned = true;
        legacy_task.unread = true;
        legacy_task.thread_id = Some("legacy-thread".to_owned());
        legacy_task.goal = Some(serde_json::json!({ "objective": "Migrate", "status": "active" }));
        legacy_task.plan = Some(serde_json::json!({ "explanation": null, "steps": [] }));
        let source = write_legacy(&directory, vec![document(&workspace, vec![legacy_task])]);
        let source_path = directory.path.join(LEGACY_STORE_FILE_NAME);
        let source_modified = fs::metadata(&source_path).unwrap().modified().unwrap();

        {
            let repository = XiaoRepository::open(&directory.path).unwrap();
            let migrated = full_workspace(&repository, &workspace);
            assert_eq!(migrated.tasks.len(), 1);
            let migrated_task = &migrated.tasks[0];
            assert_eq!(migrated_task.draft_text, "draft");
            assert!(migrated_task.pinned);
            assert!(migrated_task.unread);
            assert_eq!(migrated_task.timeline.len(), 4);
            assert_eq!(
                migrated_task
                    .thread_binding
                    .as_ref()
                    .map(|binding| binding.persistence),
                Some(XiaoThreadPersistence::LegacyUntrusted)
            );
            repository
                .with_connection(|connection| {
                    let marker_count: i64 = connection
                        .query_row("SELECT COUNT(*) FROM legacy_imports", [], |row| row.get(0))
                        .map_err(|error| error.to_string())?;
                    assert_eq!(marker_count, 1);
                    Ok(())
                })
                .unwrap();
        }

        assert_eq!(fs::read(&source_path).unwrap(), source);
        assert_eq!(
            fs::metadata(&source_path).unwrap().modified().unwrap(),
            source_modified
        );
        assert_eq!(fs::read(backup_path(&directory, &source)).unwrap(), source);

        let reopened = XiaoRepository::open(&directory.path).unwrap();
        let migrated = full_workspace(&reopened, &workspace);
        assert_eq!(migrated.tasks.len(), 1);
        assert_eq!(migrated.tasks[0].timeline.len(), 4);
    }

    #[cfg(windows)]
    #[test]
    fn duplicate_canonical_legacy_paths_merge_without_dropping_tasks() {
        let directory = TestDirectory::new("legacy-duplicate-paths");
        let workspace = directory.workspace("workspace");
        let canonical = normalize_workspace_path(&workspace.to_string_lossy());
        let verbatim = format!(r"\\?\{canonical}");
        let first = document(Path::new(&canonical), vec![task("first", 1)]);
        let mut second = document(Path::new(&verbatim), vec![task("second", 1)]);
        second.tasks[0].updated_at = 30;
        write_legacy(&directory, vec![first, second]);

        let repository = XiaoRepository::open(&directory.path).unwrap();
        let projects = repository.list_projects().unwrap();
        assert_eq!(projects.len(), 1);
        let migrated = full_workspace(&repository, &workspace);
        assert_eq!(migrated.tasks.len(), 2);
        assert!(migrated.tasks.iter().any(|task| task.id == "first"));
        assert!(migrated.tasks.iter().any(|task| task.id == "second"));
    }

    #[test]
    fn corrupt_or_unsupported_legacy_state_is_recoverable_and_untouched() {
        for (label, source, expected_error) in [
            (
                "corrupt",
                b"{not-json".to_vec(),
                "Invalid legacy Xiao state file",
            ),
            (
                "unsupported",
                br#"{ "schemaVersion": 99, "workspaces": [] }"#.to_vec(),
                "Unsupported legacy Xiao state schema version",
            ),
        ] {
            let directory = TestDirectory::new(label);
            let source_path = directory.path.join(LEGACY_STORE_FILE_NAME);
            fs::write(&source_path, &source).unwrap();

            let error = match XiaoRepository::open(&directory.path) {
                Ok(_) => panic!("invalid legacy state unexpectedly migrated"),
                Err(error) => error,
            };
            assert!(error.contains(expected_error));
            assert_eq!(fs::read(&source_path).unwrap(), source);

            let recoverable = XiaoRepository::initialize(directory.path.clone());
            assert!(recoverable
                .list_projects()
                .unwrap_err()
                .contains(expected_error));
        }
    }

    #[test]
    fn interrupted_temporary_backup_is_replaced_safely() {
        let directory = TestDirectory::new("interrupted-backup");
        let workspace = directory.workspace("workspace");
        let source = write_legacy(
            &directory,
            vec![document(&workspace, vec![task("task", 1)])],
        );
        let final_path = backup_path(&directory, &source);
        let temporary_path = directory.path.join(format!(
            ".{}.tmp",
            final_path.file_name().unwrap().to_string_lossy()
        ));
        fs::write(&temporary_path, b"partial backup").unwrap();

        XiaoRepository::open(&directory.path).unwrap();
        assert_eq!(fs::read(final_path).unwrap(), source);
        assert!(!temporary_path.exists());
    }

    #[test]
    fn existing_backup_must_match_source_exactly() {
        let directory = TestDirectory::new("backup-conflict");
        let workspace = directory.workspace("workspace");
        let source = write_legacy(
            &directory,
            vec![document(&workspace, vec![task("task", 1)])],
        );
        fs::write(backup_path(&directory, &source), b"different").unwrap();

        let error = match XiaoRepository::open(&directory.path) {
            Ok(_) => panic!("conflicting backup unexpectedly migrated"),
            Err(error) => error,
        };
        assert!(error.contains("exists with different contents"));
        assert_eq!(
            fs::read(directory.path.join(LEGACY_STORE_FILE_NAME)).unwrap(),
            source
        );
    }

    #[test]
    fn identical_existing_backup_is_reused() {
        let directory = TestDirectory::new("backup-identical");
        let workspace = directory.workspace("workspace");
        let source = write_legacy(
            &directory,
            vec![document(&workspace, vec![task("task", 1)])],
        );
        fs::write(backup_path(&directory, &source), &source).unwrap();

        let repository = XiaoRepository::open(&directory.path).unwrap();
        assert_eq!(full_workspace(&repository, &workspace).tasks.len(), 1);
        assert_eq!(fs::read(backup_path(&directory, &source)).unwrap(), source);
    }

    #[test]
    fn interrupted_legacy_import_retries_without_duplicates() {
        let directory = TestDirectory::new("legacy-retry");
        let workspace = directory.workspace("workspace");
        let source = write_legacy(
            &directory,
            vec![document(&workspace, vec![task("task", 3)])],
        );

        let error = match XiaoRepository::open_with_options(
            &directory.path,
            RepositoryOpenOptions {
                fail_legacy_before_commit: true,
            },
        ) {
            Ok(_) => panic!("injected migration failure unexpectedly succeeded"),
            Err(error) => error,
        };
        assert!(error.contains("Injected failure"));
        {
            let connection = Connection::open(directory.path.join(DATABASE_FILE_NAME)).unwrap();
            let workspaces: i64 = connection
                .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
                .unwrap();
            let markers: i64 = connection
                .query_row("SELECT COUNT(*) FROM legacy_imports", [], |row| row.get(0))
                .unwrap();
            assert_eq!(workspaces, 0);
            assert_eq!(markers, 0);
        }
        assert_eq!(fs::read(backup_path(&directory, &source)).unwrap(), source);

        let repository = XiaoRepository::open(&directory.path).unwrap();
        let migrated = full_workspace(&repository, &workspace);
        assert_eq!(migrated.tasks.len(), 1);
        assert_eq!(migrated.tasks[0].timeline.len(), 3);
        repository
            .with_connection(|connection| {
                let markers: i64 = connection
                    .query_row("SELECT COUNT(*) FROM legacy_imports", [], |row| row.get(0))
                    .map_err(|error| error.to_string())?;
                assert_eq!(markers, 1);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn migration_marker_prevents_reimport_even_if_legacy_file_changes() {
        let directory = TestDirectory::new("legacy-marker");
        let workspace = directory.workspace("workspace");
        write_legacy(
            &directory,
            vec![document(&workspace, vec![task("task", 1)])],
        );
        {
            let repository = XiaoRepository::open(&directory.path).unwrap();
            assert_eq!(full_workspace(&repository, &workspace).tasks.len(), 1);
        }
        fs::write(directory.path.join(LEGACY_STORE_FILE_NAME), b"now invalid").unwrap();

        let repository = XiaoRepository::open(&directory.path).unwrap();
        let migrated = full_workspace(&repository, &workspace);
        assert_eq!(migrated.tasks.len(), 1);
        assert_eq!(migrated.tasks[0].timeline.len(), 1);
    }

    #[test]
    fn nonempty_unmarked_database_refuses_late_legacy_merge() {
        let directory = TestDirectory::new("legacy-nonempty");
        let workspace = directory.workspace("workspace");
        {
            let repository = XiaoRepository::open(&directory.path).unwrap();
            repository
                .save_workspace(update(document(&workspace, vec![task("database", 1)])))
                .unwrap();
        }
        let legacy_workspace = directory.workspace("legacy-workspace");
        write_legacy(
            &directory,
            vec![document(&legacy_workspace, vec![task("legacy", 1)])],
        );

        let error = match XiaoRepository::open(&directory.path) {
            Ok(_) => panic!("late legacy state unexpectedly merged"),
            Err(error) => error,
        };
        assert!(error.contains("non-empty unmarked database"));
    }

    #[test]
    fn legacy_empty_bootstrap_task_cleanup_matches_previous_behavior() {
        let directory = TestDirectory::new("legacy-bootstrap");
        let workspace = directory.workspace("workspace");
        let mut empty = task("empty", 0);
        empty.title = "New task".to_owned();
        empty.thread_id = Some("stale-runtime-thread".to_owned());
        write_legacy(&directory, vec![document(&workspace, vec![empty])]);

        let repository = XiaoRepository::open(&directory.path).unwrap();
        let migrated = full_workspace(&repository, &workspace);
        assert!(migrated.tasks.is_empty());
        assert_eq!(migrated.active_task_id, None);
    }

    #[test]
    #[ignore = "set XIAO_MIGRATION_FIXTURE to validate a copied beta state"]
    fn migrate_external_legacy_copy() {
        let source_path = std::env::var_os("XIAO_MIGRATION_FIXTURE")
            .map(PathBuf::from)
            .expect("XIAO_MIGRATION_FIXTURE is required");
        let source = fs::read(&source_path).unwrap();
        let source_hash = sha256_hex(&source);
        let source_modified = fs::metadata(&source_path).unwrap().modified().unwrap();
        let mut expected: XiaoLegacyStore = serde_json::from_slice(&source).unwrap();
        normalize_legacy_store(&mut expected).unwrap();
        let expected_workspaces = expected.workspaces.len();
        let expected_tasks = expected
            .workspaces
            .iter()
            .map(|workspace| workspace.tasks.len())
            .sum::<usize>();
        let expected_timeline = expected
            .workspaces
            .iter()
            .flat_map(|workspace| &workspace.tasks)
            .map(|task| task.timeline.len())
            .sum::<usize>();

        let directory = TestDirectory::new("external-legacy-copy");
        fs::write(directory.path.join(LEGACY_STORE_FILE_NAME), &source).unwrap();
        {
            let repository = XiaoRepository::open(&directory.path).unwrap();
            repository
                .with_connection(|connection| {
                    let workspaces: i64 = connection
                        .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
                        .map_err(|error| error.to_string())?;
                    let tasks: i64 = connection
                        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
                        .map_err(|error| error.to_string())?;
                    let timeline: i64 = connection
                        .query_row("SELECT COUNT(*) FROM task_timeline_entries", [], |row| {
                            row.get(0)
                        })
                        .map_err(|error| error.to_string())?;
                    assert_eq!(workspaces, to_i64(expected_workspaces, "workspace count")?);
                    assert_eq!(tasks, to_i64(expected_tasks, "task count")?);
                    assert_eq!(timeline, to_i64(expected_timeline, "timeline count")?);
                    Ok(())
                })
                .unwrap();
        }
        let reopened = XiaoRepository::open(&directory.path).unwrap();
        assert_eq!(reopened.list_projects().unwrap().len(), expected_workspaces);
        assert_eq!(fs::read(backup_path(&directory, &source)).unwrap(), source);
        assert_eq!(fs::read(&source_path).unwrap(), source);
        assert_eq!(
            fs::metadata(&source_path).unwrap().modified().unwrap(),
            source_modified
        );
        eprintln!(
            "external_legacy_migration sha256={} workspaces={} tasks={} timeline_entries={}",
            &source_hash[..16],
            expected_workspaces,
            expected_tasks,
            expected_timeline
        );
    }

    #[test]
    #[ignore = "manual performance baseline for persistence migrations"]
    fn benchmark_representative_store_round_trip() {
        let directory = TestDirectory::new("sqlite-benchmark");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        let timeline = (0usize..80)
            .map(|index| {
                serde_json::json!({
                    "id": format!("event-{index}"),
                    "kind": if index.is_multiple_of(2) { "user" } else { "result" },
                    "title": "Synthetic persistence benchmark entry",
                    "body": "x".repeat(512),
                    "createdAt": index,
                })
            })
            .collect::<Vec<_>>();
        let mut updates = Vec::new();
        for workspace_index in 0..5 {
            let workspace = directory.workspace(&format!("workspace-{workspace_index}"));
            let tasks = (0..20)
                .map(|task_index| {
                    let mut task = task(&format!("task-{workspace_index}-{task_index}"), 0);
                    task.timeline = timeline.clone();
                    task.timeline_entry_count = timeline.len();
                    task
                })
                .collect();
            updates.push(update(document(&workspace, tasks)));
        }
        let mut save_ms = Vec::new();
        let mut load_full_ms = Vec::new();
        let mut load_bounded_ms = Vec::new();

        for _ in 0..5 {
            let started = Instant::now();
            for update in &updates {
                repository.save_workspace(update.clone()).unwrap();
            }
            save_ms.push(started.elapsed().as_millis());

            let started = Instant::now();
            repository
                .with_connection(|connection| {
                    for update in &updates {
                        let loaded = load_workspace_from_connection(
                            connection,
                            &normalize_workspace_path(&update.workspace_path),
                            true,
                            true,
                        )?
                        .unwrap();
                        assert_eq!(loaded.tasks.len(), 20);
                    }
                    Ok(())
                })
                .unwrap();
            load_full_ms.push(started.elapsed().as_millis());

            let started = Instant::now();
            for update in &updates {
                let loaded = repository
                    .load_workspace(&update.workspace_path, true)
                    .unwrap()
                    .unwrap();
                assert_eq!(loaded.tasks.len(), 20);
                assert!(loaded
                    .tasks
                    .iter()
                    .skip(1)
                    .all(|task| !task.timeline_loaded));
            }
            load_bounded_ms.push(started.elapsed().as_millis());
        }

        let mut metadata_only = updates[0].tasks[0].clone();
        metadata_only.title = "Updated benchmark title".to_owned();
        metadata_only.timeline.clear();
        metadata_only.timeline_loaded = false;
        metadata_only.timeline_complete = false;
        metadata_only.timeline_start = metadata_only.timeline_entry_count;
        let metadata_update = XiaoWorkspaceUpdate {
            tasks: vec![metadata_only],
            ..updates[0].clone()
        };
        let mut save_incremental_ms = Vec::new();
        for _ in 0..5 {
            let started = Instant::now();
            repository.save_workspace(metadata_update.clone()).unwrap();
            save_incremental_ms.push(started.elapsed().as_millis());
        }

        let database_bytes = fs::metadata(directory.path.join(DATABASE_FILE_NAME))
            .unwrap()
            .len();
        eprintln!(
            "xiao_sqlite_baseline database_bytes={database_bytes} save_full_ms={save_ms:?} save_incremental_ms={save_incremental_ms:?} load_full_ms={load_full_ms:?} load_bounded_ms={load_bounded_ms:?}"
        );
    }
}
