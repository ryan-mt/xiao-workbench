use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex as AsyncMutex, Notify};

use crate::agent::models::PersistentAgentSession;
use crate::agent::runtime::EnvironmentRuntimeRegistry;
use crate::agent::service::prepare_persistent_xiao_session;
use crate::execution::service::resolve_execution_context;
use crate::git::models::WorkspaceCheckpointCapture;
use crate::git::service::{
    create_workspace_checkpoint, discard_workspace_checkpoint, finish_workspace_checkpoint_capture,
};
use crate::lsp::{codex_supports_dynamic_tools, dynamic_tool_response, LspManager};
use crate::routines::service::RoutineService;
#[cfg(test)]
use crate::verification::models::VerificationBaselineState;
use crate::verification::service::{capture_baseline_if_required, VerificationService};
use crate::xiao::repository::XiaoRepository;

use super::models::{
    EnqueueRunRequest, NewPendingInput, NewRun, PendingInputKind, PendingInputSnapshot,
    RunProtocolEnvelope, RunRecord, RunServiceErrorEnvelope, RunSnapshot, RunStatus,
    RunUpdateEnvelope, RuntimeAttachment,
};
use super::repository::{
    bounded_diagnostic, new_uuid_v7, now_millis, CancelDisposition, CorrelatedRunEvent,
    RunMutation, RuntimeTurnSettlement,
};
use super::RUN_CONCURRENCY_LIMIT;

const THREAD_SOURCE: &str = "xiao-workbench";
const PLAN_PROGRESS_INSTRUCTIONS: &str = "When you publish a task plan with update_plan, keep it current throughout execution. As soon as a step finishes, mark it completed and set the next step to in_progress before continuing. Do not wait until the final response to batch plan status changes.";

pub struct RunService {
    notify: Arc<Notify>,
    worker_started: AtomicBool,
    dispatch: AsyncMutex<()>,
    input_resolutions: Mutex<()>,
    checkpoints: Mutex<HashMap<String, RunCheckpoint>>,
    preparation_cancellations: Mutex<HashMap<String, PreparationCancellation>>,
}

#[derive(Clone)]
struct PreparationCancellation {
    requested: Arc<AtomicBool>,
    stopped: Arc<PreparationCompletion>,
}

#[derive(Default)]
struct PreparationCompletion {
    completed: AtomicBool,
    notify: Notify,
}

impl PreparationCompletion {
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

struct RunCheckpoint {
    token: String,
    execution_root: String,
}

impl Default for RunService {
    fn default() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            worker_started: AtomicBool::new(false),
            dispatch: AsyncMutex::new(()),
            input_resolutions: Mutex::new(()),
            checkpoints: Mutex::new(HashMap::new()),
            preparation_cancellations: Mutex::new(HashMap::new()),
        }
    }
}

impl RunService {
    pub fn start(&self, app: AppHandle) {
        if self.worker_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let notify = Arc::clone(&self.notify);
        tauri::async_runtime::spawn(async move {
            reconcile_startup(&app);
            notify.notify_one();
            loop {
                notify.notified().await;
                loop {
                    let claimed = {
                        let repository = app.state::<XiaoRepository>();
                        repository.claim_next_eligible_run(RUN_CONCURRENCY_LIMIT)
                    };
                    let claimed = match claimed {
                        Ok(claimed) => claimed,
                        Err(error) => {
                            emit_service_error(&app, &error);
                            break;
                        }
                    };
                    let Some(mutation) = claimed else {
                        break;
                    };
                    emit_update(&app, &mutation, None);
                    let app_for_run = app.clone();
                    tauri::async_runtime::spawn(async move {
                        prepare_claimed_run(app_for_run, mutation.run).await;
                    });
                }
            }
        });
    }

    pub fn wake(&self) {
        self.notify.notify_one();
    }
    fn begin_preparation(&self, run_id: &str) -> Result<Arc<AtomicBool>, String> {
        let cancellation = PreparationCancellation {
            requested: Arc::new(AtomicBool::new(false)),
            stopped: Arc::new(PreparationCompletion::default()),
        };
        let requested = Arc::clone(&cancellation.requested);
        let replaced = self
            .preparation_cancellations
            .lock()
            .map_err(|error| error.to_string())?
            .insert(run_id.to_owned(), cancellation);
        if let Some(replaced) = replaced {
            replaced.requested.store(true, Ordering::Release);
            replaced.stopped.finish();
        }
        Ok(requested)
    }

    fn cancel_preparation(
        &self,
        run_id: &str,
    ) -> Result<Option<Arc<PreparationCompletion>>, String> {
        let cancellation = self
            .preparation_cancellations
            .lock()
            .map_err(|error| error.to_string())?
            .get(run_id)
            .cloned();
        if let Some(cancellation) = cancellation {
            cancellation.requested.store(true, Ordering::Release);
            return Ok(Some(cancellation.stopped));
        }
        Ok(None)
    }

    fn finish_preparation(&self, run_id: &str, cancellation: &Arc<AtomicBool>) {
        if let Ok(mut cancellations) = self.preparation_cancellations.lock() {
            if cancellations
                .get(run_id)
                .is_some_and(|current| Arc::ptr_eq(&current.requested, cancellation))
            {
                if let Some(finished) = cancellations.remove(run_id) {
                    finished.stopped.finish();
                }
            }
        }
    }

    fn finish_preparation_after_error(
        &self,
        run_id: &str,
        cancellation: &Arc<AtomicBool>,
        settle: impl FnOnce(),
    ) {
        let stopped = if let Ok(mut cancellations) = self.preparation_cancellations.lock() {
            let is_current = cancellations
                .get(run_id)
                .is_some_and(|current| Arc::ptr_eq(&current.requested, cancellation));
            if !is_current {
                return;
            }
            if !cancellation.load(Ordering::Acquire) {
                settle();
            }
            cancellations
                .remove(run_id)
                .map(|finished| finished.stopped)
        } else {
            None
        };
        if let Some(stopped) = stopped {
            stopped.finish();
        }
    }

    pub(crate) fn publish_enqueued(&self, app: &AppHandle, mutation: &RunMutation) {
        emit_update(app, mutation, None);
        self.wake();
    }

    pub fn enqueue(
        &self,
        app: &AppHandle,
        request: EnqueueRunRequest,
    ) -> Result<RunSnapshot, String> {
        let clean_prompt = request.prompt.trim();
        if clean_prompt.is_empty() {
            return Err("A prompt is required to enqueue a Xiao run.".to_owned());
        }
        let repository = app.state::<XiaoRepository>();
        let context =
            resolve_execution_context(&repository, &request.project_path, Some(&request.task_id))?;
        let defaults = repository.run_task_defaults(&context.project_path, &request.task_id)?;
        let model = effective_model(defaults.model, request.default_model)?;
        let reasoning_effort = effective_reasoning_effort(
            defaults.reasoning_effort,
            request.default_reasoning_effort,
        )?;
        let mutation = repository.enqueue_run(NewRun {
            id: new_uuid_v7(),
            workspace_id: defaults.workspace_id,
            task_id: request.task_id,
            idempotency_key: request.idempotency_key,
            parent_run_id: None,
            candidate_group_id: None,
            routine_occurrence_id: None,
            execution_environment_id: context.environment.id,
            execution_root: context.execution_root,
            managed_worktree_id: context.managed_worktree.map(|worktree| worktree.id),
            prompt: clean_prompt.to_owned(),
            input: request.input,
            history: request.history,
            model: Some(model),
            reasoning_effort: Some(reasoning_effort),
            service_tier: request.service_tier,
            mode: defaults.mode,
            approval_policy: defaults.approval_policy,
            sandbox_mode: defaults.sandbox_mode,
            goal: defaults.goal,
            queued_at: now_millis()?,
        })?;
        let snapshot = mutation.run.snapshot();
        emit_update(app, &mutation, None);
        self.wake();
        Ok(snapshot)
    }

    pub fn list(
        &self,
        repository: &XiaoRepository,
        workspace_path: &str,
        task_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<RunSnapshot>, String> {
        repository
            .list_runs(workspace_path, task_id, limit)
            .map(|runs| runs.iter().map(RunRecord::snapshot).collect())
    }

    pub async fn cancel(&self, app: &AppHandle, run_id: &str) -> Result<RunSnapshot, String> {
        let current_status = {
            let repository = app.state::<XiaoRepository>();
            repository.get_run(run_id)?.status
        };
        let needs_dispatch_lock =
            matches!(current_status, RunStatus::Queued | RunStatus::Preparing);
        let _dispatch = if needs_dispatch_lock {
            Some(self.dispatch.lock().await)
        } else {
            None
        };
        let current_status = if needs_dispatch_lock {
            let repository = app.state::<XiaoRepository>();
            repository.get_run(run_id)?.status
        } else {
            current_status
        };
        let preparation_stop = if current_status == RunStatus::Preparing {
            self.cancel_preparation(run_id)?
        } else {
            None
        };
        if let Some(stopped) = preparation_stop {
            stopped.wait().await;
        }
        let disposition = {
            let _lifecycle = self
                .input_resolutions
                .lock()
                .map_err(|error| error.to_string())?;
            let repository = app.state::<XiaoRepository>();
            repository.request_run_cancel(run_id)?
        };
        match disposition {
            CancelDisposition::Settled(mutation) => {
                let snapshot = mutation.run.snapshot();
                emit_update(app, &mutation, None);
                self.wake();
                Ok(snapshot)
            }
            CancelDisposition::Verification { run, event } => {
                if event.is_some() {
                    emit_update(
                        app,
                        &RunMutation {
                            run: run.clone(),
                            event,
                        },
                        None,
                    );
                }
                if let Some(stop) = app.state::<VerificationService>().cancel(run_id)? {
                    stop.wait().await?;
                }
                let mutation = app.state::<XiaoRepository>().finish_run_cancel(run_id)?;
                let snapshot = mutation.run.snapshot();
                emit_update(app, &mutation, None);
                self.wake();
                Ok(snapshot)
            }
            CancelDisposition::Interrupt { run, event } => {
                if event.is_some() {
                    emit_update(
                        app,
                        &RunMutation {
                            run: run.clone(),
                            event,
                        },
                        None,
                    );
                }
                let environment_id = run.execution_environment_id.clone();
                let generation = run
                    .runtime_generation
                    .ok_or("The active Xiao run has no runtime generation.")?;
                let thread_id = run
                    .thread_id
                    .as_deref()
                    .ok_or("The active Xiao run has no thread id.")?;
                let turn_id = run
                    .turn_id
                    .as_deref()
                    .ok_or("The active Xiao run has no turn id.")?;
                let runtime = {
                    let registry = app.state::<EnvironmentRuntimeRegistry>();
                    registry.require_thread_task(
                        &environment_id,
                        thread_id,
                        &run.workspace_path,
                        &run.task_id,
                        &run.execution_root,
                    )?;
                    let current_generation = registry.generation(&environment_id)?;
                    if current_generation != generation {
                        return Err(
                            "The Xiao run belongs to a stale runtime generation.".to_owned()
                        );
                    }
                    registry.runtime(&environment_id)?
                };
                runtime
                    .request_turn_interrupt(
                        generation,
                        json!({ "threadId": thread_id, "turnId": turn_id }),
                    )
                    .await?;
                match self.finish_checkpoint(run_id) {
                    Ok(Some(checkpoint)) => {
                        if let Err(error) = app.state::<XiaoRepository>().record_turn_checkpoint(
                            run_id,
                            turn_id,
                            &checkpoint,
                        ) {
                            emit_service_error_for_workspace(
                                app,
                                Some(&run.workspace_path),
                                &format!("Could not persist interrupted turn checkpoint: {error}"),
                            );
                        }
                    }
                    Ok(None) => {}
                    Err(error) => emit_service_error_for_workspace(
                        app,
                        Some(&run.workspace_path),
                        &format!("Could not finalize undo checkpoint: {error}"),
                    ),
                }
                let mutation = app.state::<XiaoRepository>().finish_run_cancel(run_id)?;
                let snapshot = mutation.run.snapshot();
                emit_update(app, &mutation, None);
                self.wake();
                Ok(snapshot)
            }
        }
    }

    pub(crate) fn rerun_verification(
        &self,
        app: &AppHandle,
        run_id: &str,
        request_key: &str,
    ) -> Result<RunSnapshot, String> {
        let _lifecycle = self
            .input_resolutions
            .lock()
            .map_err(|error| error.to_string())?;
        app.state::<VerificationService>()
            .rerun(app, run_id, request_key)
    }

    pub fn retry(
        &self,
        app: &AppHandle,
        run_id: &str,
        idempotency_key: &str,
    ) -> Result<RunSnapshot, String> {
        let repository = app.state::<XiaoRepository>();
        let mutation = repository.retry_run(run_id, idempotency_key)?;
        let snapshot = mutation.run.snapshot();
        emit_update(app, &mutation, None);
        self.wake();
        Ok(snapshot)
    }

    pub async fn resolve_input(
        &self,
        app: &AppHandle,
        pending_input_id: &str,
        result: Value,
    ) -> Result<RunSnapshot, String> {
        let _resolution = self
            .input_resolutions
            .lock()
            .map_err(|error| error.to_string())?;
        let pending = {
            let repository = app.state::<XiaoRepository>();
            repository.get_pending_input(pending_input_id)?
        };
        if pending.resolved_at.is_some() {
            let repository = app.state::<XiaoRepository>();
            return Ok(repository.get_run(&pending.run_id)?.snapshot());
        }
        if pending.invalidated_at.is_some() {
            return Err("This Xiao input request expired with its runtime generation.".to_owned());
        }
        let run = {
            let repository = app.state::<XiaoRepository>();
            repository.get_run(&pending.run_id)?
        };
        require_pending_route(&run, &pending)?;
        let request_id: Value = serde_json::from_str(&pending.request_id)
            .map_err(|_| "The Xiao input request id is invalid.".to_owned())?;
        let registry = app.state::<EnvironmentRuntimeRegistry>();
        registry.reply(
            &run.execution_environment_id,
            pending.runtime_generation,
            request_id,
            result,
        )?;
        let repository = app.state::<XiaoRepository>();
        let (mutation, pending) = repository.resolve_pending_input(pending_input_id)?;
        let snapshot = mutation.run.snapshot();
        emit_update(app, &mutation, Some(pending));
        Ok(snapshot)
    }

    fn begin_checkpoint(&self, run: &RunRecord) -> Result<(), String> {
        let stale = self
            .checkpoints
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&run.id);
        if let Some(stale) = stale {
            let _ = discard_workspace_checkpoint(&stale.token);
        }
        let token = create_workspace_checkpoint(&run.execution_root)?;
        self.checkpoints
            .lock()
            .map_err(|error| error.to_string())?
            .insert(
                run.id.clone(),
                RunCheckpoint {
                    token,
                    execution_root: run.execution_root.clone(),
                },
            );
        Ok(())
    }

    fn finish_checkpoint(
        &self,
        run_id: &str,
    ) -> Result<Option<WorkspaceCheckpointCapture>, String> {
        let checkpoint = self
            .checkpoints
            .lock()
            .map_err(|error| error.to_string())?
            .remove(run_id);
        checkpoint
            .map(|checkpoint| {
                finish_workspace_checkpoint_capture(&checkpoint.execution_root, &checkpoint.token)
            })
            .transpose()
    }

    fn discard_checkpoint(&self, run_id: &str) {
        let checkpoint = self
            .checkpoints
            .lock()
            .ok()
            .and_then(|mut checkpoints| checkpoints.remove(run_id));
        if let Some(checkpoint) = checkpoint {
            let _ = discard_workspace_checkpoint(&checkpoint.token);
        }
    }

    pub fn handle_runtime_message(
        &self,
        app: &AppHandle,
        environment_id: &str,
        generation: u64,
        message: Value,
    ) {
        let workspace_path = read_thread_id(&message).and_then(|thread_id| {
            app.state::<XiaoRepository>()
                .find_active_run_route(environment_id, generation, thread_id)
                .ok()
                .flatten()
                .map(|route| route.workspace_path)
        });
        if let Err(error) = apply_runtime_message(
            app,
            environment_id,
            generation,
            message,
            &self.input_resolutions,
        ) {
            emit_service_error_for_workspace(app, workspace_path.as_deref(), &error);
        }
    }

    pub fn handle_runtime_stopped(&self, app: &AppHandle, environment_id: &str, generation: u64) {
        let mutations = {
            let repository = app.state::<XiaoRepository>();
            repository.interrupt_runtime_generation(
                environment_id,
                generation,
                "Agent runtime stopped before the active turn settled.",
            )
        };
        match mutations {
            Ok(mutations) => {
                for mutation in mutations {
                    match self.finish_checkpoint(&mutation.run.id) {
                        Ok(Some(checkpoint)) => {
                            if let Some(turn_id) = mutation.run.turn_id.as_deref() {
                                if let Err(error) = app
                                    .state::<XiaoRepository>()
                                    .record_turn_checkpoint(&mutation.run.id, turn_id, &checkpoint)
                                {
                                    emit_service_error_for_workspace(
                                        app,
                                        Some(&mutation.run.workspace_path),
                                        &format!("Could not persist interrupted turn checkpoint: {error}"),
                                    );
                                }
                            }
                        }
                        Ok(None) => {}
                        Err(error) => emit_service_error_for_workspace(
                            app,
                            Some(&mutation.run.workspace_path),
                            &format!("Could not finalize interrupted undo checkpoint: {error}"),
                        ),
                    }
                    emit_update(app, &mutation, None);
                }
                self.wake();
            }
            Err(error) => emit_service_error(app, &error),
        }
    }
}

fn reconcile_startup(app: &AppHandle) {
    let mutations = {
        let repository = app.state::<XiaoRepository>();
        repository.reconcile_in_flight_runs()
    };
    match mutations {
        Ok(mutations) => {
            for mutation in mutations {
                emit_update(app, &mutation, None);
            }
        }
        Err(error) => emit_service_error(app, &error),
    }
}

async fn prepare_claimed_run(app: AppHandle, claimed: RunRecord) {
    let cancellation = match app.state::<RunService>().begin_preparation(&claimed.id) {
        Ok(cancellation) => cancellation,
        Err(error) => {
            settle_preparation_failure(&app, &claimed.id, RunStatus::Interrupted, &error);
            return;
        }
    };
    match app.state::<XiaoRepository>().get_run(&claimed.id) {
        Ok(run) if run.status == RunStatus::Preparing && !run.cancel_requested => {}
        Ok(_) => {
            app.state::<RunService>()
                .finish_preparation(&claimed.id, &cancellation);
            return;
        }
        Err(error) => {
            app.state::<RunService>().finish_preparation_after_error(
                &claimed.id,
                &cancellation,
                || {
                    settle_preparation_failure(&app, &claimed.id, RunStatus::Interrupted, &error);
                },
            );
            return;
        }
    }
    let before_dispatch = prepare_before_turn(&app, &claimed, Arc::clone(&cancellation)).await;
    let (attached_run, runtime, session) = match before_dispatch {
        Ok(prepared) => {
            app.state::<RunService>()
                .finish_preparation(&claimed.id, &cancellation);
            prepared
        }
        Err(error) => {
            app.state::<RunService>().finish_preparation_after_error(
                &claimed.id,
                &cancellation,
                || {
                    settle_preparation_failure(&app, &claimed.id, RunStatus::Failed, &error);
                },
            );
            return;
        }
    };

    let service = app.state::<RunService>();
    let _dispatch = service.dispatch.lock().await;
    let run = match app.state::<XiaoRepository>().get_run(&attached_run.id) {
        Ok(run) if run.status == RunStatus::Preparing && !run.cancel_requested => run,
        Ok(_) => return,
        Err(error) => {
            settle_preparation_failure(&app, &attached_run.id, RunStatus::Interrupted, &error);
            return;
        }
    };
    let turn_params = match turn_start_params(&run, &session) {
        Ok(params) => params,
        Err(error) => {
            settle_preparation_failure(&app, &run.id, RunStatus::Failed, &error);
            return;
        }
    };
    if let Err(error) = service.begin_checkpoint(&run) {
        emit_service_error_for_workspace(
            &app,
            Some(&run.workspace_path),
            &format!("Undo checkpoint unavailable: {error}"),
        );
    }
    let turn_result = runtime
        .request_turn_start(run.runtime_generation.unwrap_or_default(), turn_params)
        .await;
    let result = match turn_result {
        Ok(result) => result,
        Err(error) => {
            settle_preparation_failure(&app, &run.id, RunStatus::Interrupted, &error);
            return;
        }
    };
    let Some(turn_id) = result
        .get("turn")
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)
    else {
        settle_accepted_turn_failure(
            &app,
            &run,
            &runtime,
            "Codex turn/start returned no turn id.",
        );
        return;
    };
    let mutation = {
        let repository = app.state::<XiaoRepository>();
        repository.mark_run_running(
            &run.id,
            run.runtime_generation.unwrap_or_default(),
            run.thread_id.as_deref().unwrap_or_default(),
            turn_id,
        )
    };
    match mutation {
        Ok(mutation) => emit_update(&app, &mutation, None),
        Err(error) => {
            let current = app.state::<XiaoRepository>().get_run(&run.id);
            if current
                .as_ref()
                .is_ok_and(|current| current.status.is_terminal())
            {
                return;
            }
            settle_accepted_turn_failure(&app, &run, &runtime, &error);
        }
    }
}

fn settle_accepted_turn_failure(
    app: &AppHandle,
    run: &RunRecord,
    runtime: &Arc<crate::agent::runtime::AgentRuntime>,
    error: &str,
) {
    let generation = run.runtime_generation.unwrap_or_default();
    match runtime.stop_generation(generation) {
        Ok(_) => settle_preparation_failure(app, &run.id, RunStatus::Interrupted, error),
        Err(stop_error) => emit_service_error_for_workspace(
            app,
            Some(&run.workspace_path),
            &format!(
                "{error} The accepted turn remains nonterminal because its runtime could not be stopped safely: {stop_error}"
            ),
        ),
    }
}

async fn prepare_before_turn(
    app: &AppHandle,
    claimed: &RunRecord,
    cancellation: Arc<AtomicBool>,
) -> Result<
    (
        RunRecord,
        Arc<crate::agent::runtime::AgentRuntime>,
        PersistentAgentSession,
    ),
    String,
> {
    let context = {
        let repository = app.state::<XiaoRepository>();
        resolve_execution_context(&repository, &claimed.workspace_path, Some(&claimed.task_id))?
    };
    if context.environment.id != claimed.execution_environment_id
        || context.execution_root != claimed.execution_root
        || context
            .managed_worktree
            .as_ref()
            .map(|worktree| &worktree.id)
            != claimed.managed_worktree_id.as_ref()
    {
        return Err("The Xiao run execution context changed after enqueue.".to_owned());
    }
    let defaults = {
        let repository = app.state::<XiaoRepository>();
        repository.run_task_defaults(&claimed.workspace_path, &claimed.task_id)?
    };
    capture_baseline_if_required(app, claimed, cancellation).await?;
    let start = {
        let registry = app.state::<EnvironmentRuntimeRegistry>();
        registry.start(app.clone(), &claimed.execution_environment_id)?
    };
    let runtime = {
        let registry = app.state::<EnvironmentRuntimeRegistry>();
        registry.runtime(&claimed.execution_environment_id)?
    };
    let session = prepare_persistent_xiao_session(
        &runtime,
        &claimed.execution_root,
        &claimed.workspace_path,
        &claimed.task_id,
        claimed.model.as_deref(),
        claimed.history.clone(),
        defaults.thread_binding.as_ref(),
        claimed.service_tier.as_deref(),
        &claimed.approval_policy,
        &claimed.sandbox_mode,
        codex_supports_dynamic_tools(&start.version),
    )
    .await?;
    let attachment = RuntimeAttachment {
        generation: start.generation,
        thread_id: session.thread_id.clone(),
        thread_source: THREAD_SOURCE.to_owned(),
        cli_version: start.version,
        materialized: session.materialized,
    };
    let mutation = {
        let repository = app.state::<XiaoRepository>();
        repository.attach_run_runtime(&claimed.id, &attachment)?
    };
    emit_update(app, &mutation, None);
    let run = mutation.run;
    if let Some(goal) = run.goal.as_ref() {
        let objective = goal.get("objective").and_then(Value::as_str);
        let status = goal.get("status").and_then(Value::as_str);
        if let (Some(objective), Some(status)) = (objective, status) {
            runtime
                .request(
                    "thread/goal/set".to_owned(),
                    json!({
                        "threadId": session.thread_id,
                        "objective": objective,
                        "status": status,
                    }),
                )
                .await?;
        }
    }
    Ok((run, runtime, session))
}

fn effective_reasoning_effort(
    selected: Option<String>,
    advertised_default: Option<String>,
) -> Result<String, String> {
    if let Some(selected) = selected {
        return Ok(selected);
    }
    advertised_default
        .filter(|effort| !effort.trim().is_empty())
        .ok_or_else(|| {
            "Codex did not advertise a default reasoning effort for this model.".to_owned()
        })
}

fn effective_model(
    selected: Option<String>,
    advertised_default: Option<String>,
) -> Result<String, String> {
    selected
        .filter(|model| !model.trim().is_empty())
        .or_else(|| advertised_default.filter(|model| !model.trim().is_empty()))
        .ok_or_else(|| "Codex did not advertise a default model.".to_owned())
}

fn turn_model_override<'a>(
    run_model: Option<&'a str>,
    session_model: Option<&'a str>,
) -> Option<&'a str> {
    run_model.or(session_model)
}

fn turn_start_params(run: &RunRecord, session: &PersistentAgentSession) -> Result<Value, String> {
    let sandbox_policy = match run.sandbox_mode.as_str() {
        "danger-full-access" => json!({ "type": "dangerFullAccess" }),
        "read-only" => json!({ "type": "readOnly" }),
        _ => json!({
            "type": "workspaceWrite",
            "writableRoots": [run.execution_root],
            "networkAccess": false,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false,
        }),
    };
    let mut params = Map::from_iter([
        ("threadId".to_owned(), json!(session.thread_id)),
        ("input".to_owned(), json!(run.input)),
        ("effort".to_owned(), json!(run.reasoning_effort)),
        ("serviceTier".to_owned(), json!(run.service_tier)),
        ("approvalPolicy".to_owned(), json!(run.approval_policy)),
        ("sandboxPolicy".to_owned(), sandbox_policy),
    ]);
    let model = turn_model_override(run.model.as_deref(), session.model.as_deref())
        .ok_or_else(|| "Cannot start a Codex turn without a model.".to_owned())?;
    params.insert("model".to_owned(), json!(model));
    params.insert(
        "collaborationMode".to_owned(),
        json!({
            "mode": if run.mode == "plan" { "plan" } else { "default" },
            "settings": {
                "model": model,
                "reasoning_effort": run.reasoning_effort,
                "developer_instructions": null,
            },
        }),
    );
    if run.mode != "plan" {
        params.insert(
            "additionalContext".to_owned(),
            json!({
                "xiao.plan-progress": {
                    "kind": "application",
                    "value": PLAN_PROGRESS_INSTRUCTIONS,
                },
            }),
        );
    }
    Ok(Value::Object(params))
}

fn settle_preparation_failure(app: &AppHandle, run_id: &str, target: RunStatus, error: &str) {
    app.state::<RunService>().discard_checkpoint(run_id);
    let current = app.state::<XiaoRepository>().get_run(run_id);
    let Ok(current) = current else {
        emit_service_error(app, error);
        return;
    };
    if current.status.is_terminal() {
        return;
    }
    let target = if current.cancel_requested {
        RunStatus::Cancelled
    } else {
        target
    };
    let event_type = match target {
        RunStatus::Cancelled => "run.cancelled",
        RunStatus::Interrupted => "run.interrupted",
        RunStatus::NeedsAttention => "verification.blocked",
        _ => "run.failed",
    };
    let key = if target == RunStatus::NeedsAttention {
        "verification:start-blocked".to_owned()
    } else {
        format!("preparation:{}", target.as_database())
    };
    let mutation = app.state::<XiaoRepository>().transition_run(
        run_id,
        target,
        event_type,
        Some(&key),
        &json!({ "diagnostic": bounded_diagnostic(error) }),
    );
    match mutation {
        Ok(mutation) => {
            emit_update(app, &mutation, None);
            app.state::<RunService>().wake();
        }
        Err(transition_error) => {
            emit_service_error_for_workspace(app, Some(&current.workspace_path), &transition_error)
        }
    }
}

fn apply_runtime_message(
    app: &AppHandle,
    environment_id: &str,
    generation: u64,
    message: Value,
    lifecycle: &Mutex<()>,
) -> Result<(), String> {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return Ok(());
    };
    let _terminal_lifecycle = if method == "turn/completed" {
        Some(lifecycle.lock().map_err(|error| error.to_string())?)
    } else {
        None
    };
    let Some(thread_id) = read_thread_id(&message) else {
        return Ok(());
    };
    let route = {
        let repository = app.state::<XiaoRepository>();
        repository.find_active_run_route(environment_id, generation, thread_id)?
    };
    let Some(route) = route else {
        return Ok(());
    };
    let turn_id = read_turn_id(&message);
    let item_id = read_item_id(&message);
    validate_message_correlation(method, &route, turn_id, item_id)?;
    let safe_message = if is_live_only_method(method) {
        live_protocol_message(&message, &route.execution_root)
    } else {
        safe_protocol_message(&message, &route.execution_root)
    };

    if method == "turn/started" {
        let turn_id = turn_id.ok_or("Codex turn/started did not include a turn id.")?;
        let mutation = {
            let repository = app.state::<XiaoRepository>();
            repository.mark_run_running(&route.id, generation, thread_id, turn_id)?
        };
        emit_update(app, &mutation, None);
        if mutation.event.is_some() {
            emit_protocol(app, &mutation, generation, &safe_message, None, None);
        }
        return Ok(());
    }

    if method == "item/tool/call" {
        dispatch_lsp_tool_call(app, &route, generation, &message)?;
        return Ok(());
    }

    if let Some(kind) = pending_input_kind(method) {
        let request_id = message
            .get("id")
            .ok_or("Codex input request did not include a request id.")?;
        let Some((turn_id, item_id)) = pending_input_route(kind, turn_id, item_id)? else {
            app.state::<EnvironmentRuntimeRegistry>().reply(
                &route.execution_environment_id,
                generation,
                request_id.clone(),
                mcp_elicitation_decline_result(),
            )?;
            return Ok(());
        };
        let request_id = serde_json::to_string(request_id)
            .map_err(|error| format!("Could not encode Codex request id: {error}"))?;
        let (mutation, pending) = {
            let repository = app.state::<XiaoRepository>();
            repository.open_pending_input(NewPendingInput {
                run_id: route.id.clone(),
                runtime_generation: generation,
                request_id,
                thread_id: thread_id.to_owned(),
                turn_id: turn_id.to_owned(),
                item_id: item_id.to_owned(),
                kind,
                safe_summary: safe_message
                    .get("params")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            })?
        };
        emit_update(app, &mutation, Some(pending.clone()));
        if mutation.event.is_some() {
            emit_protocol(
                app,
                &mutation,
                generation,
                &safe_message,
                None,
                Some(pending.clone()),
            );
        }
        if route.approval_policy == "never" || kind == PendingInputKind::McpElicitation {
            auto_decline_pending(app, &route, &pending, kind)?;
        }
        return Ok(());
    }

    if method == "turn/completed" {
        let turn_id = turn_id.ok_or("Codex turn/completed did not include a turn id.")?;
        if route.turn_id.as_deref() != Some(turn_id) {
            return Err("A late Codex completion targeted another Xiao turn.".to_owned());
        }
        let status = message
            .get("params")
            .and_then(|params| params.get("turn"))
            .and_then(|turn| turn.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("failed");
        let runtime_status = match status {
            "completed" => RunStatus::Completed,
            "interrupted" => RunStatus::Interrupted,
            _ => RunStatus::Failed,
        };
        let turn_checkpoint = match app.state::<RunService>().finish_checkpoint(&route.id) {
            Ok(checkpoint) => checkpoint,
            Err(error) => {
                emit_service_error_for_workspace(
                    app,
                    Some(&route.workspace_path),
                    &format!("Could not finalize undo checkpoint: {error}"),
                );
                None
            }
        };
        let turn_diff = turn_checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.patch.clone());
        let mutation = {
            let payload = json!({
                "protocol": safe_message,
                "turnDiff": turn_diff.as_deref(),
            });
            let repository = app.state::<XiaoRepository>();
            repository.settle_runtime_turn_with_checkpoint(RuntimeTurnSettlement {
                run_id: &route.id,
                generation,
                thread_id,
                turn_id,
                runtime_status,
                payload: &payload,
                checkpoint: turn_checkpoint.as_ref(),
            })?
        };
        emit_update(app, &mutation, None);
        if mutation.event.is_some() {
            emit_protocol(app, &mutation, generation, &safe_message, turn_diff, None);
        }
        if mutation.run.status == RunStatus::Verifying && mutation.event.is_some() {
            if let Err(error) = app
                .state::<VerificationService>()
                .launch_initial(app, &mutation.run.id)
            {
                settle_preparation_failure(
                    app,
                    &mutation.run.id,
                    RunStatus::NeedsAttention,
                    &error,
                );
            }
        }
        app.state::<RunService>().wake();
        return Ok(());
    }

    if is_live_only_method(method) {
        emit_live_protocol(app, &route, generation, &safe_message, None, None);
        return Ok(());
    }
    if !is_persisted_protocol_method(method) {
        return Ok(());
    }
    let event_key = lifecycle_event_key(method, generation, thread_id, turn_id, item_id);
    let mutation = {
        let repository = app.state::<XiaoRepository>();
        let event_type = format!("agent.{method}");
        repository.record_run_event(
            &route.id,
            CorrelatedRunEvent {
                generation,
                thread_id,
                turn_id,
                event_type: &event_type,
                event_key: event_key.as_deref(),
                payload: &safe_message,
            },
        )?
    };
    if mutation.event.is_some() {
        emit_protocol(app, &mutation, generation, &safe_message, None, None);
    }
    Ok(())
}

fn auto_decline_pending(
    app: &AppHandle,
    run: &RunRecord,
    pending: &PendingInputSnapshot,
    kind: PendingInputKind,
) -> Result<(), String> {
    let service = app.state::<RunService>();
    let _resolution = service
        .input_resolutions
        .lock()
        .map_err(|error| error.to_string())?;
    let current = app
        .state::<XiaoRepository>()
        .get_pending_input(&pending.id)?;
    if current.resolved_at.is_some() || current.invalidated_at.is_some() {
        return Ok(());
    }
    let request_id: Value = serde_json::from_str(&pending.request_id)
        .map_err(|_| "The pending Codex request id is invalid.".to_owned())?;
    let result = auto_decline_result(kind);
    let registry = app.state::<EnvironmentRuntimeRegistry>();
    registry.reply(
        &run.execution_environment_id,
        pending.runtime_generation,
        request_id,
        result,
    )?;
    let (mutation, resolved) = app
        .state::<XiaoRepository>()
        .resolve_pending_input(&pending.id)?;
    emit_update(app, &mutation, Some(resolved));
    Ok(())
}

fn require_pending_route(run: &RunRecord, pending: &PendingInputSnapshot) -> Result<(), String> {
    if run.status != RunStatus::WaitingForInput
        || run.cancel_requested
        || run.runtime_generation != Some(pending.runtime_generation)
        || run.thread_id.as_deref() != Some(pending.thread_id.as_str())
        || run.turn_id.as_deref() != Some(pending.turn_id.as_str())
    {
        return Err("The Xiao input request no longer matches the active run.".to_owned());
    }
    Ok(())
}

fn read_thread_id(message: &Value) -> Option<&str> {
    message.get("params")?.get("threadId")?.as_str()
}

fn read_turn_id(message: &Value) -> Option<&str> {
    let params = message.get("params")?;
    params.get("turnId").and_then(Value::as_str).or_else(|| {
        params
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
    })
}

fn read_item_id(message: &Value) -> Option<&str> {
    let params = message.get("params")?;
    params
        .get("itemId")
        .or_else(|| params.get("callId"))
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .get("item")
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str)
        })
}

fn dispatch_lsp_tool_call(
    app: &AppHandle,
    route: &RunRecord,
    generation: u64,
    message: &Value,
) -> Result<(), String> {
    let request_id = message
        .get("id")
        .cloned()
        .ok_or("Codex dynamic tool call did not include a request id.")?;
    let params = message
        .get("params")
        .and_then(Value::as_object)
        .ok_or("Codex dynamic tool call did not include parameters.")?;
    let supported_namespace = params.get("namespace").and_then(Value::as_str) == Some("xiao_lsp");
    let tool = params
        .get("tool")
        .and_then(Value::as_str)
        .ok_or("Codex dynamic tool call did not name a tool.")?
        .to_owned();
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let environment_id = route.execution_environment_id.clone();
    let execution_root = route.execution_root.clone();
    let workspace_path = route.workspace_path.clone();
    let worker_app = app.clone();
    let worker_environment_id = environment_id.clone();
    let worker_request_id = request_id.clone();
    match std::thread::Builder::new()
        .name("xiao-lsp-tool".to_owned())
        .spawn(move || {
            let result = if supported_namespace {
                worker_app.state::<LspManager>().execute_tool(
                    &worker_environment_id,
                    &execution_root,
                    &tool,
                    arguments,
                )
            } else {
                Err("Codex requested an unknown Xiao dynamic tool namespace.".to_owned())
            };
            let response = dynamic_tool_response(result);
            if let Err(error) = worker_app.state::<EnvironmentRuntimeRegistry>().reply(
                &worker_environment_id,
                generation,
                worker_request_id,
                response,
            ) {
                emit_service_error_for_workspace(&worker_app, Some(&workspace_path), &error);
            }
        }) {
        Ok(_) => Ok(()),
        Err(error) => app.state::<EnvironmentRuntimeRegistry>().reply(
            &environment_id,
            generation,
            request_id,
            dynamic_tool_response(Err(format!(
                "Could not start the Xiao LSP tool worker: {error}"
            ))),
        ),
    }
}

fn validate_message_correlation(
    method: &str,
    run: &RunRecord,
    turn_id: Option<&str>,
    item_id: Option<&str>,
) -> Result<(), String> {
    if method == "turn/started" {
        let turn_id = turn_id.ok_or("Codex turn/started did not include a turn id.")?;
        if run
            .turn_id
            .as_deref()
            .is_some_and(|expected| expected != turn_id)
        {
            return Err("A late Codex turn/start targeted another Xiao turn.".to_owned());
        }
        return Ok(());
    }
    if method.starts_with("turn/") || method.starts_with("item/") {
        let turn_id = turn_id.ok_or("Codex turn/item event did not include a turn id.")?;
        if run.turn_id.as_deref() != Some(turn_id) {
            return Err("A late Codex event targeted another Xiao turn.".to_owned());
        }
    }
    if method.starts_with("item/") && item_id.is_none() {
        return Err("Codex item event did not include an item id.".to_owned());
    }
    Ok(())
}

fn pending_input_kind(method: &str) -> Option<PendingInputKind> {
    match method {
        "item/commandExecution/requestApproval" => Some(PendingInputKind::CommandApproval),
        "item/fileChange/requestApproval" => Some(PendingInputKind::FileApproval),
        "item/permissions/requestApproval" => Some(PendingInputKind::Permissions),
        "item/tool/requestUserInput" => Some(PendingInputKind::Question),
        "mcpServer/elicitation/request" => Some(PendingInputKind::McpElicitation),
        _ => None,
    }
}

fn pending_input_route<'a>(
    kind: PendingInputKind,
    turn_id: Option<&'a str>,
    item_id: Option<&'a str>,
) -> Result<Option<(&'a str, &'a str)>, String> {
    if kind == PendingInputKind::McpElicitation {
        return Ok(None);
    }
    let turn_id = turn_id.ok_or("Codex input request did not include a turn id.")?;
    let item_id = item_id.ok_or("Codex input request did not include an item id.")?;
    Ok(Some((turn_id, item_id)))
}

fn mcp_elicitation_decline_result() -> Value {
    json!({ "action": "decline", "content": null, "_meta": null })
}

fn auto_decline_result(kind: PendingInputKind) -> Value {
    match kind {
        PendingInputKind::McpElicitation => mcp_elicitation_decline_result(),
        PendingInputKind::Permissions => json!({ "permissions": {}, "scope": "turn" }),
        PendingInputKind::Question => json!({ "answers": {} }),
        _ => json!({ "decision": "decline" }),
    }
}

fn is_live_only_method(method: &str) -> bool {
    matches!(
        method,
        "item/agentMessage/delta"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta"
            | "item/commandExecution/outputDelta"
            | "turn/diff/updated"
    )
}

fn is_persisted_protocol_method(method: &str) -> bool {
    matches!(
        method,
        "item/started"
            | "item/completed"
            | "turn/plan/updated"
            | "thread/tokenUsage/updated"
            | "thread/name/updated"
            | "serverRequest/resolved"
    )
}

fn lifecycle_event_key(
    method: &str,
    generation: u64,
    thread_id: &str,
    turn_id: Option<&str>,
    item_id: Option<&str>,
) -> Option<String> {
    if method == "thread/tokenUsage/updated" || method == "thread/name/updated" {
        return None;
    }
    Some(format!(
        "{generation}/{thread_id}/{}/{}/{method}",
        turn_id.unwrap_or("none"),
        item_id.unwrap_or("none"),
    ))
}

fn live_protocol_message(message: &Value, execution_root: &str) -> Value {
    if message.get("method").and_then(Value::as_str) == Some("turn/diff/updated") {
        return json!({
            "method": "turn/diff/updated",
            "params": {
                "threadId": read_thread_id(message),
                "turnId": read_turn_id(message),
                "diff": message
                    .get("params")
                    .and_then(|params| params.get("diff"))
                    .and_then(Value::as_str)
                    .map(|diff| truncate_utf8(diff, 512 * 1024)),
            },
        });
    }
    safe_protocol_message(message, execution_root)
}

fn safe_protocol_message(message: &Value, execution_root: &str) -> Value {
    let safe = sanitize_value(message, execution_root, None, 0);
    if safe.get("method").is_some() {
        return safe;
    }
    json!({
        "method": message.get("method").and_then(Value::as_str),
        "params": {
            "threadId": read_thread_id(message),
            "turnId": read_turn_id(message),
            "itemId": read_item_id(message),
            "truncated": true,
        },
    })
}

fn is_sensitive_payload_key(name: &str) -> bool {
    let normalized = name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "env"
            | "environment"
            | "environmentvariable"
            | "environmentvariables"
            | "headers"
            | "auth"
            | "authentication"
            | "authorization"
            | "cookie"
            | "cookies"
            | "cookiejar"
            | "setcookie"
            | "password"
            | "passwd"
            | "credential"
            | "credentials"
            | "privatekey"
            | "encryptedcontent"
    ) || normalized.ends_with("token")
        || normalized.ends_with("apikey")
        || (normalized.contains("secret") && normalized != "issecret")
}

fn sanitize_value(value: &Value, root: &str, key: Option<&str>, depth: usize) -> Value {
    if depth > 12 {
        return Value::String("[truncated]".to_owned());
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(value) => {
            if value.starts_with("data:") {
                return Value::String("[data omitted]".to_owned());
            }
            let limit = match key {
                Some("message" | "reason" | "error") => 4 * 1024,
                Some("diff") => 512 * 1024,
                Some("aggregatedOutput" | "delta" | "text") => 16 * 1024,
                _ => 8 * 1024,
            };
            let mut clean = truncate_utf8(value, limit);
            if matches!(key, Some("path" | "cwd")) {
                clean = relative_path(&clean, root);
            }
            Value::String(clean)
        }
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(200)
                .map(|value| sanitize_value(value, root, key, depth + 1))
                .collect(),
        ),
        Value::Object(values) => {
            let mut safe = Map::new();
            for (name, value) in values {
                if is_sensitive_payload_key(name) {
                    continue;
                }
                safe.insert(
                    name.clone(),
                    sanitize_value(value, root, Some(name), depth + 1),
                );
            }
            let candidate = Value::Object(safe);
            if serde_json::to_vec(&candidate).is_ok_and(|bytes| bytes.len() <= 64 * 1024) {
                candidate
            } else {
                json!({ "truncated": true })
            }
        }
    }
}

fn truncate_utf8(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn relative_path(value: &str, root: &str) -> String {
    let normalized_value = value.replace('\\', "/");
    let is_absolute = normalized_value.starts_with('/')
        || normalized_value.starts_with("//")
        || normalized_value.as_bytes().get(1) == Some(&b':');
    if !is_absolute {
        return normalized_value;
    }
    let normalized_root = root.replace('\\', "/");
    if normalized_value.eq_ignore_ascii_case(&normalized_root) {
        return ".".to_owned();
    }
    let prefix = format!("{}/", normalized_root.trim_end_matches('/'));
    if normalized_value
        .get(..prefix.len())
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(&prefix))
    {
        return normalized_value[prefix.len()..].to_owned();
    }
    "[external path]".to_owned()
}

pub(crate) fn emit_update(
    app: &AppHandle,
    mutation: &RunMutation,
    pending_input: Option<PendingInputSnapshot>,
) {
    if let Some(service) = app.try_state::<RoutineService>() {
        service.handle_run_update(app, &mutation.run, pending_input.as_ref());
    }
    let _ = app.emit(
        "xiao://run-update",
        RunUpdateEnvelope {
            snapshot: mutation.run.snapshot(),
            event: mutation.event.clone(),
            pending_input,
        },
    );
}

fn emit_protocol(
    app: &AppHandle,
    mutation: &RunMutation,
    generation: u64,
    message: &Value,
    turn_diff: Option<String>,
    pending_input: Option<PendingInputSnapshot>,
) {
    let Some(event) = mutation.event.as_ref() else {
        return;
    };
    let run = &mutation.run;
    let _ = app.emit(
        "xiao://run-protocol",
        RunProtocolEnvelope {
            run_id: run.id.clone(),
            task_id: run.task_id.clone(),
            execution_environment_id: run.execution_environment_id.clone(),
            runtime_generation: generation,
            thread_id: run.thread_id.clone().unwrap_or_default(),
            turn_id: read_turn_id(message).map(str::to_owned),
            item_id: read_item_id(message).map(str::to_owned),
            sequence: Some(event.sequence),
            message: message.clone(),
            turn_diff,
            pending_input,
        },
    );
}

fn emit_live_protocol(
    app: &AppHandle,
    run: &RunRecord,
    generation: u64,
    message: &Value,
    turn_diff: Option<String>,
    pending_input: Option<PendingInputSnapshot>,
) {
    let _ = app.emit(
        "xiao://run-protocol",
        RunProtocolEnvelope {
            run_id: run.id.clone(),
            task_id: run.task_id.clone(),
            execution_environment_id: run.execution_environment_id.clone(),
            runtime_generation: generation,
            thread_id: run.thread_id.clone().unwrap_or_default(),
            turn_id: read_turn_id(message).map(str::to_owned),
            item_id: read_item_id(message).map(str::to_owned),
            sequence: None,
            message: message.clone(),
            turn_diff,
            pending_input,
        },
    );
}

pub(crate) fn emit_service_error(app: &AppHandle, error: &str) {
    emit_service_error_for_workspace(app, None, error);
}

pub(crate) fn emit_service_error_for_workspace(
    app: &AppHandle,
    workspace_path: Option<&str>,
    error: &str,
) {
    let _ = app.emit(
        "xiao://run-service-error",
        RunServiceErrorEnvelope {
            workspace_path: workspace_path.map(str::to_owned),
            message: bounded_diagnostic(error),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preparation_cancellation_requests_stop_and_waits_for_finish() {
        let service = RunService::default();
        let cancellation = service.begin_preparation("run-1").unwrap();
        let stopped = service.cancel_preparation("run-1").unwrap().unwrap();

        assert!(cancellation.load(Ordering::Acquire));
        assert!(!stopped.completed.load(Ordering::Acquire));

        service.finish_preparation("run-1", &cancellation);
        tauri::async_runtime::block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(1), stopped.wait())
                .await
                .expect("preparation cancellation did not observe completion");
        });
    }

    #[test]
    fn preparation_error_settles_before_completion_unless_cancel_registered() {
        let service = RunService::default();
        let ordinary = service.begin_preparation("ordinary").unwrap();
        let ordinary_completion = Arc::clone(
            &service
                .preparation_cancellations
                .lock()
                .unwrap()
                .get("ordinary")
                .unwrap()
                .stopped,
        );
        let ordinary_settled = AtomicBool::new(false);

        service.finish_preparation_after_error("ordinary", &ordinary, || {
            assert!(!ordinary_completion.completed.load(Ordering::Acquire));
            ordinary_settled.store(true, Ordering::Release);
        });

        assert!(ordinary_settled.load(Ordering::Acquire));
        assert!(ordinary_completion.completed.load(Ordering::Acquire));

        let cancelled = service.begin_preparation("cancelled").unwrap();
        let cancelled_completion = service.cancel_preparation("cancelled").unwrap().unwrap();
        let cancelled_settled = AtomicBool::new(false);
        service.finish_preparation_after_error("cancelled", &cancelled, || {
            cancelled_settled.store(true, Ordering::Release);
        });

        assert!(!cancelled_settled.load(Ordering::Acquire));
        assert!(cancelled_completion.completed.load(Ordering::Acquire));
    }

    #[test]
    fn preparation_completion_wakes_concurrent_and_late_waiters() {
        let completion = Arc::new(PreparationCompletion::default());
        tauri::async_runtime::block_on(async {
            let first = Arc::clone(&completion);
            let second = Arc::clone(&completion);
            let finisher = Arc::clone(&completion);
            tokio::time::timeout(std::time::Duration::from_secs(1), async move {
                tokio::join!(first.wait(), second.wait(), async move {
                    tokio::task::yield_now().await;
                    finisher.finish();
                });
            })
            .await
            .expect("concurrent preparation completion waiters hung");

            tokio::time::timeout(std::time::Duration::from_secs(1), completion.wait())
                .await
                .expect("a late preparation completion waiter hung");
        });
    }

    #[test]
    fn safe_protocol_payload_redacts_secrets_data_and_external_paths() {
        let safe = safe_protocol_message(
            &json!({
                "method": "item/completed",
                "params": {
                    "cwd": "C:/workspace/src",
                    "path": "D:/private/file",
                    "authorization": "bearer secret",
                    "token": "plain-token",
                    "sessionToken": "session-token",
                    "apiKey": "api-key",
                    "password": "password",
                    "cookie": "session=cookie",
                    "encryptedContent": "private reasoning",
                    "preview": "data:image/png;base64,secret",
                    "nested": {
                        "secretAnswer": "hidden",
                        "message": "ok",
                        "tokenUsage": { "inputTokens": 12 },
                    },
                }
            }),
            "C:/workspace",
        );
        assert_eq!(safe["params"]["cwd"], "src");
        assert_eq!(safe["params"]["path"], "[external path]");
        assert!(safe["params"].get("authorization").is_none());
        assert!(safe["params"].get("token").is_none());
        assert!(safe["params"].get("sessionToken").is_none());
        assert!(safe["params"].get("apiKey").is_none());
        assert!(safe["params"].get("password").is_none());
        assert!(safe["params"].get("cookie").is_none());
        assert!(safe["params"].get("encryptedContent").is_none());
        assert_eq!(safe["params"]["preview"], "[data omitted]");
        assert!(safe["params"]["nested"].get("secretAnswer").is_none());
        assert_eq!(safe["params"]["nested"]["tokenUsage"]["inputTokens"], 12);
    }

    #[test]
    fn lifecycle_keys_include_generation_and_full_route() {
        assert_eq!(
            lifecycle_event_key("item/completed", 4, "thread", Some("turn"), Some("item"))
                .as_deref(),
            Some("4/thread/turn/item/item/completed")
        );
        assert!(
            lifecycle_event_key("thread/tokenUsage/updated", 4, "thread", None, None).is_none()
        );
    }

    #[test]
    fn runtime_limits_and_live_event_policy_are_fixed() {
        assert_eq!(RUN_CONCURRENCY_LIMIT, 2);
        assert!(is_live_only_method("item/agentMessage/delta"));
        assert!(!is_persisted_protocol_method("item/agentMessage/delta"));
        assert!(is_persisted_protocol_method("item/completed"));
    }

    #[test]
    fn mcp_elicitation_auto_decline_does_not_require_turn_or_item_ids() {
        assert_eq!(
            pending_input_route(PendingInputKind::McpElicitation, None, None),
            Ok(None)
        );
        assert_eq!(
            mcp_elicitation_decline_result(),
            json!({ "action": "decline", "content": null, "_meta": null })
        );
        assert!(pending_input_route(PendingInputKind::Question, None, None).is_err());
    }

    #[test]
    fn question_auto_decline_uses_request_user_input_response_schema() {
        assert_eq!(
            auto_decline_result(PendingInputKind::Question),
            json!({ "answers": {} })
        );
    }

    #[test]
    fn default_reasoning_effort_becomes_an_explicit_turn_override() {
        assert_eq!(
            effective_reasoning_effort(None, Some("medium".to_owned())),
            Ok("medium".to_owned())
        );
        assert_eq!(
            effective_reasoning_effort(Some("high".to_owned()), Some("medium".to_owned()),),
            Ok("high".to_owned())
        );
        assert!(effective_reasoning_effort(None, None).is_err());
    }

    #[test]
    fn changed_model_overrides_the_model_stored_on_a_bound_thread() {
        let selected =
            effective_model(Some("model-b".to_owned()), Some("model-default".to_owned())).unwrap();

        assert_eq!(
            turn_model_override(Some(selected.as_str()), Some("model-a")),
            Some("model-b")
        );
    }

    #[test]
    fn advertised_default_replaces_a_bound_threads_explicit_model() {
        let selected = effective_model(None, Some("model-default".to_owned())).unwrap();

        assert_eq!(
            turn_model_override(Some(selected.as_str()), Some("model-a")),
            Some("model-default")
        );
    }

    #[test]
    fn turn_parameters_are_native_scoped_and_emit_explicit_collaboration_modes() {
        let run = RunRecord {
            id: "run".to_owned(),
            workspace_id: 1,
            workspace_path: "C:/project".to_owned(),
            task_id: "task".to_owned(),
            idempotency_key: "key".to_owned(),
            parent_run_id: None,
            candidate_group_id: None,
            routine_occurrence_id: None,
            acceptance_contract_source_version_id: None,
            acceptance_contract_snapshot: None,
            acceptance_contract_snapshot_sha256: None,
            verification_baseline_state: VerificationBaselineState::NotRequired,
            verification_baseline_artifact_id: None,
            verification_baseline_diagnostic: None,
            latest_verification_attempt_id: None,
            status: RunStatus::Preparing,
            agent_outcome: super::super::models::AgentOutcome::Pending,
            verification_outcome: super::super::models::VerificationOutcome::NotRequested,
            execution_environment_id: "environment".to_owned(),
            execution_root: "C:/owned".to_owned(),
            managed_worktree_id: None,
            prompt: "prompt".to_owned(),
            input: vec![json!({ "type": "text", "text": "prompt" })],
            history: Vec::new(),
            model: Some("gpt-test".to_owned()),
            reasoning_effort: Some("medium".to_owned()),
            service_tier: None,
            mode: "default".to_owned(),
            approval_policy: "on-request".to_owned(),
            sandbox_mode: "workspace-write".to_owned(),
            goal: None,
            thread_id: Some("thread".to_owned()),
            thread_source: Some(THREAD_SOURCE.to_owned()),
            cli_version: Some("test".to_owned()),
            runtime_generation: Some(1),
            turn_id: None,
            cancel_requested: false,
            queued_at: 1,
            started_at: Some(1),
            finished_at: None,
            version: 1,
        };
        let session = PersistentAgentSession {
            thread_id: "thread".to_owned(),
            model: Some("gpt-test".to_owned()),
            materialized: false,
        };
        let params = turn_start_params(&run, &session).unwrap();
        assert_eq!(
            params["sandboxPolicy"]["writableRoots"],
            json!(["C:/owned"])
        );
        assert_eq!(params["threadId"], "thread");
        assert_eq!(params["model"], "gpt-test");
        assert_eq!(params["collaborationMode"]["mode"], "default");
        assert_eq!(params["collaborationMode"]["settings"]["model"], "gpt-test");
        assert_eq!(
            params["collaborationMode"]["settings"]["reasoning_effort"],
            "medium"
        );
        assert!(params.get("additionalContext").is_some());

        let mut plan_run = run.clone();
        plan_run.mode = "plan".to_owned();
        plan_run.model = Some("advertised-default".to_owned());
        let unbound_session = PersistentAgentSession {
            thread_id: "thread".to_owned(),
            model: None,
            materialized: false,
        };
        let plan_params = turn_start_params(&plan_run, &unbound_session).unwrap();
        assert_eq!(plan_params["collaborationMode"]["mode"], "plan");
        assert_eq!(
            plan_params["collaborationMode"]["settings"]["model"],
            "advertised-default"
        );
        assert!(plan_params.get("additionalContext").is_none());

        plan_run.mode = "default".to_owned();
        let default_params = turn_start_params(&plan_run, &unbound_session).unwrap();
        assert_eq!(default_params["collaborationMode"]["mode"], "default");
        assert!(default_params.get("additionalContext").is_some());

        plan_run.model = None;
        assert_eq!(
            turn_start_params(&plan_run, &unbound_session).unwrap_err(),
            "Cannot start a Codex turn without a model."
        );

        let mut running = run;
        running.turn_id = Some("turn".to_owned());
        let dynamic_tool_call = json!({
            "id": 8,
            "method": "item/tool/call",
            "params": {
                "threadId": "thread",
                "turnId": "turn",
                "callId": "call",
                "namespace": "xiao_lsp",
                "tool": "definition",
                "arguments": {}
            }
        });
        assert_eq!(read_item_id(&dynamic_tool_call), Some("call"));
        assert!(validate_message_correlation(
            "item/tool/call",
            &running,
            read_turn_id(&dynamic_tool_call),
            read_item_id(&dynamic_tool_call),
        )
        .is_ok());
        assert!(
            validate_message_correlation("turn/started", &running, Some("turn"), None,).is_ok()
        );
        assert!(
            validate_message_correlation("turn/started", &running, Some("late-turn"), None,)
                .is_err()
        );
        assert!(validate_message_correlation(
            "item/completed",
            &running,
            Some("turn"),
            Some("item"),
        )
        .is_ok());
        assert!(validate_message_correlation(
            "item/completed",
            &running,
            Some("old-turn"),
            Some("item"),
        )
        .is_err());
        assert!(
            validate_message_correlation("item/completed", &running, Some("turn"), None,).is_err()
        );
    }
}
