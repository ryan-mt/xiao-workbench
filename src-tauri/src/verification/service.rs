use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

use crate::runs::models::{RunRecord, RunSnapshot, RunStatus};
use crate::runs::repository::{bounded_diagnostic, new_uuid_v7, now_millis};
use crate::runs::service::{emit_service_error_for_workspace, emit_update, RunService};
use crate::xiao::repository::XiaoRepository;

use super::artifacts::ArtifactStore;
use super::executor::{execute_cleanliness_gate, execute_command_gate, execute_diff_scope_gate};
use super::git::{capture_git_state, GitReadError, GitStateSnapshot};
use super::models::{
    AcceptanceGate, ArtifactRecord, ArtifactRetentionClass, EvidenceRecord, EvidenceRedactionState,
    GateResultRecord, VerificationAttemptRecord, VerificationAttemptTrigger,
    VerificationBaselineState, VerificationGateOutcome,
};

const VERIFICATION_ARTIFACT_MEDIA_TYPE: &str = "application/vnd.xiao.verification-gate+json";
const BASELINE_ARTIFACT_MEDIA_TYPE: &str = "application/vnd.xiao.git-state+json";
const VERIFICATION_WORKER_STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct VerificationService {
    workers: Mutex<HashMap<String, VerificationWorker>>,
}

struct VerificationWorker {
    attempt_id: String,
    cancellation: Arc<AtomicBool>,
    completion: Arc<WorkerCompletion>,
}

#[derive(Default)]
struct WorkerCompletion {
    completed: AtomicBool,
    notify: Notify,
}

impl WorkerCompletion {
    fn finish(&self) {
        if !self.completed.swap(true, Ordering::AcqRel) {
            self.notify.notify_waiters();
        }
    }

    async fn wait(&self) {
        loop {
            if self.completed.load(Ordering::Acquire) {
                return;
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.completed.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

pub(crate) struct VerificationWorkerStop {
    completion: Arc<WorkerCompletion>,
}

impl VerificationWorkerStop {
    pub(crate) async fn wait(self) -> Result<(), String> {
        tokio::time::timeout(VERIFICATION_WORKER_STOP_TIMEOUT, self.completion.wait())
            .await
            .map_err(|_| {
                "The cancelled verification worker did not stop within 5 seconds.".to_owned()
            })?;
        Ok(())
    }
}

struct ExecutedGate {
    outcome: VerificationGateOutcome,
    duration_ms: u64,
    exit_code: Option<i32>,
    diagnostic: Option<String>,
    artifact_evidence: Value,
    summary: Value,
    redaction_state: EvidenceRedactionState,
}

impl VerificationService {
    pub(crate) fn launch_initial(
        &self,
        app: &AppHandle,
        run_id: &str,
    ) -> Result<RunSnapshot, String> {
        self.launch(
            app,
            run_id,
            &format!("initial:{run_id}"),
            VerificationAttemptTrigger::Initial,
        )
    }

    pub fn rerun(
        &self,
        app: &AppHandle,
        run_id: &str,
        request_key: &str,
    ) -> Result<RunSnapshot, String> {
        if self
            .workers
            .lock()
            .map_err(|error| error.to_string())?
            .contains_key(run_id)
        {
            return Err(
                "The previous verification worker is still stopping; retry shortly.".to_owned(),
            );
        }
        self.launch(app, run_id, request_key, VerificationAttemptTrigger::Rerun)
    }

    pub fn read_artifact(
        &self,
        app: &AppHandle,
        run_id: &str,
        artifact_id: &str,
    ) -> Result<Value, String> {
        let (artifact, app_data_dir) = {
            let repository = app.state::<XiaoRepository>();
            let artifact = repository.load_verification_artifact_record(run_id, artifact_id)?;
            (artifact, repository.app_data_dir())
        };
        ArtifactStore::open(&app_data_dir)?.read_json(
            &artifact.relative_storage_path,
            artifact.byte_length,
            &artifact.sha256,
        )
    }

    pub(crate) fn cancel(&self, run_id: &str) -> Result<Option<VerificationWorkerStop>, String> {
        let workers = self.workers.lock().map_err(|error| error.to_string())?;
        let Some(worker) = workers.get(run_id) else {
            return Ok(None);
        };
        worker.cancellation.store(true, Ordering::Release);
        Ok(Some(VerificationWorkerStop {
            completion: Arc::clone(&worker.completion),
        }))
    }

    fn launch(
        &self,
        app: &AppHandle,
        run_id: &str,
        request_key: &str,
        trigger: VerificationAttemptTrigger,
    ) -> Result<RunSnapshot, String> {
        let started = app.state::<XiaoRepository>().begin_verification_attempt(
            run_id,
            request_key,
            trigger,
        )?;
        let snapshot = started.mutation.run.snapshot();
        if !started.created {
            return Ok(snapshot);
        }

        let completion = Arc::new(WorkerCompletion::default());
        let cancellation = Arc::new(AtomicBool::new(false));
        let replaced = self
            .workers
            .lock()
            .map_err(|error| error.to_string())?
            .insert(
                run_id.to_owned(),
                VerificationWorker {
                    attempt_id: started.attempt.id.clone(),
                    cancellation: Arc::clone(&cancellation),
                    completion: Arc::clone(&completion),
                },
            );
        if let Some(replaced) = replaced {
            replaced.cancellation.store(true, Ordering::Release);
        }
        emit_update(app, &started.mutation, None);

        let app_for_worker = app.clone();
        let workspace_path = snapshot.workspace_path.clone();
        let attempt = started.attempt;
        let completion_for_worker = Arc::clone(&completion);
        tauri::async_runtime::spawn(async move {
            let worker_app = app_for_worker.clone();
            let attempt_id = attempt.id.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                execute_verification_attempt(&worker_app, &attempt, &cancellation)
            })
            .await;
            let result = match result {
                Ok(result) => result,
                Err(error) => Err(format!(
                    "The verification worker stopped unexpectedly: {error}"
                )),
            };
            if let Err(error) = result {
                fail_closed_verification(&app_for_worker, &workspace_path, &attempt_id, &error);
            }
            app_for_worker
                .state::<VerificationService>()
                .finish_worker(&attempt_id);
            completion_for_worker.finish();
            app_for_worker.state::<RunService>().wake();
        });
        Ok(snapshot)
    }

    fn finish_worker(&self, attempt_id: &str) {
        if let Ok(mut workers) = self.workers.lock() {
            workers.retain(|_, worker| worker.attempt_id != attempt_id);
        }
    }
}

pub(crate) async fn capture_baseline_if_required(
    app: &AppHandle,
    run: &RunRecord,
    cancellation: Arc<AtomicBool>,
) -> Result<(), String> {
    if run.verification_baseline_state != VerificationBaselineState::Pending {
        return Ok(());
    }
    if run
        .acceptance_contract_snapshot
        .as_ref()
        .is_none_or(|snapshot| !snapshot.requires_diff_baseline())
    {
        return Err("A Xiao run requested an unnecessary verification baseline.".to_owned());
    }

    let run_id = run.id.clone();
    let execution_root = PathBuf::from(&run.execution_root);
    let app_data_dir = app.state::<XiaoRepository>().app_data_dir();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_baseline_artifact(&app_data_dir, &run_id, &execution_root, &cancellation)
    })
    .await
    .map_err(|error| format!("The verification baseline worker stopped: {error}"))?;

    match prepared {
        Ok((store, artifact)) => {
            let result = app
                .state::<XiaoRepository>()
                .persist_verification_baseline(&run.id, &artifact);
            match result {
                Ok(mutation) => {
                    emit_update(app, &mutation, None);
                    Ok(())
                }
                Err(error) => {
                    let _ = store.remove(&artifact.relative_storage_path);
                    Err(error)
                }
            }
        }
        Err(diagnostic) => {
            let mutation = app
                .state::<XiaoRepository>()
                .mark_verification_baseline_unavailable(&run.id, &diagnostic)?;
            emit_update(app, &mutation, None);
            Ok(())
        }
    }
}

fn prepare_baseline_artifact(
    app_data_dir: &Path,
    run_id: &str,
    execution_root: &Path,
    cancellation: &AtomicBool,
) -> Result<(ArtifactStore, ArtifactRecord), String> {
    let snapshot = capture_git_state(execution_root, cancellation)
        .map_err(|error| sanitize_git_error(error, execution_root))?;
    if cancellation.load(Ordering::Acquire) {
        return Err("Verification baseline capture was cancelled.".to_owned());
    }
    let store = ArtifactStore::open(app_data_dir)?;
    let artifact_id = new_uuid_v7();
    let stored = store.write_json(run_id, None, &artifact_id, &snapshot)?;
    let artifact = ArtifactRecord {
        id: artifact_id,
        run_id: run_id.to_owned(),
        verification_attempt_id: None,
        relative_storage_path: stored.relative_storage_path,
        media_type: BASELINE_ARTIFACT_MEDIA_TYPE.to_owned(),
        byte_length: stored.byte_length,
        sha256: stored.sha256,
        retention_class: ArtifactRetentionClass::VerificationBaseline,
        created_at: now_millis()?,
    };
    Ok((store, artifact))
}

fn execute_verification_attempt(
    app: &AppHandle,
    attempt: &VerificationAttemptRecord,
    cancellation: &AtomicBool,
) -> Result<(), String> {
    let app_data_dir = app.state::<XiaoRepository>().app_data_dir();
    let store = ArtifactStore::open(&app_data_dir)?;
    let run = app.state::<XiaoRepository>().get_run(&attempt.run_id)?;
    if run.status != RunStatus::Verifying
        || run.latest_verification_attempt_id.as_deref() != Some(attempt.id.as_str())
        || run.execution_root.trim().is_empty()
    {
        return Err("The verification worker no longer matches its Xiao run.".to_owned());
    }
    let execution_root = PathBuf::from(&run.execution_root);

    execute_declared_gates(&attempt.contract_snapshot.gates, |gate_index, gate| {
        let final_git_state = (!matches!(gate, AcceptanceGate::Command { .. }))
            .then(|| capture_git_state(&execution_root, cancellation));
        let executed = execute_gate(
            app,
            &store,
            &attempt.run_id,
            gate,
            &execution_root,
            cancellation,
            final_git_state.as_ref(),
        );
        let outcome = executed.outcome;
        persist_executed_gate(app, &store, attempt, gate_index, gate, executed)?;
        Ok::<_, String>(outcome)
    })?;

    let settlement = app
        .state::<XiaoRepository>()
        .settle_verification_attempt(&attempt.id)?;
    emit_update(app, &settlement.mutation, None);
    Ok(())
}

fn execute_declared_gates<E>(
    gates: &[AcceptanceGate],
    mut execute: impl FnMut(usize, &AcceptanceGate) -> Result<VerificationGateOutcome, E>,
) -> Result<(), E> {
    for (gate_index, gate) in gates.iter().enumerate() {
        if execute(gate_index, gate)? != VerificationGateOutcome::Passed {
            break;
        }
    }
    Ok(())
}

fn execute_gate(
    app: &AppHandle,
    store: &ArtifactStore,
    run_id: &str,
    gate: &AcceptanceGate,
    execution_root: &Path,
    cancellation: &AtomicBool,
    final_git_state: Option<&Result<GitStateSnapshot, GitReadError>>,
) -> ExecutedGate {
    match gate {
        AcceptanceGate::Command {
            executable,
            argv,
            timeout_ms,
            expected_exit_codes,
        } => {
            let execution = execute_command_gate(
                execution_root,
                executable,
                argv,
                *timeout_ms,
                expected_exit_codes,
                cancellation,
            );
            let diagnostic = execution
                .diagnostic
                .as_deref()
                .map(|value| sanitize_diagnostic(value, execution_root));
            let executable = sanitize_executable(&execution.evidence.executable, execution_root);
            let redacted_argv = redact_argv(&execution.evidence.argv);
            let artifact_evidence = json!({
                "executable": executable,
                "argv": redacted_argv,
                "outputHead": redact_text(&execution.evidence.output_head),
                "outputTail": redact_text(&execution.evidence.output_tail),
                "totalOutputBytes": execution.evidence.total_output_bytes,
                "outputTruncated": execution.evidence.output_truncated,
                "outputSha256": execution.evidence.output_sha256,
            });
            let summary = json!({
                "executable": executable,
                "exitCode": execution.exit_code,
                "durationMs": execution.duration_ms,
                "totalOutputBytes": execution.evidence.total_output_bytes,
                "outputTruncated": execution.evidence.output_truncated,
            });
            ExecutedGate {
                outcome: execution.outcome,
                duration_ms: execution.duration_ms,
                exit_code: execution.exit_code,
                diagnostic,
                artifact_evidence,
                summary,
                redaction_state: EvidenceRedactionState::BestEffort,
            }
        }
        AcceptanceGate::DiffScope {
            allowed_patterns,
            denied_patterns,
        } => {
            let started = Instant::now();
            let baseline = load_baseline(app, store, run_id, execution_root);
            let baseline = match baseline {
                Ok(baseline) => baseline,
                Err(error) => {
                    return blocked_git_gate(
                        started,
                        error,
                        json!({
                            "allowedPatterns": allowed_patterns,
                            "deniedPatterns": denied_patterns,
                            "changedPaths": [],
                            "violatingPaths": [],
                        }),
                    );
                }
            };
            let final_state = match final_git_state {
                Some(Ok(snapshot)) => snapshot,
                Some(Err(error)) => {
                    return git_error_gate(
                        started,
                        error.clone(),
                        execution_root,
                        json!({
                            "allowedPatterns": allowed_patterns,
                            "deniedPatterns": denied_patterns,
                            "changedPaths": [],
                            "violatingPaths": [],
                        }),
                    );
                }
                None => {
                    return blocked_git_gate(
                        started,
                        "The final Git state is unavailable.".to_owned(),
                        json!({
                            "allowedPatterns": allowed_patterns,
                            "deniedPatterns": denied_patterns,
                            "changedPaths": [],
                            "violatingPaths": [],
                        }),
                    );
                }
            };
            let execution = execute_diff_scope_gate(
                execution_root,
                &baseline,
                final_state,
                allowed_patterns,
                denied_patterns,
                cancellation,
            );
            let artifact_evidence = serde_json::to_value(&execution.evidence)
                .unwrap_or_else(|_| json!({ "encodingError": true }));
            let summary = json!({
                "changedPathCount": execution.evidence.changed_paths.len(),
                "violatingPaths": execution.evidence.violating_paths,
                "durationMs": execution.duration_ms,
            });
            ExecutedGate {
                outcome: execution.outcome,
                duration_ms: execution.duration_ms,
                exit_code: None,
                diagnostic: execution
                    .diagnostic
                    .as_deref()
                    .map(|value| sanitize_diagnostic(value, execution_root)),
                artifact_evidence,
                summary,
                redaction_state: EvidenceRedactionState::Safe,
            }
        }
        AcceptanceGate::Cleanliness {
            allow_staged,
            allow_unstaged,
            allow_untracked,
        } => {
            let started = Instant::now();
            let final_state = match final_git_state {
                Some(Ok(snapshot)) => snapshot,
                Some(Err(error)) => {
                    return git_error_gate(
                        started,
                        error.clone(),
                        execution_root,
                        json!({
                            "stagedPaths": [],
                            "unstagedPaths": [],
                            "untrackedPaths": [],
                            "violatingStagedPaths": [],
                            "violatingUnstagedPaths": [],
                            "violatingUntrackedPaths": [],
                        }),
                    );
                }
                None => {
                    return blocked_git_gate(
                        started,
                        "The final Git state is unavailable.".to_owned(),
                        json!({
                            "stagedPaths": [],
                            "unstagedPaths": [],
                            "untrackedPaths": [],
                            "violatingStagedPaths": [],
                            "violatingUnstagedPaths": [],
                            "violatingUntrackedPaths": [],
                        }),
                    );
                }
            };
            let execution = execute_cleanliness_gate(
                final_state,
                *allow_staged,
                *allow_unstaged,
                *allow_untracked,
                cancellation,
            );
            let artifact_evidence = serde_json::to_value(&execution.evidence)
                .unwrap_or_else(|_| json!({ "encodingError": true }));
            let summary = json!({
                "violatingStagedPaths": execution.evidence.violating_staged_paths,
                "violatingUnstagedPaths": execution.evidence.violating_unstaged_paths,
                "violatingUntrackedPaths": execution.evidence.violating_untracked_paths,
                "durationMs": execution.duration_ms,
            });
            ExecutedGate {
                outcome: execution.outcome,
                duration_ms: execution.duration_ms,
                exit_code: None,
                diagnostic: execution
                    .diagnostic
                    .as_deref()
                    .map(|value| sanitize_diagnostic(value, execution_root)),
                artifact_evidence,
                summary,
                redaction_state: EvidenceRedactionState::Safe,
            }
        }
    }
}

fn load_baseline(
    app: &AppHandle,
    store: &ArtifactStore,
    run_id: &str,
    execution_root: &Path,
) -> Result<GitStateSnapshot, String> {
    let artifact = app
        .state::<XiaoRepository>()
        .load_verification_baseline_artifact(run_id)?
        .ok_or("The durable verification baseline is unavailable.")?;
    store
        .read_json::<GitStateSnapshot>(
            &artifact.relative_storage_path,
            artifact.byte_length,
            &artifact.sha256,
        )
        .map_err(|error| sanitize_diagnostic(&error, execution_root))
}

fn persist_executed_gate(
    app: &AppHandle,
    store: &ArtifactStore,
    attempt: &VerificationAttemptRecord,
    gate_index: usize,
    gate: &AcceptanceGate,
    executed: ExecutedGate,
) -> Result<(), String> {
    let timestamp = now_millis()?;
    let gate_result_id = new_uuid_v7();
    let artifact_id = new_uuid_v7();
    let evidence_id = new_uuid_v7();
    let artifact_payload = json!({
        "schemaVersion": 1,
        "runId": attempt.run_id,
        "verificationAttemptId": attempt.id,
        "gateIndex": gate_index,
        "gateType": gate.gate_type(),
        "outcome": executed.outcome,
        "durationMs": executed.duration_ms,
        "exitCode": executed.exit_code,
        "diagnostic": executed.diagnostic,
        "evidence": executed.artifact_evidence,
    });
    let stored = store.write_json(
        &attempt.run_id,
        Some(&attempt.id),
        &artifact_id,
        &artifact_payload,
    )?;
    let artifact = ArtifactRecord {
        id: artifact_id,
        run_id: attempt.run_id.clone(),
        verification_attempt_id: Some(attempt.id.clone()),
        relative_storage_path: stored.relative_storage_path,
        media_type: VERIFICATION_ARTIFACT_MEDIA_TYPE.to_owned(),
        byte_length: stored.byte_length,
        sha256: stored.sha256,
        retention_class: ArtifactRetentionClass::RunEvidence,
        created_at: timestamp,
    };
    let gate_result = GateResultRecord {
        id: gate_result_id.clone(),
        verification_attempt_id: attempt.id.clone(),
        gate_index,
        gate_type: gate.gate_type(),
        outcome: executed.outcome,
        duration_ms: executed.duration_ms,
        exit_code: executed.exit_code,
        diagnostic: executed.diagnostic.map(|value| bounded_diagnostic(&value)),
        started_at: timestamp
            .saturating_sub(i64::try_from(executed.duration_ms).unwrap_or(i64::MAX)),
        finished_at: timestamp,
    };
    let evidence = EvidenceRecord {
        id: evidence_id,
        run_id: attempt.run_id.clone(),
        verification_attempt_id: Some(attempt.id.clone()),
        gate_result_id: Some(gate_result_id),
        evidence_type: gate.gate_type().as_database().to_owned(),
        summary: executed.summary,
        artifact_id: Some(artifact.id.clone()),
        redaction_state: executed.redaction_state,
        created_at: timestamp,
    };
    let result =
        app.state::<XiaoRepository>()
            .persist_verification_gate(&gate_result, &artifact, &evidence);
    match result {
        Ok(persisted) => {
            emit_update(app, &persisted.mutation, None);
            Ok(())
        }
        Err(error) => {
            let _ = store.remove(&artifact.relative_storage_path);
            Err(error)
        }
    }
}

fn blocked_git_gate(started: Instant, diagnostic: String, evidence: Value) -> ExecutedGate {
    ExecutedGate {
        outcome: VerificationGateOutcome::Blocked,
        duration_ms: elapsed_millis(started),
        exit_code: None,
        diagnostic: Some(bounded_diagnostic(&diagnostic)),
        artifact_evidence: evidence,
        summary: json!({ "blocked": true }),
        redaction_state: EvidenceRedactionState::Safe,
    }
}

fn git_error_gate(
    started: Instant,
    error: GitReadError,
    execution_root: &Path,
    evidence: Value,
) -> ExecutedGate {
    let diagnostic = sanitize_git_error(error.clone(), execution_root);
    ExecutedGate {
        outcome: error.outcome,
        duration_ms: elapsed_millis(started),
        exit_code: None,
        diagnostic: Some(bounded_diagnostic(&diagnostic)),
        artifact_evidence: evidence,
        summary: json!({
            "blocked": error.outcome == VerificationGateOutcome::Blocked,
            "cancelled": error.outcome == VerificationGateOutcome::Cancelled,
        }),
        redaction_state: EvidenceRedactionState::Safe,
    }
}

fn fail_closed_verification(app: &AppHandle, workspace_path: &str, attempt_id: &str, error: &str) {
    emit_service_error_for_workspace(app, Some(workspace_path), error);
    match app
        .state::<XiaoRepository>()
        .settle_verification_attempt(attempt_id)
    {
        Ok(settlement) => emit_update(app, &settlement.mutation, None),
        Err(settlement_error) => emit_service_error_for_workspace(
            app,
            Some(workspace_path),
            &format!("{error} Verification could not settle fail-closed: {settlement_error}"),
        ),
    }
}

fn sanitize_git_error(error: GitReadError, execution_root: &Path) -> String {
    sanitize_diagnostic(&error.diagnostic, execution_root)
}

fn sanitize_diagnostic(value: &str, execution_root: &Path) -> String {
    let root = execution_root.to_string_lossy();
    let mut sanitized = value.replace(root.as_ref(), "<run-root>");
    let forward = root.replace('\\', "/");
    if forward != root {
        sanitized = sanitized.replace(&forward, "<run-root>");
    }
    bounded_diagnostic(&redact_text(&sanitized))
}

fn sanitize_executable(value: &str, execution_root: &Path) -> String {
    let path = Path::new(value);
    if !path.is_absolute() {
        return value.to_owned();
    }
    if let Ok(relative) = path.strip_prefix(execution_root) {
        return format!(
            "<run-root>/{}",
            relative.to_string_lossy().replace('\\', "/")
        );
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "executable".to_owned());
    format!("<external:{name}>")
}

fn redact_argv(argv: &[String]) -> Vec<String> {
    let mut redact_next = false;
    argv.iter()
        .map(|argument| {
            if redact_next {
                redact_next = false;
                return "<redacted>".to_owned();
            }
            let lower = argument.to_ascii_lowercase();
            if let Some((name, _)) = argument.split_once('=') {
                if is_sensitive_argument_name(&name.to_ascii_lowercase()) {
                    return format!("{name}=<redacted>");
                }
            }
            if let Some((name, _)) = argument.split_once(':') {
                if is_sensitive_argument_name(&name.to_ascii_lowercase()) {
                    return format!("{name}:<redacted>");
                }
            }
            if is_sensitive_argument_name(&lower) {
                redact_next = true;
                return "<redacted>".to_owned();
            }
            redact_text(argument)
        })
        .collect()
}

fn is_sensitive_argument_name(value: &str) -> bool {
    [
        "token",
        "secret",
        "password",
        "authorization",
        "api-key",
        "apikey",
        "cookie",
    ]
    .iter()
    .any(|needle| value.trim_start_matches('-').contains(needle))
}

fn redact_text(value: &str) -> String {
    value
        .lines()
        .map(redact_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    for marker in [
        "authorization:",
        "authorization=",
        "token:",
        "token=",
        "secret:",
        "secret=",
        "password:",
        "password=",
        "api_key:",
        "api_key=",
        "apikey:",
        "apikey=",
        "cookie:",
        "cookie=",
    ] {
        if let Some(index) = lower.find(marker) {
            let end = index + marker.len();
            return format!("{}<redacted>", &line[..end]);
        }
    }
    if let Some(index) = lower.find("bearer ") {
        return format!("{}bearer <redacted>", &line[..index]);
    }
    line.to_owned()
}

fn elapsed_millis(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    struct TestRepository {
        path: PathBuf,
    }

    impl TestRepository {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "xiao-verification-order-{label}-{}",
                crate::runs::repository::new_uuid_v7()
            ));
            fs::create_dir_all(&path).unwrap();
            let repository = Self { path };
            repository.git_success(&["init", "--quiet", "--initial-branch=main"]);
            repository
        }

        fn write(&self, path: &str, contents: &str) {
            fs::write(self.path.join(path), contents).unwrap();
        }

        fn git_success(&self, arguments: &[&str]) {
            let output = Command::new("git")
                .args(arguments)
                .current_dir(&self.path)
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GCM_INTERACTIVE", "Never")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {arguments:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn worker_completion_wakes_concurrent_and_late_waiters() {
        let completion = Arc::new(WorkerCompletion::default());
        tauri::async_runtime::block_on(async {
            let first = Arc::clone(&completion);
            let second = Arc::clone(&completion);
            let finisher = Arc::clone(&completion);
            tokio::time::timeout(Duration::from_secs(1), async move {
                tokio::join!(first.wait(), second.wait(), async move {
                    tokio::task::yield_now().await;
                    finisher.finish();
                });
            })
            .await
            .expect("concurrent verification completion waiters hung");

            tokio::time::timeout(Duration::from_secs(1), completion.wait())
                .await
                .expect("a late verification completion waiter hung");
        });
    }

    fn command_gate() -> AcceptanceGate {
        AcceptanceGate::Command {
            executable: "tool".to_owned(),
            argv: Vec::new(),
            timeout_ms: 1_000,
            expected_exit_codes: vec![0],
        }
    }

    fn cleanliness_gate() -> AcceptanceGate {
        AcceptanceGate::Cleanliness {
            allow_staged: false,
            allow_unstaged: false,
            allow_untracked: false,
        }
    }

    fn diff_scope_gate() -> AcceptanceGate {
        AcceptanceGate::DiffScope {
            allowed_patterns: Vec::new(),
            denied_patterns: Vec::new(),
        }
    }

    #[test]
    fn failing_cleanliness_stops_before_later_command_launch() {
        let repository = TestRepository::new("cleanliness-first");
        repository.write("already-dirty.txt", "dirty");
        let gates = vec![cleanliness_gate(), command_gate()];
        let cancellation = AtomicBool::new(false);
        let command_side_effect = repository.path.join("command-launched.txt");
        let mut executed_indices = Vec::new();

        execute_declared_gates(&gates, |gate_index, gate| {
            executed_indices.push(gate_index);
            let outcome = match gate {
                AcceptanceGate::Cleanliness {
                    allow_staged,
                    allow_unstaged,
                    allow_untracked,
                } => {
                    let state = capture_git_state(&repository.path, &cancellation).unwrap();
                    execute_cleanliness_gate(
                        &state,
                        *allow_staged,
                        *allow_unstaged,
                        *allow_untracked,
                        &cancellation,
                    )
                    .outcome
                }
                AcceptanceGate::Command { .. } => {
                    fs::write(&command_side_effect, "launched").unwrap();
                    VerificationGateOutcome::Passed
                }
                AcceptanceGate::DiffScope { .. } => unreachable!(),
            };
            Ok::<_, ()>(outcome)
        })
        .unwrap();

        assert_eq!(executed_indices, vec![0]);
        assert!(!command_side_effect.exists());
    }

    #[test]
    fn git_gates_observe_preceding_command_mutation() {
        let repository = TestRepository::new("command-first");
        let cancellation = AtomicBool::new(false);
        let baseline = capture_git_state(&repository.path, &cancellation).unwrap();
        let gates = vec![command_gate(), diff_scope_gate(), cleanliness_gate()];
        let mut diff_changed_paths = Vec::new();
        let mut cleanliness_untracked_paths = Vec::new();

        execute_declared_gates(&gates, |_, gate| {
            let outcome = match gate {
                AcceptanceGate::Command { .. } => {
                    repository.write("command-mutation.txt", "mutation");
                    VerificationGateOutcome::Passed
                }
                AcceptanceGate::DiffScope {
                    allowed_patterns,
                    denied_patterns,
                } => {
                    let state = capture_git_state(&repository.path, &cancellation).unwrap();
                    let execution = execute_diff_scope_gate(
                        &repository.path,
                        &baseline,
                        &state,
                        allowed_patterns,
                        denied_patterns,
                        &cancellation,
                    );
                    diff_changed_paths = execution.evidence.changed_paths;
                    execution.outcome
                }
                AcceptanceGate::Cleanliness {
                    allow_staged,
                    allow_unstaged,
                    allow_untracked,
                } => {
                    let state = capture_git_state(&repository.path, &cancellation).unwrap();
                    let execution = execute_cleanliness_gate(
                        &state,
                        *allow_staged,
                        *allow_unstaged,
                        *allow_untracked,
                        &cancellation,
                    );
                    cleanliness_untracked_paths = execution.evidence.untracked_paths;
                    execution.outcome
                }
            };
            Ok::<_, ()>(outcome)
        })
        .unwrap();

        assert_eq!(diff_changed_paths, vec!["command-mutation.txt"]);
        assert_eq!(cleanliness_untracked_paths, vec!["command-mutation.txt"]);
    }

    #[test]
    fn all_passing_gates_execute_once_in_declared_order() {
        let gates = vec![cleanliness_gate(), command_gate(), diff_scope_gate()];
        let mut executed = Vec::new();

        execute_declared_gates(&gates, |gate_index, gate| {
            executed.push((gate_index, gate.gate_type().as_database()));
            Ok::<_, ()>(VerificationGateOutcome::Passed)
        })
        .unwrap();

        assert_eq!(
            executed,
            vec![(0, "cleanliness"), (1, "command"), (2, "diff_scope")]
        );
    }

    #[test]
    fn redacts_inline_sensitive_argv_before_persistence() {
        let argv = vec![
            "--token=token-secret".to_owned(),
            "safe-next".to_owned(),
            "/password:password-secret".to_owned(),
            "safe-colon-next".to_owned(),
            "-Dtoken=define-secret".to_owned(),
            "--authorization=Bearer bearer-secret".to_owned(),
            "--cookie=session-secret".to_owned(),
        ];
        let redacted = redact_argv(&argv);
        let encoded = serde_json::to_string(&redacted).unwrap();

        for secret in [
            "token-secret",
            "password-secret",
            "define-secret",
            "bearer-secret",
            "session-secret",
        ] {
            assert!(!encoded.contains(secret));
        }
        assert_eq!(redacted[0], "--token=<redacted>");
        assert_eq!(redacted[1], "safe-next");
        assert_eq!(redacted[2], "/password:<redacted>");
        assert_eq!(redacted[3], "safe-colon-next");
        assert_eq!(redacted[4], "-Dtoken=<redacted>");
        assert_eq!(
            redact_argv(&["--cookie".to_owned(), "cookie-secret".to_owned()]),
            vec!["<redacted>", "<redacted>"],
        );
    }
}
