import { invoke } from "@tauri-apps/api/core";

import type {
  AgentAccountSummary,
  AgentAccountUsage,
  AgentModelSummary,
  AgentSessionStart,
  XiaoHistoryItem,
} from "../models/agent";
import type {
  CodexUpdateResult,
  CodexUpdateStatus,
  ExecutionContext,
  FileNode,
  GitBranch,
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

  startAgent() {
    return invoke<{ version: string; alreadyRunning: boolean }>("start_agent_runtime");
  },

  stopAgent() {
    return invoke<void>("stop_agent_runtime");
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

  replyToAgent(requestId: number | string, result: Record<string, unknown>) {
    return invoke<void>("agent_reply", { requestId, result });
  },

  readAgentAccount() {
    return invoke<AgentAccountSummary>("read_agent_account");
  },

  readAgentUsage() {
    return invoke<AgentAccountUsage>("read_agent_usage");
  },

  listAgentModels() {
    return invoke<AgentModelSummary[]>("list_agent_models");
  },

  startXiaoSession(
    projectPath: string,
    taskId: string,
    model: string | null,
    history: XiaoHistoryItem[],
    threadId: string | null,
    serviceTier: string | null,
    approvalPolicy: string,
    sandbox: string,
  ) {
    return invoke<AgentSessionStart>("start_xiao_session", {
      projectPath,
      taskId,
      model,
      history,
      threadId,
      serviceTier,
      approvalPolicy,
      sandbox,
    });
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
