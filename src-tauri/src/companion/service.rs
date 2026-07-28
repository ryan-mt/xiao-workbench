use std::collections::HashSet;

use rusqlite::{Connection, Transaction, TransactionBehavior};
use uuid::Uuid;

use super::models::{
    AppendProjectionUpdate, CommandEnvelope, CommandResult, CommandState, CompanionAuditRecord,
    CompanionGrant, CompanionSession, ExchangePairingRequest, ExchangedSession,
    ExecutionAuthorization, HostCommandAck, HostCommandRefusal, IssuePairingRequest,
    NotificationCursor, NotificationPage, PairingCredential, ReconnectCursor, RevokedDevice,
    SessionCredential, SnapshotPageCursor, SyncBatch, SyncPhase, SyncRequest,
};
use super::repository::{
    command_fingerprint, credential_hash, CommandReservation, CompanionRepository,
};

const MAX_PAIRING_TTL_SECONDS: i64 = 10 * 60;
const MAX_CLOCK_SKEW_MILLIS: i64 = 5 * 60 * 1_000;
const MAX_DEVICE_ID_BYTES: usize = 256;
const MAX_DEVICE_NAME_BYTES: usize = 256;
const MAX_ID_BYTES: usize = 512;
const MAX_COMMAND_PAYLOAD_BYTES: usize = 16 * 1024;
const MAX_SYNC_UPDATES: usize = 1_000;
const DEFAULT_SYNC_UPDATES: usize = 200;

pub trait CompanionCommandHost {
    /// Re-reads current host policy and target state immediately before execution.
    fn reauthorize(
        &self,
        transaction: &Transaction<'_>,
        session: &CompanionSession,
        command: &CommandEnvelope,
    ) -> Result<ExecutionAuthorization, HostCommandRefusal>;

    /// Executes against canonical host state. Implementations must repeat the expected-version
    /// check in the same atomic operation that applies the command.
    fn execute(
        &self,
        transaction: &Transaction<'_>,
        session: &CompanionSession,
        command: &CommandEnvelope,
        authorization: &ExecutionAuthorization,
    ) -> Result<HostCommandAck, HostCommandRefusal>;
}

#[derive(Default)]
pub struct CompanionService;

impl CompanionService {
    pub fn issue_pairing(
        &self,
        connection: &mut Connection,
        request: IssuePairingRequest,
    ) -> Result<PairingCredential, String> {
        if !(1..=MAX_PAIRING_TTL_SECONDS).contains(&request.ttl_seconds) {
            return Err(format!(
                "Companion pairing lifetime must be between 1 and {MAX_PAIRING_TTL_SECONDS} seconds."
            ));
        }
        let pairing_id = new_id();
        let owner_credential = new_secret();
        let expires_at = request
            .now
            .checked_add(request.ttl_seconds)
            .ok_or("The Companion pairing expiration is outside the supported range.")?;
        CompanionRepository::insert_pairing(
            connection,
            &pairing_id,
            &credential_hash(&owner_credential),
            expires_at,
            request.now,
        )?;
        Ok(PairingCredential {
            pairing_id,
            owner_credential,
            expires_at,
        })
    }

    pub fn exchange_pairing(
        &self,
        connection: &mut Connection,
        request: ExchangePairingRequest,
    ) -> Result<ExchangedSession, String> {
        validate_required(
            "Companion device id",
            &request.device_id,
            MAX_DEVICE_ID_BYTES,
        )?;
        validate_required(
            "Companion device name",
            &request.device_name,
            MAX_DEVICE_NAME_BYTES,
        )?;
        let grants = canonical_grants(request.grants);
        let session_id = new_id();
        let secret = new_secret();
        let session = CompanionSession {
            session_id: session_id.clone(),
            device_id: request.device_id.clone(),
            device_name: request.device_name,
            grants,
            generation: 1,
            created_at: request.now,
            last_seen_at: request.now,
            rotated_at: None,
            revoked_at: None,
        };
        CompanionRepository::exchange_pairing(
            connection,
            &credential_hash(&request.owner_credential),
            &session,
            &credential_hash(&secret),
            request.now,
        )?;
        Ok(ExchangedSession {
            credential: SessionCredential {
                session_id,
                device_id: request.device_id,
                generation: session.generation,
                secret,
            },
            session,
        })
    }

    pub fn list_sessions(&self, connection: &Connection) -> Result<Vec<CompanionSession>, String> {
        CompanionRepository::list_sessions(connection)
    }

    pub fn rotate_session(
        &self,
        connection: &mut Connection,
        session_id: &str,
        now: i64,
    ) -> Result<ExchangedSession, String> {
        validate_required("Companion session id", session_id, MAX_ID_BYTES)?;
        let secret = new_secret();
        let session = CompanionRepository::rotate_session(
            connection,
            session_id,
            &credential_hash(&secret),
            now,
        )?;
        Ok(ExchangedSession {
            credential: SessionCredential {
                session_id: session.session_id.clone(),
                device_id: session.device_id.clone(),
                generation: session.generation,
                secret,
            },
            session,
        })
    }

    pub fn revoke_session(
        &self,
        connection: &mut Connection,
        session_id: &str,
        now: i64,
    ) -> Result<CompanionSession, String> {
        validate_required("Companion session id", session_id, MAX_ID_BYTES)?;
        CompanionRepository::revoke_session(connection, session_id, now)
    }

    pub fn revoke_device(
        &self,
        connection: &mut Connection,
        device_id: &str,
        now: i64,
    ) -> Result<RevokedDevice, String> {
        validate_required("Companion device id", device_id, MAX_DEVICE_ID_BYTES)?;
        Ok(RevokedDevice {
            device_id: device_id.to_owned(),
            revoked_sessions: CompanionRepository::revoke_device(connection, device_id, now)?,
        })
    }

    pub fn replace_grants(
        &self,
        connection: &mut Connection,
        session_id: &str,
        grants: Vec<CompanionGrant>,
        now: i64,
    ) -> Result<CompanionSession, String> {
        validate_required("Companion session id", session_id, MAX_ID_BYTES)?;
        CompanionRepository::replace_grants(connection, session_id, &canonical_grants(grants), now)
    }

    pub fn append_projection_update(
        &self,
        connection: &mut Connection,
        update: AppendProjectionUpdate,
    ) -> Result<super::models::ProjectionUpdate, String> {
        validate_required(
            "Companion projection event id",
            &update.event_id,
            MAX_ID_BYTES,
        )?;
        validate_required(
            "Companion projection entity id",
            &update.entity_id,
            MAX_ID_BYTES,
        )?;
        if update.entity_version < 0 {
            return Err("Companion projection entity versions cannot be negative.".to_owned());
        }
        CompanionRepository::append_projection_update(connection, &update)
    }

    pub fn notifications(
        &self,
        connection: &mut Connection,
        credential: &SessionCredential,
        cursor: Option<NotificationCursor>,
        limit: Option<usize>,
        now: i64,
    ) -> Result<NotificationPage, String> {
        let session = CompanionRepository::authenticate(connection, credential, now)?;
        if !session.grants.contains(&CompanionGrant::ReadAttention) {
            return Err(
                "The current Companion session grants do not authorize Attention notifications."
                    .to_owned(),
            );
        }
        CompanionRepository::list_notifications(
            connection,
            cursor.as_ref(),
            limit.unwrap_or(50).clamp(1, 200),
        )
    }

    pub fn mark_disconnected(&self, cursor: ReconnectCursor) -> SyncBatch {
        SyncBatch {
            phase: SyncPhase::Stale,
            generation: cursor.generation,
            from_sequence: cursor.sequence,
            cursor: cursor.sequence,
            latest_sequence: cursor.sequence,
            is_snapshot: false,
            has_more: false,
            next_snapshot: None,
            updates: Vec::new(),
        }
    }

    pub fn sync(
        &self,
        connection: &mut Connection,
        credential: &SessionCredential,
        cursor: Option<ReconnectCursor>,
        now: i64,
    ) -> Result<SyncBatch, String> {
        self.sync_page(
            connection,
            credential,
            SyncRequest {
                cursor,
                limit: None,
            },
            now,
        )
    }

    pub fn sync_page(
        &self,
        connection: &mut Connection,
        credential: &SessionCredential,
        request: SyncRequest,
        now: i64,
    ) -> Result<SyncBatch, String> {
        let session = CompanionRepository::authenticate(connection, credential, now)?;
        let (projection_generation, latest_sequence, authorization_epoch) =
            CompanionRepository::projection_position(connection)?;
        let generation = authorized_generation(projection_generation, authorization_epoch)?;
        let limit = request
            .limit
            .unwrap_or(DEFAULT_SYNC_UPDATES)
            .clamp(1, MAX_SYNC_UPDATES);
        let reset_snapshot = request
            .cursor
            .as_ref()
            .map(|cursor| cursor.generation != generation)
            .unwrap_or(true);
        let continued_snapshot = request
            .cursor
            .as_ref()
            .filter(|cursor| cursor.generation == generation)
            .and_then(|cursor| cursor.snapshot.as_ref());
        let snapshot = reset_snapshot || continued_snapshot.is_some();
        let from_sequence = if reset_snapshot {
            0
        } else {
            request
                .cursor
                .as_ref()
                .map(|cursor| cursor.sequence)
                .unwrap_or(0)
        };
        let snapshot_base = continued_snapshot
            .map(|snapshot| snapshot.base_sequence)
            .unwrap_or(latest_sequence);
        if from_sequence > latest_sequence {
            return Err("The Companion reconnect cursor is ahead of the primary host.".to_owned());
        }
        if !snapshot && from_sequence == latest_sequence {
            return Ok(SyncBatch {
                phase: SyncPhase::Live,
                generation,
                from_sequence,
                cursor: latest_sequence,
                latest_sequence,
                is_snapshot: false,
                has_more: false,
                next_snapshot: None,
                updates: Vec::new(),
            });
        }
        let (mut updates, scan_cursor, has_more) = if snapshot {
            CompanionRepository::load_projection_snapshot(
                connection,
                projection_generation,
                from_sequence,
                snapshot_base,
                &session.grants,
                limit,
            )?
        } else {
            CompanionRepository::load_projection_updates(
                connection,
                projection_generation,
                from_sequence,
                &session.grants,
                limit,
            )?
        };
        for update in &mut updates {
            update.generation = generation;
        }
        let next_snapshot = (snapshot && has_more).then_some(SnapshotPageCursor {
            base_sequence: snapshot_base,
        });
        Ok(SyncBatch {
            phase: SyncPhase::Reconciling,
            generation,
            from_sequence,
            cursor: if snapshot && !has_more {
                snapshot_base
            } else {
                scan_cursor.min(latest_sequence)
            },
            latest_sequence,
            is_snapshot: snapshot,
            has_more,
            next_snapshot,
            updates,
        })
    }

    pub fn confirm_reconciled(
        &self,
        connection: &mut Connection,
        credential: &SessionCredential,
        cursor: ReconnectCursor,
        now: i64,
    ) -> Result<SyncBatch, String> {
        let _session = CompanionRepository::authenticate(connection, credential, now)?;
        let (projection_generation, latest_sequence, authorization_epoch) =
            CompanionRepository::projection_position(connection)?;
        let generation = authorized_generation(projection_generation, authorization_epoch)?;
        if cursor.generation != generation
            || cursor.sequence != latest_sequence
            || cursor.snapshot.is_some()
        {
            return Err(
                "Companion reconciliation is incomplete; request the remaining host updates."
                    .to_owned(),
            );
        }
        Ok(SyncBatch {
            phase: SyncPhase::Live,
            generation,
            from_sequence: cursor.sequence,
            cursor: cursor.sequence,
            latest_sequence,
            is_snapshot: false,
            has_more: false,
            next_snapshot: None,
            updates: Vec::new(),
        })
    }

    pub fn execute_command(
        &self,
        connection: &mut Connection,
        credential: &SessionCredential,
        envelope: CommandEnvelope,
        now: i64,
        host: &impl CompanionCommandHost,
    ) -> Result<CommandResult, String> {
        validate_command_envelope_shape(&envelope)?;
        if credential.session_id != envelope.session_id
            || credential.device_id != envelope.device_id
            || credential.generation != envelope.session_generation
        {
            return Err(
                "The Companion command identity does not match the session credential.".to_owned(),
            );
        }
        let _session = CompanionRepository::authenticate(connection, credential, now)?;
        let fingerprint = command_fingerprint(&envelope)?;
        if let Some(result) =
            CompanionRepository::existing_command(connection, &envelope, &fingerprint)?
        {
            return Ok(result);
        }
        validate_command_audit_timestamp(&envelope, now)?;

        if envelope.capability.is_forbidden() {
            return self.record_refusal(
                connection,
                &envelope,
                &fingerprint,
                "forbidden_capability",
                "The primary host does not permit this capability through Companion access.",
                now,
            );
        }
        if envelope.capability.expected_target() != Some(envelope.target.kind) {
            return self.record_refusal(
                connection,
                &envelope,
                &fingerprint,
                "invalid_target_scope",
                "The Companion command target is outside the capability's bounded scope.",
                now,
            );
        }
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Could not start the atomic Companion command: {error}"))?;
        let session = CompanionRepository::authenticate(&transaction, credential, now)?;
        match CompanionRepository::reserve_command(&transaction, &envelope, &fingerprint, now)? {
            CommandReservation::Existing(result) => return Ok(result),
            CommandReservation::Reserved => {}
        }
        if !session
            .grants
            .iter()
            .any(|grant| grant.allows_command(envelope.capability))
        {
            let result = self.finish_reserved_refusal(
                &transaction,
                &envelope,
                HostCommandRefusal {
                    code: "grant_denied".to_owned(),
                    message: "The current Companion session grants do not authorize this command."
                        .to_owned(),
                    definitive: true,
                },
                now,
            )?;
            transaction.commit().map_err(|error| {
                format!("Could not commit the Companion grant refusal: {error}")
            })?;
            return Ok(result);
        }
        let authorization = match host.reauthorize(&transaction, &session, &envelope) {
            Ok(authorization) => authorization,
            Err(refusal) => {
                let result = self.finish_reserved_refusal(&transaction, &envelope, refusal, now)?;
                transaction.commit().map_err(|error| {
                    format!("Could not commit the Companion authorization refusal: {error}")
                })?;
                return Ok(result);
            }
        };
        if authorization.current_version != envelope.expected_version {
            let result = self.finish_reserved_refusal(
                &transaction,
                &envelope,
                HostCommandRefusal {
                    code: "version_conflict".to_owned(),
                    message: format!(
                        "The target changed from expected version {} to version {}.",
                        envelope.expected_version, authorization.current_version
                    ),
                    definitive: true,
                },
                now,
            )?;
            transaction.commit().map_err(|error| {
                format!("Could not commit the Companion version refusal: {error}")
            })?;
            return Ok(result);
        }
        if requires_runtime_outbox(envelope.capability) {
            CompanionRepository::enqueue_runtime_effect(&transaction, &envelope, now)?;
            transaction.commit().map_err(|error| {
                format!("Could not commit the pending Companion runtime command: {error}")
            })?;
            return Ok(CommandResult {
                command_id: envelope.command_id,
                state: CommandState::PendingHostAcknowledgement,
                acknowledgement: None,
                refusal_code: None,
                message: Some(
                    "The primary host is executing this durable Companion runtime command."
                        .to_owned(),
                ),
            });
        }
        let acknowledgement = match host.execute(&transaction, &session, &envelope, &authorization)
        {
            Ok(acknowledgement) => acknowledgement,
            Err(refusal) if refusal.definitive => {
                let result = self.finish_reserved_refusal(&transaction, &envelope, refusal, now)?;
                transaction.commit().map_err(|error| {
                    format!("Could not commit the Companion execution refusal: {error}")
                })?;
                return Ok(result);
            }
            Err(refusal) => return Err(refusal.message),
        };
        let result = CompanionRepository::complete_command(
            &transaction,
            &envelope.command_id,
            &acknowledgement,
            now,
        )?;
        self.append_audit(
            &transaction,
            &envelope,
            "acknowledged",
            "The primary host reauthorized and acknowledged the Companion command.",
            now,
        )?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit the atomic Companion command: {error}"))?;
        Ok(result)
    }

    fn record_refusal(
        &self,
        connection: &mut Connection,
        envelope: &CommandEnvelope,
        fingerprint: &str,
        code: &str,
        message: &str,
        now: i64,
    ) -> Result<CommandResult, String> {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Could not start the Companion refusal record: {error}"))?;
        let result = CompanionRepository::refuse_command(
            &transaction,
            envelope,
            fingerprint,
            code,
            message,
            now,
        )?;
        if result.state == CommandState::Refused {
            self.append_audit(&transaction, envelope, "refused", message, now)?;
        }
        transaction
            .commit()
            .map_err(|error| format!("Could not commit the Companion refusal: {error}"))?;
        Ok(result)
    }

    fn finish_reserved_refusal(
        &self,
        connection: &Connection,
        envelope: &CommandEnvelope,
        refusal: HostCommandRefusal,
        now: i64,
    ) -> Result<CommandResult, String> {
        if !refusal.definitive {
            return Err(refusal.message);
        }
        let result = CompanionRepository::refuse_reserved_command(
            connection,
            &envelope.command_id,
            &refusal.code,
            &refusal.message,
            now,
        )?;
        self.append_audit(connection, envelope, "refused", &refusal.message, now)?;
        Ok(result)
    }

    fn append_audit(
        &self,
        connection: &Connection,
        envelope: &CommandEnvelope,
        decision: &str,
        reason: &str,
        now: i64,
    ) -> Result<(), String> {
        CompanionRepository::append_audit(
            connection,
            &CompanionAuditRecord {
                id: new_id(),
                command_id: Some(envelope.command_id.clone()),
                session_id: Some(envelope.session_id.clone()),
                device_id: envelope.device_id.clone(),
                capability: envelope.capability,
                target: envelope.target.clone(),
                decision: decision.to_owned(),
                reason: reason.to_owned(),
                created_at: now,
            },
        )
    }
}

fn validate_command_envelope_shape(envelope: &CommandEnvelope) -> Result<(), String> {
    validate_required(
        "Companion command session id",
        &envelope.session_id,
        MAX_ID_BYTES,
    )?;
    validate_required(
        "Companion command device id",
        &envelope.device_id,
        MAX_DEVICE_ID_BYTES,
    )?;
    validate_required("Companion command id", &envelope.command_id, MAX_ID_BYTES)?;
    validate_required(
        "Companion command idempotency key",
        &envelope.idempotency_key,
        MAX_ID_BYTES,
    )?;
    validate_required(
        "Companion command target id",
        &envelope.target.id,
        MAX_ID_BYTES,
    )?;
    if envelope.target.kind == super::models::TargetKind::Task {
        validate_required(
            "Companion command target project id",
            envelope.target.project_id.as_deref().unwrap_or_default(),
            MAX_ID_BYTES,
        )?;
    }
    if envelope.expected_version < 0 {
        return Err("Companion expected entity versions cannot be negative.".to_owned());
    }
    let payload_bytes = serde_json::to_vec(&envelope.payload)
        .map_err(|error| format!("Could not encode the Companion command payload: {error}"))?
        .len();
    if payload_bytes > MAX_COMMAND_PAYLOAD_BYTES {
        return Err(format!(
            "Companion command payloads cannot exceed {MAX_COMMAND_PAYLOAD_BYTES} bytes."
        ));
    }
    Ok(())
}

fn validate_command_audit_timestamp(envelope: &CommandEnvelope, now: i64) -> Result<(), String> {
    if envelope.audit_timestamp.abs_diff(now) > MAX_CLOCK_SKEW_MILLIS as u64 {
        return Err(
            "The Companion command audit timestamp is outside the accepted window.".to_owned(),
        );
    }
    Ok(())
}

fn requires_runtime_outbox(capability: super::models::CommandCapability) -> bool {
    use super::models::CommandCapability;
    matches!(
        capability,
        CommandCapability::ResolveApproval
            | CommandCapability::ResolveQuestion
            | CommandCapability::ResolveMcpElicitation
            | CommandCapability::StopRun
            | CommandCapability::RetryRun
            | CommandCapability::SendFollowUp
    )
}

fn authorized_generation(
    projection_generation: i64,
    authorization_epoch: i64,
) -> Result<i64, String> {
    projection_generation
        .checked_mul(1_i64 << 32)
        .and_then(|generation| generation.checked_add(authorization_epoch))
        .ok_or_else(|| {
            "The Companion authorization generation is outside the supported range.".to_owned()
        })
}

fn validate_required(label: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label} is required."));
    }
    if value.len() > max_bytes {
        return Err(format!("{label} cannot exceed {max_bytes} bytes."));
    }
    Ok(())
}

fn canonical_grants(grants: Vec<CompanionGrant>) -> Vec<CompanionGrant> {
    let unique: HashSet<_> = grants.into_iter().collect();
    let mut grants: Vec<_> = unique.into_iter().collect();
    grants.sort_by_key(|grant| *grant as u8);
    grants
}

fn new_id() -> String {
    Uuid::now_v7().to_string()
}

fn new_secret() -> String {
    format!("{}.{}", Uuid::now_v7(), Uuid::now_v7())
}
