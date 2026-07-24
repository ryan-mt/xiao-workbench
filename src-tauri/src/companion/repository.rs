use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};

use super::models::{
    CommandCapability, CommandEnvelope, CommandResult, CommandState, CompanionAuditRecord,
    CompanionGrant, CompanionNotification, CompanionOutboxIntent, CompanionSession, HostCommandAck,
    NotificationCursor, NotificationPage, ProjectionKind, ProjectionUpdate, SessionCredential,
    TargetKind, TargetScope,
};

pub const COMPANION_SCHEMA_VERSION: i64 = 1;

pub const COMPANION_SCHEMA_SQL: &str = r#"
INSERT INTO rollout_capabilities(
    capability_id, version, enabled, migrated_at, enabled_at
) VALUES ('companion-release-assurance', 1, 0, 0, NULL);

CREATE TABLE companion_pairings (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE companion_sessions (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    grants_json TEXT NOT NULL CHECK (json_valid(grants_json)),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    rotated_at INTEGER,
    revoked_at INTEGER
);
CREATE INDEX companion_sessions_by_device
    ON companion_sessions(device_id, created_at DESC);

CREATE TABLE companion_projection_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    authorization_epoch INTEGER NOT NULL CHECK (
        authorization_epoch >= 1 AND authorization_epoch < 4294967296
    ),
    latest_sequence INTEGER NOT NULL CHECK (latest_sequence >= 0)
);
INSERT INTO companion_projection_state(
    singleton, generation, authorization_epoch, latest_sequence
) VALUES (1, 1, 1, 0);

CREATE TABLE companion_projection_updates (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_version INTEGER NOT NULL CHECK (entity_version >= 0),
    occurred_at INTEGER NOT NULL
);
CREATE INDEX companion_projection_updates_by_entity
    ON companion_projection_updates(generation, entity_kind, entity_id, sequence DESC);
CREATE INDEX companion_projection_updates_by_kind_sequence
    ON companion_projection_updates(generation, entity_kind, sequence DESC);
CREATE TRIGGER companion_projection_deduplicate
BEFORE INSERT ON companion_projection_updates
WHEN EXISTS (
    SELECT 1 FROM companion_projection_updates existing
    WHERE existing.event_id = NEW.event_id
)
BEGIN
    SELECT RAISE(IGNORE);
END;

CREATE TABLE companion_commands (
    command_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    session_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    session_generation INTEGER NOT NULL,
    capability TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    expected_version INTEGER NOT NULL,
    audit_timestamp INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'refused')),
    refusal_code TEXT,
    message TEXT,
    host_ack_json TEXT CHECK (host_ack_json IS NULL OR json_valid(host_ack_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES companion_sessions(id)
);

CREATE TABLE companion_command_outbox (
    command_id TEXT PRIMARY KEY,
    envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'dispatching', 'executing', 'dispatched', 'cancelled')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT,
    created_at INTEGER NOT NULL,
    dispatched_at INTEGER,
    FOREIGN KEY (command_id) REFERENCES companion_commands(command_id) ON DELETE CASCADE
);
CREATE INDEX companion_command_outbox_pending
    ON companion_command_outbox(status, created_at, command_id);

CREATE TABLE companion_audit (
    id TEXT PRIMARY KEY,
    command_id TEXT,
    session_id TEXT,
    device_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX companion_audit_by_device_time
    ON companion_audit(device_id, created_at DESC);
CREATE UNIQUE INDEX companion_audit_by_command_decision
    ON companion_audit(command_id, decision)
    WHERE command_id IS NOT NULL;

CREATE TRIGGER companion_projection_advance
AFTER INSERT ON companion_projection_updates
BEGIN
    UPDATE companion_projection_state
    SET latest_sequence = MAX(latest_sequence, NEW.sequence)
    WHERE singleton = 1;
END;

CREATE TRIGGER companion_project_insert
AFTER INSERT ON workspaces
BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'project', COALESCE(NEW.public_id, CAST(NEW.id AS TEXT)),
        MAX(NEW.updated_at, 0), NEW.updated_at
    );
END;
CREATE TRIGGER companion_project_update
AFTER UPDATE ON workspaces BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'project', COALESCE(NEW.public_id, CAST(NEW.id AS TEXT)),
        MAX(NEW.updated_at, 0), NEW.updated_at
    );
END;
CREATE TRIGGER companion_project_delete
BEFORE DELETE ON workspaces BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'project', COALESCE(OLD.public_id, CAST(OLD.id AS TEXT)),
        MAX(OLD.updated_at + 1, 0), OLD.updated_at
    );
END;

CREATE TRIGGER companion_task_insert
AFTER INSERT ON tasks BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'task', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                 WHERE id = NEW.workspace_id) || '/' || NEW.task_id,
        MAX(NEW.updated_at, 0), NEW.updated_at
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'task_stage', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                       WHERE id = NEW.workspace_id) || '/' || NEW.task_id,
        NEW.task_stage_version, NEW.updated_at
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'project', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                    WHERE id = NEW.workspace_id),
        MAX(NEW.updated_at, 0), NEW.updated_at
    );
END;
CREATE TRIGGER companion_task_update
AFTER UPDATE ON tasks BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'task', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                 WHERE id = NEW.workspace_id) || '/' || NEW.task_id,
        MAX(NEW.updated_at, 0), NEW.updated_at
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'task_stage', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                       WHERE id = NEW.workspace_id) || '/' || NEW.task_id,
        NEW.task_stage_version, NEW.updated_at
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'project', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                    WHERE id = NEW.workspace_id),
        MAX(NEW.updated_at, 0), NEW.updated_at
    );
END;
CREATE TRIGGER companion_task_delete
BEFORE DELETE ON tasks BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'task', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                 WHERE id = OLD.workspace_id) || '/' || OLD.task_id,
        MAX(OLD.updated_at + 1, 0), OLD.updated_at
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'task_stage', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                       WHERE id = OLD.workspace_id) || '/' || OLD.task_id,
        OLD.task_stage_version + 1, OLD.updated_at
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'project', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                    WHERE id = OLD.workspace_id),
        MAX(OLD.updated_at + 1, 0), OLD.updated_at
    );
END;

CREATE TRIGGER companion_run_insert
AFTER INSERT ON runs BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'run', NEW.id, NEW.version, NEW.queued_at
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'observatory', NEW.id, NEW.version, NEW.queued_at
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'task', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                 WHERE id = NEW.workspace_id) || '/' || NEW.task_id,
        COALESCE((SELECT updated_at FROM tasks
                  WHERE workspace_id = NEW.workspace_id AND task_id = NEW.task_id), 0),
        NEW.queued_at
    );
END;
CREATE TRIGGER companion_run_update
AFTER UPDATE ON runs BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'run', NEW.id, NEW.version, COALESCE(NEW.finished_at, NEW.started_at, NEW.queued_at)
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'observatory', NEW.id, NEW.version, COALESCE(NEW.finished_at, NEW.started_at, NEW.queued_at)
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'task', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                 WHERE id = NEW.workspace_id) || '/' || NEW.task_id,
        COALESCE((SELECT updated_at FROM tasks
                  WHERE workspace_id = NEW.workspace_id AND task_id = NEW.task_id), 0),
        COALESCE(NEW.finished_at, NEW.started_at, NEW.queued_at)
    );
END;
CREATE TRIGGER companion_run_delete
BEFORE DELETE ON runs BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'run', OLD.id, OLD.version + 1, COALESCE(OLD.finished_at, OLD.started_at, OLD.queued_at)
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'observatory', OLD.id, OLD.version + 1,
        COALESCE(OLD.finished_at, OLD.started_at, OLD.queued_at)
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'task', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                 WHERE id = OLD.workspace_id) || '/' || OLD.task_id,
        COALESCE((SELECT updated_at FROM tasks
                  WHERE workspace_id = OLD.workspace_id AND task_id = OLD.task_id), 0) + 1,
        COALESCE(OLD.finished_at, OLD.started_at, OLD.queued_at)
    );
END;

CREATE TRIGGER companion_attention_insert
AFTER INSERT ON attention_occurrences BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'attention', NEW.id, MAX(NEW.created_at, 0), NEW.created_at
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'project', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                    WHERE id = NEW.workspace_id),
        MAX(NEW.created_at, 0), NEW.created_at
    );
END;
CREATE TRIGGER companion_attention_update
AFTER UPDATE ON attention_occurrences BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'attention', NEW.id,
        MAX(NEW.created_at, COALESCE(NEW.resolved_at, 0), COALESCE(NEW.acknowledged_at, 0)),
        MAX(NEW.created_at, COALESCE(NEW.resolved_at, 0), COALESCE(NEW.acknowledged_at, 0))
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'project', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                    WHERE id = NEW.workspace_id),
        MAX(NEW.created_at, COALESCE(NEW.resolved_at, 0), COALESCE(NEW.acknowledged_at, 0)),
        MAX(NEW.created_at, COALESCE(NEW.resolved_at, 0), COALESCE(NEW.acknowledged_at, 0))
    );
END;
CREATE TRIGGER companion_attention_delete
BEFORE DELETE ON attention_occurrences BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'attention', OLD.id,
        MAX(OLD.created_at, COALESCE(OLD.resolved_at, 0), COALESCE(OLD.acknowledged_at, 0)) + 1,
        MAX(OLD.created_at, COALESCE(OLD.resolved_at, 0), COALESCE(OLD.acknowledged_at, 0))
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'project', (SELECT COALESCE(public_id, CAST(id AS TEXT)) FROM workspaces
                    WHERE id = OLD.workspace_id),
        MAX(OLD.created_at, COALESCE(OLD.resolved_at, 0), COALESCE(OLD.acknowledged_at, 0)) + 1,
        MAX(OLD.created_at, COALESCE(OLD.resolved_at, 0), COALESCE(OLD.acknowledged_at, 0))
    );
END;

CREATE TRIGGER companion_timeline_insert
AFTER INSERT ON run_events BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'safe_timeline', NEW.run_id || ':' || NEW.sequence, NEW.sequence, NEW.timestamp
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'observatory', NEW.run_id,
        COALESCE((SELECT version FROM runs WHERE id = NEW.run_id), 0), NEW.timestamp
    );
END;
CREATE TRIGGER companion_timeline_delete
BEFORE DELETE ON run_events BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'safe_timeline', OLD.run_id || ':' || OLD.sequence, OLD.sequence + 1, OLD.timestamp
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'observatory', OLD.run_id,
        COALESCE((SELECT version FROM runs WHERE id = OLD.run_id), 0), OLD.timestamp
    );
END;

CREATE TRIGGER companion_pending_input_insert
AFTER INSERT ON pending_inputs BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'pending_input', NEW.id, MAX(NEW.opened_at, 0), NEW.opened_at
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'observatory', NEW.run_id,
        COALESCE((SELECT version FROM runs WHERE id = NEW.run_id), 0), NEW.opened_at
    );
END;
CREATE TRIGGER companion_pending_input_update
AFTER UPDATE ON pending_inputs BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'pending_input', NEW.id,
        MAX(NEW.opened_at, COALESCE(NEW.resolved_at, 0), COALESCE(NEW.invalidated_at, 0)),
        MAX(NEW.opened_at, COALESCE(NEW.resolved_at, 0), COALESCE(NEW.invalidated_at, 0))
    ),
    (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'observatory', NEW.run_id,
        COALESCE((SELECT version FROM runs WHERE id = NEW.run_id), 0),
        MAX(NEW.opened_at, COALESCE(NEW.resolved_at, 0), COALESCE(NEW.invalidated_at, 0))
    );
END;
CREATE TRIGGER companion_pending_input_delete
BEFORE DELETE ON pending_inputs BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'pending_input', OLD.id,
        MAX(OLD.opened_at, COALESCE(OLD.resolved_at, 0), COALESCE(OLD.invalidated_at, 0)) + 1,
        MAX(OLD.opened_at, COALESCE(OLD.resolved_at, 0), COALESCE(OLD.invalidated_at, 0))
    );
END;

CREATE TRIGGER companion_verification_insert
AFTER INSERT ON verification_attempts BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'verification', NEW.run_id, NEW.version, NEW.updated_at
    );
END;
CREATE TRIGGER companion_verification_update
AFTER UPDATE ON verification_attempts BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'verification', NEW.run_id, NEW.version, NEW.updated_at
    );
END;
CREATE TRIGGER companion_verification_delete
BEFORE DELETE ON verification_attempts BEGIN
    INSERT OR IGNORE INTO companion_projection_updates(
        event_id, generation, entity_kind, entity_id, entity_version, occurred_at
    ) VALUES (
        'auto:' || lower(hex(randomblob(16))),
        (SELECT generation FROM companion_projection_state WHERE singleton = 1),
        'verification', OLD.run_id, OLD.version + 1, OLD.updated_at
    );
END;

INSERT OR IGNORE INTO companion_projection_updates(
    event_id, generation, entity_kind, entity_id, entity_version, occurred_at
)
SELECT 'project:' || id || ':' || updated_at, 1, 'project',
       COALESCE(public_id, CAST(id AS TEXT)),
       MAX(updated_at, 0), updated_at FROM workspaces;
INSERT OR IGNORE INTO companion_projection_updates(
    event_id, generation, entity_kind, entity_id, entity_version, occurred_at
)
SELECT 'task:' || t.workspace_id || ':' || t.task_id || ':' || t.updated_at, 1, 'task',
       COALESCE(w.public_id, CAST(w.id AS TEXT)) || '/' || t.task_id,
       MAX(t.updated_at, 0), t.updated_at
FROM tasks t JOIN workspaces w ON w.id = t.workspace_id;
INSERT OR IGNORE INTO companion_projection_updates(
    event_id, generation, entity_kind, entity_id, entity_version, occurred_at
)
SELECT 'task-stage:' || t.workspace_id || ':' || t.task_id || ':' || t.task_stage_version, 1,
       'task_stage', COALESCE(w.public_id, CAST(w.id AS TEXT)) || '/' || t.task_id,
       t.task_stage_version, t.updated_at
FROM tasks t JOIN workspaces w ON w.id = t.workspace_id;
INSERT OR IGNORE INTO companion_projection_updates(
    event_id, generation, entity_kind, entity_id, entity_version, occurred_at
)
SELECT 'run:' || id || ':' || version, 1, 'run', id, version, queued_at FROM runs;
INSERT OR IGNORE INTO companion_projection_updates(
    event_id, generation, entity_kind, entity_id, entity_version, occurred_at
)
SELECT 'observatory:' || id || ':' || version, 1, 'observatory', id, version, queued_at FROM runs;
INSERT OR IGNORE INTO companion_projection_updates(
    event_id, generation, entity_kind, entity_id, entity_version, occurred_at
)
SELECT 'attention:' || id || ':' ||
           MAX(created_at, COALESCE(resolved_at, 0), COALESCE(acknowledged_at, 0)),
       1, 'attention', id,
       MAX(created_at, COALESCE(resolved_at, 0), COALESCE(acknowledged_at, 0)),
       MAX(created_at, COALESCE(resolved_at, 0), COALESCE(acknowledged_at, 0))
FROM attention_occurrences;
INSERT OR IGNORE INTO companion_projection_updates(
    event_id, generation, entity_kind, entity_id, entity_version, occurred_at
)
SELECT 'safe-timeline:' || event.run_id || ':' || event.sequence, 1, 'safe_timeline',
       event.run_id || ':' || event.sequence, event.sequence, event.timestamp
FROM run_events event;
INSERT OR IGNORE INTO companion_projection_updates(
    event_id, generation, entity_kind, entity_id, entity_version, occurred_at
)
SELECT 'pending-input:' || id || ':' ||
           MAX(opened_at, COALESCE(resolved_at, 0), COALESCE(invalidated_at, 0)),
       1, 'pending_input', id,
       MAX(opened_at, COALESCE(resolved_at, 0), COALESCE(invalidated_at, 0)),
       MAX(opened_at, COALESCE(resolved_at, 0), COALESCE(invalidated_at, 0))
FROM pending_inputs;
INSERT OR IGNORE INTO companion_projection_updates(
    event_id, generation, entity_kind, entity_id, entity_version, occurred_at
)
SELECT 'verification:' || id || ':' || version, 1, 'verification',
       run_id, version, updated_at
FROM verification_attempts;
"#;

pub struct CompanionRepository;

pub(crate) enum CommandReservation {
    Reserved,
    Existing(CommandResult),
}

impl CompanionRepository {
    pub fn install_schema(connection: &mut Connection) -> Result<(), String> {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Could not start the Companion schema migration: {error}"))?;
        transaction
            .execute_batch(COMPANION_SCHEMA_SQL)
            .map_err(|error| format!("Could not install the Companion schema: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit the Companion schema migration: {error}"))
    }

    pub fn verify_schema(connection: &Connection) -> Result<(), String> {
        connection
            .prepare(
                "SELECT id, secret_hash, expires_at, consumed_at, created_at
                 FROM companion_pairings LIMIT 0",
            )
            .and_then(|_| {
                connection.prepare(
                    "SELECT id, device_id, device_name, secret_hash, grants_json, generation,
                            created_at, last_seen_at, rotated_at, revoked_at
                     FROM companion_sessions LIMIT 0",
                )
            })
            .and_then(|_| {
                connection.prepare(
                    "SELECT generation, authorization_epoch, latest_sequence
                     FROM companion_projection_state LIMIT 0",
                )
            })
            .and_then(|_| {
                connection.prepare(
                    "SELECT sequence, event_id, generation, entity_kind, entity_id,
                            entity_version, occurred_at
                     FROM companion_projection_updates LIMIT 0",
                )
            })
            .and_then(|_| {
                connection.prepare(
                    "SELECT command_id, idempotency_key, fingerprint, status
                     FROM companion_commands LIMIT 0",
                )
            })
            .map(|_| ())
            .map_err(|error| {
                format!(
                    "Companion schema version {COMPANION_SCHEMA_VERSION} is unavailable: {error}"
                )
            })
    }

    pub(crate) fn insert_pairing(
        connection: &mut Connection,
        pairing_id: &str,
        secret_hash: &str,
        expires_at: i64,
        created_at: i64,
    ) -> Result<(), String> {
        connection
            .execute(
                "INSERT INTO companion_pairings(id, secret_hash, expires_at, consumed_at, created_at)
                 VALUES (?1, ?2, ?3, NULL, ?4)",
                params![pairing_id, secret_hash, expires_at, created_at],
            )
            .map(|_| ())
            .map_err(|error| format!("Could not persist the Companion pairing credential: {error}"))
    }

    pub(crate) fn exchange_pairing(
        connection: &mut Connection,
        credential_hash: &str,
        session: &CompanionSession,
        session_secret_hash: &str,
        now: i64,
    ) -> Result<(), String> {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Could not start Companion pairing: {error}"))?;
        let pairing_id = transaction
            .query_row(
                "SELECT id FROM companion_pairings
                 WHERE secret_hash = ?1 AND consumed_at IS NULL AND expires_at >= ?2",
                params![credential_hash, now],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| {
                format!("Could not inspect the Companion pairing credential: {error}")
            })?
            .ok_or("The Companion pairing credential is invalid, expired, or already used.")?;
        let consumed = transaction
            .execute(
                "UPDATE companion_pairings SET consumed_at = ?1
                 WHERE id = ?2 AND consumed_at IS NULL AND expires_at >= ?1",
                params![now, pairing_id],
            )
            .map_err(|error| {
                format!("Could not consume the Companion pairing credential: {error}")
            })?;
        if consumed != 1 {
            return Err("The Companion pairing credential was already used.".to_owned());
        }
        transaction
            .execute(
                "INSERT INTO companion_sessions(
                    id, device_id, device_name, secret_hash, grants_json, generation,
                    created_at, last_seen_at, rotated_at, revoked_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL)",
                params![
                    session.session_id,
                    session.device_id,
                    session.device_name,
                    session_secret_hash,
                    json_string(&session.grants, "Companion grants")?,
                    session.generation,
                    session.created_at,
                    session.last_seen_at,
                ],
            )
            .map_err(|error| format!("Could not create the Companion session: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit Companion pairing: {error}"))
    }

    pub fn list_sessions(connection: &Connection) -> Result<Vec<CompanionSession>, String> {
        let mut statement = connection
            .prepare(
                "SELECT id, device_id, device_name, grants_json, generation, created_at,
                        last_seen_at, rotated_at, revoked_at
                 FROM companion_sessions ORDER BY created_at DESC, id DESC",
            )
            .map_err(|error| format!("Could not prepare the Companion session list: {error}"))?;
        let rows = statement
            .query_map([], session_from_row)
            .map_err(|error| format!("Could not query Companion sessions: {error}"))?;
        rows.map(|row| {
            row.map_err(|error| format!("Could not decode a Companion session: {error}"))
                .and_then(|row| row.decode())
        })
        .collect()
    }

    pub(crate) fn rotate_session(
        connection: &mut Connection,
        session_id: &str,
        new_secret_hash: &str,
        now: i64,
    ) -> Result<CompanionSession, String> {
        let changed = connection
            .execute(
                "UPDATE companion_sessions
                 SET secret_hash = ?1, generation = generation + 1, rotated_at = ?2,
                     last_seen_at = ?2
                 WHERE id = ?3 AND revoked_at IS NULL",
                params![new_secret_hash, now, session_id],
            )
            .map_err(|error| format!("Could not rotate the Companion session: {error}"))?;
        if changed != 1 {
            return Err("The Companion session does not exist or has been revoked.".to_owned());
        }
        Self::load_session(connection, session_id)
    }

    pub fn revoke_session(
        connection: &mut Connection,
        session_id: &str,
        now: i64,
    ) -> Result<CompanionSession, String> {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Could not start Companion session revocation: {error}"))?;
        let changed = transaction
            .execute(
                "UPDATE companion_sessions
                 SET revoked_at = ?1, generation = generation + 1
                 WHERE id = ?2 AND revoked_at IS NULL",
                params![now, session_id],
            )
            .map_err(|error| format!("Could not revoke the Companion session: {error}"))?;
        if changed != 1 {
            return Err("The Companion session does not exist or is already revoked.".to_owned());
        }
        refuse_pending_for_session(&transaction, session_id, now)?;
        let session = Self::load_session(&transaction, session_id)?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit Companion session revocation: {error}"))?;
        Ok(session)
    }

    pub fn revoke_device(
        connection: &mut Connection,
        device_id: &str,
        now: i64,
    ) -> Result<Vec<CompanionSession>, String> {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Could not start Companion device revocation: {error}"))?;
        let session_ids = {
            let mut statement = transaction
                .prepare(
                    "SELECT id FROM companion_sessions
                     WHERE device_id = ?1 AND revoked_at IS NULL ORDER BY created_at, id",
                )
                .map_err(|error| format!("Could not inspect Companion device sessions: {error}"))?;
            let rows = statement
                .query_map([device_id], |row| row.get::<_, String>(0))
                .map_err(|error| format!("Could not query Companion device sessions: {error}"))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| format!("Could not decode Companion device sessions: {error}"))?;
            rows
        };
        if session_ids.is_empty() {
            return Err("The Companion device has no active sessions.".to_owned());
        }
        transaction
            .execute(
                "UPDATE companion_sessions
                 SET revoked_at = ?1, generation = generation + 1
                 WHERE device_id = ?2 AND revoked_at IS NULL",
                params![now, device_id],
            )
            .map_err(|error| format!("Could not revoke the Companion device: {error}"))?;
        for session_id in &session_ids {
            refuse_pending_for_session(&transaction, session_id, now)?;
        }
        let sessions = session_ids
            .iter()
            .map(|session_id| Self::load_session(&transaction, session_id))
            .collect::<Result<Vec<_>, _>>()?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit Companion device revocation: {error}"))?;
        Ok(sessions)
    }

    pub fn replace_grants(
        connection: &mut Connection,
        session_id: &str,
        grants: &[CompanionGrant],
        now: i64,
    ) -> Result<CompanionSession, String> {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Could not start Companion grant replacement: {error}"))?;
        let changed = transaction
            .execute(
                "UPDATE companion_sessions SET grants_json = ?1, last_seen_at = ?2
                 WHERE id = ?3 AND revoked_at IS NULL",
                params![json_string(grants, "Companion grants")?, now, session_id],
            )
            .map_err(|error| format!("Could not replace Companion grants: {error}"))?;
        if changed != 1 {
            return Err("The Companion session does not exist or has been revoked.".to_owned());
        }
        let advanced = transaction
            .execute(
                "UPDATE companion_projection_state
                 SET authorization_epoch = authorization_epoch + 1
                 WHERE singleton = 1 AND authorization_epoch < 4294967295",
                [],
            )
            .map_err(|error| format!("Could not advance Companion authorization state: {error}"))?;
        if advanced != 1 {
            return Err("The Companion authorization epoch is exhausted.".to_owned());
        }
        let session = Self::load_session(&transaction, session_id)?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit Companion grant replacement: {error}"))?;
        Ok(session)
    }

    pub(crate) fn authenticate(
        connection: &Connection,
        credential: &SessionCredential,
        now: i64,
    ) -> Result<CompanionSession, String> {
        let (session, stored_hash) =
            Self::load_session_with_hash(connection, &credential.session_id)?;
        if session.revoked_at.is_some()
            || session.device_id != credential.device_id
            || session.generation != credential.generation
            || !constant_time_eq(
                stored_hash.as_bytes(),
                credential_hash(&credential.secret).as_bytes(),
            )
        {
            return Err(
                "The Companion session credential is invalid, revoked, or from a late generation."
                    .to_owned(),
            );
        }
        connection
            .execute(
                "UPDATE companion_sessions SET last_seen_at = MAX(last_seen_at, ?1)
                 WHERE id = ?2",
                params![now, credential.session_id],
            )
            .map_err(|error| format!("Could not update Companion session activity: {error}"))?;
        Ok(CompanionSession {
            last_seen_at: session.last_seen_at.max(now),
            ..session
        })
    }

    pub(crate) fn load_session(
        connection: &Connection,
        session_id: &str,
    ) -> Result<CompanionSession, String> {
        let row = connection
            .query_row(
                "SELECT id, device_id, device_name, grants_json, generation, created_at,
                        last_seen_at, rotated_at, revoked_at
                 FROM companion_sessions WHERE id = ?1",
                [session_id],
                session_from_row,
            )
            .optional()
            .map_err(|error| format!("Could not load the Companion session: {error}"))?
            .ok_or("The Companion session does not exist.")?;
        row.decode()
    }

    fn load_session_with_hash(
        connection: &Connection,
        session_id: &str,
    ) -> Result<(CompanionSession, String), String> {
        let row = connection
            .query_row(
                "SELECT id, device_id, device_name, grants_json, generation, created_at,
                        last_seen_at, rotated_at, revoked_at, secret_hash
                 FROM companion_sessions WHERE id = ?1",
                [session_id],
                |row| {
                    Ok((
                        StoredSessionRow {
                            session_id: row.get(0)?,
                            device_id: row.get(1)?,
                            device_name: row.get(2)?,
                            grants_json: row.get(3)?,
                            generation: row.get(4)?,
                            created_at: row.get(5)?,
                            last_seen_at: row.get(6)?,
                            rotated_at: row.get(7)?,
                            revoked_at: row.get(8)?,
                        },
                        row.get(9)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Could not authenticate the Companion session: {error}"))?
            .ok_or("The Companion session does not exist.")?;
        Ok((row.0.decode()?, row.1))
    }

    pub fn projection_position(connection: &Connection) -> Result<(i64, i64, i64), String> {
        connection
            .query_row(
                "SELECT generation, latest_sequence, authorization_epoch
                 FROM companion_projection_state
                 WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| format!("Could not load the Companion projection position: {error}"))
    }

    pub fn advance_projection_generation(
        connection: &mut Connection,
        expected_generation: i64,
    ) -> Result<i64, String> {
        let changed = connection
            .execute(
                "UPDATE companion_projection_state
                 SET generation = generation + 1
                 WHERE singleton = 1 AND generation = ?1",
                [expected_generation],
            )
            .map_err(|error| {
                format!("Could not advance the Companion projection generation: {error}")
            })?;
        if changed != 1 {
            return Err("The Companion projection generation changed concurrently.".to_owned());
        }
        Self::projection_position(connection).map(|position| position.0)
    }

    pub(crate) fn append_projection_update(
        connection: &mut Connection,
        update: &super::models::AppendProjectionUpdate,
    ) -> Result<ProjectionUpdate, String> {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Could not start the Companion projection update: {error}"))?;
        let (generation, _, _) = Self::projection_position(&transaction)?;
        if update.generation != generation {
            return Err(if update.generation < generation {
                "The Companion projection update belongs to a late runtime generation.".to_owned()
            } else {
                "The Companion projection update belongs to an unknown future generation."
                    .to_owned()
            });
        }
        let inserted = transaction
            .execute(
                "INSERT INTO companion_projection_updates(
                event_id, generation, entity_kind, entity_id, entity_version, occurred_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(event_id) DO NOTHING",
                params![
                    update.event_id,
                    update.generation,
                    projection_kind_database(update.kind),
                    update.entity_id,
                    update.entity_version,
                    update.occurred_at,
                ],
            )
            .map_err(|error| {
                format!("Could not persist the Companion projection update: {error}")
            })?;
        let record = load_projection_journal_by_event(&transaction, &update.event_id)?;
        if inserted == 0
            && (record.generation != update.generation
                || record.kind()? != update.kind
                || record.entity_id != update.entity_id
                || record.entity_version != update.entity_version
                || record.occurred_at != update.occurred_at)
        {
            return Err(
                "The Companion projection event id was replayed with different content.".to_owned(),
            );
        }
        transaction
            .execute(
                "UPDATE companion_projection_state
                 SET latest_sequence = MAX(latest_sequence, ?1)
                 WHERE singleton = 1",
                [record.sequence],
            )
            .map_err(|error| {
                format!("Could not advance the Companion reconnect cursor: {error}")
            })?;
        let hydrated = hydrate_projection(&transaction, record)?;
        transaction.commit().map_err(|error| {
            format!("Could not commit the Companion projection update: {error}")
        })?;
        Ok(hydrated)
    }

    pub(crate) fn load_projection_updates(
        connection: &Connection,
        generation: i64,
        after_sequence: i64,
        grants: &[CompanionGrant],
        limit: usize,
    ) -> Result<(Vec<ProjectionUpdate>, i64, bool), String> {
        let sql = "SELECT sequence, event_id, generation, entity_kind, entity_id,
                          entity_version, occurred_at
                   FROM companion_projection_updates
                   WHERE generation = ?1 AND sequence > ?2
                   ORDER BY sequence ASC LIMIT ?3";
        let mut statement = connection
            .prepare(sql)
            .map_err(|error| format!("Could not prepare Companion synchronization: {error}"))?;
        let raw_updates = statement
            .query_map(
                params![generation, after_sequence, (limit + 1) as i64],
                projection_from_row,
            )
            .map_err(|error| format!("Could not load Companion updates: {error}"))?
            .map(|row| {
                row.map_err(|error| {
                    format!("Could not decode a Companion projection journal entry: {error}")
                })
                .and_then(|stored| stored.decode())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = raw_updates.len() > limit;
        let page = &raw_updates[..raw_updates.len().min(limit)];
        let scan_cursor = page
            .last()
            .map(|update| update.sequence)
            .unwrap_or(after_sequence);
        let updates = page
            .iter()
            .filter(|update| {
                update
                    .kind()
                    .is_ok_and(|kind| grants.iter().any(|grant| grant.allows_projection(kind)))
            })
            .cloned()
            .map(|update| hydrate_projection(connection, update))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((updates, scan_cursor, has_more))
    }

    pub(crate) fn load_projection_snapshot(
        connection: &Connection,
        generation: i64,
        after_sequence: i64,
        base_sequence: i64,
        grants: &[CompanionGrant],
        limit: usize,
    ) -> Result<(Vec<ProjectionUpdate>, i64, bool), String> {
        let mut statement = connection
            .prepare(
                "SELECT sequence, event_id, generation, entity_kind, entity_id,
                        entity_version, occurred_at
                 FROM companion_projection_updates current
                 WHERE generation = ?1
                   AND sequence > ?2
                   AND sequence <= ?3
                   AND current.entity_kind <> 'task_stage'
                   AND (
                       current.entity_kind <> 'safe_timeline'
                       OR current.sequence >= COALESCE((
                           SELECT recent.sequence
                           FROM companion_projection_updates recent
                           WHERE recent.generation = ?1
                             AND recent.entity_kind = 'safe_timeline'
                             AND recent.sequence <= ?3
                           ORDER BY recent.sequence DESC
                           LIMIT 1 OFFSET 199
                       ), 0)
                   )
                   AND sequence = (
                       SELECT candidate.sequence
                       FROM companion_projection_updates candidate
                       WHERE candidate.generation = current.generation
                         AND candidate.entity_kind = current.entity_kind
                         AND candidate.entity_id = current.entity_id
                         AND candidate.sequence <= ?3
                       ORDER BY candidate.sequence DESC
                       LIMIT 1
                   )
                 ORDER BY sequence ASC LIMIT ?4",
            )
            .map_err(|error| {
                format!("Could not prepare the canonical Companion snapshot: {error}")
            })?;
        let journal = statement
            .query_map(
                params![
                    generation,
                    after_sequence,
                    base_sequence,
                    (limit + 1) as i64
                ],
                projection_from_row,
            )
            .map_err(|error| format!("Could not query the canonical Companion snapshot: {error}"))?
            .map(|row| {
                row.map_err(|error| {
                    format!("Could not decode a Companion snapshot reference: {error}")
                })
                .and_then(|stored| stored.decode())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = journal.len() > limit;
        let page = &journal[..journal.len().min(limit)];
        let scan_cursor = page
            .last()
            .map(|entry| entry.sequence)
            .unwrap_or(after_sequence);
        let updates = page
            .iter()
            .filter(|entry| {
                entry
                    .kind()
                    .is_ok_and(|kind| grants.iter().any(|grant| grant.allows_projection(kind)))
            })
            .cloned()
            .map(|entry| hydrate_projection(connection, entry))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((updates, scan_cursor, has_more))
    }

    pub(crate) fn reserve_command(
        connection: &Connection,
        envelope: &CommandEnvelope,
        fingerprint: &str,
        now: i64,
    ) -> Result<CommandReservation, String> {
        if let Some((stored_fingerprint, result)) =
            load_command_by_identity(connection, &envelope.command_id, &envelope.idempotency_key)?
        {
            if stored_fingerprint != fingerprint {
                return Err(
                    "The Companion command identity was replayed with a different envelope."
                        .to_owned(),
                );
            }
            return Ok(CommandReservation::Existing(result));
        }
        connection
            .execute(
                "INSERT INTO companion_commands(
                    command_id, idempotency_key, fingerprint, session_id, device_id,
                    session_generation, capability, target_kind, target_id,
                    expected_version, audit_timestamp, status, refusal_code, message,
                    host_ack_json, created_at, updated_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                    'pending', NULL, NULL, NULL, ?12, ?12
                 )",
                params![
                    envelope.command_id,
                    envelope.idempotency_key,
                    fingerprint,
                    envelope.session_id,
                    envelope.device_id,
                    envelope.session_generation,
                    command_capability_database(envelope.capability),
                    target_kind_database(envelope.target.kind),
                    envelope.target.id,
                    envelope.expected_version,
                    envelope.audit_timestamp,
                    now,
                ],
            )
            .map_err(|error| {
                format!("Could not persist the Companion command reservation: {error}")
            })?;
        Ok(CommandReservation::Reserved)
    }

    pub(crate) fn complete_command(
        connection: &Connection,
        command_id: &str,
        acknowledgement: &HostCommandAck,
        now: i64,
    ) -> Result<CommandResult, String> {
        let acknowledgement_json = json_string(acknowledgement, "Companion host acknowledgement")?;
        let changed = connection
            .execute(
                "UPDATE companion_commands
                 SET status = 'succeeded', host_ack_json = ?1, updated_at = ?2
                 WHERE command_id = ?3 AND status = 'pending'",
                params![acknowledgement_json, now, command_id],
            )
            .map_err(|error| {
                format!("Could not persist the Companion host acknowledgement: {error}")
            })?;
        if changed != 1 {
            return Err(
                "The Companion command is no longer awaiting host acknowledgement.".to_owned(),
            );
        }
        Ok(CommandResult {
            command_id: command_id.to_owned(),
            state: CommandState::Succeeded,
            acknowledgement: Some(acknowledgement.clone()),
            refusal_code: None,
            message: None,
        })
    }

    pub(crate) fn enqueue_runtime_effect(
        connection: &Connection,
        envelope: &CommandEnvelope,
        now: i64,
    ) -> Result<(), String> {
        connection
            .execute(
                "INSERT OR IGNORE INTO companion_command_outbox(
                    command_id, envelope_json, status, attempt_count, last_error,
                    created_at, dispatched_at
                 ) VALUES (?1, ?2, 'pending', 0, NULL, ?3, NULL)",
                params![
                    envelope.command_id,
                    json_string(envelope, "Companion runtime outbox intent")?,
                    now,
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("Could not persist the Companion runtime intent: {error}"))
    }

    pub fn pending_runtime_effects(
        connection: &Connection,
        limit: usize,
    ) -> Result<Vec<CompanionOutboxIntent>, String> {
        let mut statement = connection
            .prepare(
                "SELECT command_id, envelope_json, status, attempt_count, created_at
                 FROM companion_command_outbox
                 WHERE status IN ('pending', 'dispatching', 'executing')
                 ORDER BY created_at, command_id LIMIT ?1",
            )
            .map_err(|error| format!("Could not prepare Companion runtime recovery: {error}"))?;
        let intents = statement
            .query_map([limit.clamp(1, 200) as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|error| format!("Could not query Companion runtime recovery: {error}"))?
            .map(|row| {
                let (command_id, envelope_json, status, attempt_count, created_at) =
                    row.map_err(|error| {
                        format!("Could not decode a Companion runtime intent: {error}")
                    })?;
                Ok(CompanionOutboxIntent {
                    command_id,
                    envelope: parse_json(&envelope_json, "Companion runtime outbox intent")?,
                    status,
                    attempt_count,
                    created_at,
                })
            })
            .collect();
        intents
    }

    pub fn claim_runtime_effects(
        connection: &mut Connection,
        limit: usize,
    ) -> Result<Vec<CompanionOutboxIntent>, String> {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Could not claim Companion runtime recovery: {error}"))?;
        let intents = Self::pending_runtime_effects(&transaction, limit)?;
        for intent in &intents {
            if intent.status == "executing" {
                continue;
            }
            transaction
                .execute(
                    "UPDATE companion_command_outbox
                     SET status = 'dispatching', attempt_count = attempt_count + 1
                     WHERE command_id = ?1 AND status IN ('pending', 'dispatching')",
                    [&intent.command_id],
                )
                .map_err(|error| format!("Could not claim Companion runtime intent: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("Could not commit Companion runtime claims: {error}"))?;
        Ok(intents)
    }

    pub fn mark_runtime_effect_executing(
        connection: &Connection,
        command_id: &str,
    ) -> Result<(), String> {
        let changed = connection
            .execute(
                "UPDATE companion_command_outbox
                 SET status = 'executing'
                 WHERE command_id = ?1 AND status = 'dispatching'",
                [command_id],
            )
            .map_err(|error| format!("Could not start Companion runtime effect: {error}"))?;
        if changed != 1 {
            return Err("The Companion runtime intent is not ready to execute.".to_owned());
        }
        Ok(())
    }

    pub fn acknowledge_runtime_dispatch(
        connection: &mut Connection,
        command_id: &str,
        resulting_version: i64,
        dispatched_at: i64,
    ) -> Result<(), String> {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                format!("Could not start Companion runtime acknowledgement: {error}")
            })?;
        let changed = transaction
            .execute(
                "UPDATE companion_command_outbox
                 SET status = 'dispatched', last_error = NULL, dispatched_at = ?1
                 WHERE command_id = ?2 AND status IN ('dispatching', 'executing')",
                params![dispatched_at, command_id],
            )
            .map_err(|error| {
                format!("Could not acknowledge Companion runtime dispatch: {error}")
            })?;
        if changed != 1 {
            return Err("The Companion runtime intent is not dispatching.".to_owned());
        }
        let acknowledgement = HostCommandAck {
            acknowledgement_id: format!("host:{command_id}"),
            resulting_version,
            acknowledged_at: dispatched_at,
            detail: Some(serde_json::json!({ "durableEffect": "runtime_effect" })),
        };
        Self::complete_command(&transaction, command_id, &acknowledgement, dispatched_at)?;
        transaction
            .execute(
                "INSERT INTO companion_audit(
                    id, command_id, session_id, device_id, capability, target_kind,
                    target_id, decision, reason, created_at
                 )
                 SELECT ?1, command_id, session_id, device_id, capability, target_kind,
                        target_id, 'acknowledged',
                        'The primary host executed and acknowledged the Companion runtime effect.',
                        ?2
                 FROM companion_commands WHERE command_id = ?3",
                params![uuid::Uuid::now_v7().to_string(), dispatched_at, command_id],
            )
            .map_err(|error| {
                format!("Could not audit Companion runtime acknowledgement: {error}")
            })?;
        transaction.commit().map_err(|error| {
            format!("Could not commit Companion runtime acknowledgement: {error}")
        })?;
        Ok(())
    }

    pub fn record_runtime_dispatch_failure(
        connection: &Connection,
        command_id: &str,
        diagnostic: &str,
    ) -> Result<(), String> {
        connection
            .execute(
                "UPDATE companion_command_outbox
                 SET status = 'pending', last_error = ?1
                 WHERE command_id = ?2 AND status IN ('dispatching', 'executing')",
                params![diagnostic, command_id],
            )
            .map(|_| ())
            .map_err(|error| {
                format!("Could not record Companion runtime recovery failure: {error}")
            })
    }

    pub fn refuse_runtime_effect(
        connection: &mut Connection,
        command_id: &str,
        refusal_code: &str,
        message: &str,
        now: i64,
    ) -> Result<(), String> {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                format!("Could not start the Companion runtime effect refusal: {error}")
            })?;
        transaction
            .execute(
                "UPDATE companion_command_outbox
                 SET status = 'cancelled', last_error = ?1
                 WHERE command_id = ?2
                   AND status IN ('pending', 'dispatching', 'executing')",
                params![message, command_id],
            )
            .map_err(|error| format!("Could not cancel Companion runtime effect: {error}"))?;
        let changed = transaction
            .execute(
                "UPDATE companion_commands
                 SET status = 'refused', refusal_code = ?1, message = ?2, updated_at = ?3
                 WHERE command_id = ?4 AND status = 'pending'",
                params![refusal_code, message, now, command_id],
            )
            .map_err(|error| format!("Could not refuse Companion runtime effect: {error}"))?;
        if changed == 1 {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO companion_audit(
                        id, command_id, session_id, device_id, capability, target_kind,
                        target_id, decision, reason, created_at
                     )
                     SELECT ?1, command_id, session_id, device_id, capability, target_kind,
                            target_id, 'refused', ?2, ?3
                     FROM companion_commands WHERE command_id = ?4",
                    params![uuid::Uuid::now_v7().to_string(), message, now, command_id],
                )
                .map_err(|error| {
                    format!("Could not audit refused Companion runtime effect: {error}")
                })?;
        }
        transaction.commit().map_err(|error| {
            format!("Could not commit Companion runtime effect refusal: {error}")
        })?;
        Ok(())
    }

    pub(crate) fn refuse_reserved_command(
        connection: &Connection,
        command_id: &str,
        refusal_code: &str,
        message: &str,
        now: i64,
    ) -> Result<CommandResult, String> {
        let changed = connection
            .execute(
                "UPDATE companion_commands
                 SET status = 'refused', refusal_code = ?1, message = ?2, updated_at = ?3
                 WHERE command_id = ?4 AND status = 'pending'",
                params![refusal_code, message, now, command_id],
            )
            .map_err(|error| format!("Could not persist the Companion command refusal: {error}"))?;
        if changed != 1 {
            return Err("The Companion command is no longer pending.".to_owned());
        }
        Ok(CommandResult {
            command_id: command_id.to_owned(),
            state: CommandState::Refused,
            acknowledgement: None,
            refusal_code: Some(refusal_code.to_owned()),
            message: Some(message.to_owned()),
        })
    }

    pub(crate) fn refuse_command(
        connection: &Connection,
        envelope: &CommandEnvelope,
        fingerprint: &str,
        refusal_code: &str,
        message: &str,
        now: i64,
    ) -> Result<CommandResult, String> {
        if let Some((stored_fingerprint, result)) =
            load_command_by_identity(connection, &envelope.command_id, &envelope.idempotency_key)?
        {
            if stored_fingerprint != fingerprint {
                return Err(
                    "The Companion command identity was replayed with a different envelope."
                        .to_owned(),
                );
            }
            return Ok(result);
        }
        connection
            .execute(
                "INSERT INTO companion_commands(
                    command_id, idempotency_key, fingerprint, session_id, device_id,
                    session_generation, capability, target_kind, target_id,
                    expected_version, audit_timestamp, status, refusal_code, message,
                    host_ack_json, created_at, updated_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                    'refused', ?12, ?13, NULL, ?14, ?14
                 )",
                params![
                    envelope.command_id,
                    envelope.idempotency_key,
                    fingerprint,
                    envelope.session_id,
                    envelope.device_id,
                    envelope.session_generation,
                    command_capability_database(envelope.capability),
                    target_kind_database(envelope.target.kind),
                    envelope.target.id,
                    envelope.expected_version,
                    envelope.audit_timestamp,
                    refusal_code,
                    message,
                    now,
                ],
            )
            .map_err(|error| format!("Could not persist the Companion refusal: {error}"))?;
        Ok(CommandResult {
            command_id: envelope.command_id.clone(),
            state: CommandState::Refused,
            acknowledgement: None,
            refusal_code: Some(refusal_code.to_owned()),
            message: Some(message.to_owned()),
        })
    }

    pub(crate) fn append_audit(
        connection: &Connection,
        audit: &CompanionAuditRecord,
    ) -> Result<(), String> {
        connection
            .execute(
                "INSERT OR IGNORE INTO companion_audit(
                    id, command_id, session_id, device_id, capability, target_kind,
                    target_id, decision, reason, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    audit.id,
                    audit.command_id,
                    audit.session_id,
                    audit.device_id,
                    command_capability_database(audit.capability),
                    target_kind_database(audit.target.kind),
                    audit.target.id,
                    audit.decision,
                    audit.reason,
                    audit.created_at,
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("Could not append the Companion audit record: {error}"))
    }

    pub fn list_audit(
        connection: &Connection,
        device_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<CompanionAuditRecord>, String> {
        let mut statement = connection
            .prepare(
                "SELECT id, command_id, session_id, device_id, capability, target_kind,
                        target_id, decision, reason, created_at
                 FROM companion_audit
                 WHERE ?1 IS NULL OR device_id = ?1
                 ORDER BY created_at DESC, id DESC LIMIT ?2",
            )
            .map_err(|error| format!("Could not prepare Companion audit history: {error}"))?;
        let rows = statement
            .query_map(params![device_id, limit.clamp(1, 1_000) as i64], |row| {
                Ok(StoredAuditRow {
                    id: row.get(0)?,
                    command_id: row.get(1)?,
                    session_id: row.get(2)?,
                    device_id: row.get(3)?,
                    capability: row.get(4)?,
                    target_kind: row.get(5)?,
                    target_id: row.get(6)?,
                    decision: row.get(7)?,
                    reason: row.get(8)?,
                    created_at: row.get(9)?,
                })
            })
            .map_err(|error| format!("Could not query Companion audit history: {error}"))?;
        rows.map(|row| {
            row.map_err(|error| format!("Could not decode a Companion audit record: {error}"))
                .and_then(|stored| stored.decode())
        })
        .collect()
    }

    pub(crate) fn list_notifications(
        connection: &Connection,
        cursor: Option<&NotificationCursor>,
        limit: usize,
    ) -> Result<NotificationPage, String> {
        let (after_created_at, after_id) = cursor
            .map(|cursor| (cursor.created_at, cursor.attention_id.as_str()))
            .unwrap_or((i64::MIN, ""));
        let mut statement = connection
            .prepare(
                "SELECT id, kind, created_at
                 FROM attention_occurrences
                 WHERE resolved_at IS NULL
                   AND acknowledged_at IS NULL
                   AND (created_at > ?1 OR (created_at = ?1 AND id > ?2))
                 ORDER BY created_at ASC, id ASC LIMIT ?3",
            )
            .map_err(|error| format!("Could not prepare Companion notifications: {error}"))?;
        let rows = statement
            .query_map(
                params![after_created_at, after_id, (limit + 1) as i64],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .map_err(|error| format!("Could not query Companion notifications: {error}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Could not decode Companion notifications: {error}"))?;
        let has_more = rows.len() > limit;
        let notifications = rows
            .into_iter()
            .take(limit)
            .map(|(attention_id, kind, created_at)| {
                let title = match kind.as_str() {
                    "decision" => "Operator decision needed",
                    "failure" => "Task needs attention",
                    "verification" => "Verification needs attention",
                    "review" | "publication" => "Outcome ready",
                    _ => "Xiao needs attention",
                };
                CompanionNotification {
                    deep_link: format!("xiao://attention/{attention_id}"),
                    attention_id,
                    kind,
                    title: title.to_owned(),
                    body: "Open Xiao Companion to review the canonical Attention item.".to_owned(),
                    created_at,
                }
            })
            .collect::<Vec<_>>();
        let next_cursor = notifications
            .last()
            .map(|notification| NotificationCursor {
                created_at: notification.created_at,
                attention_id: notification.attention_id.clone(),
            })
            .or_else(|| cursor.cloned());
        Ok(NotificationPage {
            notifications,
            next_cursor,
            has_more,
        })
    }
}

pub(crate) fn credential_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex_string(&hasher.finalize())
}

pub(crate) fn command_fingerprint(envelope: &CommandEnvelope) -> Result<String, String> {
    let bytes = serde_json::to_vec(envelope)
        .map_err(|error| format!("Could not encode the Companion command envelope: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(hex_string(&hasher.finalize()))
}

struct StoredSessionRow {
    session_id: String,
    device_id: String,
    device_name: String,
    grants_json: String,
    generation: i64,
    created_at: i64,
    last_seen_at: i64,
    rotated_at: Option<i64>,
    revoked_at: Option<i64>,
}

impl StoredSessionRow {
    fn decode(self) -> Result<CompanionSession, String> {
        Ok(CompanionSession {
            session_id: self.session_id,
            device_id: self.device_id,
            device_name: self.device_name,
            grants: parse_json(&self.grants_json, "Companion grants")?,
            generation: self.generation,
            created_at: self.created_at,
            last_seen_at: self.last_seen_at,
            rotated_at: self.rotated_at,
            revoked_at: self.revoked_at,
        })
    }
}

#[derive(Clone)]
struct StoredProjectionRow {
    sequence: i64,
    event_id: String,
    generation: i64,
    entity_kind: String,
    entity_id: String,
    entity_version: i64,
    occurred_at: i64,
}

impl StoredProjectionRow {
    fn decode(self) -> Result<Self, String> {
        projection_kind_from_database(&self.entity_kind)?;
        Ok(self)
    }

    fn kind(&self) -> Result<ProjectionKind, String> {
        projection_kind_from_database(&self.entity_kind)
    }

    fn tombstone(self) -> Result<ProjectionUpdate, String> {
        let entity_id = self.entity_id;
        Ok(ProjectionUpdate {
            sequence: self.sequence,
            event_id: self.event_id,
            generation: self.generation,
            kind: projection_kind_from_database(&self.entity_kind)?,
            entity_id: entity_id.clone(),
            entity_version: self.entity_version,
            payload: serde_json::json!({
                "id": entity_id,
                "deleted": true,
            }),
            occurred_at: self.occurred_at,
        })
    }
}

struct StoredAuditRow {
    id: String,
    command_id: Option<String>,
    session_id: Option<String>,
    device_id: String,
    capability: String,
    target_kind: String,
    target_id: String,
    decision: String,
    reason: String,
    created_at: i64,
}

impl StoredAuditRow {
    fn decode(self) -> Result<CompanionAuditRecord, String> {
        Ok(CompanionAuditRecord {
            id: self.id,
            command_id: self.command_id,
            session_id: self.session_id,
            device_id: self.device_id,
            capability: command_capability_from_database(&self.capability)?,
            target: TargetScope {
                kind: target_kind_from_database(&self.target_kind)?,
                id: self.target_id,
                project_id: None,
            },
            decision: self.decision,
            reason: self.reason,
            created_at: self.created_at,
        })
    }
}

fn session_from_row(row: &Row<'_>) -> rusqlite::Result<StoredSessionRow> {
    Ok(StoredSessionRow {
        session_id: row.get(0)?,
        device_id: row.get(1)?,
        device_name: row.get(2)?,
        grants_json: row.get(3)?,
        generation: row.get(4)?,
        created_at: row.get(5)?,
        last_seen_at: row.get(6)?,
        rotated_at: row.get(7)?,
        revoked_at: row.get(8)?,
    })
}

fn projection_from_row(row: &Row<'_>) -> rusqlite::Result<StoredProjectionRow> {
    Ok(StoredProjectionRow {
        sequence: row.get(0)?,
        event_id: row.get(1)?,
        generation: row.get(2)?,
        entity_kind: row.get(3)?,
        entity_id: row.get(4)?,
        entity_version: row.get(5)?,
        occurred_at: row.get(6)?,
    })
}

fn load_projection_journal_by_event(
    connection: &Connection,
    event_id: &str,
) -> Result<StoredProjectionRow, String> {
    let stored = connection
        .query_row(
            "SELECT sequence, event_id, generation, entity_kind, entity_id,
                    entity_version, occurred_at
             FROM companion_projection_updates WHERE event_id = ?1",
            [event_id],
            projection_from_row,
        )
        .map_err(|error| format!("Could not reload the Companion projection update: {error}"))?;
    stored.decode()
}

fn hydrate_projection(
    connection: &Connection,
    journal: StoredProjectionRow,
) -> Result<ProjectionUpdate, String> {
    let payload = match journal.kind()? {
        ProjectionKind::Project => connection
            .query_row(
                "SELECT COALESCE(w.public_id, CAST(w.id AS TEXT)),
                        COALESCE(w.display_name, 'Project'),
                        (SELECT COUNT(*) FROM tasks t WHERE t.workspace_id = w.id),
                        (SELECT COUNT(*) FROM attention_occurrences a
                         WHERE a.workspace_id = w.id AND a.resolved_at IS NULL
                           AND a.acknowledged_at IS NULL)
                 FROM workspaces w
                 WHERE COALESCE(w.public_id, CAST(w.id AS TEXT)) = ?1",
                [&journal.entity_id],
                |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "name": row.get::<_, String>(1)?,
                        "taskCount": row.get::<_, i64>(2)?,
                        "attentionCount": row.get::<_, i64>(3)?,
                    }))
                },
            )
            .optional(),
        ProjectionKind::Task | ProjectionKind::TaskStage => {
            let (workspace_id, task_id) = split_scoped_entity_id(&journal.entity_id)?;
            connection
                .query_row(
                    "SELECT COALESCE(w.public_id, CAST(w.id AS TEXT)), t.task_id, t.title,
                            t.task_stage, t.task_stage_version,
                            (SELECT r.id FROM runs r
                             WHERE r.workspace_id = t.workspace_id AND r.task_id = t.task_id
                             ORDER BY r.queued_at DESC, r.id DESC LIMIT 1)
                     FROM tasks t
                     JOIN workspaces w ON w.id = t.workspace_id
                     WHERE COALESCE(w.public_id, CAST(w.id AS TEXT)) = ?1
                       AND t.task_id = ?2",
                    params![workspace_id, task_id],
                    |row| {
                        let stage: String = row.get(3)?;
                        Ok(serde_json::json!({
                            "id": row.get::<_, String>(1)?,
                            "projectId": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(2)?,
                            "stage": stage,
                            "version": row.get::<_, i64>(4)?,
                            "currentRunId": row.get::<_, Option<String>>(5)?,
                            "outcomeAcceptancePermitted": matches!(
                                stage.as_str(), "ready_for_review" | "published"
                            ),
                        }))
                    },
                )
                .optional()
        }
        ProjectionKind::Run => connection
            .query_row(
                "SELECT r.id, COALESCE(w.public_id, CAST(w.id AS TEXT)), r.task_id,
                        r.status, r.agent_outcome, r.verification_outcome, r.queued_at,
                        r.started_at, r.finished_at, r.version
                 FROM runs r JOIN workspaces w ON w.id = r.workspace_id
                 WHERE r.id = ?1",
                [&journal.entity_id],
                |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "projectId": row.get::<_, String>(1)?,
                        "taskId": row.get::<_, String>(2)?,
                        "status": row.get::<_, String>(3)?,
                        "version": row.get::<_, i64>(9)?,
                        "canStop": matches!(
                            row.get::<_, String>(3)?.as_str(),
                            "queued" | "preparing" | "running" | "waiting_for_input" | "verifying"
                        ),
                        "canRetry": matches!(
                            row.get::<_, String>(3)?.as_str(),
                            "failed" | "interrupted"
                        ),
                        "canFollowUp": matches!(
                            row.get::<_, String>(3)?.as_str(),
                            "running" | "waiting_for_input"
                        ),
                        "safeSummary": format!(
                            "Run is {} with verification {}.",
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(5)?
                        ),
                    }))
                },
            )
            .optional(),
        ProjectionKind::PendingInput => connection
            .query_row(
                "SELECT id, run_id,
                        MAX(opened_at, COALESCE(resolved_at, 0), COALESCE(invalidated_at, 0)),
                        kind, safe_summary_json
                 FROM pending_inputs
                 WHERE id = ?1 AND resolved_at IS NULL AND invalidated_at IS NULL",
                [&journal.entity_id],
                |row| {
                    let kind: String = row.get(3)?;
                    let safe_summary: String = row.get(4)?;
                    let safe_summary = serde_json::from_str::<serde_json::Value>(&safe_summary)
                        .unwrap_or(serde_json::Value::Null);
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "runId": row.get::<_, String>(1)?,
                        "version": row.get::<_, i64>(2)?,
                        "kind": pending_input_kind(&kind),
                        "safePrompt": safe_prompt(&safe_summary),
                        "options": safe_options(&kind, &safe_summary),
                    }))
                },
            )
            .optional(),
        ProjectionKind::Attention => connection
            .query_row(
                "SELECT a.id, COALESCE(w.public_id, CAST(w.id AS TEXT)), a.task_id,
                        a.run_id, a.kind, a.priority, a.title, a.safe_summary, a.surface,
                        a.created_at, a.resolved_at, a.acknowledged_at
                 FROM attention_occurrences a
                 JOIN workspaces w ON w.id = a.workspace_id
                 WHERE a.id = ?1 AND a.resolved_at IS NULL",
                [&journal.entity_id],
                |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "projectId": row.get::<_, String>(1)?,
                        "taskId": row.get::<_, String>(2)?,
                        "runId": row.get::<_, Option<String>>(3)?,
                        "kind": row.get::<_, String>(4)?,
                        "version": journal.entity_version,
                        "title": row.get::<_, String>(6)?,
                        "safeSummary": row.get::<_, String>(7)?,
                        "acknowledged": row.get::<_, Option<i64>>(11)?.is_some(),
                    }))
                },
            )
            .optional(),
        ProjectionKind::SafeTimeline => {
            let (run_id, sequence) = split_timeline_entity_id(&journal.entity_id)?;
            connection
            .query_row(
                "SELECT e.run_id, e.sequence, e.timestamp, e.event_type,
                            e.safe_payload_json, r.task_id
                     FROM run_events e JOIN runs r ON r.id = e.run_id
                     WHERE e.run_id = ?1 AND e.sequence = ?2",
                params![run_id, sequence],
                |row| {
                    let safe_payload: String = row.get(4)?;
                    Ok(serde_json::json!({
                            "id": format!("{}:{}", row.get::<_, String>(0)?, row.get::<_, i64>(1)?),
                            "taskId": row.get::<_, String>(5)?,
                            "runId": row.get::<_, String>(0)?,
                            "occurredAt": row.get::<_, i64>(2)?,
                            "kind": row.get::<_, String>(3)?,
                            "safeSummary": safe_summary_text(
                                &serde_json::from_str::<serde_json::Value>(&safe_payload)
                                    .unwrap_or(serde_json::Value::Null)
                            ),
                    }))
                },
            )
            .optional()
        }
        ProjectionKind::Verification => connection
            .query_row(
                "SELECT id, run_id, attempt_number, trigger, status, started_at,
                        finished_at, updated_at, version
                 FROM verification_attempts
                 WHERE run_id = ?1
                 ORDER BY attempt_number DESC, updated_at DESC, id DESC
                 LIMIT 1",
                [&journal.entity_id],
                |row| {
                    Ok(serde_json::json!({
                        "runId": row.get::<_, String>(1)?,
                        "status": verification_status(&row.get::<_, String>(4)?),
                        "safeSummary": format!(
                            "Verification attempt {} is {}.",
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(4)?
                        ),
                    }))
                },
            )
            .optional(),
        ProjectionKind::Observatory => connection
            .query_row(
                "SELECT r.id, r.status, COUNT(p.id),
                        (SELECT event_type FROM run_events e WHERE e.run_id = r.id
                         ORDER BY e.sequence DESC LIMIT 1)
                 FROM runs r
                 LEFT JOIN pending_inputs p ON p.run_id = r.id
                    AND p.resolved_at IS NULL AND p.invalidated_at IS NULL
                 WHERE r.id = ?1 GROUP BY r.id",
                [&journal.entity_id],
                |row| {
                    Ok(serde_json::json!({
                        "runId": row.get::<_, String>(0)?,
                        "activeAgents": if matches!(
                            row.get::<_, String>(1)?.as_str(),
                            "preparing" | "running" | "waiting_for_input" | "verifying"
                        ) { 1 } else { 0 },
                        "waitingAgents": row.get::<_, i64>(2)?,
                        "safeLatestActivity": row.get::<_, Option<String>>(3)?,
                    }))
                },
            )
            .optional(),
    }
    .map_err(|error| format!("Could not query the canonical Companion projection: {error}"))?;
    match payload {
        Some(payload) => {
            let kind = journal.kind()?;
            Ok(ProjectionUpdate {
                sequence: journal.sequence,
                event_id: journal.event_id,
                generation: journal.generation,
                kind,
                entity_id: journal.entity_id,
                entity_version: journal.entity_version,
                payload,
                occurred_at: journal.occurred_at,
            })
        }
        None => journal.tombstone(),
    }
}

fn split_scoped_entity_id(value: &str) -> Result<(&str, &str), String> {
    value
        .split_once('/')
        .ok_or_else(|| format!("Companion projection entity id '{value}' is not scoped."))
}

fn split_timeline_entity_id(value: &str) -> Result<(&str, i64), String> {
    let (run_id, sequence) = value
        .rsplit_once(':')
        .ok_or_else(|| format!("Companion timeline entity id '{value}' is invalid."))?;
    let sequence = sequence
        .parse()
        .map_err(|_| format!("Companion timeline entity id '{value}' has no sequence."))?;
    Ok((run_id, sequence))
}

fn pending_input_kind(value: &str) -> &'static str {
    match value {
        "question" => "question",
        "mcp_elicitation" => "mcp_elicitation",
        _ => "approval",
    }
}

fn safe_prompt(value: &serde_json::Value) -> String {
    ["question", "prompt", "reason", "message"]
        .iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_str))
        .map(|value| bounded_text(value, 320))
        .unwrap_or_else(|| "Operator input requested.".to_owned())
}

fn safe_options(kind: &str, value: &serde_json::Value) -> Vec<serde_json::Value> {
    match kind {
        "command_approval" | "file_approval" | "permissions" => vec![
            serde_json::json!({ "id": "accept", "label": "Accept" }),
            serde_json::json!({ "id": "decline", "label": "Decline" }),
        ],
        "mcp_elicitation" => vec![
            serde_json::json!({ "id": "decline", "label": "Decline" }),
            serde_json::json!({ "id": "cancel", "label": "Cancel" }),
        ],
        "question" => value
            .get("questions")
            .and_then(serde_json::Value::as_array)
            .filter(|questions| questions.len() == 1)
            .and_then(|questions| questions.first())
            .and_then(|question| question.get("options"))
            .and_then(serde_json::Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .take(20)
                    .enumerate()
                    .filter_map(|(index, option)| {
                        let label = option
                            .as_str()
                            .or_else(|| option.get("label").and_then(serde_json::Value::as_str))?;
                        Some(serde_json::json!({
                            "id": format!("question:{index}"),
                            "label": bounded_text(label, 120),
                        }))
                    })
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn safe_summary_text(value: &serde_json::Value) -> String {
    if let Some(value) = value.as_str() {
        return bounded_text(value, 320);
    }
    ["summary", "message", "reason", "status"]
        .iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_str))
        .map(|value| bounded_text(value, 320))
        .unwrap_or_else(|| "Run activity updated.".to_owned())
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn verification_status(value: &str) -> &'static str {
    match value {
        "running" => "running",
        "passed" => "passed",
        "failed" | "cancelled" | "interrupted" => "failed",
        "blocked" => "blocked",
        _ => "not_run",
    }
}

fn load_command_by_identity(
    connection: &Connection,
    command_id: &str,
    idempotency_key: &str,
) -> Result<Option<(String, CommandResult)>, String> {
    let candidates = connection
        .prepare(
            "SELECT command_id, idempotency_key, fingerprint, status, refusal_code,
                    message, host_ack_json
             FROM companion_commands
             WHERE command_id = ?1 OR idempotency_key = ?2",
        )
        .and_then(|mut statement| {
            statement
                .query_map(params![command_id, idempotency_key], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| format!("Could not inspect Companion command idempotency: {error}"))?;
    if candidates.len() > 1 {
        return Err("The Companion command and idempotency identities conflict.".to_owned());
    }
    candidates
        .into_iter()
        .next()
        .map(
            |(
                stored_command_id,
                stored_idempotency_key,
                fingerprint,
                status,
                refusal_code,
                message,
                acknowledgement_json,
            )| {
                if stored_command_id != command_id || stored_idempotency_key != idempotency_key {
                    return Err(
                        "The Companion command or idempotency identity is already in use."
                            .to_owned(),
                    );
                }
                let (state, acknowledgement) = match status.as_str() {
                    "pending" => (CommandState::PendingHostAcknowledgement, None),
                    "succeeded" => (
                        CommandState::Succeeded,
                        acknowledgement_json
                            .as_deref()
                            .map(|json| parse_json(json, "Companion host acknowledgement"))
                            .transpose()?,
                    ),
                    "refused" => (CommandState::Refused, None),
                    value => return Err(format!("Unknown Companion command state '{value}'.")),
                };
                Ok((
                    fingerprint,
                    CommandResult {
                        command_id: stored_command_id,
                        state,
                        acknowledgement,
                        refusal_code,
                        message,
                    },
                ))
            },
        )
        .transpose()
}

fn refuse_pending_for_session(
    connection: &Connection,
    session_id: &str,
    now: i64,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE companion_command_outbox
             SET status = 'cancelled',
                 last_error = 'The primary host revoked the Companion session.'
             WHERE status IN ('pending', 'dispatching', 'executing')
               AND command_id IN (
                   SELECT command_id FROM companion_commands
                   WHERE session_id = ?1 AND status = 'pending'
               )",
            [session_id],
        )
        .map_err(|error| {
            format!("Could not cancel runtime effects after Companion revocation: {error}")
        })?;
    connection
        .execute(
            "INSERT OR IGNORE INTO companion_audit(
                id, command_id, session_id, device_id, capability, target_kind,
                target_id, decision, reason, created_at
             )
             SELECT 'revoked:' || command_id, command_id, session_id, device_id,
                    capability, target_kind, target_id, 'refused',
                    'The primary host revoked the Companion session.', ?1
             FROM companion_commands
             WHERE session_id = ?2 AND status = 'pending'",
            params![now, session_id],
        )
        .map_err(|error| format!("Could not audit commands refused by revocation: {error}"))?;
    connection
        .execute(
            "UPDATE companion_commands
             SET status = 'refused', refusal_code = 'session_revoked',
                 message = 'The primary host revoked the Companion session.', updated_at = ?1
             WHERE session_id = ?2 AND status = 'pending'",
            params![now, session_id],
        )
        .map(|_| ())
        .map_err(|error| format!("Could not reconcile commands after revocation: {error}"))
}

fn json_string(value: &(impl serde::Serialize + ?Sized), label: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("Could not encode {label}: {error}"))
}

fn hex_string(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn parse_json<T: DeserializeOwned>(value: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|error| format!("Could not decode {label}: {error}"))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn projection_kind_database(kind: ProjectionKind) -> &'static str {
    match kind {
        ProjectionKind::Project => "project",
        ProjectionKind::Task => "task",
        ProjectionKind::TaskStage => "task_stage",
        ProjectionKind::Run => "run",
        ProjectionKind::PendingInput => "pending_input",
        ProjectionKind::Attention => "attention",
        ProjectionKind::SafeTimeline => "safe_timeline",
        ProjectionKind::Verification => "verification",
        ProjectionKind::Observatory => "observatory",
    }
}

fn projection_kind_from_database(value: &str) -> Result<ProjectionKind, String> {
    match value {
        "project" => Ok(ProjectionKind::Project),
        "task" => Ok(ProjectionKind::Task),
        "task_stage" => Ok(ProjectionKind::TaskStage),
        "run" => Ok(ProjectionKind::Run),
        "pending_input" => Ok(ProjectionKind::PendingInput),
        "attention" => Ok(ProjectionKind::Attention),
        "safe_timeline" => Ok(ProjectionKind::SafeTimeline),
        "verification" => Ok(ProjectionKind::Verification),
        "observatory" => Ok(ProjectionKind::Observatory),
        _ => Err(format!("Unknown Companion projection kind '{value}'.")),
    }
}

fn target_kind_database(kind: TargetKind) -> &'static str {
    match kind {
        TargetKind::Project => "project",
        TargetKind::Task => "task",
        TargetKind::Run => "run",
        TargetKind::Attention => "attention",
        TargetKind::PendingInput => "pending_input",
        TargetKind::Host => "host",
        TargetKind::Terminal => "terminal",
        TargetKind::Filesystem => "filesystem",
        TargetKind::Worktree => "worktree",
        TargetKind::Publication => "publication",
        TargetKind::Handoff => "handoff",
        TargetKind::Checkpoint => "checkpoint",
        TargetKind::ExecutionEnvironment => "execution_environment",
    }
}

fn target_kind_from_database(value: &str) -> Result<TargetKind, String> {
    match value {
        "project" => Ok(TargetKind::Project),
        "task" => Ok(TargetKind::Task),
        "run" => Ok(TargetKind::Run),
        "attention" => Ok(TargetKind::Attention),
        "pending_input" => Ok(TargetKind::PendingInput),
        "host" => Ok(TargetKind::Host),
        "terminal" => Ok(TargetKind::Terminal),
        "filesystem" => Ok(TargetKind::Filesystem),
        "worktree" => Ok(TargetKind::Worktree),
        "publication" => Ok(TargetKind::Publication),
        "handoff" => Ok(TargetKind::Handoff),
        "checkpoint" => Ok(TargetKind::Checkpoint),
        "execution_environment" => Ok(TargetKind::ExecutionEnvironment),
        _ => Err(format!("Unknown Companion target kind '{value}'.")),
    }
}

fn command_capability_database(capability: CommandCapability) -> &'static str {
    match capability {
        CommandCapability::ResolveApproval => "resolve_approval",
        CommandCapability::ResolveQuestion => "resolve_question",
        CommandCapability::ResolveMcpElicitation => "resolve_mcp_elicitation",
        CommandCapability::StopRun => "stop_run",
        CommandCapability::RetryRun => "retry_run",
        CommandCapability::SendFollowUp => "send_follow_up",
        CommandCapability::AcknowledgeAttention => "acknowledge_attention",
        CommandCapability::AcceptOutcome => "accept_outcome",
        CommandCapability::OpenTerminal => "open_terminal",
        CommandCapability::BrowseFiles => "browse_files",
        CommandCapability::ChangeHostSettings => "change_host_settings",
        CommandCapability::ChangeUnrestrictedPolicy => "change_unrestricted_policy",
        CommandCapability::ManageWorktrees => "manage_worktrees",
        CommandCapability::PublishSourceControl => "publish_source_control",
        CommandCapability::ImportHandoff => "import_handoff",
        CommandCapability::RestoreCheckpoint => "restore_checkpoint",
        CommandCapability::RegisterExecutionEnvironment => "register_execution_environment",
        CommandCapability::ExecuteArbitraryCommand => "execute_arbitrary_command",
    }
}

fn command_capability_from_database(value: &str) -> Result<CommandCapability, String> {
    match value {
        "resolve_approval" => Ok(CommandCapability::ResolveApproval),
        "resolve_question" => Ok(CommandCapability::ResolveQuestion),
        "resolve_mcp_elicitation" => Ok(CommandCapability::ResolveMcpElicitation),
        "stop_run" => Ok(CommandCapability::StopRun),
        "retry_run" => Ok(CommandCapability::RetryRun),
        "send_follow_up" => Ok(CommandCapability::SendFollowUp),
        "acknowledge_attention" => Ok(CommandCapability::AcknowledgeAttention),
        "accept_outcome" => Ok(CommandCapability::AcceptOutcome),
        "open_terminal" => Ok(CommandCapability::OpenTerminal),
        "browse_files" => Ok(CommandCapability::BrowseFiles),
        "change_host_settings" => Ok(CommandCapability::ChangeHostSettings),
        "change_unrestricted_policy" => Ok(CommandCapability::ChangeUnrestrictedPolicy),
        "manage_worktrees" => Ok(CommandCapability::ManageWorktrees),
        "publish_source_control" => Ok(CommandCapability::PublishSourceControl),
        "import_handoff" => Ok(CommandCapability::ImportHandoff),
        "restore_checkpoint" => Ok(CommandCapability::RestoreCheckpoint),
        "register_execution_environment" => Ok(CommandCapability::RegisterExecutionEnvironment),
        "execute_arbitrary_command" => Ok(CommandCapability::ExecuteArbitraryCommand),
        _ => Err(format!("Unknown Companion command capability '{value}'.")),
    }
}
