use rusqlite::Connection;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use super::adapter::CompanionExecutionGate;
use super::models::{
    CommandEnvelope, CommandResult, CompanionAuditRecord, CompanionGrant, CompanionSession,
    ExchangePairingRequest, ExchangedSession, IssuePairingRequest, NotificationCursor,
    NotificationPage, PairingCredential, ReconnectCursor, RevokedDevice, SessionCredential,
    SyncBatch, SyncRequest,
};
use super::repository::CompanionRepository;
use super::service::{CompanionCommandHost, CompanionService};
use super::transport::client::{CompanionPinnedClient, CompanionSessionReference};
use super::transport::{CompanionHostRuntime, PairingBundle};
use crate::xiao::repository::XiaoRepository;

pub fn issue_pairing(
    service: &CompanionService,
    connection: &mut Connection,
    request: IssuePairingRequest,
) -> Result<PairingCredential, String> {
    service.issue_pairing(connection, request)
}

pub fn exchange_pairing(
    service: &CompanionService,
    connection: &mut Connection,
    request: ExchangePairingRequest,
) -> Result<ExchangedSession, String> {
    service.exchange_pairing(connection, request)
}

pub fn list_sessions(connection: &Connection) -> Result<Vec<CompanionSession>, String> {
    CompanionService.list_sessions(connection)
}

pub fn rotate_session(
    service: &CompanionService,
    connection: &mut Connection,
    session_id: &str,
    now: i64,
) -> Result<ExchangedSession, String> {
    service.rotate_session(connection, session_id, now)
}

pub fn revoke_session(
    service: &CompanionService,
    connection: &mut Connection,
    session_id: &str,
    now: i64,
) -> Result<CompanionSession, String> {
    service.revoke_session(connection, session_id, now)
}

pub fn revoke_device(
    service: &CompanionService,
    connection: &mut Connection,
    device_id: &str,
    now: i64,
) -> Result<RevokedDevice, String> {
    service.revoke_device(connection, device_id, now)
}

pub fn replace_grants(
    service: &CompanionService,
    connection: &mut Connection,
    session_id: &str,
    grants: Vec<CompanionGrant>,
    now: i64,
) -> Result<CompanionSession, String> {
    service.replace_grants(connection, session_id, grants, now)
}

pub fn sync(
    service: &CompanionService,
    connection: &mut Connection,
    credential: &SessionCredential,
    cursor: Option<ReconnectCursor>,
    now: i64,
) -> Result<SyncBatch, String> {
    service.sync(connection, credential, cursor, now)
}

pub fn confirm_reconciled(
    service: &CompanionService,
    connection: &mut Connection,
    credential: &SessionCredential,
    cursor: ReconnectCursor,
    now: i64,
) -> Result<SyncBatch, String> {
    service.confirm_reconciled(connection, credential, cursor, now)
}

pub fn execute_command(
    service: &CompanionService,
    connection: &mut Connection,
    credential: &SessionCredential,
    envelope: CommandEnvelope,
    now: i64,
    host: &impl CompanionCommandHost,
) -> Result<CommandResult, String> {
    service.execute_command(connection, credential, envelope, now, host)
}

#[tauri::command]
pub fn issue_companion_pairing(
    ttl_seconds: Option<i64>,
    repository: State<'_, XiaoRepository>,
) -> Result<PairingCredential, String> {
    repository.with_connection(|connection| {
        issue_pairing(
            &CompanionService,
            connection,
            IssuePairingRequest {
                ttl_seconds: ttl_seconds.unwrap_or(300),
                now: now_seconds()?,
            },
        )
    })
}

#[tauri::command]
pub fn issue_companion_pairing_bundle(
    ttl_seconds: Option<i64>,
    repository: State<'_, XiaoRepository>,
    runtime: State<'_, CompanionHostRuntime>,
) -> Result<PairingBundle, String> {
    let identity = runtime.identity()?;
    repository.with_connection(|connection| {
        let credential = issue_pairing(
            &CompanionService,
            connection,
            IssuePairingRequest {
                ttl_seconds: ttl_seconds.unwrap_or(300),
                now: now_seconds()?,
            },
        )?;
        PairingBundle::new(identity, credential)
    })
}

#[tauri::command]
pub fn exchange_companion_pairing(
    owner_credential: String,
    device_id: String,
    device_name: String,
    grants: Vec<CompanionGrant>,
    repository: State<'_, XiaoRepository>,
) -> Result<ExchangedSession, String> {
    repository.with_connection(|connection| {
        exchange_pairing(
            &CompanionService,
            connection,
            ExchangePairingRequest {
                owner_credential,
                device_id,
                device_name,
                grants,
                now: now_seconds()?,
            },
        )
    })
}

#[tauri::command]
pub fn list_companion_sessions(
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<CompanionSession>, String> {
    repository.with_connection(|connection| list_sessions(connection))
}

#[tauri::command]
pub async fn rotate_companion_session(
    session_id: String,
    repository: State<'_, XiaoRepository>,
    execution_gate: State<'_, CompanionExecutionGate>,
) -> Result<ExchangedSession, String> {
    let _execution_lease = execution_gate.0.lock().await;
    repository.with_connection(|connection| {
        rotate_session(&CompanionService, connection, &session_id, now_seconds()?)
    })
}

#[tauri::command]
pub async fn revoke_companion_session(
    session_id: String,
    repository: State<'_, XiaoRepository>,
    execution_gate: State<'_, CompanionExecutionGate>,
) -> Result<CompanionSession, String> {
    let _execution_lease = execution_gate.0.lock().await;
    repository.with_connection(|connection| {
        revoke_session(&CompanionService, connection, &session_id, now_seconds()?)
    })
}

#[tauri::command]
pub async fn revoke_companion_device(
    device_id: String,
    repository: State<'_, XiaoRepository>,
    execution_gate: State<'_, CompanionExecutionGate>,
) -> Result<RevokedDevice, String> {
    let _execution_lease = execution_gate.0.lock().await;
    repository.with_connection(|connection| {
        revoke_device(&CompanionService, connection, &device_id, now_seconds()?)
    })
}

#[tauri::command]
pub async fn replace_companion_session_grants(
    session_id: String,
    grants: Vec<CompanionGrant>,
    repository: State<'_, XiaoRepository>,
    execution_gate: State<'_, CompanionExecutionGate>,
) -> Result<CompanionSession, String> {
    let _execution_lease = execution_gate.0.lock().await;
    repository.with_connection(|connection| {
        replace_grants(
            &CompanionService,
            connection,
            &session_id,
            grants,
            now_seconds()?,
        )
    })
}

#[tauri::command]
pub fn sync_companion(
    credential: SessionCredential,
    cursor: Option<ReconnectCursor>,
    repository: State<'_, XiaoRepository>,
) -> Result<SyncBatch, String> {
    repository.with_connection(|connection| {
        sync(
            &CompanionService,
            connection,
            &credential,
            cursor,
            now_seconds()?,
        )
    })
}

#[tauri::command]
pub fn confirm_companion_reconciled(
    credential: SessionCredential,
    cursor: ReconnectCursor,
    repository: State<'_, XiaoRepository>,
) -> Result<SyncBatch, String> {
    repository.with_connection(|connection| {
        confirm_reconciled(
            &CompanionService,
            connection,
            &credential,
            cursor,
            now_seconds()?,
        )
    })
}

#[tauri::command]
pub fn list_companion_audit(
    device_id: Option<String>,
    limit: Option<usize>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<CompanionAuditRecord>, String> {
    repository.with_connection(|connection| {
        CompanionRepository::list_audit(
            connection,
            device_id.as_deref(),
            limit.unwrap_or(200).min(1_000),
        )
    })
}

#[tauri::command]
pub fn pair_remote_companion(
    pairing_code: String,
    device_id: String,
    device_name: String,
    grants: Vec<CompanionGrant>,
    client: State<'_, CompanionPinnedClient>,
) -> Result<CompanionSessionReference, String> {
    client.pair(&pairing_code, device_id, device_name, grants, now_millis()?)
}

#[tauri::command]
pub fn poll_remote_companion(
    reference_id: String,
    cursor: Option<ReconnectCursor>,
    limit: Option<usize>,
    client: State<'_, CompanionPinnedClient>,
) -> Result<SyncBatch, String> {
    client.sync(&reference_id, SyncRequest { cursor, limit })
}

#[tauri::command]
pub fn confirm_remote_companion(
    reference_id: String,
    cursor: ReconnectCursor,
    client: State<'_, CompanionPinnedClient>,
) -> Result<SyncBatch, String> {
    client.reconcile(&reference_id, cursor)
}

#[tauri::command]
pub fn poll_remote_companion_notifications(
    reference_id: String,
    cursor: Option<NotificationCursor>,
    limit: Option<usize>,
    client: State<'_, CompanionPinnedClient>,
) -> Result<NotificationPage, String> {
    client.notifications(&reference_id, cursor, limit)
}

#[tauri::command]
pub fn execute_remote_companion_command(
    reference_id: String,
    envelope: CommandEnvelope,
    client: State<'_, CompanionPinnedClient>,
) -> Result<CommandResult, String> {
    client.execute(&reference_id, envelope)
}

#[tauri::command]
pub fn install_remote_companion_rotation(
    reference_id: String,
    rotation_code: String,
    client: State<'_, CompanionPinnedClient>,
) -> Result<CompanionSessionReference, String> {
    client.install_rotation(&reference_id, &rotation_code)
}

#[tauri::command]
pub fn forget_remote_companion(
    reference_id: String,
    client: State<'_, CompanionPinnedClient>,
) -> Result<(), String> {
    client.forget(&reference_id)
}

fn now_seconds() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Could not read the primary host clock: {error}"))
        .and_then(|duration| {
            i64::try_from(duration.as_secs())
                .map_err(|_| "The primary host clock is outside the supported range.".to_owned())
        })
}

fn now_millis() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Could not read the Companion client clock: {error}"))
        .and_then(|duration| {
            i64::try_from(duration.as_millis()).map_err(|_| {
                "The Companion client clock is outside the supported range.".to_owned()
            })
        })
}
