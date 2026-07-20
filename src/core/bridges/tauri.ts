import { invoke } from "@tauri-apps/api/core";

import type {
  AgentAccountSummary,
  AgentAccountUsage,
  AgentModelSummary,
} from "../models/agent";
import type {
  CodexUpdateResult,
  CodexUpdateStatus,
  ExecutionContext,
  FileNode,
  GitBranch,
  GitCheckSummary,
  GitPullRequestSummary,
  GitPushResult,
  GitSummary,
  ManagedWorktreeSummary,
  WorkspaceSnapshot,
  SystemInfo,
} from "../models/workspace";
import type {
  XiaoProjectSummary,
  XiaoTimelinePage,
  XiaoWorkspaceDocument,
  XiaoWorkspaceUpdate,
} from "../models/xiao";
import type {
  EnqueueRunRequest,
  PendingInputSnapshot,
  RunEventPage,
  RunSnapshot,
} from "../models/run";
import type {
  CreateRoutineRequest,
  RoutineSummary,
  UpdateRoutineRequest,
} from "../models/routine";
import type {
  AcceptanceContractPreset,
  AcceptanceContractVersionSummary,
  SaveTaskAcceptanceContractRequest,
  VerificationEvidencePage,
} from "../models/verification";
import type {
  ExportHandoffResult,
  ImportHandoffResult,
  RestoreTurnsResult,
  TurnCheckpointSummary,
} from "../models/observatory";

export const isTauriHost = () => "__TAURI_INTERNALS__" in window;

export const nativeBridge = {
  getWorkspace(path?: string, taskId?: string | null) {
    return invoke<WorkspaceSnapshot>("get_workspace_snapshot", { path, taskId });
  },

  listWorkspaceFiles(projectPath: string, taskId: string | null, relativePath: string) {
    return invoke<FileNode[]>("list_workspace_files", { projectPath, taskId, relativePath });
  },

  getSystemInfo() {
    return invoke<SystemInfo>("get_system_info");
  },

  checkCodexUpdate() {
    return invoke<CodexUpdateStatus>("check_codex_update");
  },

  updateCodexCli() {
    return invoke<CodexUpdateResult>("update_codex_cli");
  },

  startAgent(projectPath: string, taskId: string | null) {
    return invoke<{
      version: string;
      alreadyRunning: boolean;
      environmentId: string;
      generation: number;
    }>("start_agent_runtime", { projectPath, taskId });
  },

  stopAgent(projectPath: string, taskId: string | null) {
    return invoke<void>("stop_agent_runtime", { projectPath, taskId });
  },

  agentRequest<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> | null = {},
    context?: { projectPath: string; taskId: string | null },
  ) {
    return invoke<T>("agent_request", {
      method,
      params,
      projectPath: context?.projectPath,
      taskId: context?.taskId,
    });
  },

  readAgentAccount(projectPath: string, taskId: string | null) {
    return invoke<AgentAccountSummary>("read_agent_account", { projectPath, taskId });
  },

  readAgentUsage(projectPath: string, taskId: string | null) {
    return invoke<AgentAccountUsage>("read_agent_usage", { projectPath, taskId });
  },

  listAgentModels(projectPath: string, taskId: string | null) {
    return invoke<AgentModelSummary[]>("list_agent_models", { projectPath, taskId });
  },

  enqueueXiaoRun(request: EnqueueRunRequest) {
    return invoke<RunSnapshot>("enqueue_xiao_run", { request });
  },

  listXiaoRuns(workspacePath: string, taskId: string | null = null, limit = 50) {
    return invoke<RunSnapshot[]>("list_xiao_runs", { workspacePath, taskId, limit });
  },

  listXiaoPendingInputs(workspacePath: string, taskId: string | null = null) {
    return invoke<PendingInputSnapshot[]>("list_xiao_pending_inputs", {
      workspacePath,
      taskId,
    });
  },

  loadXiaoRunEvents(runId: string, afterSequence: number | null = null, limit = 200) {
    return invoke<RunEventPage>("load_xiao_run_events", { runId, afterSequence, limit });
  },

  listXiaoTurnCheckpoints(projectPath: string, taskId: string, limit = 50) {
    return invoke<TurnCheckpointSummary[]>("list_xiao_turn_checkpoints", {
      projectPath,
      taskId,
      limit,
    });
  },

  restoreXiaoTurns(projectPath: string, taskId: string, targetCheckpointId: string) {
    return invoke<RestoreTurnsResult>("restore_xiao_turns", {
      request: { projectPath, taskId, targetCheckpointId },
    });
  },

  exportXiaoHandoff(
    projectPath: string,
    taskId: string,
    destinationPath: string,
    attachmentPaths: string[],
  ) {
    return invoke<ExportHandoffResult>("export_xiao_handoff", {
      request: { projectPath, taskId, destinationPath, attachmentPaths },
    });
  },

  importXiaoHandoff(projectPath: string, bundlePath: string) {
    return invoke<ImportHandoffResult>("import_xiao_handoff", {
      request: { projectPath, bundlePath },
    });
  },

  cancelXiaoRun(runId: string) {
    return invoke<RunSnapshot>("cancel_xiao_run", { runId });
  },

  retryXiaoRun(runId: string, idempotencyKey: string) {
    return invoke<RunSnapshot>("retry_xiao_run", { runId, idempotencyKey });
  },

  resolveXiaoRunInput(pendingInputId: string, result: Record<string, unknown>) {
    return invoke<RunSnapshot>("resolve_xiao_run_input", { pendingInputId, result });
  },

  saveXiaoTaskAcceptanceContract(request: SaveTaskAcceptanceContractRequest) {
    return invoke<AcceptanceContractVersionSummary | null>(
      "save_xiao_task_acceptance_contract",
      { request },
    );
  },

  discoverXiaoAcceptancePresets(projectPath: string, taskId: string | null) {
    return invoke<AcceptanceContractPreset[]>("discover_xiao_acceptance_presets", {
      projectPath,
      taskId,
    });
  },

  rerunXiaoVerification(runId: string, requestKey: string) {
    return invoke<RunSnapshot>("rerun_xiao_verification", { runId, requestKey });
  },

  listXiaoVerificationEvidence(runId: string, limit = 10) {
    return invoke<VerificationEvidencePage>("list_xiao_verification_evidence", {
      runId,
      limit,
    });
  },

  readXiaoVerificationArtifact(runId: string, artifactId: string) {
    return invoke<unknown>("read_xiao_verification_artifact", { runId, artifactId });
  },

  createXiaoRoutine(request: CreateRoutineRequest) {
    return invoke<RoutineSummary>("create_xiao_routine", { request });
  },

  updateXiaoRoutine(request: UpdateRoutineRequest) {
    return invoke<RoutineSummary>("update_xiao_routine", { request });
  },

  listXiaoRoutines(workspacePath: string) {
    return invoke<RoutineSummary[]>("list_xiao_routines", { workspacePath });
  },

  setXiaoRoutineEnabled(routineId: string, enabled: boolean) {
    return invoke<RoutineSummary>("set_xiao_routine_enabled", { routineId, enabled });
  },

  runXiaoRoutineNow(routineId: string, idempotencyKey: string) {
    return invoke<RoutineSummary>("run_xiao_routine_now", { routineId, idempotencyKey });
  },

  deleteXiaoRoutine(routineId: string) {
    return invoke<void>("delete_xiao_routine", { routineId });
  },

  readWorkspaceFile(projectPath: string, taskId: string | null, relativePath: string) {
    return invoke<string>("read_workspace_file", { projectPath, taskId, relativePath });
  },

  mutateGit(
    projectPath: string,
    taskId: string | null,
    action: "commit" | "discard" | "stage" | "stage-all" | "switch" | "unstage",
    paths: string[],
    message?: string,
  ) {
    return invoke<string>("mutate_git", { projectPath, taskId, action, paths, message });
  },

  getGitBranches(projectPath: string, taskId: string | null) {
    return invoke<GitBranch[]>("get_git_branches", { projectPath, taskId });
  },

  compareGitBranch(projectPath: string, taskId: string | null, baseBranch: string) {
    return invoke<GitSummary>("compare_git_branch", { projectPath, taskId, baseBranch });
  },

  getGitWorktrees(projectPath: string, taskId: string | null) {
    return invoke<Array<{ path: string; branch: string; head: string; isMain: boolean }>>(
      "get_git_worktrees",
      { projectPath, taskId },
    );
  },

  publishGitBranch(projectPath: string, taskId: string | null) {
    return invoke<GitPushResult>("publish_git_branch", { projectPath, taskId });
  },

  getGitPullRequest(projectPath: string, taskId: string | null) {
    return invoke<GitPullRequestSummary | null>("get_git_pull_request", { projectPath, taskId });
  },

  createGitDraftPullRequest(projectPath: string, taskId: string | null) {
    return invoke<GitPullRequestSummary>("create_git_draft_pull_request", { projectPath, taskId });
  },

  getGitPullRequestChecks(projectPath: string, taskId: string | null) {
    return invoke<GitCheckSummary[]>("get_git_pull_request_checks", { projectPath, taskId });
  },

  addGitWorktree(projectPath: string, targetPath: string, branch: string) {
    return invoke<void>("add_git_worktree", { projectPath, targetPath, branch });
  },

  applyGitPatch(
    projectPath: string,
    taskId: string | null,
    patch: string,
    reverse: boolean,
    checkOnly: boolean,
  ) {
    return invoke<void>("apply_git_patch", {
      projectPath,
      taskId,
      patch,
      reverse,
      checkOnly,
    });
  },

  createGitCheckpoint(projectPath: string, taskId: string | null) {
    return invoke<string>("create_git_checkpoint", { projectPath, taskId });
  },

  finishGitCheckpoint(projectPath: string, taskId: string | null, token: string) {
    return invoke<string>("finish_git_checkpoint", { projectPath, taskId, token });
  },

  discardGitCheckpoint(token: string) {
    return invoke<void>("discard_git_checkpoint", { token });
  },

  startTerminal(
    sessionId: string,
    projectPath: string,
    taskId: string | null,
    shell: string,
    cols: number,
    rows: number,
  ) {
    return invoke<{ sessionId: string; shell: string }>("start_terminal", {
      sessionId,
      projectPath,
      taskId,
      shell,
      cols,
      rows,
    });
  },

  writeTerminal(sessionId: string, data: string) {
    return invoke<void>("write_terminal", { sessionId, data });
  },

  resizeTerminal(sessionId: string, cols: number, rows: number) {
    return invoke<void>("resize_terminal", { sessionId, cols, rows });
  },

  stopTerminal(sessionId: string) {
    return invoke<void>("stop_terminal", { sessionId });
  },

  navigateBrowser(url: string, label = "xiao-browser") {
    return invoke<void>("navigate_browser", { url, label });
  },

  goBackBrowser(label = "xiao-browser") {
    return invoke<void>("go_back_browser", { label });
  },

  goForwardBrowser(label = "xiao-browser") {
    return invoke<void>("go_forward_browser", { label });
  },

  reloadBrowser(label = "xiao-browser") {
    return invoke<void>("reload_browser", { label });
  },

  getBrowserUrl(label = "xiao-browser") {
    return invoke<string>("get_browser_url", { label });
  },

  setBrowserMuted(label: string, muted: boolean) {
    return invoke<void>("set_browser_muted", { label, muted });
  },

  openWorkspacePreview(projectPath: string, taskId: string | null, relativePath: string) {
    return invoke<string>("open_workspace_preview", { projectPath, taskId, relativePath });
  },

  getXiaoExecutionContext(projectPath: string, taskId: string | null) {
    return invoke<ExecutionContext>("get_xiao_execution_context", { projectPath, taskId });
  },

  prepareXiaoManagedWorktree(projectPath: string, taskId: string) {
    return invoke<ExecutionContext>("prepare_xiao_managed_worktree", { projectPath, taskId });
  },

  listXiaoManagedWorktrees(projectPath: string) {
    return invoke<ManagedWorktreeSummary[]>("list_xiao_managed_worktrees", { projectPath });
  },

  removeXiaoManagedWorktree(
    projectPath: string,
    taskId: string,
    worktreeId: string,
    confirmed: boolean,
  ) {
    return invoke<ExecutionContext>("remove_xiao_managed_worktree", {
      projectPath,
      taskId,
      worktreeId,
      confirmed,
    });
  },

  loadXiaoWorkspace(workspacePath: string, includeActiveTimeline = true) {
    return invoke<XiaoWorkspaceDocument | null>("load_xiao_workspace", {
      workspacePath,
      includeActiveTimeline,
    });
  },

  loadXiaoTimelinePage(
    workspacePath: string,
    taskId: string,
    before: number | null = null,
    limit = 200,
  ) {
    return invoke<XiaoTimelinePage>("load_xiao_timeline_page", {
      workspacePath,
      taskId,
      before,
      limit,
    });
  },

  saveXiaoWorkspace(update: XiaoWorkspaceUpdate) {
    return invoke<void>("save_xiao_workspace", { update });
  },

  listXiaoProjects() {
    return invoke<XiaoProjectSummary[]>("list_xiao_projects");
  },

  openXiaoProject(path: string) {
    return invoke<void>("open_xiao_project", { path });
  },
};
