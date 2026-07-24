#![expect(
    dead_code,
    reason = "M5 verification lifecycle is wired by the run service"
)]

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde_json::json;

use crate::runs::models::{AgentOutcome, RunStatus, VerificationOutcome};
use crate::runs::repository::{
    append_event, bounded_diagnostic, execution_roots_overlap, load_run, new_uuid_v7, now_millis,
    RunMutation, ACTIVE_STATUSES_SQL,
};
use crate::runs::RUN_CONCURRENCY_LIMIT;
use crate::xiao::repository::{task_execution_binding_matches, XiaoRepository};

use super::models::{
    AcceptanceContractSnapshot, ArtifactRecord, ArtifactRetentionClass, EvidenceRecord,
    EvidenceRedactionState, GateResultRecord, VerificationArtifactSummary,
    VerificationAttemptEvidence, VerificationAttemptRecord, VerificationAttemptStatus,
    VerificationAttemptTrigger, VerificationBaselineState, VerificationEvidenceItem,
    VerificationEvidencePage, VerificationGateEvidence, VerificationGateOutcome,
    VerificationGateType,
};

const MAX_VERIFICATION_ID_BYTES: usize = 512;
const MAX_EVIDENCE_TYPE_BYTES: usize = 128;
const MAX_MEDIA_TYPE_BYTES: usize = 256;
const MAX_RELATIVE_ARTIFACT_PATH_BYTES: usize = 4 * 1024;
const MAX_VERIFICATION_ATTEMPTS_PER_RUN: i64 = 20;
const MAX_EVIDENCE_SUMMARY_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct VerificationAttemptStart {
    pub mutation: RunMutation,
    pub attempt: VerificationAttemptRecord,
    pub created: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct PersistedGateResult {
    pub mutation: RunMutation,
    pub gate_result: GateResultRecord,
    pub artifact: ArtifactRecord,
    pub evidence: EvidenceRecord,
}

#[derive(Debug, Clone)]
pub(crate) struct VerificationSettlement {
    pub mutation: RunMutation,
    pub attempt: VerificationAttemptRecord,
}

#[derive(Debug, Clone)]
pub(crate) struct VerificationCancellationSettlement {
    pub attempt_id: String,
    pub status: VerificationAttemptStatus,
}

impl XiaoRepository {
    pub(crate) fn persist_verification_baseline(
        &self,
        run_id: &str,
        artifact: &ArtifactRecord,
    ) -> Result<RunMutation, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| {
                    format!("Could not start verification baseline persistence: {error}")
                })?;
            let current = load_run(&transaction, run_id)?;
            if current.verification_baseline_state == VerificationBaselineState::Ready {
                transaction.commit().map_err(|error| {
                    format!("Could not finish idempotent baseline persistence: {error}")
                })?;
                return Ok(RunMutation {
                    run: current,
                    event: None,
                });
            }
            if current.status != RunStatus::Preparing
                || current.verification_baseline_state != VerificationBaselineState::Pending
                || current
                    .acceptance_contract_snapshot
                    .as_ref()
                    .is_none_or(|snapshot| !snapshot.requires_diff_baseline())
            {
                return Err("The Xiao run is not waiting for a verification baseline.".to_owned());
            }
            if artifact.run_id != run_id
                || artifact.verification_attempt_id.is_some()
                || artifact.retention_class != ArtifactRetentionClass::VerificationBaseline
            {
                return Err("The verification baseline artifact binding is invalid.".to_owned());
            }
            validate_artifact(artifact)?;
            insert_artifact(&transaction, artifact)?;
            let changed = transaction
                .execute(
                    r#"UPDATE runs SET verification_baseline_state = 'ready',
                        verification_baseline_artifact_id = ?1,
                        verification_baseline_diagnostic = NULL, version = version + 1
                     WHERE id = ?2 AND version = ?3 AND status = 'preparing'
                       AND verification_baseline_state = 'pending'"#,
                    params![artifact.id, run_id, current.version],
                )
                .map_err(|error| {
                    format!("Could not attach verification baseline artifact: {error}")
                })?;
            if changed != 1 {
                return Err("The Xiao run changed during baseline persistence.".to_owned());
            }
            let event = append_event(
                &transaction,
                run_id,
                "verification.baseline_ready",
                Some("verification:baseline:ready"),
                &json!({ "artifactId": artifact.id }),
            )?;
            let run = load_run(&transaction, run_id)?;
            transaction.commit().map_err(|error| {
                format!("Could not commit verification baseline persistence: {error}")
            })?;
            Ok(RunMutation {
                run,
                event: Some(event),
            })
        })
    }

    pub(crate) fn mark_verification_baseline_unavailable(
        &self,
        run_id: &str,
        diagnostic: &str,
    ) -> Result<RunMutation, String> {
        let diagnostic = bounded_diagnostic(diagnostic);
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| {
                    format!("Could not start unavailable baseline persistence: {error}")
                })?;
            let current = load_run(&transaction, run_id)?;
            if current.verification_baseline_state == VerificationBaselineState::Unavailable {
                transaction.commit().map_err(|error| {
                    format!("Could not finish duplicate unavailable baseline: {error}")
                })?;
                return Ok(RunMutation {
                    run: current,
                    event: None,
                });
            }
            if current.status != RunStatus::Preparing
                || current.verification_baseline_state != VerificationBaselineState::Pending
            {
                return Err("The Xiao run is not waiting for a verification baseline.".to_owned());
            }
            let changed = transaction
                .execute(
                    r#"UPDATE runs SET verification_baseline_state = 'unavailable',
                        verification_baseline_artifact_id = NULL,
                        verification_baseline_diagnostic = ?1, version = version + 1
                     WHERE id = ?2 AND version = ?3 AND status = 'preparing'
                       AND verification_baseline_state = 'pending'"#,
                    params![diagnostic, run_id, current.version],
                )
                .map_err(|error| {
                    format!("Could not persist unavailable verification baseline: {error}")
                })?;
            if changed != 1 {
                return Err("The Xiao run changed during baseline failure persistence.".to_owned());
            }
            let event = append_event(
                &transaction,
                run_id,
                "verification.baseline_unavailable",
                Some("verification:baseline:unavailable"),
                &json!({ "diagnostic": diagnostic }),
            )?;
            let run = load_run(&transaction, run_id)?;
            transaction.commit().map_err(|error| {
                format!("Could not commit unavailable verification baseline: {error}")
            })?;
            Ok(RunMutation {
                run,
                event: Some(event),
            })
        })
    }

    pub(crate) fn load_verification_baseline_artifact(
        &self,
        run_id: &str,
    ) -> Result<Option<ArtifactRecord>, String> {
        self.with_connection(|connection| {
            let artifact_id = connection
                .query_row(
                    r#"SELECT verification_baseline_artifact_id FROM runs WHERE id = ?1"#,
                    [run_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|error| format!("Could not load baseline artifact binding: {error}"))?
                .ok_or("The Xiao run was not found.")?;
            artifact_id
                .as_deref()
                .map(|artifact_id| load_artifact(connection, artifact_id))
                .transpose()
        })
    }

    pub(crate) fn begin_verification_attempt(
        &self,
        run_id: &str,
        request_key: &str,
        trigger: VerificationAttemptTrigger,
    ) -> Result<VerificationAttemptStart, String> {
        validate_identity(request_key, "verification request key")?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start verification attempt: {error}"))?;
            if let Some(existing) = load_attempt_by_request_key(&transaction, run_id, request_key)?
            {
                let run = load_run(&transaction, run_id)?;
                transaction.commit().map_err(|error| {
                    format!("Could not finish idempotent verification request: {error}")
                })?;
                return Ok(VerificationAttemptStart {
                    mutation: RunMutation { run, event: None },
                    attempt: existing,
                    created: false,
                });
            }

            let current = load_run(&transaction, run_id)?;
            if current.cancel_requested {
                return Err("The Xiao run has a pending cancellation intent.".to_owned());
            }
            let allowed = match trigger {
                VerificationAttemptTrigger::Initial => current.status == RunStatus::Verifying,
                VerificationAttemptTrigger::Rerun => {
                    matches!(
                        current.status,
                        RunStatus::NeedsAttention | RunStatus::Interrupted
                    ) && current.agent_outcome == AgentOutcome::Completed
                }
            };
            if !allowed {
                return Err("The Xiao run cannot start this verification attempt.".to_owned());
            }
            if trigger == VerificationAttemptTrigger::Rerun {
                let binding_matches = task_execution_binding_matches(
                    &transaction,
                    current.workspace_id,
                    &current.task_id,
                    &current.execution_environment_id,
                    current.managed_worktree_id.as_deref(),
                )?
                .unwrap_or(false);
                if !binding_matches {
                    return Err(
                        "The Xiao verification execution binding is no longer available."
                            .to_owned(),
                    );
                }
                let active_count: i64 = transaction
                    .query_row(
                        &format!(
                            "SELECT COUNT(*) FROM runs WHERE status IN ({ACTIVE_STATUSES_SQL})"
                        ),
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| {
                        format!("Could not inspect Xiao verification capacity: {error}")
                    })?;
                if active_count >= i64::try_from(RUN_CONCURRENCY_LIMIT).unwrap_or(i64::MAX) {
                    return Err("Xiao verification is waiting for global run capacity.".to_owned());
                }
                let active_roots = {
                    let mut statement = transaction
                        .prepare(&format!(
                            r#"SELECT execution_root FROM runs
                               WHERE id != ?1 AND status IN ({ACTIVE_STATUSES_SQL})"#
                        ))
                        .map_err(|error| {
                            format!("Could not prepare active Xiao execution roots: {error}")
                        })?;
                    let rows = statement
                        .query_map([run_id], |row| row.get::<_, String>(0))
                        .map_err(|error| {
                            format!("Could not query active Xiao execution roots: {error}")
                        })?;
                    rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
                        format!("Could not decode active Xiao execution roots: {error}")
                    })?
                };
                let overlapping_run = active_roots.iter().any(|active_root| {
                    execution_roots_overlap(active_root, &current.execution_root)
                });
                if overlapping_run {
                    return Err(
                        "Another active Xiao run already owns this execution root.".to_owned()
                    );
                }
            }
            let snapshot = current
                .acceptance_contract_snapshot
                .clone()
                .ok_or("The Xiao run has no acceptance contract snapshot.")?;
            let expected_hash = current
                .acceptance_contract_snapshot_sha256
                .as_deref()
                .ok_or("The Xiao run acceptance contract hash is missing.")?;
            let normalized = snapshot.validate_canonical()?;
            if normalized.content_sha256 != expected_hash {
                return Err("The Xiao run acceptance contract hash does not match.".to_owned());
            }
            let running_attempt = transaction
                .query_row(
                    r#"SELECT 1 FROM verification_attempts
                       WHERE run_id = ?1 AND status = 'running'"#,
                    [run_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|error| format!("Could not inspect running verification: {error}"))?
                .is_some();
            if running_attempt {
                return Err("The Xiao run already has a running verification attempt.".to_owned());
            }
            let attempt_count: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM verification_attempts WHERE run_id = ?1",
                    [run_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not count verification attempts: {error}"))?;
            if attempt_count >= MAX_VERIFICATION_ATTEMPTS_PER_RUN {
                return Err(format!(
                    "This Xiao run reached the bounded history limit of \
                     {MAX_VERIFICATION_ATTEMPTS_PER_RUN} verification attempts."
                ));
            }
            let attempt_number: i64 = transaction
                .query_row(
                    r#"SELECT COALESCE(MAX(attempt_number), 0) + 1
                       FROM verification_attempts WHERE run_id = ?1"#,
                    [run_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not allocate verification attempt: {error}"))?;
            let attempt_id = new_uuid_v7();
            let timestamp = now_millis()?;
            transaction
                .execute(
                    r#"INSERT INTO verification_attempts(
                        id, run_id, request_key, attempt_number, trigger,
                        contract_snapshot_json, contract_snapshot_sha256,
                        expected_gate_count, status, diagnostic, started_at,
                        finished_at, updated_at, version
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                        'running', NULL, ?9, NULL, ?9, 0)"#,
                    params![
                        attempt_id,
                        run_id,
                        request_key,
                        attempt_number,
                        trigger.as_database(),
                        normalized.canonical_json,
                        normalized.content_sha256,
                        i64::try_from(snapshot.gates.len()).unwrap_or(i64::MAX),
                        timestamp,
                    ],
                )
                .map_err(|error| format!("Could not create verification attempt: {error}"))?;
            let changed = transaction
                .execute(
                    r#"UPDATE runs SET status = 'verifying', agent_outcome = 'completed',
                        verification_outcome = 'pending', latest_verification_attempt_id = ?1,
                        finished_at = NULL, version = version + 1
                     WHERE id = ?2 AND version = ?3 AND cancel_requested = 0"#,
                    params![attempt_id, run_id, current.version],
                )
                .map_err(|error| format!("Could not bind verification attempt: {error}"))?;
            if changed != 1 {
                return Err("The Xiao run changed while verification started.".to_owned());
            }
            let event = append_event(
                &transaction,
                run_id,
                "verification.started",
                Some(&format!("verification:{attempt_id}:started")),
                &json!({
                    "attemptId": attempt_id,
                    "attemptNumber": attempt_number,
                    "trigger": trigger,
                    "gateCount": snapshot.gates.len(),
                }),
            )?;
            let run = load_run(&transaction, run_id)?;
            let attempt = load_attempt(&transaction, &attempt_id)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit verification attempt: {error}"))?;
            Ok(VerificationAttemptStart {
                mutation: RunMutation {
                    run,
                    event: Some(event),
                },
                attempt,
                created: true,
            })
        })
    }

    pub(crate) fn persist_verification_gate(
        &self,
        gate_result: &GateResultRecord,
        artifact: &ArtifactRecord,
        evidence: &EvidenceRecord,
    ) -> Result<PersistedGateResult, String> {
        validate_gate_result(gate_result)?;
        validate_artifact(artifact)?;
        validate_evidence(evidence)?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start gate-result persistence: {error}"))?;
            let attempt = load_attempt(&transaction, &gate_result.verification_attempt_id)?;
            if attempt.status != VerificationAttemptStatus::Running {
                return Err("The verification attempt is no longer running.".to_owned());
            }
            let expected_gate = attempt
                .contract_snapshot
                .gates
                .get(gate_result.gate_index)
                .ok_or("The verification gate index is outside the contract.")?;
            if expected_gate.gate_type() != gate_result.gate_type {
                return Err("The verification gate type does not match the contract.".to_owned());
            }
            if artifact.run_id != attempt.run_id
                || artifact.verification_attempt_id.as_deref() != Some(attempt.id.as_str())
                || artifact.retention_class != ArtifactRetentionClass::RunEvidence
                || evidence.run_id != attempt.run_id
                || evidence.verification_attempt_id.as_deref() != Some(attempt.id.as_str())
                || evidence.gate_result_id.as_deref() != Some(gate_result.id.as_str())
                || evidence.artifact_id.as_deref() != Some(artifact.id.as_str())
            {
                return Err("The verification gate evidence binding is invalid.".to_owned());
            }
            insert_artifact(&transaction, artifact)?;
            transaction
                .execute(
                    r#"INSERT INTO gate_results(
                        id, verification_attempt_id, gate_index, gate_type, outcome,
                        duration_ms, exit_code, diagnostic, started_at, finished_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
                    params![
                        gate_result.id,
                        gate_result.verification_attempt_id,
                        i64::try_from(gate_result.gate_index).unwrap_or(i64::MAX),
                        gate_result.gate_type.as_database(),
                        gate_result.outcome.as_database(),
                        i64::try_from(gate_result.duration_ms).unwrap_or(i64::MAX),
                        gate_result.exit_code,
                        gate_result.diagnostic.as_deref().map(bounded_diagnostic),
                        gate_result.started_at,
                        gate_result.finished_at,
                    ],
                )
                .map_err(|error| format!("Could not persist verification gate result: {error}"))?;
            transaction
                .execute(
                    r#"INSERT INTO evidence(
                        id, run_id, verification_attempt_id, gate_result_id,
                        evidence_type, summary_json, artifact_id, redaction_state, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
                    params![
                        evidence.id,
                        evidence.run_id,
                        evidence.verification_attempt_id,
                        evidence.gate_result_id,
                        evidence.evidence_type,
                        serde_json::to_string(&evidence.summary).map_err(|error| format!(
                            "Could not encode evidence summary: {error}"
                        ))?,
                        evidence.artifact_id,
                        evidence.redaction_state.as_database(),
                        evidence.created_at,
                    ],
                )
                .map_err(|error| format!("Could not persist verification evidence: {error}"))?;
            let event = append_event(
                &transaction,
                &attempt.run_id,
                "verification.gate_finished",
                Some(&format!(
                    "verification:{}:gate:{}",
                    attempt.id, gate_result.gate_index
                )),
                &json!({
                    "attemptId": attempt.id,
                    "gateResultId": gate_result.id,
                    "gateIndex": gate_result.gate_index,
                    "gateType": gate_result.gate_type,
                    "outcome": gate_result.outcome,
                    "durationMs": gate_result.duration_ms,
                    "artifactId": artifact.id,
                }),
            )?;
            let run = load_run(&transaction, &attempt.run_id)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit verification gate result: {error}"))?;
            Ok(PersistedGateResult {
                mutation: RunMutation {
                    run,
                    event: Some(event),
                },
                gate_result: gate_result.clone(),
                artifact: artifact.clone(),
                evidence: evidence.clone(),
            })
        })
    }

    pub(crate) fn settle_verification_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<VerificationSettlement, String> {
        self.settle_verification_attempt_inner(attempt_id, false)
    }

    #[cfg(test)]
    pub(crate) fn settle_verification_attempt_with_failpoint(
        &self,
        attempt_id: &str,
    ) -> Result<VerificationSettlement, String> {
        self.settle_verification_attempt_inner(attempt_id, true)
    }

    fn settle_verification_attempt_inner(
        &self,
        attempt_id: &str,
        fail_before_commit: bool,
    ) -> Result<VerificationSettlement, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start verification settlement: {error}"))?;
            let attempt = load_attempt(&transaction, attempt_id)?;
            if attempt.status != VerificationAttemptStatus::Running {
                let run = load_run(&transaction, &attempt.run_id)?;
                transaction.commit().map_err(|error| {
                    format!("Could not finish idempotent verification settlement: {error}")
                })?;
                return Ok(VerificationSettlement {
                    mutation: RunMutation { run, event: None },
                    attempt,
                });
            }
            let current = load_run(&transaction, &attempt.run_id)?;
            if current.status != RunStatus::Verifying
                || current.latest_verification_attempt_id.as_deref() != Some(attempt_id)
            {
                return Err("The Xiao run no longer matches its verification attempt.".to_owned());
            }
            if current.acceptance_contract_snapshot != Some(attempt.contract_snapshot.clone())
                || current.acceptance_contract_snapshot_sha256.as_deref()
                    != Some(attempt.contract_snapshot_sha256.as_str())
            {
                return Err(
                    "The verification attempt contract no longer matches the run.".to_owned(),
                );
            }
            if current.cancel_requested {
                transaction.commit().map_err(|error| {
                    format!("Could not defer verification settlement for cancellation: {error}")
                })?;
                return Ok(VerificationSettlement {
                    mutation: RunMutation {
                        run: current,
                        event: None,
                    },
                    attempt,
                });
            }
            let outcomes = load_gate_outcomes(&transaction, attempt_id)?;
            let cancelled =
                current.cancel_requested || outcomes.contains(&VerificationGateOutcome::Cancelled);
            let complete = outcomes.len() == attempt.expected_gate_count;
            let (status, diagnostic) = if outcomes.contains(&VerificationGateOutcome::Failed) {
                (
                    VerificationAttemptStatus::Failed,
                    Some("One or more verification gates failed.".to_owned()),
                )
            } else if cancelled {
                (
                    VerificationAttemptStatus::Cancelled,
                    Some("Verification was cancelled.".to_owned()),
                )
            } else if outcomes.contains(&VerificationGateOutcome::Blocked) {
                (
                    VerificationAttemptStatus::Blocked,
                    Some("One or more verification gates were blocked.".to_owned()),
                )
            } else if complete
                && outcomes
                    .iter()
                    .all(|outcome| *outcome == VerificationGateOutcome::Passed)
            {
                (VerificationAttemptStatus::Passed, None)
            } else {
                (
                    VerificationAttemptStatus::Blocked,
                    Some(format!(
                        "Verification persisted {} of {} expected gate results.",
                        outcomes.len(),
                        attempt.expected_gate_count
                    )),
                )
            };
            if status == VerificationAttemptStatus::Passed
                && (!complete
                    || outcomes
                        .iter()
                        .any(|outcome| *outcome != VerificationGateOutcome::Passed))
            {
                return Err("Incomplete verification cannot settle as passed.".to_owned());
            }
            let timestamp = now_millis()?;
            let changed = transaction
                .execute(
                    r#"UPDATE verification_attempts SET status = ?1, diagnostic = ?2,
                        finished_at = ?3, updated_at = ?3, version = version + 1
                     WHERE id = ?4 AND version = ?5 AND status = 'running'"#,
                    params![
                        status.as_database(),
                        diagnostic,
                        timestamp,
                        attempt_id,
                        attempt.version,
                    ],
                )
                .map_err(|error| format!("Could not settle verification attempt: {error}"))?;
            if changed != 1 {
                return Err("The verification attempt changed during settlement.".to_owned());
            }
            let (run_status, verification_outcome, event_type) = match status {
                VerificationAttemptStatus::Passed => (
                    RunStatus::Completed,
                    VerificationOutcome::Passed,
                    "verification.passed",
                ),
                VerificationAttemptStatus::Failed => (
                    RunStatus::NeedsAttention,
                    VerificationOutcome::Failed,
                    "verification.failed",
                ),
                VerificationAttemptStatus::Blocked => (
                    RunStatus::NeedsAttention,
                    VerificationOutcome::Blocked,
                    "verification.blocked",
                ),
                VerificationAttemptStatus::Cancelled => (
                    RunStatus::NeedsAttention,
                    VerificationOutcome::Blocked,
                    "verification.cancelled",
                ),
                VerificationAttemptStatus::Running | VerificationAttemptStatus::Interrupted => {
                    return Err("Verification settled to an invalid terminal status.".to_owned());
                }
            };
            let run_changed = transaction
                .execute(
                    r#"UPDATE runs SET status = ?1, agent_outcome = 'completed',
                        verification_outcome = ?2, cancel_requested = 0,
                        finished_at = ?3, version = version + 1
                     WHERE id = ?4 AND version = ?5 AND status = 'verifying'
                       AND latest_verification_attempt_id = ?6"#,
                    params![
                        run_status.as_database(),
                        verification_outcome.as_database(),
                        timestamp,
                        current.id,
                        current.version,
                        attempt_id,
                    ],
                )
                .map_err(|error| format!("Could not settle verified Xiao run: {error}"))?;
            if run_changed != 1 {
                return Err("The Xiao run changed during verification settlement.".to_owned());
            }
            let event = append_event(
                &transaction,
                &current.id,
                event_type,
                Some(&format!("verification:{attempt_id}:settled")),
                &json!({
                    "attemptId": attempt_id,
                    "attemptNumber": attempt.attempt_number,
                    "status": status,
                    "gateCount": outcomes.len(),
                }),
            )?;
            if status == VerificationAttemptStatus::Passed {
                crate::xiao::supervision::advance_task_after_verification(
                    &transaction,
                    &current,
                    attempt_id,
                    timestamp,
                )?;
            }
            let run = load_run(&transaction, &current.id)?;
            let attempt = load_attempt(&transaction, attempt_id)?;
            if fail_before_commit {
                return Err("Injected failure before verification settlement commit.".to_owned());
            }
            transaction
                .commit()
                .map_err(|error| format!("Could not commit verification settlement: {error}"))?;
            Ok(VerificationSettlement {
                mutation: RunMutation {
                    run,
                    event: Some(event),
                },
                attempt,
            })
        })
    }

    pub fn list_verification_evidence(
        &self,
        run_id: &str,
        limit: Option<usize>,
    ) -> Result<VerificationEvidencePage, String> {
        let limit = limit.unwrap_or(10).clamp(1, 20);
        self.with_connection(|connection| {
            load_run(connection, run_id)?;
            let mut stored = {
                let mut statement = connection
                    .prepare(
                        r#"SELECT id, run_id, request_key, attempt_number, trigger,
                            contract_snapshot_json, contract_snapshot_sha256,
                            expected_gate_count, status, diagnostic, started_at,
                            finished_at, updated_at, version
                         FROM verification_attempts
                         WHERE run_id = ?1
                         ORDER BY attempt_number DESC
                         LIMIT ?2"#,
                    )
                    .map_err(|error| {
                        format!("Could not prepare verification evidence history: {error}")
                    })?;
                let query_limit = limit.saturating_add(1);
                let rows = statement
                    .query_map(
                        params![run_id, i64::try_from(query_limit).unwrap_or(21)],
                        attempt_from_row,
                    )
                    .map_err(|error| {
                        format!("Could not query verification evidence history: {error}")
                    })?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
                    format!("Could not decode verification evidence history: {error}")
                })?
            };
            let has_more = stored.len() > limit;
            stored.truncate(limit);
            let attempts = stored
                .into_iter()
                .map(|stored| {
                    let attempt = stored.decode()?;
                    let gate_results = load_gate_results(connection, &attempt.id)?;
                    let gates = gate_results
                        .into_iter()
                        .map(|result| {
                            Ok(VerificationGateEvidence {
                                evidence: load_evidence_items(connection, &result.id)?,
                                result,
                            })
                        })
                        .collect::<Result<Vec<_>, String>>()?;
                    Ok(VerificationAttemptEvidence { attempt, gates })
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(VerificationEvidencePage { attempts, has_more })
        })
    }

    pub(crate) fn load_verification_artifact_record(
        &self,
        run_id: &str,
        artifact_id: &str,
    ) -> Result<ArtifactRecord, String> {
        self.with_connection(|connection| {
            load_run(connection, run_id)?;
            let artifact = load_artifact(connection, artifact_id)?;
            if artifact.run_id != run_id
                || artifact.retention_class != ArtifactRetentionClass::RunEvidence
            {
                return Err("The verification artifact does not belong to this run.".to_owned());
            }
            Ok(artifact)
        })
    }
}

pub(crate) fn cancel_running_verification_attempt_in_transaction(
    transaction: &Transaction<'_>,
    run_id: &str,
    timestamp: i64,
) -> Result<Option<VerificationCancellationSettlement>, String> {
    let running = transaction
        .query_row(
            r#"SELECT va.id, EXISTS(
                    SELECT 1 FROM gate_results gr
                    WHERE gr.verification_attempt_id = va.id AND gr.outcome = 'failed'
                )
               FROM verification_attempts va
               WHERE va.run_id = ?1 AND va.status = 'running'"#,
            [run_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Could not inspect verification cancellation: {error}"))?;
    let Some((attempt_id, has_failed_gate)) = running else {
        return Ok(None);
    };
    let (status, diagnostic) = if has_failed_gate {
        (
            VerificationAttemptStatus::Failed,
            "One or more verification gates failed.",
        )
    } else {
        (
            VerificationAttemptStatus::Cancelled,
            "Verification was cancelled.",
        )
    };
    let changed = transaction
        .execute(
            r#"UPDATE verification_attempts SET status = ?1, diagnostic = ?2,
                finished_at = ?3, updated_at = ?3, version = version + 1
             WHERE id = ?4 AND status = 'running'"#,
            params![status.as_database(), diagnostic, timestamp, attempt_id],
        )
        .map_err(|error| format!("Could not cancel verification attempt: {error}"))?;
    if changed != 1 {
        return Err("The verification attempt changed during cancellation.".to_owned());
    }
    Ok(Some(VerificationCancellationSettlement {
        attempt_id,
        status,
    }))
}

pub(crate) fn interrupt_running_verification_attempts_in_transaction(
    transaction: &Transaction<'_>,
    timestamp: i64,
) -> Result<(), String> {
    transaction
        .execute(
            r#"UPDATE verification_attempts
               SET status = CASE WHEN EXISTS(
                       SELECT 1 FROM gate_results gr
                       WHERE gr.verification_attempt_id = verification_attempts.id
                         AND gr.outcome = 'failed'
                   ) THEN 'failed' ELSE 'interrupted' END,
                   diagnostic = CASE WHEN EXISTS(
                       SELECT 1 FROM gate_results gr
                       WHERE gr.verification_attempt_id = verification_attempts.id
                         AND gr.outcome = 'failed'
                   ) THEN 'One or more verification gates failed.'
                   ELSE 'Verification was interrupted by process restart.' END,
                   finished_at = ?1, updated_at = ?1, version = version + 1
               WHERE status = 'running'"#,
            [timestamp],
        )
        .map_err(|error| format!("Could not interrupt stale verification attempts: {error}"))?;
    Ok(())
}

fn load_attempt(
    connection: &Connection,
    attempt_id: &str,
) -> Result<VerificationAttemptRecord, String> {
    connection
        .query_row(
            r#"SELECT id, run_id, request_key, attempt_number, trigger,
                contract_snapshot_json, contract_snapshot_sha256, expected_gate_count,
                status, diagnostic, started_at, finished_at, updated_at, version
             FROM verification_attempts WHERE id = ?1"#,
            [attempt_id],
            attempt_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not load verification attempt: {error}"))?
        .ok_or_else(|| format!("Verification attempt `{attempt_id}` was not found."))?
        .decode()
}

fn load_attempt_by_request_key(
    connection: &Connection,
    run_id: &str,
    request_key: &str,
) -> Result<Option<VerificationAttemptRecord>, String> {
    connection
        .query_row(
            r#"SELECT id, run_id, request_key, attempt_number, trigger,
                contract_snapshot_json, contract_snapshot_sha256, expected_gate_count,
                status, diagnostic, started_at, finished_at, updated_at, version
             FROM verification_attempts WHERE run_id = ?1 AND request_key = ?2"#,
            params![run_id, request_key],
            attempt_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not load verification request: {error}"))?
        .map(StoredAttempt::decode)
        .transpose()
}

struct StoredAttempt {
    id: String,
    run_id: String,
    request_key: String,
    attempt_number: i64,
    trigger: String,
    contract_snapshot_json: String,
    contract_snapshot_sha256: String,
    expected_gate_count: i64,
    status: String,
    diagnostic: Option<String>,
    started_at: i64,
    finished_at: Option<i64>,
    updated_at: i64,
    version: i64,
}

impl StoredAttempt {
    fn decode(self) -> Result<VerificationAttemptRecord, String> {
        let contract_snapshot: AcceptanceContractSnapshot =
            serde_json::from_str(&self.contract_snapshot_json).map_err(|error| {
                format!("Could not decode verification contract snapshot: {error}")
            })?;
        let normalized = contract_snapshot.validate_canonical()?;
        if normalized.content_sha256 != self.contract_snapshot_sha256 {
            return Err("The stored verification contract hash does not match.".to_owned());
        }
        Ok(VerificationAttemptRecord {
            id: self.id,
            run_id: self.run_id,
            request_key: self.request_key,
            attempt_number: u32::try_from(self.attempt_number)
                .map_err(|_| "The verification attempt number is invalid.".to_owned())?,
            trigger: VerificationAttemptTrigger::from_database(&self.trigger)?,
            contract_snapshot,
            contract_snapshot_sha256: self.contract_snapshot_sha256,
            expected_gate_count: usize::try_from(self.expected_gate_count)
                .map_err(|_| "The verification gate count is invalid.".to_owned())?,
            status: VerificationAttemptStatus::from_database(&self.status)?,
            diagnostic: self.diagnostic,
            started_at: self.started_at,
            finished_at: self.finished_at,
            updated_at: self.updated_at,
            version: self.version,
        })
    }
}

fn attempt_from_row(row: &Row<'_>) -> rusqlite::Result<StoredAttempt> {
    Ok(StoredAttempt {
        id: row.get(0)?,
        run_id: row.get(1)?,
        request_key: row.get(2)?,
        attempt_number: row.get(3)?,
        trigger: row.get(4)?,
        contract_snapshot_json: row.get(5)?,
        contract_snapshot_sha256: row.get(6)?,
        expected_gate_count: row.get(7)?,
        status: row.get(8)?,
        diagnostic: row.get(9)?,
        started_at: row.get(10)?,
        finished_at: row.get(11)?,
        updated_at: row.get(12)?,
        version: row.get(13)?,
    })
}

fn load_gate_outcomes(
    connection: &Connection,
    attempt_id: &str,
) -> Result<Vec<VerificationGateOutcome>, String> {
    let mut statement = connection
        .prepare(
            r#"SELECT outcome FROM gate_results
               WHERE verification_attempt_id = ?1 ORDER BY gate_index"#,
        )
        .map_err(|error| format!("Could not prepare verification gate outcomes: {error}"))?;
    let rows = statement
        .query_map([attempt_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not query verification gate outcomes: {error}"))?;
    rows.map(|row| {
        let value = row.map_err(|error| format!("Could not decode gate outcome: {error}"))?;
        VerificationGateOutcome::from_database(&value)
    })
    .collect()
}

fn load_gate_results(
    connection: &Connection,
    attempt_id: &str,
) -> Result<Vec<GateResultRecord>, String> {
    let mut statement = connection
        .prepare(
            r#"SELECT id, verification_attempt_id, gate_index, gate_type, outcome,
                duration_ms, exit_code, diagnostic, started_at, finished_at
             FROM gate_results
             WHERE verification_attempt_id = ?1
             ORDER BY gate_index"#,
        )
        .map_err(|error| format!("Could not prepare verification gate evidence: {error}"))?;
    let rows = statement
        .query_map([attempt_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<i32>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
            ))
        })
        .map_err(|error| format!("Could not query verification gate evidence: {error}"))?;
    rows.map(|row| {
        let (
            id,
            verification_attempt_id,
            gate_index,
            gate_type,
            outcome,
            duration_ms,
            exit_code,
            diagnostic,
            started_at,
            finished_at,
        ) = row.map_err(|error| format!("Could not decode verification gate evidence: {error}"))?;
        Ok(GateResultRecord {
            id,
            verification_attempt_id,
            gate_index: usize::try_from(gate_index)
                .map_err(|_| "The stored verification gate index is invalid.".to_owned())?,
            gate_type: VerificationGateType::from_database(&gate_type)?,
            outcome: VerificationGateOutcome::from_database(&outcome)?,
            duration_ms: u64::try_from(duration_ms)
                .map_err(|_| "The stored verification gate duration is invalid.".to_owned())?,
            exit_code,
            diagnostic,
            started_at,
            finished_at,
        })
    })
    .collect()
}

fn load_evidence_items(
    connection: &Connection,
    gate_result_id: &str,
) -> Result<Vec<VerificationEvidenceItem>, String> {
    let mut statement = connection
        .prepare(
            r#"SELECT e.id, e.run_id, e.verification_attempt_id, e.gate_result_id,
                e.evidence_type, e.summary_json, e.artifact_id, e.redaction_state,
                e.created_at, a.id, a.media_type, a.byte_length, a.sha256,
                a.retention_class, a.created_at
             FROM evidence e
             LEFT JOIN artifacts a ON a.id = e.artifact_id
             WHERE e.gate_result_id = ?1
             ORDER BY e.created_at, e.id"#,
        )
        .map_err(|error| format!("Could not prepare verification evidence items: {error}"))?;
    let rows = statement
        .query_map([gate_result_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<i64>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, Option<String>>(13)?,
                row.get::<_, Option<i64>>(14)?,
            ))
        })
        .map_err(|error| format!("Could not query verification evidence items: {error}"))?;
    rows.map(|row| {
        let (
            id,
            run_id,
            verification_attempt_id,
            stored_gate_result_id,
            evidence_type,
            summary_json,
            artifact_id,
            redaction_state,
            created_at,
            joined_artifact_id,
            media_type,
            byte_length,
            sha256,
            retention_class,
            artifact_created_at,
        ) = row.map_err(|error| format!("Could not decode verification evidence item: {error}"))?;
        let summary = serde_json::from_str(&summary_json)
            .map_err(|error| format!("Could not decode verification evidence summary: {error}"))?;
        let evidence = EvidenceRecord {
            id,
            run_id,
            verification_attempt_id,
            gate_result_id: stored_gate_result_id,
            evidence_type,
            summary,
            artifact_id,
            redaction_state: EvidenceRedactionState::from_database(&redaction_state)?,
            created_at,
        };
        let artifact = match joined_artifact_id {
            Some(id) => Some(VerificationArtifactSummary {
                id,
                media_type: media_type.ok_or("The verification artifact media type is missing.")?,
                byte_length: u64::try_from(
                    byte_length.ok_or("The verification artifact length is missing.")?,
                )
                .map_err(|_| "The verification artifact length is invalid.".to_owned())?,
                sha256: sha256.ok_or("The verification artifact checksum is missing.")?,
                retention_class: ArtifactRetentionClass::from_database(
                    retention_class
                        .as_deref()
                        .ok_or("The verification artifact retention class is missing.")?,
                )?,
                created_at: artifact_created_at
                    .ok_or("The verification artifact timestamp is missing.")?,
            }),
            None => None,
        };
        Ok(VerificationEvidenceItem { evidence, artifact })
    })
    .collect()
}

fn insert_artifact(transaction: &Transaction<'_>, artifact: &ArtifactRecord) -> Result<(), String> {
    transaction
        .execute(
            r#"INSERT INTO artifacts(
                id, run_id, verification_attempt_id, relative_storage_path,
                media_type, byte_length, sha256, retention_class, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
            params![
                artifact.id,
                artifact.run_id,
                artifact.verification_attempt_id,
                artifact.relative_storage_path,
                artifact.media_type,
                i64::try_from(artifact.byte_length).unwrap_or(i64::MAX),
                artifact.sha256,
                artifact.retention_class.as_database(),
                artifact.created_at,
            ],
        )
        .map_err(|error| format!("Could not persist verification artifact: {error}"))?;
    Ok(())
}

fn load_artifact(connection: &Connection, artifact_id: &str) -> Result<ArtifactRecord, String> {
    connection
        .query_row(
            r#"SELECT id, run_id, verification_attempt_id, relative_storage_path,
                media_type, byte_length, sha256, retention_class, created_at
             FROM artifacts WHERE id = ?1"#,
            [artifact_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not load verification artifact: {error}"))?
        .ok_or_else(|| format!("Verification artifact `{artifact_id}` was not found."))
        .and_then(
            |(
                id,
                run_id,
                verification_attempt_id,
                relative_storage_path,
                media_type,
                byte_length,
                sha256,
                retention_class,
                created_at,
            )| {
                Ok(ArtifactRecord {
                    id,
                    run_id,
                    verification_attempt_id,
                    relative_storage_path,
                    media_type,
                    byte_length: u64::try_from(byte_length)
                        .map_err(|_| "The verification artifact length is invalid.".to_owned())?,
                    sha256,
                    retention_class: ArtifactRetentionClass::from_database(&retention_class)?,
                    created_at,
                })
            },
        )
}

fn validate_gate_result(gate_result: &GateResultRecord) -> Result<(), String> {
    validate_identity(&gate_result.id, "gate result ID")?;
    validate_identity(
        &gate_result.verification_attempt_id,
        "verification attempt ID",
    )?;
    if gate_result.gate_index >= 32
        || gate_result.finished_at < gate_result.started_at
        || gate_result
            .diagnostic
            .as_deref()
            .is_some_and(|diagnostic| bounded_diagnostic(diagnostic).len() != diagnostic.len())
    {
        return Err("The verification gate result is invalid.".to_owned());
    }
    i64::try_from(gate_result.duration_ms)
        .map_err(|_| "The verification gate duration is invalid.".to_owned())?;
    Ok(())
}

fn validate_artifact(artifact: &ArtifactRecord) -> Result<(), String> {
    validate_identity(&artifact.id, "artifact ID")?;
    validate_identity(&artifact.run_id, "artifact run ID")?;
    if let Some(attempt_id) = &artifact.verification_attempt_id {
        validate_identity(attempt_id, "artifact verification attempt ID")?;
    }
    if artifact.relative_storage_path.is_empty()
        || artifact.relative_storage_path.len() > MAX_RELATIVE_ARTIFACT_PATH_BYTES
        || artifact.relative_storage_path.contains('\\')
        || artifact.relative_storage_path.starts_with('/')
        || artifact
            .relative_storage_path
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
        || artifact.media_type.trim().is_empty()
        || artifact.media_type.len() > MAX_MEDIA_TYPE_BYTES
        || !is_sha256(&artifact.sha256)
    {
        return Err("The verification artifact record is invalid.".to_owned());
    }
    i64::try_from(artifact.byte_length)
        .map_err(|_| "The verification artifact length is invalid.".to_owned())?;
    Ok(())
}

fn validate_evidence(evidence: &EvidenceRecord) -> Result<(), String> {
    validate_identity(&evidence.id, "evidence ID")?;
    validate_identity(&evidence.run_id, "evidence run ID")?;
    if let Some(attempt_id) = &evidence.verification_attempt_id {
        validate_identity(attempt_id, "evidence verification attempt ID")?;
    }
    if let Some(gate_result_id) = &evidence.gate_result_id {
        validate_identity(gate_result_id, "evidence gate result ID")?;
    }
    if let Some(artifact_id) = &evidence.artifact_id {
        validate_identity(artifact_id, "evidence artifact ID")?;
    }
    if evidence.evidence_type.trim().is_empty()
        || evidence.evidence_type.len() > MAX_EVIDENCE_TYPE_BYTES
        || serde_json::to_vec(&evidence.summary)
            .map_err(|error| format!("Could not encode evidence summary: {error}"))?
            .len()
            > MAX_EVIDENCE_SUMMARY_BYTES
    {
        return Err("The verification evidence record is invalid.".to_owned());
    }
    Ok(())
}

fn validate_identity(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > MAX_VERIFICATION_ID_BYTES {
        return Err(format!("The {label} is invalid."));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
