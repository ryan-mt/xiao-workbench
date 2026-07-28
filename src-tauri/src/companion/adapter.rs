use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, Transaction};
use tauri::{AppHandle, Manager};

use crate::runs::models::RunEventPage;
use crate::runs::models::{EnqueueRunRequest, PendingInputKind, RunStatus, SteerRunRequest};
use crate::runs::service::RunService;
use crate::xiao::models::{TaskStage, XiaoTaskDocument, XiaoWorkspaceMode, XiaoWorkspaceUpdate};
use crate::xiao::repository::XiaoRepository;

use super::models::{
    CommandCapability, CommandEnvelope, CommandResult, CompanionGrant, CompanionSession,
    ExchangePairingRequest, ExchangedSession, ExecutionAuthorization, HostCommandAck,
    HostCommandRefusal, NotificationCursor, NotificationPage, ReconnectCursor, SessionCredential,
    SyncBatch, SyncRequest, TargetKind,
};
use super::repository::CompanionRepository;
use super::service::{CompanionCommandHost, CompanionService};
use super::transport::router::CompanionApi;

const MAX_FOLLOW_UP_MESSAGE_BYTES: usize = 8 * 1024;
const MAX_TASK_PROMPT_BYTES: usize = 8 * 1024;

#[derive(Default)]
pub struct CompanionExecutionGate(pub tokio::sync::Mutex<()>);

pub struct AppCompanionApi {
    app: AppHandle,
}

impl AppCompanionApi {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl CompanionApi for AppCompanionApi {
    fn exchange_pairing(
        &self,
        mut request: ExchangePairingRequest,
    ) -> Result<ExchangedSession, String> {
        request.now = now_seconds()?;
        self.app
            .state::<XiaoRepository>()
            .with_connection(|connection| CompanionService.exchange_pairing(connection, request))
    }

    fn sync(
        &self,
        credential: &SessionCredential,
        request: SyncRequest,
    ) -> Result<SyncBatch, String> {
        self.app
            .state::<XiaoRepository>()
            .with_connection(|connection| {
                CompanionService.sync_page(connection, credential, request, now_seconds()?)
            })
    }

    fn confirm_reconciled(
        &self,
        credential: &SessionCredential,
        cursor: ReconnectCursor,
    ) -> Result<SyncBatch, String> {
        self.app
            .state::<XiaoRepository>()
            .with_connection(|connection| {
                CompanionService.confirm_reconciled(connection, credential, cursor, now_seconds()?)
            })
    }

    fn notifications(
        &self,
        credential: &SessionCredential,
        cursor: Option<NotificationCursor>,
        limit: Option<usize>,
    ) -> Result<NotificationPage, String> {
        self.app
            .state::<XiaoRepository>()
            .with_connection(|connection| {
                CompanionService.notifications(
                    connection,
                    credential,
                    cursor,
                    limit,
                    now_seconds()?,
                )
            })
    }

    fn execute(
        &self,
        credential: &SessionCredential,
        envelope: CommandEnvelope,
    ) -> Result<CommandResult, String> {
        self.app
            .state::<XiaoRepository>()
            .with_connection(|connection| {
                CompanionService.execute_command(
                    connection,
                    credential,
                    envelope,
                    now_millis()?,
                    &AppCompanionCommandHost,
                )
            })
    }

    fn conversation(
        &self,
        credential: &SessionCredential,
        run_id: &str,
        after_sequence: Option<i64>,
        limit: Option<usize>,
    ) -> Result<RunEventPage, String> {
        let repository = self.app.state::<XiaoRepository>();
        repository.with_connection(|connection| {
            let session =
                CompanionRepository::authenticate(connection, credential, now_seconds()?)?;
            if !session.grants.contains(&CompanionGrant::ReadConversation) {
                return Err(
                    "The current Companion session does not authorize full conversation reads."
                        .to_owned(),
                );
            }
            let belongs_to_run = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM runs WHERE id = ?1)",
                    [run_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| {
                    format!("Could not authorize the Companion conversation: {error}")
                })?;
            if !belongs_to_run {
                return Err("The requested Xiao Run does not exist.".to_owned());
            }
            Ok(())
        })?;
        let events = repository.list_run_events(run_id, after_sequence, limit)?;
        let next_sequence = events.last().map(|event| event.sequence);
        Ok(RunEventPage {
            events,
            next_sequence,
        })
    }
}

struct AppCompanionCommandHost;

impl CompanionCommandHost for AppCompanionCommandHost {
    fn reauthorize(
        &self,
        transaction: &Transaction<'_>,
        _session: &CompanionSession,
        command: &CommandEnvelope,
    ) -> Result<ExecutionAuthorization, HostCommandRefusal> {
        if command.capability == CommandCapability::CreateTask {
            validate_new_task_payload(command)
                .map_err(|error| definitive_refusal("invalid_task", &error))?;
            let current_version = transaction
                .query_row(
                    "SELECT updated_at FROM workspaces
                     WHERE COALESCE(public_id, CAST(id AS TEXT)) = ?1",
                    [&command.target.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| definitive_refusal("authorization_failed", &error.to_string()))?
                .ok_or_else(|| {
                    definitive_refusal("target_missing", "The canonical Project does not exist.")
                })?;
            return Ok(ExecutionAuthorization { current_version });
        }
        let task_project_id = if command.target.kind == TargetKind::Task {
            Some(command.target.project_id.as_deref().ok_or_else(|| {
                definitive_refusal(
                    "invalid_target_scope",
                    "A Task command requires its canonical Project identity.",
                )
            })?)
        } else {
            None
        };
        if command.target.kind == TargetKind::PendingInput {
            let (current_version, kind, safe_summary_json) = transaction
                .query_row(
                    "SELECT MAX(opened_at, COALESCE(resolved_at, 0),
                                COALESCE(invalidated_at, 0)),
                            kind, safe_summary_json
                     FROM pending_inputs
                     WHERE id = ?1 AND resolved_at IS NULL AND invalidated_at IS NULL",
                    [&command.target.id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| definitive_refusal("authorization_failed", &error.to_string()))?
                .ok_or_else(|| {
                    definitive_refusal(
                        "target_missing",
                        "The canonical pending input does not exist or is no longer open.",
                    )
                })?;
            let kind = PendingInputKind::from_database(&kind)
                .map_err(|error| definitive_refusal("invalid_pending_input", &error))?;
            let safe_summary = serde_json::from_str(&safe_summary_json)
                .map_err(|error| definitive_refusal("invalid_pending_input", &error.to_string()))?;
            bounded_pending_input_result(kind, &safe_summary, command)
                .map_err(|error| definitive_refusal("invalid_pending_input_option", &error))?;
            return Ok(ExecutionAuthorization { current_version });
        }
        if command.target.kind == TargetKind::Run {
            let (current_version, status, runtime_generation, thread_id, turn_id) = transaction
                .query_row(
                    "SELECT version, status, runtime_generation, thread_id, turn_id
                     FROM runs WHERE id = ?1",
                    [&command.target.id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| definitive_refusal("authorization_failed", &error.to_string()))?
                .ok_or_else(|| {
                    definitive_refusal("target_missing", "The canonical Run does not exist.")
                })?;
            if command.capability == CommandCapability::RetryRun
                && !matches!(status.as_str(), "failed" | "interrupted")
            {
                return Err(definitive_refusal(
                    "run_not_retryable",
                    "Only failed or interrupted Runs can be retried.",
                ));
            }
            if command.capability == CommandCapability::StopRun
                && !matches!(
                    status.as_str(),
                    "queued" | "preparing" | "running" | "waiting_for_input" | "verifying"
                )
            {
                return Err(definitive_refusal(
                    "run_not_stoppable",
                    "Only active Runs can be stopped.",
                ));
            }
            if command.capability == CommandCapability::SendFollowUp
                && (!matches!(status.as_str(), "running" | "waiting_for_input")
                    || runtime_generation.is_none()
                    || thread_id.is_none()
                    || turn_id.is_none())
            {
                return Err(definitive_refusal(
                    "run_not_steerable",
                    "The Run no longer has an active canonical turn for follow-up.",
                ));
            }
            return Ok(ExecutionAuthorization { current_version });
        }
        let current_version = match command.target.kind {
            TargetKind::Task => transaction.query_row(
                "SELECT t.task_stage_version
                 FROM tasks t
                 JOIN workspaces w ON w.id = t.workspace_id
                 WHERE t.task_id = ?1
                   AND COALESCE(w.public_id, CAST(w.id AS TEXT)) = ?2",
                params![command.target.id, task_project_id],
                |row| row.get(0),
            ),
            TargetKind::Attention => transaction.query_row(
                "SELECT MAX(created_at, COALESCE(resolved_at, 0), COALESCE(acknowledged_at, 0))
                 FROM attention_occurrences WHERE id = ?1",
                [&command.target.id],
                |row| row.get(0),
            ),
            TargetKind::Run => unreachable!("Run authorization returned above"),
            _ => {
                return Err(definitive_refusal(
                    "invalid_target_scope",
                    "The canonical host has no bounded entity version for this target.",
                ));
            }
        }
        .optional()
        .map_err(|error| definitive_refusal("authorization_failed", &error.to_string()))?
        .ok_or_else(|| {
            definitive_refusal("target_missing", "The canonical target does not exist.")
        })?;
        Ok(ExecutionAuthorization { current_version })
    }

    fn execute(
        &self,
        transaction: &Transaction<'_>,
        _session: &CompanionSession,
        command: &CommandEnvelope,
        authorization: &ExecutionAuthorization,
    ) -> Result<HostCommandAck, HostCommandRefusal> {
        let resulting_version = match command.capability {
            CommandCapability::AcknowledgeAttention => {
                let changed = transaction
                    .execute(
                        "UPDATE attention_occurrences
                         SET acknowledged_at = ?1
                         WHERE id = ?2 AND resolved_at IS NULL AND acknowledged_at IS NULL
                           AND MAX(created_at, COALESCE(resolved_at, 0),
                                   COALESCE(acknowledged_at, 0)) = ?3",
                        params![
                            command.audit_timestamp,
                            command.target.id,
                            authorization.current_version
                        ],
                    )
                    .map_err(|error| {
                        definitive_refusal("attention_update_failed", &error.to_string())
                    })?;
                if changed != 1 {
                    return Err(definitive_refusal(
                        "version_conflict",
                        "The Attention item changed before acknowledgement.",
                    ));
                }
                command.audit_timestamp
            }
            CommandCapability::AcceptOutcome => {
                let project_id = command.target.project_id.as_deref().ok_or_else(|| {
                    definitive_refusal(
                        "invalid_target_scope",
                        "Outcome acceptance requires its canonical Project identity.",
                    )
                })?;
                let row = transaction
                    .query_row(
                        "SELECT t.workspace_id, t.task_stage, t.task_stage_version
                         FROM tasks t
                         JOIN workspaces w ON w.id = t.workspace_id
                         WHERE t.task_id = ?1
                           AND COALESCE(w.public_id, CAST(w.id AS TEXT)) = ?2",
                        params![command.target.id, project_id],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, i64>(2)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(|error| {
                        definitive_refusal("outcome_lookup_failed", &error.to_string())
                    })?
                    .ok_or_else(|| {
                        definitive_refusal("target_missing", "The Task does not exist.")
                    })?;
                if !matches!(row.1.as_str(), "ready_for_review" | "published")
                    || row.2 != authorization.current_version
                {
                    return Err(definitive_refusal(
                        "outcome_not_acceptable",
                        "The Task outcome is no longer eligible for acceptance.",
                    ));
                }
                let resulting_version = row.2 + 1;
                transaction
                    .execute(
                        "UPDATE tasks
                         SET task_stage = 'completed', task_stage_version = ?1,
                             updated_at = MAX(updated_at, ?2)
                         WHERE workspace_id = ?3 AND task_id = ?4
                           AND task_stage_version = ?5
                           AND task_stage IN ('ready_for_review', 'published')",
                        params![
                            resulting_version,
                            command.audit_timestamp,
                            row.0,
                            command.target.id,
                            row.2,
                        ],
                    )
                    .map_err(|error| {
                        definitive_refusal("outcome_update_failed", &error.to_string())
                    })?;
                transaction
                    .execute(
                        "INSERT INTO task_stage_transitions(
                            id, workspace_id, task_id, from_stage, to_stage, expected_version,
                            resulting_version, actor, reason, source_run_id,
                            idempotency_key, created_at
                         ) VALUES (?1, ?2, ?3, ?4, 'completed', ?5, ?6,
                                   'companion', 'Operator accepted outcome from Companion',
                                   NULL, ?7, ?8)",
                        params![
                            uuid::Uuid::now_v7().to_string(),
                            row.0,
                            command.target.id,
                            row.1,
                            row.2,
                            resulting_version,
                            command.idempotency_key,
                            command.audit_timestamp,
                        ],
                    )
                    .map_err(|error| {
                        definitive_refusal("outcome_audit_failed", &error.to_string())
                    })?;
                resulting_version
            }
            _ => authorization.current_version,
        };
        Ok(HostCommandAck {
            acknowledgement_id: format!("host:{}", command.command_id),
            resulting_version,
            acknowledged_at: command.audit_timestamp,
            detail: Some(serde_json::json!({
                "durableEffect": if requires_runtime_dispatch(command.capability) {
                    "runtime_outbox"
                } else {
                    "canonical_state"
                }
            })),
        })
    }
}

pub fn start_runtime_outbox_reconciler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let _ = reconcile_runtime_outbox(&app).await;
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

pub async fn reconcile_runtime_outbox(app: &AppHandle) -> Result<usize, String> {
    let intents = app
        .state::<XiaoRepository>()
        .with_connection(|connection| CompanionRepository::claim_runtime_effects(connection, 50))?;
    let mut dispatched = 0;
    for intent in intents {
        let execution_gate = app.state::<CompanionExecutionGate>();
        let _execution_lease = execution_gate.0.lock().await;
        match prepare_runtime_effect(app, &intent)? {
            RuntimePreparation::Acknowledge(resulting_version) => {
                app.state::<XiaoRepository>()
                    .with_connection(|connection| {
                        CompanionRepository::acknowledge_runtime_dispatch(
                            connection,
                            &intent.command_id,
                            resulting_version,
                            now_millis()?,
                        )
                    })?;
                dispatched += 1;
                continue;
            }
            RuntimePreparation::Refuse { code, message } => {
                app.state::<XiaoRepository>()
                    .with_connection(|connection| {
                        CompanionRepository::refuse_runtime_effect(
                            connection,
                            &intent.command_id,
                            code,
                            &message,
                            now_millis()?,
                        )
                    })?;
                continue;
            }
            RuntimePreparation::Execute => {}
        }
        let result = match intent.envelope.capability {
            CommandCapability::StopRun => app
                .state::<RunService>()
                .cancel_at_version(
                    app,
                    &intent.envelope.target.id,
                    intent.envelope.expected_version,
                    &intent.command_id,
                )
                .await
                .and_then(|_| completed_runtime_effect_receipt_version(app, &intent)),
            CommandCapability::RetryRun => app
                .state::<RunService>()
                .retry_at_version(
                    app,
                    &intent.envelope.target.id,
                    &intent.command_id,
                    intent.envelope.expected_version,
                )
                .and_then(|_| completed_runtime_effect_receipt_version(app, &intent)),
            CommandCapability::ResolveApproval
            | CommandCapability::ResolveQuestion
            | CommandCapability::ResolveMcpElicitation => {
                let pending = app
                    .state::<XiaoRepository>()
                    .get_pending_input(&intent.envelope.target.id)?;
                let result = bounded_pending_input_result(
                    pending.kind,
                    &pending.safe_summary,
                    &intent.envelope,
                )?;
                app.state::<RunService>()
                    .resolve_input_at_version(
                        app,
                        &intent.envelope.target.id,
                        result,
                        intent.envelope.expected_version,
                        &intent.command_id,
                    )
                    .await
                    .and_then(|_| completed_runtime_effect_receipt_version(app, &intent))
            }
            CommandCapability::SendFollowUp => {
                let message = bounded_follow_up_message(&intent.envelope)?;
                let run = app
                    .state::<XiaoRepository>()
                    .get_run(&intent.envelope.target.id)?;
                app.state::<RunService>()
                    .steer_at_version(
                        app,
                        SteerRunRequest {
                            project_path: run.workspace_path,
                            task_id: run.task_id,
                            run_id: run.id,
                            client_user_message_id: intent.command_id.clone(),
                            input: vec![serde_json::json!({
                                "type": "text",
                                "text": message,
                                "text_elements": [],
                            })],
                        },
                        intent.envelope.expected_version,
                    )
                    .await
                    .and_then(|_| {
                        app.state::<XiaoRepository>()
                            .get_run(&intent.envelope.target.id)
                            .map(|run| run.version)
                    })
            }
            CommandCapability::CreateTask => create_companion_task(app, &intent),
            _ => Ok(intent.envelope.expected_version),
        };
        app.state::<XiaoRepository>()
            .with_connection(|connection| match result {
                Ok(resulting_version) => {
                    dispatched += 1;
                    CompanionRepository::acknowledge_runtime_dispatch(
                        connection,
                        &intent.command_id,
                        resulting_version,
                        now_millis()?,
                    )
                }
                Err(error)
                    if matches!(
                        intent.envelope.capability,
                        CommandCapability::ResolveApproval
                            | CommandCapability::ResolveQuestion
                            | CommandCapability::ResolveMcpElicitation
                            | CommandCapability::SendFollowUp
                    ) =>
                {
                    CompanionRepository::refuse_runtime_effect(
                        connection,
                        &intent.command_id,
                        "host_ack_unknown",
                        &format!(
                            "The primary host did not provide a durable acknowledgement and the effect will not be repeated: {error}"
                        ),
                        now_millis()?,
                    )
                }
                Err(error) if intent.envelope.capability == CommandCapability::RetryRun => {
                    CompanionRepository::refuse_runtime_effect(
                        connection,
                        &intent.command_id,
                        "runtime_effect_failed",
                        &error,
                        now_millis()?,
                    )
                }
                Err(error) if intent.envelope.capability == CommandCapability::CreateTask => {
                    CompanionRepository::refuse_runtime_effect(
                        connection,
                        &intent.command_id,
                        "runtime_effect_failed",
                        &error,
                        now_millis()?,
                    )
                }
                Err(error) => CompanionRepository::record_runtime_dispatch_failure(
                    connection,
                    &intent.command_id,
                    &error,
                ),
            })?;
    }
    Ok(dispatched)
}

#[derive(Debug, PartialEq, Eq)]
enum RuntimePreparation {
    Execute,
    Acknowledge(i64),
    Refuse { code: &'static str, message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeEffectReceipt {
    Started,
    Completed(i64),
}

fn prepare_runtime_effect(
    app: &AppHandle,
    intent: &super::models::CompanionOutboxIntent,
) -> Result<RuntimePreparation, String> {
    app.state::<XiaoRepository>().with_connection(|connection| {
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| format!("Could not reauthorize Companion runtime effect: {error}"))?;
        if intent.status == "executing" {
            if let Some(recovered) = recover_interrupted_runtime_effect(&transaction, intent)? {
                return Ok(recovered);
            }
        }
        let session =
            match CompanionRepository::load_session(&transaction, &intent.envelope.session_id) {
                Ok(session) => session,
                Err(message) => {
                    return Ok(RuntimePreparation::Refuse {
                        code: "session_invalid",
                        message,
                    });
                }
            };
        if session.revoked_at.is_some()
            || session.device_id != intent.envelope.device_id
            || session.generation != intent.envelope.session_generation
        {
            return Ok(RuntimePreparation::Refuse {
                code: "session_revoked",
                message: "The Companion session changed or was revoked before execution."
                    .to_owned(),
            });
        }
        if !session
            .grants
            .iter()
            .any(|grant| grant.allows_command(intent.envelope.capability))
        {
            return Ok(RuntimePreparation::Refuse {
                code: "grant_denied",
                message: "The Companion grant was removed before the runtime effect executed."
                    .to_owned(),
            });
        }
        let authorization =
            match AppCompanionCommandHost.reauthorize(&transaction, &session, &intent.envelope) {
                Ok(authorization) => authorization,
                Err(refusal) => {
                    return Ok(RuntimePreparation::Refuse {
                        code: "execution_reauthorization_failed",
                        message: format!("{}: {}", refusal.code, refusal.message),
                    });
                }
            };
        if authorization.current_version != intent.envelope.expected_version {
            return Ok(RuntimePreparation::Refuse {
                code: "version_conflict",
                message: format!(
                    "The target changed from expected version {} to version {} before execution.",
                    intent.envelope.expected_version, authorization.current_version
                ),
            });
        }
        if intent.status != "executing" {
            CompanionRepository::mark_runtime_effect_executing(&transaction, &intent.command_id)?;
        }
        transaction.commit().map_err(|error| {
            format!("Could not commit Companion runtime reauthorization: {error}")
        })?;
        Ok(RuntimePreparation::Execute)
    })
}

fn recover_interrupted_runtime_effect(
    connection: &rusqlite::Connection,
    intent: &super::models::CompanionOutboxIntent,
) -> Result<Option<RuntimePreparation>, String> {
    match intent.envelope.capability {
        CommandCapability::ResolveApproval
        | CommandCapability::ResolveQuestion
        | CommandCapability::ResolveMcpElicitation => {
            if let Some(RuntimeEffectReceipt::Completed(version)) =
                runtime_effect_receipt(connection, intent)?
            {
                Ok(Some(RuntimePreparation::Acknowledge(version)))
            } else {
                Ok(Some(RuntimePreparation::Refuse {
                    code: "host_ack_unknown",
                    message: "The host restarted after beginning the input reply; canonical state has no command-correlated receipt, so Xiao will not repeat it or report success.".to_owned(),
                }))
            }
        }
        CommandCapability::StopRun => {
            let receipt = runtime_effect_receipt(connection, intent)?;
            if let Some(RuntimeEffectReceipt::Completed(version)) = receipt {
                return Ok(Some(RuntimePreparation::Acknowledge(version)));
            }
            let state = connection
                .query_row(
                    "SELECT status, cancel_requested FROM runs WHERE id = ?1",
                    [&intent.envelope.target.id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
                )
                .optional()
                .map_err(|error| {
                    format!("Could not reconcile interrupted Companion stop: {error}")
                })?;
            match state {
                Some((status, true)) if !RunStatus::from_database(&status)?.is_terminal() => {
                    if receipt == Some(RuntimeEffectReceipt::Started) {
                        Ok(Some(RuntimePreparation::Execute))
                    } else {
                        Ok(Some(RuntimePreparation::Refuse {
                            code: "host_ack_unknown",
                            message: "The Run was stopped without this command's durable receipt, so Xiao will not report the interrupted stop as successful.".to_owned(),
                        }))
                    }
                }
                Some((status, _)) if RunStatus::from_database(&status)?.is_terminal() => {
                    Ok(Some(RuntimePreparation::Refuse {
                        code: "host_ack_unknown",
                        message: "The Run became terminal without a command-correlated stop receipt, so Xiao will not report the interrupted stop as successful.".to_owned(),
                    }))
                }
                None => Ok(Some(RuntimePreparation::Refuse {
                    code: "target_missing",
                    message: "The stopped Run no longer exists on the primary host.".to_owned(),
                })),
                _ => Ok(None),
            }
        }
        CommandCapability::RetryRun => {
            if let Some(RuntimeEffectReceipt::Completed(version)) =
                runtime_effect_receipt(connection, intent)?
            {
                return Ok(Some(RuntimePreparation::Acknowledge(version)));
            }
            let retry_exists = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM runs WHERE idempotency_key = ?1)",
                    [&intent.command_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| {
                    format!("Could not reconcile interrupted Companion retry: {error}")
                })?;
            if retry_exists {
                Ok(Some(RuntimePreparation::Refuse {
                    code: "host_ack_unknown",
                    message: "The retry Run exists without this command's durable receipt, so Xiao will not infer acknowledgement from its current version.".to_owned(),
                }))
            } else {
                Ok(None)
            }
        }
        CommandCapability::SendFollowUp => Ok(Some(RuntimePreparation::Refuse {
            code: "host_ack_unknown",
            message: "The host restarted after beginning the follow-up; no canonical receipt proves acknowledgement, so Xiao will not repeat it.".to_owned(),
        })),
        CommandCapability::CreateTask => {
            let task_id = validate_new_task_payload(&intent.envelope)?.0;
            let run_version = connection
                .query_row(
                    "SELECT version FROM runs WHERE idempotency_key = ?1",
                    [&intent.command_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|error| {
                    format!("Could not reconcile interrupted Companion task creation: {error}")
                })?;
            if let Some(version) = run_version {
                return Ok(Some(RuntimePreparation::Acknowledge(version)));
            }
            let task_exists = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM tasks WHERE task_id = ?1)",
                    [&task_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| {
                    format!("Could not inspect interrupted Companion task creation: {error}")
                })?;
            if task_exists {
                Ok(Some(RuntimePreparation::Refuse {
                    code: "host_ack_unknown",
                    message: "The Task was created without a command-correlated Run acknowledgement, so Xiao will not repeat the assignment.".to_owned(),
                }))
            } else {
                Ok(None)
            }
        }
        _ => Ok(None),
    }
}

fn runtime_effect_receipt(
    connection: &rusqlite::Connection,
    intent: &super::models::CompanionOutboxIntent,
) -> Result<Option<RuntimeEffectReceipt>, String> {
    let target_kind = match intent.envelope.target.kind {
        TargetKind::Run => "run",
        TargetKind::PendingInput => "pending_input",
        _ => return Ok(None),
    };
    connection
        .query_row(
            "SELECT CASE
                        WHEN json_type(
                            safe_payload_json,
                            '$.companionCommandReceipt.resultingVersion'
                        ) = 'integer'
                        THEN json_extract(
                            safe_payload_json,
                            '$.companionCommandReceipt.resultingVersion'
                        )
                        ELSE NULL
                    END
             FROM run_events
             WHERE json_extract(
                       safe_payload_json,
                       '$.companionCommandReceipt.commandId'
                   ) = ?1
               AND json_extract(
                       safe_payload_json,
                       '$.companionCommandReceipt.targetKind'
                   ) = ?2
               AND json_extract(
                       safe_payload_json,
                       '$.companionCommandReceipt.targetId'
                   ) = ?3
             ORDER BY json_type(
                        safe_payload_json,
                        '$.companionCommandReceipt.resultingVersion'
                      ) = 'integer' DESC,
                      sequence DESC
             LIMIT 1",
            params![intent.command_id, target_kind, intent.envelope.target.id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .map(|receipt| {
            receipt.map(|resulting_version| match resulting_version {
                Some(version) => RuntimeEffectReceipt::Completed(version),
                None => RuntimeEffectReceipt::Started,
            })
        })
        .map_err(|error| format!("Could not inspect the Companion command receipt: {error}"))
}

fn completed_runtime_effect_receipt_version(
    app: &AppHandle,
    intent: &super::models::CompanionOutboxIntent,
) -> Result<i64, String> {
    app.state::<XiaoRepository>().with_connection(|connection| {
        match runtime_effect_receipt(connection, intent)? {
            Some(RuntimeEffectReceipt::Completed(version)) => Ok(version),
            _ => Err(
                "The canonical runtime mutation has no completed Companion command receipt."
                    .to_owned(),
            ),
        }
    })
}

fn requires_runtime_dispatch(capability: CommandCapability) -> bool {
    matches!(
        capability,
        CommandCapability::ResolveApproval
            | CommandCapability::ResolveQuestion
            | CommandCapability::ResolveMcpElicitation
            | CommandCapability::StopRun
            | CommandCapability::RetryRun
            | CommandCapability::SendFollowUp
            | CommandCapability::CreateTask
    )
}

fn validate_new_task_payload(envelope: &CommandEnvelope) -> Result<(String, String), String> {
    let task_id = envelope
        .payload
        .get("taskId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("A Companion task requires a taskId.")?;
    if task_id.len() > 256 {
        return Err("A Companion taskId cannot exceed 256 bytes.".to_owned());
    }
    let prompt = envelope
        .payload
        .get("prompt")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("A Companion task requires a prompt.")?;
    if prompt.len() > MAX_TASK_PROMPT_BYTES {
        return Err(format!(
            "Companion task prompts cannot exceed {MAX_TASK_PROMPT_BYTES} bytes."
        ));
    }
    Ok((task_id.to_owned(), prompt.to_owned()))
}

fn create_companion_task(
    app: &AppHandle,
    intent: &super::models::CompanionOutboxIntent,
) -> Result<i64, String> {
    let (task_id, prompt) = validate_new_task_payload(&intent.envelope)?;
    let repository = app.state::<XiaoRepository>();
    let workspace_path = repository.with_connection(|connection| {
        connection
            .query_row(
                "SELECT workspace_path FROM workspaces
                 WHERE COALESCE(public_id, CAST(id AS TEXT)) = ?1",
                [&intent.envelope.target.id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| format!("Could not resolve the Companion Project: {error}"))
    })?;
    let mut workspace = repository
        .load_workspace(&workspace_path, false)?
        .ok_or("The Companion Project is no longer available.")?;
    if !workspace.tasks.iter().any(|task| task.id == task_id) {
        let active_source = workspace
            .active_task_id
            .as_deref()
            .and_then(|id| workspace.tasks.iter().find(|task| task.id == id));
        let source = active_source
            .filter(|task| task.model.is_some() && task.reasoning_effort.is_some())
            .or_else(|| {
                workspace
                    .tasks
                    .iter()
                    .find(|task| task.model.is_some() && task.reasoning_effort.is_some())
            });
        let model = source.and_then(|task| task.model.clone());
        let reasoning_effort = source.and_then(|task| task.reasoning_effort.clone());
        if model.is_none() || reasoning_effort.is_none() {
            return Err(
                "Create one desktop Xiao task with a selected model before assigning from Companion."
                    .to_owned(),
            );
        }
        let now = now_millis()?;
        let title = prompt
            .lines()
            .next()
            .unwrap_or(&prompt)
            .trim()
            .chars()
            .take(72)
            .collect::<String>();
        workspace.tasks.insert(
            0,
            XiaoTaskDocument {
                id: task_id.clone(),
                title,
                created_at: now,
                updated_at: now,
                stage: TaskStage::Draft,
                stage_version: 0,
                codex_profile_id: source.and_then(|task| task.codex_profile_id.clone()),
                workbench_state: serde_json::json!({}),
                draft_text: prompt.clone(),
                follow_ups: Vec::new(),
                archived: false,
                pinned: false,
                unread: false,
                model: model.clone(),
                reasoning_effort: reasoning_effort.clone(),
                thread_id: None,
                thread_binding: None,
                mode: source
                    .map(|task| task.mode.clone())
                    .unwrap_or_else(|| "default".to_owned()),
                approval_policy: source
                    .map(|task| task.approval_policy.clone())
                    .unwrap_or_else(|| "on-request".to_owned()),
                sandbox_mode: source
                    .map(|task| task.sandbox_mode.clone())
                    .unwrap_or_else(|| "workspace-write".to_owned()),
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
            },
        );
        workspace.active_task_id = Some(task_id.clone());
        repository.save_workspace(XiaoWorkspaceUpdate {
            schema_version: workspace.schema_version,
            workspace_path: workspace.workspace_path.clone(),
            active_task_id: workspace.active_task_id.clone(),
            show_archived: workspace.show_archived,
            task_ids: workspace.tasks.iter().map(|task| task.id.clone()).collect(),
            tasks: workspace.tasks,
        })?;
    }
    let run = app.state::<RunService>().enqueue(
        app,
        EnqueueRunRequest {
            project_path: workspace_path,
            task_id,
            idempotency_key: intent.command_id.clone(),
            prompt: prompt.clone(),
            input: vec![serde_json::json!({
                "type": "text",
                "text": prompt,
                "text_elements": [],
            })],
            history: Vec::new(),
            default_model: None,
            default_reasoning_effort: None,
            service_tier: None,
        },
    )?;
    Ok(run.version)
}

fn definitive_refusal(code: &str, message: &str) -> HostCommandRefusal {
    HostCommandRefusal {
        code: code.to_owned(),
        message: message.to_owned(),
        definitive: true,
    }
}

fn bounded_follow_up_message(envelope: &CommandEnvelope) -> Result<String, String> {
    let message = envelope
        .payload
        .get("message")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .ok_or("A Companion follow-up requires a non-empty message.")?;
    if message.len() > MAX_FOLLOW_UP_MESSAGE_BYTES {
        return Err(format!(
            "Companion follow-up messages cannot exceed {MAX_FOLLOW_UP_MESSAGE_BYTES} bytes."
        ));
    }
    Ok(message.to_owned())
}

fn bounded_pending_input_result(
    kind: PendingInputKind,
    safe_summary: &serde_json::Value,
    envelope: &CommandEnvelope,
) -> Result<serde_json::Value, String> {
    let expected_capability = match kind {
        PendingInputKind::CommandApproval
        | PendingInputKind::FileApproval
        | PendingInputKind::Permissions => CommandCapability::ResolveApproval,
        PendingInputKind::Question => CommandCapability::ResolveQuestion,
        PendingInputKind::McpElicitation => CommandCapability::ResolveMcpElicitation,
    };
    if envelope.capability != expected_capability {
        return Err("The Companion capability does not match the canonical input kind.".to_owned());
    }
    let option_id = envelope
        .payload
        .get("optionId")
        .and_then(serde_json::Value::as_str)
        .ok_or("A Companion input resolution requires an optionId.")?;
    match kind {
        PendingInputKind::CommandApproval | PendingInputKind::FileApproval => match option_id {
            "accept" | "decline" => Ok(serde_json::json!({ "decision": option_id })),
            _ => Err("The selected approval option is no longer available.".to_owned()),
        },
        PendingInputKind::Permissions => match option_id {
            "accept" => {
                let requested = safe_summary
                    .get("permissions")
                    .and_then(serde_json::Value::as_object);
                let mut permissions = serde_json::Map::new();
                if let Some(network) = requested
                    .and_then(|value| value.get("network"))
                    .filter(|value| value.is_object())
                {
                    permissions.insert("network".to_owned(), network.clone());
                }
                if let Some(file_system) = requested
                    .and_then(|value| value.get("fileSystem"))
                    .filter(|value| value.is_object())
                {
                    permissions.insert("fileSystem".to_owned(), file_system.clone());
                }
                Ok(serde_json::json!({
                    "permissions": permissions,
                    "scope": "turn",
                }))
            }
            "decline" => Ok(serde_json::json!({
                "permissions": {},
                "scope": "turn",
            })),
            _ => Err("The selected permissions option is no longer available.".to_owned()),
        },
        PendingInputKind::Question => {
            let questions = safe_summary
                .get("questions")
                .and_then(serde_json::Value::as_array)
                .ok_or("The canonical question has no bounded choices.")?;
            if questions.len() != 1 {
                return Err(
                    "Companion access refuses multi-question requests that cannot be answered completely."
                        .to_owned(),
                );
            }
            let option_index = option_id
                .strip_prefix("question:")
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or("The selected question option is invalid.")?;
            let question = questions
                .first()
                .ok_or("The canonical question has no bounded choices.")?;
            let question_id = question
                .get("id")
                .and_then(serde_json::Value::as_str)
                .ok_or("The canonical question has no id.")?;
            let option = question
                .get("options")
                .and_then(serde_json::Value::as_array)
                .and_then(|options| options.get(option_index))
                .ok_or("The selected question option is no longer available.")?;
            let answer = option
                .as_str()
                .or_else(|| option.get("label").and_then(serde_json::Value::as_str))
                .ok_or("The canonical question option has no answer label.")?;
            Ok(serde_json::json!({
                "answers": {
                    (question_id): { "answers": [answer] }
                }
            }))
        }
        PendingInputKind::McpElicitation => match option_id {
            "decline" | "cancel" => Ok(serde_json::json!({
                "action": option_id,
                "content": null,
                "_meta": null,
            })),
            _ => Err("Companion access cannot accept MCP form content.".to_owned()),
        },
    }
}

fn now_seconds() -> Result<i64, String> {
    now_duration().and_then(|duration| {
        i64::try_from(duration.as_secs())
            .map_err(|_| "The primary host clock is outside the supported range.".to_owned())
    })
}

fn now_millis() -> Result<i64, String> {
    now_duration().and_then(|duration| {
        i64::try_from(duration.as_millis())
            .map_err(|_| "The primary host clock is outside the supported range.".to_owned())
    })
}

fn now_duration() -> Result<std::time::Duration, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Could not read the primary host clock: {error}"))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use serde_json::json;

    use super::*;
    use crate::companion::models::TargetScope;

    fn envelope(
        capability: CommandCapability,
        target_kind: TargetKind,
        project_id: Option<&str>,
        payload: serde_json::Value,
    ) -> CommandEnvelope {
        CommandEnvelope {
            session_id: "session".to_owned(),
            session_generation: 1,
            device_id: "device".to_owned(),
            command_id: "command".to_owned(),
            idempotency_key: "idempotency".to_owned(),
            expected_version: 1,
            target: TargetScope {
                kind: target_kind,
                id: "same-task".to_owned(),
                project_id: project_id.map(str::to_owned),
            },
            audit_timestamp: 1_900_000_000_000,
            capability,
            payload,
        }
    }

    #[test]
    fn task_authorization_is_scoped_to_the_canonical_project() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE workspaces (
                    id INTEGER PRIMARY KEY,
                    public_id TEXT,
                    workspace_path TEXT NOT NULL
                 );
                 CREATE TABLE tasks (
                    workspace_id INTEGER NOT NULL,
                    task_id TEXT NOT NULL,
                    task_stage_version INTEGER NOT NULL
                 );
                 INSERT INTO workspaces VALUES (1, 'project-a', 'a');
                 INSERT INTO workspaces VALUES (2, 'project-b', 'b');
                 INSERT INTO tasks VALUES (1, 'same-task', 3);
                 INSERT INTO tasks VALUES (2, 'same-task', 9);",
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        let command = envelope(
            CommandCapability::AcceptOutcome,
            TargetKind::Task,
            Some("project-b"),
            json!({}),
        );
        let authorization = AppCompanionCommandHost
            .reauthorize(&transaction, &session(), &command)
            .unwrap();
        assert_eq!(authorization.current_version, 9);

        let missing_scope = envelope(
            CommandCapability::AcceptOutcome,
            TargetKind::Task,
            None,
            json!({}),
        );
        assert_eq!(
            AppCompanionCommandHost
                .reauthorize(&transaction, &session(), &missing_scope)
                .unwrap_err()
                .code,
            "invalid_target_scope"
        );
    }

    #[test]
    fn runtime_reauthorization_enforces_canonical_retry_and_follow_up_eligibility() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE runs (
                    id TEXT PRIMARY KEY,
                    version INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    runtime_generation INTEGER,
                    thread_id TEXT,
                    turn_id TEXT
                 );
                 INSERT INTO runs VALUES (
                    'same-task', 3, 'cancelled', NULL, NULL, NULL
                 );",
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        let retry = envelope(
            CommandCapability::RetryRun,
            TargetKind::Run,
            None,
            json!({}),
        );
        assert_eq!(
            AppCompanionCommandHost
                .reauthorize(&transaction, &session(), &retry)
                .unwrap_err()
                .code,
            "run_not_retryable"
        );
        let follow_up = envelope(
            CommandCapability::SendFollowUp,
            TargetKind::Run,
            None,
            json!({ "message": "Continue." }),
        );
        assert_eq!(
            AppCompanionCommandHost
                .reauthorize(&transaction, &session(), &follow_up)
                .unwrap_err()
                .code,
            "run_not_steerable"
        );
        let stop = envelope(CommandCapability::StopRun, TargetKind::Run, None, json!({}));
        assert_eq!(
            AppCompanionCommandHost
                .reauthorize(&transaction, &session(), &stop)
                .unwrap_err()
                .code,
            "run_not_stoppable"
        );
    }

    #[test]
    fn task_creation_requires_a_current_project_and_a_bounded_prompt() {
        assert_eq!(
            CommandCapability::CreateTask.expected_target(),
            Some(TargetKind::Project)
        );
        assert!(!CommandCapability::CreateTask.is_forbidden());
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE workspaces (
                    id INTEGER PRIMARY KEY,
                    public_id TEXT,
                    updated_at INTEGER NOT NULL
                 );
                 INSERT INTO workspaces VALUES (1, 'same-task', 7);",
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        let create = envelope(
            CommandCapability::CreateTask,
            TargetKind::Project,
            None,
            json!({
                "taskId": "mobile-task",
                "prompt": "Fix the mobile login flow."
            }),
        );
        assert_eq!(
            AppCompanionCommandHost
                .reauthorize(&transaction, &session(), &create)
                .unwrap()
                .current_version,
            7
        );
        let invalid = envelope(
            CommandCapability::CreateTask,
            TargetKind::Project,
            None,
            json!({ "taskId": "mobile-task", "prompt": " " }),
        );
        assert_eq!(
            AppCompanionCommandHost
                .reauthorize(&transaction, &session(), &invalid)
                .unwrap_err()
                .code,
            "invalid_task"
        );
    }

    #[test]
    fn pending_input_results_are_reconstructed_from_canonical_safe_state() {
        let permissions = envelope(
            CommandCapability::ResolveApproval,
            TargetKind::PendingInput,
            None,
            json!({
                "optionId": "accept",
                "result": { "permissions": { "unrestricted": true } }
            }),
        );
        assert_eq!(
            bounded_pending_input_result(
                PendingInputKind::Permissions,
                &json!({
                    "permissions": {
                        "network": { "hosts": ["api.example.test"] },
                        "unbounded": true
                    }
                }),
                &permissions,
            )
            .unwrap(),
            json!({
                "permissions": {
                    "network": { "hosts": ["api.example.test"] }
                },
                "scope": "turn"
            })
        );
        let question = envelope(
            CommandCapability::ResolveQuestion,
            TargetKind::PendingInput,
            None,
            json!({ "optionId": "question:1" }),
        );
        assert_eq!(
            bounded_pending_input_result(
                PendingInputKind::Question,
                &json!({
                    "questions": [{
                        "id": "canonical-question",
                        "options": [
                            { "label": "First" },
                            { "label": "Second" }
                        ]
                    }]
                }),
                &question,
            )
            .unwrap(),
            json!({
                "answers": {
                    "canonical-question": { "answers": ["Second"] }
                }
            })
        );
        assert!(bounded_pending_input_result(
            PendingInputKind::Question,
            &json!({
                "questions": [
                    { "id": "one", "options": ["First"] },
                    { "id": "two", "options": ["Second"] }
                ]
            }),
            &question,
        )
        .unwrap_err()
        .contains("multi-question"));

        let mcp_accept = envelope(
            CommandCapability::ResolveMcpElicitation,
            TargetKind::PendingInput,
            None,
            json!({ "optionId": "accept" }),
        );
        assert!(bounded_pending_input_result(
            PendingInputKind::McpElicitation,
            &json!({}),
            &mcp_accept,
        )
        .is_err());
    }

    #[test]
    fn follow_up_targets_an_exact_run_and_is_bounded() {
        assert_eq!(
            CommandCapability::SendFollowUp.expected_target(),
            Some(TargetKind::Run)
        );
        let follow_up = envelope(
            CommandCapability::SendFollowUp,
            TargetKind::Run,
            None,
            json!({ "message": "  Continue with the focused check.  " }),
        );
        assert_eq!(
            bounded_follow_up_message(&follow_up).unwrap(),
            "Continue with the focused check."
        );
    }

    #[test]
    fn runtime_receipt_replay_keeps_the_original_run_resulting_version() {
        let connection = interrupted_effect_connection();
        let intent = interrupted_intent(CommandCapability::StopRun, TargetKind::Run);
        connection
            .execute(
                "INSERT INTO run_events(run_id, sequence, safe_payload_json)
                 VALUES (
                    'same-task',
                    1,
                    '{\"companionCommandReceipt\":{\"commandId\":\"command\",\"targetKind\":\"run\",\"targetId\":\"same-task\",\"resultingVersion\":8}}'
                 )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE runs
                 SET status = 'cancelled', version = 12
                 WHERE id = 'same-task'",
                [],
            )
            .unwrap();

        assert_eq!(
            recover_interrupted_runtime_effect(&connection, &intent).unwrap(),
            Some(RuntimePreparation::Acknowledge(8))
        );
    }

    #[test]
    fn pending_input_runtime_receipt_uses_the_pending_input_resulting_version() {
        let connection = interrupted_effect_connection();
        let intent =
            interrupted_intent(CommandCapability::ResolveApproval, TargetKind::PendingInput);
        connection
            .execute(
                "INSERT INTO run_events(run_id, sequence, safe_payload_json)
                 VALUES (
                    'same-task',
                    1,
                    '{\"companionCommandReceipt\":{\"commandId\":\"command\",\"targetKind\":\"pending_input\",\"targetId\":\"same-task\",\"resultingVersion\":11}}'
                 )",
                [],
            )
            .unwrap();
        connection
            .execute("UPDATE runs SET version = 42 WHERE id = 'same-task'", [])
            .unwrap();

        assert_eq!(
            recover_interrupted_runtime_effect(&connection, &intent).unwrap(),
            Some(RuntimePreparation::Acknowledge(11))
        );
    }

    #[test]
    fn interrupted_input_without_a_command_receipt_is_never_acknowledged_or_repeated() {
        let connection = interrupted_effect_connection();
        let mut intent =
            interrupted_intent(CommandCapability::ResolveApproval, TargetKind::PendingInput);

        assert_eq!(
            recover_interrupted_runtime_effect(&connection, &intent).unwrap(),
            Some(RuntimePreparation::Refuse {
                code: "host_ack_unknown",
                message: "The host restarted after beginning the input reply; canonical state has no command-correlated receipt, so Xiao will not repeat it or report success.".to_owned(),
            })
        );

        connection
            .execute(
                "UPDATE pending_inputs SET resolved_at = 10 WHERE id = 'same-task'",
                [],
            )
            .unwrap();
        assert_eq!(
            recover_interrupted_runtime_effect(&connection, &intent).unwrap(),
            Some(RuntimePreparation::Refuse {
                code: "host_ack_unknown",
                message: "The host restarted after beginning the input reply; canonical state has no command-correlated receipt, so Xiao will not repeat it or report success.".to_owned(),
            })
        );
        connection
            .execute(
                "INSERT INTO run_events(run_id, sequence, safe_payload_json)
                 VALUES ('same-task', 1, '{\"companionCommandId\":\"command\"}')",
                [],
            )
            .unwrap();
        assert_eq!(
            recover_interrupted_runtime_effect(&connection, &intent).unwrap(),
            Some(RuntimePreparation::Refuse {
                code: "host_ack_unknown",
                message: "The host restarted after beginning the input reply; canonical state has no command-correlated receipt, so Xiao will not repeat it or report success.".to_owned(),
            })
        );

        intent.envelope.capability = CommandCapability::SendFollowUp;
        intent.envelope.target.kind = TargetKind::Run;
        assert_eq!(
            recover_interrupted_runtime_effect(&connection, &intent).unwrap(),
            Some(RuntimePreparation::Refuse {
                code: "host_ack_unknown",
                message: "The host restarted after beginning the follow-up; no canonical receipt proves acknowledgement, so Xiao will not repeat it.".to_owned(),
            })
        );
    }

    #[test]
    fn interrupted_idempotent_run_effects_use_canonical_receipts() {
        let connection = interrupted_effect_connection();
        let stop = interrupted_intent(CommandCapability::StopRun, TargetKind::Run);
        assert_eq!(
            recover_interrupted_runtime_effect(&connection, &stop).unwrap(),
            None
        );
        connection
            .execute(
                "UPDATE runs SET status = 'failed', version = 8 WHERE id = 'same-task'",
                [],
            )
            .unwrap();
        assert!(matches!(
            recover_interrupted_runtime_effect(&connection, &stop).unwrap(),
            Some(RuntimePreparation::Refuse {
                code: "host_ack_unknown",
                ..
            })
        ));
        connection
            .execute(
                "UPDATE runs
                 SET status = 'running', cancel_requested = 1, version = 9
                 WHERE id = 'same-task'",
                [],
            )
            .unwrap();
        assert!(matches!(
            recover_interrupted_runtime_effect(&connection, &stop).unwrap(),
            Some(RuntimePreparation::Refuse {
                code: "host_ack_unknown",
                ..
            })
        ));
        connection
            .execute(
                "INSERT INTO run_events(run_id, sequence, safe_payload_json)
                 VALUES ('same-task', 1, '{\"companionCommandId\":\"command\"}')",
                [],
            )
            .unwrap();
        assert_eq!(
            recover_interrupted_runtime_effect(&connection, &stop).unwrap(),
            Some(RuntimePreparation::Refuse {
                code: "host_ack_unknown",
                message: "The Run was stopped without this command's durable receipt, so Xiao will not report the interrupted stop as successful.".to_owned(),
            })
        );
        connection
            .execute(
                "INSERT INTO run_events(run_id, sequence, safe_payload_json)
                 VALUES (
                    'same-task',
                    2,
                    '{\"companionCommandReceipt\":{\"commandId\":\"command\",\"targetKind\":\"run\",\"targetId\":\"same-task\"}}'
                 )",
                [],
            )
            .unwrap();
        assert_eq!(
            recover_interrupted_runtime_effect(&connection, &stop).unwrap(),
            Some(RuntimePreparation::Execute)
        );
        connection
            .execute(
                "UPDATE runs
                 SET status = 'cancelled', cancel_requested = 0, version = 12
                 WHERE id = 'same-task'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO run_events(run_id, sequence, safe_payload_json)
                 VALUES (
                    'same-task',
                    3,
                    '{\"companionCommandReceipt\":{\"commandId\":\"command\",\"targetKind\":\"run\",\"targetId\":\"same-task\",\"resultingVersion\":11}}'
                 )",
                [],
            )
            .unwrap();
        assert_eq!(
            recover_interrupted_runtime_effect(&connection, &stop).unwrap(),
            Some(RuntimePreparation::Acknowledge(11))
        );

        let mut retry = interrupted_intent(CommandCapability::RetryRun, TargetKind::Run);
        retry.command_id = "retry-command".to_owned();
        retry.envelope.command_id = "retry-command".to_owned();
        assert_eq!(
            recover_interrupted_runtime_effect(&connection, &retry).unwrap(),
            None
        );
        connection
            .execute(
                "INSERT INTO runs(id, status, cancel_requested, version, idempotency_key)
                 VALUES ('retried-run', 'queued', 0, 1, 'retry-command')",
                [],
            )
            .unwrap();
        assert_eq!(
            recover_interrupted_runtime_effect(&connection, &retry).unwrap(),
            Some(RuntimePreparation::Refuse {
                code: "host_ack_unknown",
                message: "The retry Run exists without this command's durable receipt, so Xiao will not infer acknowledgement from its current version.".to_owned(),
            })
        );
        connection
            .execute(
                "INSERT INTO run_events(run_id, sequence, safe_payload_json)
                 VALUES (
                    'retried-run',
                    1,
                    '{\"companionCommandReceipt\":{\"commandId\":\"retry-command\",\"targetKind\":\"run\",\"targetId\":\"same-task\",\"resultingVersion\":7}}'
                 )",
                [],
            )
            .unwrap();
        connection
            .execute("UPDATE runs SET version = 4 WHERE id = 'retried-run'", [])
            .unwrap();
        assert_eq!(
            recover_interrupted_runtime_effect(&connection, &retry).unwrap(),
            Some(RuntimePreparation::Acknowledge(7))
        );
    }

    fn interrupted_effect_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE runs (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    cancel_requested INTEGER NOT NULL,
                    version INTEGER NOT NULL,
                    idempotency_key TEXT
                 );
                 CREATE TABLE pending_inputs (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    resolved_at INTEGER,
                    invalidated_at INTEGER
                 );
                 CREATE TABLE run_events (
                    run_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    safe_payload_json TEXT NOT NULL
                 );
                 CREATE TABLE tasks (
                    task_id TEXT PRIMARY KEY
                 );
                 INSERT INTO runs(id, status, cancel_requested, version, idempotency_key)
                 VALUES ('same-task', 'running', 0, 7, NULL);
                 INSERT INTO pending_inputs(id, run_id, resolved_at, invalidated_at)
                 VALUES ('same-task', 'same-task', NULL, NULL);",
            )
            .unwrap();
        connection
    }

    fn interrupted_intent(
        capability: CommandCapability,
        target_kind: TargetKind,
    ) -> super::super::models::CompanionOutboxIntent {
        super::super::models::CompanionOutboxIntent {
            command_id: "command".to_owned(),
            envelope: envelope(capability, target_kind, None, json!({})),
            status: "executing".to_owned(),
            attempt_count: 1,
            created_at: 1_900_000_000_000,
        }
    }

    fn session() -> CompanionSession {
        CompanionSession {
            session_id: "session".to_owned(),
            device_id: "device".to_owned(),
            device_name: "Device".to_owned(),
            grants: vec![],
            generation: 1,
            created_at: 0,
            last_seen_at: 0,
            rotated_at: None,
            revoked_at: None,
        }
    }
}
