import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { isTauriHost, nativeBridge } from "../core/bridges/tauri";
import {
  contextUsedPercent,
  type AgentAttachment,
  type AgentFollowUp,
  type AgentGoal,
  type AgentPlan,
  type AgentTurnOutcome,
  type AgentUndoResult,
  type TimelineEntry,
} from "../core/models/agent";
import type {
  AcceptanceContractVersionSummary,
  AcceptanceGate,
} from "../core/models/verification";
import type { RoutineOpenRunTarget, RoutineSummary } from "../core/models/routine";
import type {
  XiaoProjectSummary,
  XiaoWorkspaceDocument,
  XiaoWorkspaceMode,
  XiaoWorkspaceUpdate,
} from "../core/models/xiao";
import { workspacePathComparisonKey as comparableWorkspacePath } from "../core/workspacePath";
import { serviceTierForFastMode } from "../features/agent/hooks/agentProtocol";
import {
  titleFromPrompt,
  useAgentRuntime,
  type AttentionHydrationStatus,
} from "../features/agent/hooks/useAgentRuntime";
import { AttentionCenter } from "../features/attention/AttentionCenter";
import { projectAttentionItems } from "../features/attention/attentionProjection";
import { CommandMenu } from "../features/command-menu/components/CommandMenu";
import { FocusRail } from "../features/focus-rail/components/FocusRail";
import type { RoutineDraft } from "../features/focus-rail/components/SchedulePanel";
import type { SavedAcceptanceContract } from "../features/focus-rail/components/VerificationPanel";
import type {
  FocusResourceRequest,
  FocusView,
} from "../features/focus-rail/focus-rail.types";
import { useRoutines } from "../features/focus-rail/hooks/useRoutines";
import { ProfilePage } from "../features/profile/components/ProfilePage";
import { useLocalProfile } from "../features/profile/hooks/useLocalProfile";
import {
  SettingsPage,
  type ArchivedTaskItem,
} from "../features/settings/components/SettingsPage";
import {
  useAppPreferences,
  type TaskRunDefaults,
} from "../features/settings/hooks/useAppPreferences";
import { useCodexUpdate } from "../features/settings/hooks/useCodexUpdate";
import { useTheme } from "../features/settings/hooks/useTheme";
import { AppShell } from "../features/shell/components/AppShell";
import { GlobalContextMenu } from "../features/shell/components/GlobalContextMenu";
import { Sidebar } from "../features/shell/components/Sidebar";
import { StatusBar } from "../features/shell/components/StatusBar";
import { TaskSwitcher } from "../features/shell/components/TaskSwitcher";
import { TitleBar } from "../features/shell/components/TitleBar";
import type { AppPage } from "../features/shell/shell.types";
import {
  readComposerAttachmentRecoveries,
  storeComposerAttachmentRecovery,
} from "../features/task/composer/attachmentRecovery";
import { managedWorktreeCleanupMessage } from "../features/task/taskEnvironment";
import { forkTaskFromEntry } from "../features/task/taskFork";
import {
  completeTimelineMetadata,
  hasUnloadedTimeline,
  mergeTimelinePage,
  toXiaoTaskDocument,
} from "../features/task/taskPersistence";
import {
  taskGroupForUpdatedAt,
  type TaskGroup,
  type WorkbenchTask,
} from "../features/task/task.types";
import { resolveTimelineResource } from "../features/task/timeline/resourceNavigation";
import { TaskWorkspace } from "../features/task/workspace/TaskWorkspace";
import { useWorkspace } from "../features/workspace/hooks/useWorkspace";

export type StoredTaskState = {
  tasks: WorkbenchTask[];
  activeTaskId: string | null;
  showArchived: boolean;
};

type PersistedWorkspaceSnapshot = {
  tasks: Map<string, WorkbenchTask>;
  taskIds: string[];
  activeTaskId: string | null;
  showArchived: boolean;
};

type ProjectPreference = {
  name?: string;
  pinned?: boolean;
  hidden?: boolean;
};

type ProjectPreferences = Record<string, ProjectPreference>;

const projectPreferencesStorageKey = "xiao.projects.v1";
const activeProjectStorageKey = "xiao.active-project.v1";
const focusRailPreferenceStorageKey = "xiao.focus-rail.v1";
const focusViews = new Set<FocusView>([
  "plan",
  "files",
  "changes",
  "context",
  "verification",
  "observatory",
  "extensions",
  "terminal",
  "browser",
  "run",
  "schedule",
  "runtime",
]);

const readFocusRailPreference = (): { view: FocusView; open: boolean } => {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(focusRailPreferenceStorageKey) ?? "null",
    ) as { view?: unknown; open?: unknown } | null;
    return {
      view: typeof stored?.view === "string" && focusViews.has(stored.view as FocusView)
        ? stored.view as FocusView
        : "changes",
      open: stored?.open === true,
    };
  } catch {
    return { view: "changes", open: false };
  }
};
const focusAppContentNextFrame = () => {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(".app-content")?.focus();
  });
};

export type ReviewContextState = Record<string, AgentAttachment[]>;

export const workspaceTaskKey = (workspacePath: string, taskId: string) =>
  `${comparableWorkspacePath(workspacePath)}\u0000${taskId}`;

export const taskReviewContext = (
  current: ReviewContextState,
  workspacePath: string,
  taskId: string,
) => current[workspaceTaskKey(workspacePath, taskId)] ?? [];

export const stageTaskReviewContext = (
  current: ReviewContextState,
  workspacePath: string,
  taskId: string,
  attachment: AgentAttachment,
) => {
  const key = workspaceTaskKey(workspacePath, taskId);
  const existing = current[key] ?? [];
  return {
    ...current,
    [key]: [
      ...existing.filter((item) => item.id !== attachment.id),
      attachment,
    ],
  };
};

export const removeTaskReviewContext = (
  current: ReviewContextState,
  workspacePath: string,
  taskId: string,
  attachmentId: string,
) => {
  const key = workspaceTaskKey(workspacePath, taskId);
  const existing = current[key];
  if (!existing) return current;
  const remaining = existing.filter((item) => item.id !== attachmentId);
  if (remaining.length === existing.length) return current;
  const next = { ...current };
  if (remaining.length) next[key] = remaining;
  else delete next[key];
  return next;
};

export const clearTaskReviewContext = (
  current: ReviewContextState,
  workspacePath: string,
  taskId: string,
  submitted: AgentAttachment[],
) => {
  const key = workspaceTaskKey(workspacePath, taskId);
  const existing = current[key];
  if (!existing) return current;
  const submittedAttachments = new Set(submitted);
  const remaining = existing.filter((attachment) => !submittedAttachments.has(attachment));
  if (remaining.length === existing.length) return current;
  const next = { ...current };
  if (remaining.length) next[key] = remaining;
  else delete next[key];
  return next;
};

export const applyTaskAcceptanceContractSave = (
  workspacePath: string,
  tasks: WorkbenchTask[],
  saved: SavedAcceptanceContract,
) => {
  if (comparableWorkspacePath(workspacePath) !== comparableWorkspacePath(saved.projectPath)) {
    return tasks;
  }
  const taskIndex = tasks.findIndex((task) => task.id === saved.taskId);
  if (taskIndex < 0) return tasks;
  const next = [...tasks];
  next[taskIndex] = { ...next[taskIndex], acceptanceContract: saved.contract };
  return next;
};

export type ConfirmedNativeTaskState = {
  workspacePath: string;
  generation: number;
  taskIds: ReadonlySet<string>;
};

export type ConfirmedNativeTaskScope = Pick<
  ConfirmedNativeTaskState,
  "workspacePath" | "generation"
>;

export const isCurrentNativeTaskScope = (
  current: ConfirmedNativeTaskState,
  scope: ConfirmedNativeTaskScope,
) =>
  current.generation === scope.generation &&
  comparableWorkspacePath(current.workspacePath) === comparableWorkspacePath(scope.workspacePath);

export type TaskOperationScope = ConfirmedNativeTaskScope & {
  taskId: string;
};

export const captureTaskOperationScope = (
  current: ConfirmedNativeTaskState,
  workspacePath: string,
  taskId: string,
): TaskOperationScope | null => {
  const scope = {
    workspacePath,
    generation: current.generation,
    taskId,
  };
  return isCurrentNativeTaskScope(current, scope) ? scope : null;
};

export const applyCurrentTaskOperationCompletion = (
  current: ConfirmedNativeTaskState,
  scope: TaskOperationScope | null,
  apply: (taskId: string) => void,
) => {
  if (!scope || !isCurrentNativeTaskScope(current, scope)) return false;
  apply(scope.taskId);
  return true;
};

export type UndoRecoveryScope = {
  workspacePath: string;
  taskId: string;
  revision: number;
};

type UndoRecoveryCallbacks<
  Task extends { id: string; draftText: string },
  State extends { tasks: Task[] },
> = {
  currentWorkspacePath: () => string;
  currentRevision: () => number;
  claimRevision: () => number;
  loadOriginState: () => Promise<State>;
  persistOriginState: (state: State) => Promise<void>;
  restoreTask: (task: Task, result: AgentUndoResult, restoreComposer: boolean) => Task;
  applyVisible: (
    taskId: string,
    result: AgentUndoResult,
    restoreComposer: boolean,
  ) => void;
  storeAttachments: (taskId: string, attachments: AgentAttachment[]) => void;
};

export const completeUndoRecovery = async <
  Task extends { id: string; draftText: string },
  State extends { tasks: Task[] },
>(
  scope: UndoRecoveryScope,
  result: AgentUndoResult,
  callbacks: UndoRecoveryCallbacks<Task, State>,
) => {
  const originIsVisible = () =>
    comparableWorkspacePath(callbacks.currentWorkspacePath()) ===
    comparableWorkspacePath(scope.workspacePath);
  const applyVisible = () => {
    const restoreComposer = callbacks.currentRevision() === scope.revision;
    if (restoreComposer) callbacks.claimRevision();
    callbacks.applyVisible(scope.taskId, result, restoreComposer);
    if (restoreComposer) callbacks.storeAttachments(scope.taskId, result.attachments);
  };

  if (originIsVisible()) {
    applyVisible();
    return true;
  }

  const originState = await callbacks.loadOriginState();
  if (originIsVisible()) {
    applyVisible();
    return true;
  }
  const taskIndex = originState.tasks.findIndex((task) => task.id === scope.taskId);
  if (taskIndex < 0) return false;

  const restoreComposer = callbacks.currentRevision() === scope.revision;
  const claimedRevision = restoreComposer ? callbacks.claimRevision() : null;
  const tasks = [...originState.tasks];
  tasks[taskIndex] = callbacks.restoreTask(tasks[taskIndex], result, restoreComposer);
  await callbacks.persistOriginState({ ...originState, tasks });

  const composerStillCurrent =
    claimedRevision !== null && callbacks.currentRevision() === claimedRevision;
  if (composerStillCurrent) {
    callbacks.storeAttachments(scope.taskId, result.attachments);
  }
  if (originIsVisible()) {
    callbacks.applyVisible(scope.taskId, result, composerStillCurrent);
  }
  return true;
};

export const restoreTaskAfterUndo = (
  task: WorkbenchTask,
  result: AgentUndoResult,
  restoreComposer: boolean,
  updatedAt = Date.now(),
): WorkbenchTask => {
  const timelineReturned = result.timeline !== undefined;
  const restored = {
    ...task,
    title: result.resetTitle ? "New task" : task.title,
    draftText: restoreComposer ? result.prompt : task.draftText,
    timeline: result.timeline ?? task.timeline,
    plan: timelineReturned ? null : task.plan,
    updatedAt,
    meta: "Now" as const,
  };
  return timelineReturned ? completeTimelineMetadata(restored) : restored;
};

export const removeTaskOperationRevision = <Task extends { id: string }>(
  tasks: Task[],
  scope: TaskOperationScope,
  originatingTask: Task,
) => {
  const index = tasks.findIndex(
    (task) => task.id === scope.taskId && task === originatingTask,
  );
  if (index < 0) return tasks;
  const next = [...tasks];
  next.splice(index, 1);
  return next;
};

export const applyCurrentWorkspaceSaveCompletion = (
  current: ConfirmedNativeTaskState,
  scope: ConfirmedNativeTaskScope | null,
  apply: () => void,
) => {
  if (!scope || !isCurrentNativeTaskScope(current, scope)) return false;
  apply();
  return true;
};

export const applyCurrentFocusResourceCompletion = (
  currentRequestId: number,
  requestId: number,
  apply: () => void,
) => {
  if (requestId !== currentRequestId) return false;
  apply();
  return true;
};

export const applyCurrentWorkspaceArchiveCompletion = (
  current: ConfirmedNativeTaskState,
  scope: ConfirmedNativeTaskScope,
  state: StoredTaskState,
  apply: (state: StoredTaskState) => void,
) => {
  if (!isCurrentNativeTaskScope(current, scope)) return false;
  apply(state);
  return true;
};

export const archivedProjectTaskState = (
  tasks: WorkbenchTask[],
  updatedAt: number,
): StoredTaskState => {
  const archivedTasks = tasks.map((task) =>
    task.archived
      ? task
      : { ...task, archived: true, pinned: false, updatedAt, meta: "Now" },
  );
  return {
    tasks: archivedTasks,
    activeTaskId: null,
    showArchived: false,
  };
};

export const beginNativeTaskConfirmation = (
  current: ConfirmedNativeTaskState,
  workspacePath: string,
): ConfirmedNativeTaskState => ({
  workspacePath,
  generation: current.generation + 1,
  taskIds: new Set(),
});

export const confirmNativeTaskIds = (
  current: ConfirmedNativeTaskState,
  scope: ConfirmedNativeTaskScope,
  taskIds: Iterable<string>,
): ConfirmedNativeTaskState => {
  if (!isCurrentNativeTaskScope(current, scope)) {
    return current;
  }
  return { ...current, taskIds: new Set(taskIds) };
};

export const confirmedExecutionTaskId = (
  current: ConfirmedNativeTaskState,
  workspacePath: string,
  selectedTaskId: string | null,
) => (
  selectedTaskId &&
  comparableWorkspacePath(current.workspacePath) === comparableWorkspacePath(workspacePath) &&
  current.taskIds.has(selectedTaskId)
    ? selectedTaskId
    : null
);

export const shouldAutoConnectAgentRuntime = (
  codexUpdating: boolean,
  taskStateReady: boolean,
  workspaceActionable: boolean,
  taskWorkspacePath: string,
  workspacePath: string,
) => (
  !codexUpdating &&
  taskStateReady &&
  workspaceActionable &&
  comparableWorkspacePath(taskWorkspacePath) === comparableWorkspacePath(workspacePath) &&
  Boolean(workspacePath)
);

export const attentionTaskStateMatchesWorkspace = (
  taskStateReady: boolean,
  taskWorkspacePath: string,
  workspacePath: string,
) => (
  taskStateReady &&
  Boolean(workspacePath) &&
  comparableWorkspacePath(taskWorkspacePath) === comparableWorkspacePath(workspacePath)
);

export const attentionHydrationStatusForTaskState = (
  taskStateReady: boolean,
  taskWorkspacePath: string,
  workspacePath: string,
  workspaceLoading: boolean,
  taskLoadError: string | null,
  workspaceError: string | null,
  runtimeStatus: AttentionHydrationStatus,
): AttentionHydrationStatus => {
  const pathMatches =
    comparableWorkspacePath(taskWorkspacePath) === comparableWorkspacePath(workspacePath);
  if (workspaceError || (pathMatches && taskLoadError)) return "partial";
  if (workspaceLoading) return "loading";
  return attentionTaskStateMatchesWorkspace(
    taskStateReady,
    taskWorkspacePath,
    workspacePath,
  )
    ? runtimeStatus
    : "loading";
};

export const attentionRetryTargets = (
  taskWorkspacePath: string,
  workspacePath: string,
  taskLoadError: string | null,
  workspaceError: string | null,
) => ({
  agent: true,
  workspace: Boolean(workspaceError),
  taskState: Boolean(
    taskLoadError &&
    comparableWorkspacePath(taskWorkspacePath) === comparableWorkspacePath(workspacePath)
  ),
});

export const taskIsVisible = (
  activePage: AppPage,
  activeTaskId: string | null,
  taskId: string,
) => activePage === "tasks" && activeTaskId === taskId;

export const clearVisibleTaskUnread = <Task extends { id: string; unread: boolean }>(
  tasks: Task[],
  activePage: AppPage,
  activeTaskId: string | null,
): Task[] => {
  if (activePage !== "tasks" || !activeTaskId) return tasks;
  const index = tasks.findIndex((task) => task.id === activeTaskId && task.unread);
  if (index < 0) return tasks;
  const next = [...tasks];
  next[index] = { ...next[index], unread: false };
  return next;
};

export const markTaskUnreadAfterCompletion = (
  tasks: WorkbenchTask[],
  taskId: string,
  visible: boolean,
  updatedAt: number,
): WorkbenchTask[] => {
  if (visible) return tasks;
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return tasks;
  const next = [...tasks];
  next[index] = { ...next[index], unread: true, updatedAt, meta: "Now" };
  return next;
};

export const isTaskWorkspaceStateLoading = (
  workspaceLoading: boolean,
  taskStateReady: boolean,
  taskWorkspacePath: string,
  workspacePath: string,
  taskHistoryLoading: boolean,
) => (
  workspaceLoading ||
  !taskStateReady ||
  comparableWorkspacePath(taskWorkspacePath) !== comparableWorkspacePath(workspacePath) ||
  taskHistoryLoading
);

export const shouldLoadTaskWorkspaceState = (
  loading: boolean,
  taskStateReady: boolean,
  taskLoadError: string | null,
  taskWorkspacePath: string,
  workspacePath: string,
) => (
  !loading &&
  Boolean(workspacePath) &&
  (
    comparableWorkspacePath(taskWorkspacePath) !== comparableWorkspacePath(workspacePath) ||
    (!taskStateReady && taskLoadError === null)
  )
);

export const shouldInvalidateTaskWorkspaceState = (
  requestedWorkspacePath: string | undefined,
  taskWorkspacePath: string,
) => (
  Boolean(requestedWorkspacePath) &&
  comparableWorkspacePath(requestedWorkspacePath ?? "") !==
    comparableWorkspacePath(taskWorkspacePath)
);

export const shouldAdoptResolvedWorkspacePath = (
  loading: boolean,
  requestedWorkspacePath: string | undefined,
  resolvedWorkspacePath: string,
) => (
  !loading &&
  Boolean(resolvedWorkspacePath) &&
  comparableWorkspacePath(requestedWorkspacePath ?? "") !==
    comparableWorkspacePath(resolvedWorkspacePath)
);

const readActiveProjectPath = () => {
  try { return window.localStorage.getItem(activeProjectStorageKey) || undefined; }
  catch { return undefined; }
};

const readProjectPreferences = (): ProjectPreferences => {
  try {
    const stored = window.localStorage.getItem(projectPreferencesStorageKey);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ProjectPreferences)
      : {};
  } catch {
    return {};
  }
};

const writeProjectPreferences = (preferences: ProjectPreferences) => {
  try {
    window.localStorage.setItem(projectPreferencesStorageKey, JSON.stringify(preferences));
  } catch {
    // Desktop webviews and browser previews can run with storage disabled.
  }
};

const applyProjectPreferences = (
  projects: XiaoProjectSummary[],
  preferences: ProjectPreferences,
): XiaoProjectSummary[] =>
  projects
    .filter((project) => !preferences[project.path]?.hidden)
    .map((project) => {
      const preference = preferences[project.path];
      const customName = preference?.name?.trim();
      return {
        ...project,
        name: customName || project.name,
        pinned: Boolean(preference?.pinned),
      };
    })
    .sort(
      (left, right) =>
        Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
        right.updatedAt - left.updatedAt,
    );

const taskGroups = new Set<TaskGroup>(["Active", "Recent", "Yesterday", "This week", "Older"]);
const taskDateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const createDraftTask = (defaults: TaskRunDefaults): WorkbenchTask => {
  const createdAt = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "New task",
    meta: "Draft",
    group: "Active",
    archived: false,
    pinned: false,
    unread: false,
    createdAt,
    updatedAt: createdAt,
    draftText: "",
    followUps: [],
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    threadId: null,
    threadBinding: null,
    mode: defaults.mode,
    approvalPolicy: defaults.approvalPolicy,
    sandboxMode: defaults.sandboxMode,
    goal: null,
    acceptanceContract: null,
    timeline: [],
    timelineLoaded: true,
    timelineComplete: true,
    timelineStart: 0,
    timelineEntryCount: 0,
    plan: null,
    executionEnvironmentId: null,
    workspaceMode: "local",
    managedWorktreeId: null,
  };
};

const defaultTaskState = (): StoredTaskState => {
  return { tasks: [], activeTaskId: null, showArchived: false };
};

const ensureValidActiveTask = (state: StoredTaskState): StoredTaskState => {
  const activeTask = state.tasks.find((task) => task.id === state.activeTaskId);
  if (activeTask && !activeTask.archived) return { ...state, showArchived: false };

  const liveTask = state.tasks.find((task) => !task.archived);
  if (liveTask) return { ...state, activeTaskId: liveTask.id, showArchived: false };

  return { ...state, activeTaskId: null, showArchived: false };
};

const taskMeta = (updatedAt: number) => {
  const elapsed = Math.max(0, Date.now() - updatedAt);
  if (elapsed < 60_000) return "Now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 172_800_000) return "Yesterday";
  return taskDateFormatter.format(new Date(updatedAt));
};

const taskGroup = (updatedAt: number, active: boolean): TaskGroup => {
  return taskGroupForUpdatedAt(updatedAt, active, Date.now());
};

type StoredWorkbenchTask = Omit<
  WorkbenchTask,
  | "acceptanceContract"
  | "approvalPolicy"
  | "draftText"
  | "followUps"
  | "executionEnvironmentId"
  | "goal"
  | "managedWorktreeId"
  | "mode"
  | "plan"
  | "reasoningEffort"
  | "sandboxMode"
  | "threadBinding"
  | "threadId"
  | "timelineComplete"
  | "timelineEntryCount"
  | "timelineLoaded"
  | "timelineStart"
  | "workspaceMode"
> & {
  acceptanceContract?: WorkbenchTask["acceptanceContract"];
  draftText?: string;
  followUps?: WorkbenchTask["followUps"];
  reasoningEffort?: string | null;
  plan?: AgentPlan | null;
  threadId?: string | null;
  threadBinding?: WorkbenchTask["threadBinding"];
  timelineLoaded?: boolean;
  timelineComplete?: boolean;
  timelineStart?: number;
  timelineEntryCount?: number;
  executionEnvironmentId?: string | null;
  workspaceMode?: "local" | "managed-worktree";
  managedWorktreeId?: string | null;
  mode?: "default" | "plan";
  approvalPolicy?: "never" | "on-request" | "untrusted";
  sandboxMode?: "danger-full-access" | "read-only" | "workspace-write";
  goal?: AgentGoal | null;
};

const isAgentGoal = (value: unknown): value is AgentGoal => {
  if (!value || typeof value !== "object") return false;
  const goal = value as Record<string, unknown>;
  return (
    typeof goal.objective === "string" &&
    ["active", "paused", "complete"].includes(String(goal.status))
  );
};

const isAgentPlan = (value: unknown): value is AgentPlan => {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  return (
    (plan.explanation === null || typeof plan.explanation === "string") &&
    Array.isArray(plan.steps) &&
    plan.steps.every((item) => {
      if (!item || typeof item !== "object") return false;
      const step = item as Record<string, unknown>;
      return (
        typeof step.step === "string" &&
        ["pending", "inProgress", "completed"].includes(String(step.status))
      );
    })
  );
};

const activeAgentPlan = (plan: AgentPlan | null | undefined) =>
  plan?.steps.length && plan.steps.every((step) => step.status === "completed")
    ? null
    : plan ?? null;

const isAgentAttachment = (value: unknown): value is AgentAttachment => {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Record<string, unknown>;
  return (
    typeof attachment.name === "string" &&
    typeof attachment.path === "string" &&
    ["directory", "file", "image", "review"].includes(String(attachment.kind))
  );
};

const isAgentFollowUp = (value: unknown): value is WorkbenchTask["followUps"][number] => {
  if (!value || typeof value !== "object") return false;
  const followUp = value as Record<string, unknown>;
  return (
    typeof followUp.id === "string" &&
    typeof followUp.prompt === "string" &&
    typeof followUp.createdAt === "number" &&
    Array.isArray(followUp.attachments) &&
    followUp.attachments.every(isAgentAttachment)
  );
};

const isThreadBinding = (value: unknown): value is WorkbenchTask["threadBinding"] => {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.threadId === "string" &&
    ["ephemeral", "persistent", "legacy-untrusted"].includes(String(binding.persistence)) &&
    typeof binding.materialized === "boolean" &&
    (binding.threadSource === null || typeof binding.threadSource === "string") &&
    (binding.cliVersion === null || typeof binding.cliVersion === "string")
  );
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === "number");

const isAcceptanceGate = (value: unknown): value is AcceptanceGate => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const gate = value as Record<string, unknown>;
  switch (gate.type) {
    case "command":
      return (
        typeof gate.executable === "string" &&
        isStringArray(gate.argv) &&
        typeof gate.timeoutMs === "number" &&
        isNumberArray(gate.expectedExitCodes)
      );
    case "diffScope":
      return (
        isStringArray(gate.allowedPatterns) &&
        isStringArray(gate.deniedPatterns)
      );
    case "cleanliness":
      return (
        typeof gate.allowStaged === "boolean" &&
        typeof gate.allowUnstaged === "boolean" &&
        typeof gate.allowUntracked === "boolean"
      );
    default:
      return false;
  }
};

export const isAcceptanceContractVersionSummary = (
  value: unknown,
): value is AcceptanceContractVersionSummary => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const contract = value as Record<string, unknown>;
  return (
    typeof contract.versionId === "string" &&
    typeof contract.contractId === "string" &&
    typeof contract.version === "number" &&
    typeof contract.schema === "number" &&
    typeof contract.name === "string" &&
    Array.isArray(contract.gates) &&
    contract.gates.every(isAcceptanceGate) &&
    typeof contract.hash === "string" &&
    typeof contract.createdAt === "number" &&
    typeof contract.updatedAt === "number"
  );
};

const isWorkbenchTask = (value: unknown): value is StoredWorkbenchTask => {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.meta === "string" &&
    taskGroups.has(task.group as TaskGroup) &&
    typeof task.archived === "boolean" &&
    typeof task.pinned === "boolean" &&
    (task.unread === undefined || typeof task.unread === "boolean") &&
    typeof task.createdAt === "number" &&
    typeof task.updatedAt === "number" &&
    (task.draftText === undefined || typeof task.draftText === "string") &&
    (task.followUps === undefined ||
      (Array.isArray(task.followUps) && task.followUps.every(isAgentFollowUp))) &&
    (task.model === null || typeof task.model === "string") &&
    (task.reasoningEffort === undefined ||
      task.reasoningEffort === null ||
      typeof task.reasoningEffort === "string") &&
    (task.threadId === undefined || task.threadId === null || typeof task.threadId === "string") &&
    (task.threadBinding === undefined || task.threadBinding === null || isThreadBinding(task.threadBinding)) &&
    (task.timelineLoaded === undefined || typeof task.timelineLoaded === "boolean") &&
    (task.timelineComplete === undefined || typeof task.timelineComplete === "boolean") &&
    (task.timelineStart === undefined || (typeof task.timelineStart === "number" && task.timelineStart >= 0)) &&
    (task.timelineEntryCount === undefined ||
      (typeof task.timelineEntryCount === "number" && task.timelineEntryCount >= 0)) &&
    (task.executionEnvironmentId === undefined || task.executionEnvironmentId === null ||
      typeof task.executionEnvironmentId === "string") &&
    (task.workspaceMode === undefined || ["local", "managed-worktree"].includes(String(task.workspaceMode))) &&
    (task.managedWorktreeId === undefined || task.managedWorktreeId === null ||
      typeof task.managedWorktreeId === "string") &&
    (task.mode === undefined || task.mode === "default" || task.mode === "plan") &&
    (task.approvalPolicy === undefined ||
      ["never", "on-request", "untrusted"].includes(String(task.approvalPolicy))) &&
    (task.sandboxMode === undefined ||
      ["danger-full-access", "read-only", "workspace-write"].includes(String(task.sandboxMode))) &&
    (task.goal === undefined || task.goal === null || isAgentGoal(task.goal)) &&
    (task.acceptanceContract === undefined ||
      task.acceptanceContract === null ||
      isAcceptanceContractVersionSummary(task.acceptanceContract)) &&
    (task.plan === undefined || task.plan === null || isAgentPlan(task.plan)) &&
    Array.isArray(task.timeline)
  );
};

const isLegacyEmptyDraft = (task: StoredWorkbenchTask) =>
  task.title === "New task" &&
  !task.archived &&
  !task.pinned &&
  !task.unread &&
  task.model === null &&
  (task.reasoningEffort === undefined || task.reasoningEffort === null) &&
  (task.threadId === undefined || task.threadId === null) &&
  (task.threadBinding === undefined || task.threadBinding === null) &&
  (task.workspaceMode === undefined || task.workspaceMode === "local") &&
  (task.managedWorktreeId === undefined || task.managedWorktreeId === null) &&
  (task.mode === undefined || task.mode === "default") &&
  (task.approvalPolicy === undefined || task.approvalPolicy === "on-request") &&
  (task.sandboxMode === undefined || task.sandboxMode === "workspace-write") &&
  (task.goal === undefined || task.goal === null) &&
  (task.draftText === undefined || !task.draftText.trim()) &&
  (task.followUps === undefined || task.followUps.length === 0) &&
  task.timeline.length === 0 &&
  (task.plan === undefined || task.plan === null);

const taskStorageKey = (workspacePath: string) => `xiao.tasks.v2:${workspacePath}`;
const retiredFixtureTaskIds = new Set([
  "workbench-shell",
  "agent-protocol",
  "workspace-boundaries",
  "diff-experience",
]);

export const readBrowserTaskState = (workspacePath: string): StoredTaskState => {
  try {
    const stored = window.localStorage.getItem(taskStorageKey(workspacePath));
    if (!stored) return defaultTaskState();
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    if (
      !Array.isArray(parsed.tasks) ||
      !parsed.tasks.every(isWorkbenchTask)
    ) {
      return defaultTaskState();
    }
    const tasks: WorkbenchTask[] = parsed.tasks
      .filter((task) => !retiredFixtureTaskIds.has(task.id) && !isLegacyEmptyDraft(task))
      .map((task) => ({
        ...task,
        draftText: task.draftText ?? "",
        followUps: task.followUps ?? [],
        reasoningEffort: task.reasoningEffort ?? null,
        threadId: task.threadId ?? null,
        threadBinding: task.threadBinding ?? null,
        mode: task.mode ?? "default",
        approvalPolicy: task.approvalPolicy ?? "on-request",
        sandboxMode: task.sandboxMode ?? "workspace-write",
        goal: task.goal ?? null,
        acceptanceContract: task.acceptanceContract ?? null,
        plan: activeAgentPlan(task.plan),
        unread: task.unread ?? false,
        timelineLoaded: true,
        timelineComplete: true,
        timelineStart: 0,
        timelineEntryCount: task.timeline.length,
        executionEnvironmentId: task.executionEnvironmentId ?? null,
        workspaceMode: task.workspaceMode ?? "local",
        managedWorktreeId: task.managedWorktreeId ?? null,
      }));
    const activeTaskId =
      typeof parsed.activeTaskId === "string" &&
      tasks.some((task) => task.id === parsed.activeTaskId)
        ? parsed.activeTaskId
        : null;
    return {
      tasks,
      activeTaskId,
      showArchived: false,
    };
  } catch {
    return defaultTaskState();
  }
};

const stateFromDocument = (document: XiaoWorkspaceDocument): StoredTaskState => ({
  activeTaskId: document.activeTaskId,
  showArchived: false,
  tasks: document.tasks.map((task) => ({
    ...task,
    draftText: task.draftText ?? "",
    followUps: task.followUps ?? [],
    threadId: null,
    threadBinding: task.threadBinding ?? null,
    mode: task.mode ?? "default",
    approvalPolicy: task.approvalPolicy ?? "on-request",
    sandboxMode: task.sandboxMode ?? "workspace-write",
    goal: task.goal ?? null,
    acceptanceContract: task.acceptanceContract ?? null,
    plan: activeAgentPlan(task.plan),
    unread: task.unread ?? false,
    timelineLoaded: task.timelineLoaded,
    timelineComplete: task.timelineComplete,
    timelineStart: task.timelineStart,
    timelineEntryCount: task.timelineEntryCount,
    executionEnvironmentId: task.executionEnvironmentId ?? null,
    workspaceMode: task.workspaceMode ?? "local",
    managedWorktreeId: task.managedWorktreeId ?? null,
    meta: taskMeta(task.updatedAt),
    group: taskGroup(task.updatedAt, task.id === document.activeTaskId && !task.archived),
  })),
});

const snapshotFromState = (state: StoredTaskState): PersistedWorkspaceSnapshot => ({
  tasks: new Map(state.tasks.map((task) => [task.id, task])),
  taskIds: state.tasks.map((task) => task.id),
  activeTaskId: state.activeTaskId,
  showArchived: state.showArchived,
});

const updateFromState = (
  workspacePath: string,
  state: StoredTaskState,
  previous?: PersistedWorkspaceSnapshot,
): XiaoWorkspaceUpdate => {
  const changedTasks = previous
    ? state.tasks.filter((task) => previous.tasks.get(task.id) !== task)
    : state.tasks;
  return {
    schemaVersion: 1,
    workspacePath,
    activeTaskId: state.activeTaskId,
    showArchived: state.showArchived,
    taskIds: state.tasks.map((task) => task.id),
    tasks: changedTasks.map((task) => {
      const previousTask = previous?.tasks.get(task.id);
      return toXiaoTaskDocument(task, !previousTask || previousTask.timeline !== task.timeline);
    }),
  };
};

const updateFromDocument = (document: XiaoWorkspaceDocument): XiaoWorkspaceUpdate => ({
  schemaVersion: document.schemaVersion,
  workspacePath: document.workspacePath,
  activeTaskId: document.activeTaskId,
  showArchived: document.showArchived,
  taskIds: document.tasks.map((task) => task.id),
  tasks: document.tasks,
});

type WorkspaceTaskStateSnapshot = {
  path: string;
  state: StoredTaskState;
};


export class WorkspaceTaskSaveDebouncer {
  private pending: (WorkspaceTaskStateSnapshot & {
    timer: number | NodeJS.Timeout;
  }) | null = null;
  private readonly latestByWorkspace = new Map<string, WorkspaceTaskStateSnapshot>();
  private readonly lastSucceededByWorkspace = new Map<string, WorkspaceTaskStateSnapshot>();
  private readonly lastFailureByWorkspace = new Map<string, unknown>();
  private readonly inFlightByWorkspace = new Map<string, {
    snapshot: WorkspaceTaskStateSnapshot;
    promise: Promise<void>;
  }>();

  constructor(
    private readonly persist: (path: string, state: StoredTaskState) => Promise<void>,
    private readonly delayMs = 250,
  ) {}

  schedule(snapshot: WorkspaceTaskStateSnapshot) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    this.remember(snapshot);
    const inFlight = this.inFlightByWorkspace.get(comparableWorkspacePath(snapshot.path));
    if (
      this.wasPersisted(snapshot) ||
      (inFlight && this.sameSnapshot(inFlight.snapshot, snapshot))
    ) return;
    const pending = {
      ...snapshot,
      timer: setTimeout(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        void this.request(snapshot).catch(() => undefined);
      }, this.delayMs),
    };
    this.pending = pending;
  }

  persistImmediately(snapshot: WorkspaceTaskStateSnapshot) {
    if (
      this.pending &&
      comparableWorkspacePath(this.pending.path) === comparableWorkspacePath(snapshot.path)
    ) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    this.remember(snapshot);
    return this.request(snapshot);
  }

  adoptPersisted(snapshot: WorkspaceTaskStateSnapshot) {
    const key = comparableWorkspacePath(snapshot.path);
    if (this.pending && comparableWorkspacePath(this.pending.path) === key) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    this.remember(snapshot);
    this.lastSucceededByWorkspace.set(key, snapshot);
    this.lastFailureByWorkspace.delete(key);
  }

  flushBeforeWorkspaceTransition(
    currentPath: string,
    nextPath: string,
    latest: WorkspaceTaskStateSnapshot | null,
  ) {
    if (comparableWorkspacePath(currentPath) === comparableWorkspacePath(nextPath)) {
      return null;
    }
    const pending = this.pending &&
      comparableWorkspacePath(this.pending.path) === comparableWorkspacePath(currentPath)
      ? this.pending
      : null;
    const snapshot = latest &&
      comparableWorkspacePath(latest.path) === comparableWorkspacePath(currentPath)
      ? latest
      : pending;
    if (pending) {
      clearTimeout(pending.timer);
      this.pending = null;
    }
    if (!snapshot) return null;
    this.remember(snapshot);
    return !this.wasPersisted(snapshot) ? this.flush(snapshot) : null;
  }

  flushOnDispose(latest: WorkspaceTaskStateSnapshot | null) {
    const snapshot = latest ?? this.pending;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    if (!snapshot) return null;
    this.remember(snapshot);
    return !this.wasPersisted(snapshot) ? this.flush(snapshot) : null;
  }

  async waitForWorkspacePersistence(path: string) {
    const key = comparableWorkspacePath(path);
    const pending = this.pending &&
      comparableWorkspacePath(this.pending.path) === key
      ? this.pending
      : null;
    if (pending) {
      clearTimeout(pending.timer);
      this.pending = null;
      this.remember(pending);
    }
    const snapshot = this.latestByWorkspace.get(key) ?? pending;
    let operation = pending
      ? this.flush(pending)
      : this.inFlightByWorkspace.get(key)?.promise ?? null;
    if (!operation && snapshot && this.lastFailureByWorkspace.has(key)) {
      operation = this.request(snapshot);
    }
    if (!operation) return null;

    let failure: unknown = null;
    try {
      await operation;
    } catch (reason) {
      failure = reason;
    }
    while (true) {
      const replacement = this.inFlightByWorkspace.get(key);
      if (!replacement || replacement.promise === operation) break;
      operation = replacement.promise;
      try {
        await operation;
        failure = null;
      } catch (reason) {
        failure = reason;
      }
    }
    const preserved = this.latestByWorkspace.get(key);
    return preserved
      ? {
          snapshot: preserved,
          error: this.lastFailureByWorkspace.get(key) ?? failure,
        }
      : null;
  }

  private flush(snapshot: WorkspaceTaskStateSnapshot) {
    const inFlight = this.inFlightByWorkspace.get(comparableWorkspacePath(snapshot.path));
    if (inFlight && this.sameSnapshot(inFlight.snapshot, snapshot)) {
      return inFlight.promise.catch(() => this.request(snapshot));
    }
    return this.request(snapshot);
  }

  private request(snapshot: WorkspaceTaskStateSnapshot) {
    if (this.wasPersisted(snapshot)) return Promise.resolve();
    const key = comparableWorkspacePath(snapshot.path);
    const inFlight = this.inFlightByWorkspace.get(key);
    if (inFlight && this.sameSnapshot(inFlight.snapshot, snapshot)) {
      return inFlight.promise;
    }
    this.remember(snapshot);
    let promise: Promise<void>;
    try {
      promise = this.persist(snapshot.path, snapshot.state);
    } catch (reason) {
      promise = Promise.reject(reason);
    }
    const request = { snapshot, promise };
    this.inFlightByWorkspace.set(key, request);
    void promise.then(
      () => {
        this.lastSucceededByWorkspace.set(key, snapshot);
        this.lastFailureByWorkspace.delete(key);
        if (this.inFlightByWorkspace.get(key) === request) {
          this.inFlightByWorkspace.delete(key);
        }
      },
      (reason) => {
        this.lastFailureByWorkspace.set(key, reason);
        if (this.inFlightByWorkspace.get(key) === request) {
          this.inFlightByWorkspace.delete(key);
        }
      },
    );
    return promise;
  }

  private remember(snapshot: WorkspaceTaskStateSnapshot) {
    this.latestByWorkspace.set(comparableWorkspacePath(snapshot.path), snapshot);
  }

  private wasPersisted(snapshot: WorkspaceTaskStateSnapshot) {
    const succeeded = this.lastSucceededByWorkspace.get(comparableWorkspacePath(snapshot.path));
    return Boolean(succeeded && this.sameSnapshot(succeeded, snapshot));
  }

  private sameSnapshot(
    left: WorkspaceTaskStateSnapshot,
    right: WorkspaceTaskStateSnapshot,
  ) {
    return (
      comparableWorkspacePath(left.path) === comparableWorkspacePath(right.path) &&
      left.state.tasks === right.state.tasks &&
      left.state.activeTaskId === right.state.activeTaskId &&
      left.state.showArchived === right.state.showArchived
    );
  }
}

export const submitTaskFollowUpAfterPersistence = async (
  snapshot: WorkspaceTaskStateSnapshot,
  persist: (snapshot: WorkspaceTaskStateSnapshot) => Promise<void>,
  submit: () => Promise<boolean>,
) => {
  try {
    await persist(snapshot);
  } catch {
    return false;
  }
  return submit();
};

export const queuedFollowUpIdForAutoSend = ({
  followUps,
  runtimeReady,
  taskStateReady,
  timelineReady,
  environmentBusy,
  taskStateError,
  workspaceError,
  sendingFollowUpId,
  failedFollowUpId,
  nativeTaskConfirmed,
}: {
  followUps: readonly AgentFollowUp[];
  runtimeReady: boolean;
  taskStateReady: boolean;
  timelineReady: boolean;
  environmentBusy: boolean;
  taskStateError: string | null;
  workspaceError: string | null;
  sendingFollowUpId: string | null;
  failedFollowUpId: string | null;
  nativeTaskConfirmed: boolean;
}) =>
  runtimeReady &&
  taskStateReady &&
  timelineReady &&
  !environmentBusy &&
  !taskStateError &&
  !workspaceError &&
  !sendingFollowUpId &&
  !failedFollowUpId &&
  nativeTaskConfirmed
    ? followUps[0]?.id ?? null
    : null;

const mergeProject = (
  projects: XiaoProjectSummary[],
  project: XiaoProjectSummary,
): XiaoProjectSummary[] => {
  const next = projects.filter((item) => item.path !== project.path);
  return [project, ...next].sort(
    (left, right) =>
      Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
      right.updatedAt - left.updatedAt,
  );
};

export const createContinuationTask = (
  source: WorkbenchTask,
  identity: { id: string; createdAt: number },
): WorkbenchTask =>
  completeTimelineMetadata({
    ...source,
    id: identity.id,
    title: `Continue: ${source.title}`,
    archived: false,
    pinned: false,
    unread: false,
    createdAt: identity.createdAt,
    updatedAt: identity.createdAt,
    draftText: "",
    followUps: [],
    threadId: null,
    threadBinding: null,
    executionEnvironmentId: null,
    workspaceMode: "local",
    managedWorktreeId: null,
    goal: null,
    acceptanceContract: null,
    meta: "Now",
    group: "Active",
    timeline: source.timeline.map((entry) => ({ ...entry })),
    plan: source.plan
      ? { ...source.plan, steps: source.plan.steps.map((step) => ({ ...step })) }
      : null,
  });

export function App() {
  const { profile, saveProfile } = useLocalProfile();
  const [activeProjectPath, setActiveProjectPath] = useState<string | undefined>(readActiveProjectPath);
  const activeProjectPathRef = useRef(activeProjectPath);
  activeProjectPathRef.current = activeProjectPath;
  const { theme, setTheme } = useTheme();
  const { preferences, updatePreferences, updateTaskRunDefaults } = useAppPreferences();
  const codexUpdate = useCodexUpdate();
  const [initialTaskState] = useState(defaultTaskState);
  const [activePage, setActivePage] = useState<AppPage>("tasks");
  const [initialFocusRailPreference] = useState(readFocusRailPreference);
  const [focusView, setFocusView] = useState<FocusView>(initialFocusRailPreference.view);
  const [focusResourceRequest, setFocusResourceRequest] = useState<FocusResourceRequest | null>(null);
  const focusResourceRequestId = useRef(0);
  const focusResourceContextRef = useRef("");
  const [focusPanelOpen, setFocusPanelOpen] = useState(initialFocusRailPreference.open);
  const invalidateFocusResourceRequest = () => {
    focusResourceRequestId.current += 1;
    setFocusResourceRequest(null);
  };
  const closeFocusPanel = () => {
    invalidateFocusResourceRequest();
    setFocusPanelOpen(false);
  };
  const [sidebarOpen, setSidebarOpen] = useState(
    () =>
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      !window.matchMedia("(max-width: 760px)").matches,
  );
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [taskSwitcherOpen, setTaskSwitcherOpen] = useState(false);
  const [taskWorkspacePath, setTaskWorkspacePath] = useState("");
  const taskWorkspacePathRef = useRef(taskWorkspacePath);
  taskWorkspacePathRef.current = taskWorkspacePath;
  const [taskStateReady, setTaskStateReady] = useState(!isTauriHost());
  const taskStateReadyRef = useRef(taskStateReady);
  taskStateReadyRef.current = taskStateReady;
  const [taskLoadError, setTaskLoadError] = useState<string | null>(null);
  const [taskLoadRetryRevision, setTaskLoadRetryRevision] = useState(0);
  const taskLoadErrorRef = useRef(taskLoadError);
  taskLoadErrorRef.current = taskLoadError;
  const [confirmedNativeTasks, setConfirmedNativeTasks] = useState<ConfirmedNativeTaskState>({
    workspacePath: "",
    generation: 0,
    taskIds: new Set(),
  });
  const confirmedNativeTasksRef = useRef(confirmedNativeTasks);
  const [taskHistoryError, setTaskHistoryError] = useState<string | null>(null);
  const [taskSaveError, setTaskSaveError] = useState<string | null>(null);
  const [taskHistoryLoadingId, setTaskHistoryLoadingId] = useState<string | null>(null);
  const [environmentBusyTaskId, setEnvironmentBusyTaskId] = useState<string | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<WorkbenchTask[]>(initialTaskState.tasks);
  const [activeTaskId, setActiveTaskId] = useState(initialTaskState.activeTaskId);
  const [draftTask, setDraftTask] = useState(() => createDraftTask(preferences.taskRunDefaults));
  const [openTaskIds, setOpenTaskIds] = useState<string[]>(
    initialTaskState.activeTaskId ? [initialTaskState.activeTaskId] : [],
  );
  const [draftTabOpen, setDraftTabOpen] = useState(initialTaskState.activeTaskId === null);
  const [projectPreferences, setProjectPreferences] = useState<ProjectPreferences>(
    readProjectPreferences,
  );
  const projectPreferencesRef = useRef(projectPreferences);
  const archivedRefreshId = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const persistedWorkspaceSnapshotsRef = useRef(new Map<string, PersistedWorkspaceSnapshot>());
  const latestTaskStateRef = useRef<{ path: string; state: StoredTaskState } | null>(null);
  const replaceConfirmedNativeTaskIds = useCallback(
    (scope: ConfirmedNativeTaskScope, taskIds: Iterable<string>) => {
      const next = confirmNativeTaskIds(confirmedNativeTasksRef.current, scope, taskIds);
      if (next === confirmedNativeTasksRef.current) return;
      confirmedNativeTasksRef.current = next;
      setConfirmedNativeTasks(next);
    },
    [],
  );
  const focusedLaunchTaskRef = useRef<string | null>(null);
  const notifiedRuntimeErrorRef = useRef<string | null>(null);
  const notifiedApprovalRef = useRef<string | null>(null);
  const notifiedQuestionRef = useRef<string | null>(null);
  const [projects, setProjects] = useState<XiaoProjectSummary[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<ArchivedTaskItem[]>([]);
  const [archivedTasksLoading, setArchivedTasksLoading] = useState(false);
  const [archivedTasksError, setArchivedTasksError] = useState<string | null>(null);
  const [reviewContextByTask, setReviewContextByTask] = useState<ReviewContextState>({});
  const [restoredAttachmentsByTask, setRestoredAttachmentsByTask] = useState<
    Record<string, AgentAttachment[]>
  >(readComposerAttachmentRecoveries);
  const composerRevisionByTaskRef = useRef<Record<string, number>>({});
  const [routineOpenTarget, setRoutineOpenTarget] = useState<RoutineOpenRunTarget | null>(null);
  const handledRoutineRunRef = useRef<string | null>(null);
  const [sendingFollowUpId, setSendingFollowUpId] = useState<string | null>(null);
  const [failedFollowUpId, setFailedFollowUpId] = useState<string | null>(null);
  const selectedTask = tasks.find((task) => task.id === activeTaskId) ?? null;
  const activeTask = selectedTask ?? draftTask;
  const activeTaskTimelineReady = !hasUnloadedTimeline(activeTask);
  const executionTaskId = confirmedExecutionTaskId(
    confirmedNativeTasks,
    activeProjectPath ?? "",
    selectedTask?.id ?? null,
  );
  const {
    workspace,
    system,
    loading,
    error: workspaceError,
    actionable: workspaceActionable,
    refresh,
    loadDirectory,
  } = useWorkspace(activeProjectPath, executionTaskId);
  const routineController = useRoutines(workspace.path);
  useLayoutEffect(() => {
    if (!shouldInvalidateTaskWorkspaceState(activeProjectPath, taskWorkspacePath)) return;
    taskStateReadyRef.current = false;
    setTaskStateReady(false);
    taskLoadErrorRef.current = null;
    setTaskLoadError(null);
  }, [activeProjectPath, taskWorkspacePath]);
  const focusResourceContext = JSON.stringify([
    comparableWorkspacePath(activeProjectPath ?? ""),
    workspaceTaskKey(workspace.path, activeTask.id),
  ]);
  useLayoutEffect(() => {
    if (focusResourceContextRef.current === focusResourceContext) return;
    focusResourceContextRef.current = focusResourceContext;
    focusResourceRequestId.current += 1;
    setFocusResourceRequest(null);
  }, [focusResourceContext]);
  const activeTaskHistoryLoading = Boolean(
    selectedTask && hasUnloadedTimeline(selectedTask) && !taskHistoryError,
  );
  const taskWorkspaceStateLoading = isTaskWorkspaceStateLoading(
    loading,
    taskStateReady,
    taskWorkspacePath,
    workspace.path,
    activeTaskHistoryLoading,
  );
  const activeEnvironmentBusy = environmentBusyTaskId === activeTask.id;
  const taskStateError = taskLoadError ?? taskHistoryError ?? taskSaveError;
  const pendingReviewContext = taskReviewContext(
    reviewContextByTask,
    taskWorkspacePath,
    activeTask.id,
  );
  const dangerousRoutineIds = new Set(
    routineController.routines
      .filter((routine) =>
        routine.sandboxMode === "danger-full-access" ||
        tasks.find((task) => task.id === routine.taskId)?.sandboxMode === "danger-full-access",
      )
      .map((routine) => routine.id),
  );
  const focusedLaunch =
    taskStateReady &&
    taskWorkspacePath === workspace.path &&
    activePage === "tasks" &&
    routineOpenTarget?.taskId !== activeTask.id &&
    (!selectedTask || !selectedTask.archived) &&
    activeTaskTimelineReady &&
    activeTask.timeline.length === 0;
  if (taskStateReady && taskWorkspacePath) {
    latestTaskStateRef.current = {
      path: taskWorkspacePath,
      state: { tasks, activeTaskId, showArchived: false },
    };
  }
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        focusRailPreferenceStorageKey,
        JSON.stringify({ view: focusView, open: focusPanelOpen }),
      );
    } catch {
      // Focus rail persistence is optional when local storage is unavailable.
    }
  }, [focusPanelOpen, focusView]);

  const closeSidebarOnNarrow = useCallback(() => {
    if (window.matchMedia("(max-width: 760px)").matches) setSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (!focusedLaunch || !preferences.focusNewTasks) return;
    const taskKey = `${workspace.path}\u0000${activeTask.id}`;
    if (focusedLaunchTaskRef.current === taskKey) return;
    focusedLaunchTaskRef.current = taskKey;
    setSidebarOpen(false);
    closeFocusPanel();
  }, [activeTask.id, focusedLaunch, preferences.focusNewTasks, workspace.path]);

  const enqueueWorkspaceSave = useCallback((update: XiaoWorkspaceUpdate) => {
    const operation = saveQueueRef.current
      .catch(() => undefined)
      .then(() => nativeBridge.saveXiaoWorkspace(update));
    saveQueueRef.current = operation;
    return operation;
  }, []);

  const persistTaskState = useCallback(
    (path: string, state: StoredTaskState) => {
      const currentConfirmation = confirmedNativeTasksRef.current;
      const confirmationScope = comparableWorkspacePath(currentConfirmation.workspacePath) ===
        comparableWorkspacePath(path)
        ? {
            workspacePath: currentConfirmation.workspacePath,
            generation: currentConfirmation.generation,
          }
        : null;
      let operation: Promise<void>;
      if (isTauriHost()) {
        const previous = persistedWorkspaceSnapshotsRef.current.get(path);
        const update = updateFromState(path, state, previous);
        const taskIdsChanged =
          !previous ||
          previous.taskIds.length !== update.taskIds.length ||
          previous.taskIds.some((taskId, index) => taskId !== update.taskIds[index]);
        const workspaceChanged =
          !previous ||
          previous.activeTaskId !== state.activeTaskId ||
          previous.showArchived !== state.showArchived;
        if (!update.tasks.length && !taskIdsChanged && !workspaceChanged) {
          operation = Promise.resolve();
        } else {
          const nextSnapshot = snapshotFromState(state);
          operation = enqueueWorkspaceSave(update).then(() => {
            persistedWorkspaceSnapshotsRef.current.set(path, nextSnapshot);
          });
        }
      } else {
        operation = new Promise<void>((resolve, reject) => {
          try {
            window.localStorage.setItem(taskStorageKey(path), JSON.stringify(state));
            resolve();
          } catch (reason) {
            reject(reason);
          }
        });
      }

      void operation.then(() => {
        applyCurrentWorkspaceSaveCompletion(
          confirmedNativeTasksRef.current,
          confirmationScope,
          () => {
            replaceConfirmedNativeTaskIds(
              confirmationScope!,
              state.tasks.map((task) => task.id),
            );
            setTaskSaveError(null);
          },
        );
      }).catch((reason) => {
        applyCurrentWorkspaceSaveCompletion(
          confirmedNativeTasksRef.current,
          confirmationScope,
          () => setTaskSaveError(reason instanceof Error ? reason.message : String(reason)),
        );
      });
      return operation;
    },
    [enqueueWorkspaceSave, replaceConfirmedNativeTaskIds],
  );
  const taskSaveDebouncerRef = useRef<WorkspaceTaskSaveDebouncer | null>(null);
  if (!taskSaveDebouncerRef.current) {
    taskSaveDebouncerRef.current = new WorkspaceTaskSaveDebouncer(persistTaskState);
  }
  const taskSaveDebouncer = taskSaveDebouncerRef.current;

  useEffect(() => {
    if (
      !isTauriHost() ||
      !shouldAdoptResolvedWorkspacePath(loading, activeProjectPath, workspace.path)
    ) return;
    setActiveProjectPath(workspace.path);
  }, [activeProjectPath, loading, workspace.path]);

  useEffect(() => {
    if (!activeProjectPath) return;
    try { window.localStorage.setItem(activeProjectStorageKey, activeProjectPath); }
    catch { /* The current session still keeps the selected project. */ }
  }, [activeProjectPath]);

  useEffect(() => {
    if (!isTauriHost()) return;
    let disposed = false;
    let removeListener: (() => void) | null = null;
    void listen<RoutineOpenRunTarget>("xiao://routine-open-run", (event) => {
      const target = event.payload;
      handledRoutineRunRef.current = null;
      setRoutineOpenTarget(target);
      setActiveProjectPath(target.workspacePath);
      setActivePage("tasks");
    }).then((unlisten) => {
      if (disposed) unlisten();
      else removeListener = unlisten;
    }).catch((reason) => {
      if (!disposed) console.error("Could not register the routine deep-link listener.", reason);
    });
    return () => {
      disposed = true;
      removeListener?.();
    };
  }, []);

  useEffect(() => {
    if (
      !routineOpenTarget ||
      handledRoutineRunRef.current === routineOpenTarget.runId ||
      !taskStateReady ||
      comparableWorkspacePath(taskWorkspacePath) !== comparableWorkspacePath(routineOpenTarget.workspacePath) ||
      !tasks.some((task) => task.id === routineOpenTarget.taskId)
    ) return;
    handledRoutineRunRef.current = routineOpenTarget.runId;
    setActiveTaskId(routineOpenTarget.taskId);
    setOpenTaskIds((current) => current.includes(routineOpenTarget.taskId)
      ? current
      : [...current, routineOpenTarget.taskId]);
    setActivePage("tasks");
    openFocusView("schedule");
  }, [routineOpenTarget, taskStateReady, taskWorkspacePath, tasks]);

  useEffect(() => {
    if (!isTauriHost()) return;
    void nativeBridge
      .listXiaoProjects()
      .then((items) =>
        setProjects((current) =>
          applyProjectPreferences(
            current.reduce((merged, project) => mergeProject(merged, project), items),
            projectPreferencesRef.current,
          ),
        ),
      )
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!shouldLoadTaskWorkspaceState(
      loading,
      taskStateReadyRef.current,
      taskLoadErrorRef.current,
      taskWorkspacePath,
      workspace.path,
    )) return;
    const outgoingSave = taskSaveDebouncer.flushBeforeWorkspaceTransition(
      taskWorkspacePath,
      workspace.path,
      latestTaskStateRef.current,
    );
    if (outgoingSave) void outgoingSave.catch(() => undefined);
    let cancelled = false;
    const requestStillCurrent = () =>
      !isTauriHost() ||
      !shouldInvalidateTaskWorkspaceState(activeProjectPathRef.current, workspace.path);
    const nextConfirmation = beginNativeTaskConfirmation(
      confirmedNativeTasksRef.current,
      workspace.path,
    );
    const confirmationScope: ConfirmedNativeTaskScope = {
      workspacePath: nextConfirmation.workspacePath,
      generation: nextConfirmation.generation,
    };
    confirmedNativeTasksRef.current = nextConfirmation;
    setConfirmedNativeTasks(nextConfirmation);
    taskStateReadyRef.current = false;
    setTaskStateReady(false);
    taskLoadErrorRef.current = null;
    setTaskLoadError(null);
    setTaskHistoryError(null);
    setEnvironmentError(null);
    setEnvironmentBusyTaskId(null);

    const loadState = async () => {
      try {
        const saveBarrier = await taskSaveDebouncer.waitForWorkspacePersistence(workspace.path);
        const loadedState = isTauriHost()
          ? await nativeBridge
              .loadXiaoWorkspace(workspace.path)
              .then((document) => (document ? stateFromDocument(document) : defaultTaskState()))
          : readBrowserTaskState(workspace.path);
        const nextState = ensureValidActiveTask(saveBarrier?.snapshot.state ?? loadedState);
        if (cancelled || !requestStillCurrent()) return;
        if (isTauriHost()) {
          persistedWorkspaceSnapshotsRef.current.set(
            workspace.path,
            snapshotFromState(loadedState),
          );
        }
        replaceConfirmedNativeTaskIds(
          confirmationScope,
          loadedState.tasks.map((task) => task.id),
        );
        taskWorkspacePathRef.current = workspace.path;
        setTasks(nextState.tasks);
        setActiveTaskId(nextState.activeTaskId);
        const nextDraft = createDraftTask(preferences.taskRunDefaults);
        setDraftTask(nextDraft);
        setOpenTaskIds(nextState.activeTaskId ? [nextState.activeTaskId] : []);
        setDraftTabOpen(nextState.activeTaskId === null);
        setTaskWorkspacePath(workspace.path);
        setTaskHistoryLoadingId(null);
        setSendingFollowUpId(null);
        setFailedFollowUpId(null);
        if (saveBarrier) {
          setTaskSaveError(
            saveBarrier.error instanceof Error
              ? saveBarrier.error.message
              : saveBarrier.error === null
                ? null
                : String(saveBarrier.error),
          );
        }
        taskStateReadyRef.current = true;
        setTaskStateReady(true);
        setProjects((current) =>
          applyProjectPreferences(
            mergeProject(current, {
              path: workspace.path,
              name: workspace.name,
              updatedAt:
                Math.max(0, ...nextState.tasks.map((task) => task.updatedAt)) ||
                current.find((project) => project.path === workspace.path)?.updatedAt ||
                Date.now(),
            }),
            projectPreferencesRef.current,
          ),
        );
      } catch (reason) {
        if (cancelled || !requestStillCurrent()) return;
        replaceConfirmedNativeTaskIds(confirmationScope, []);
        taskWorkspacePathRef.current = workspace.path;
        setTasks([]);
        setActiveTaskId(null);
        setDraftTask(createDraftTask(preferences.taskRunDefaults));
        setOpenTaskIds([]);
        setDraftTabOpen(true);
        setTaskHistoryLoadingId(null);
        setTaskWorkspacePath(workspace.path);
        const message = reason instanceof Error ? reason.message : String(reason);
        taskLoadErrorRef.current = message;
        setTaskLoadError(message);
      }
    };

    void loadState();
    return () => {
      cancelled = true;
    };
  }, [
    loading,
    replaceConfirmedNativeTaskIds,
    taskLoadRetryRevision,
    taskSaveDebouncer,
    taskWorkspacePath,
    workspace.name,
    workspace.path,
  ]);

  useEffect(() => {
    setTaskHistoryError(null);
    setEnvironmentError(null);
  }, [activeTaskId, taskWorkspacePath]);

  useEffect(() => {
    if (
      !isTauriHost() ||
      !taskStateReady ||
      taskWorkspacePath !== workspace.path ||
      !selectedTask ||
      !hasUnloadedTimeline(selectedTask) ||
      taskHistoryLoadingId === selectedTask.id
    ) return;

    let cancelled = false;
    const taskId = selectedTask.id;
    const before = selectedTask.timelineLoaded ? selectedTask.timelineStart : null;
    setTaskHistoryLoadingId(taskId);
    setTaskHistoryError(null);
    void nativeBridge
      .loadXiaoTimelinePage(workspace.path, taskId, before)
      .then((page) => {
        if (cancelled) return;
        setTaskHistoryLoadingId((current) => current === taskId ? null : current);
        setTasks((current) =>
          current.map((task) => task.id === taskId ? mergeTimelinePage(task, page) : task),
        );
      })
      .catch((reason) => {
        if (cancelled) return;
        setTaskHistoryLoadingId((current) => current === taskId ? null : current);
        setTaskHistoryError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      cancelled = true;
      setTaskHistoryLoadingId((current) => current === taskId ? null : current);
    };
  }, [
    selectedTask?.id,
    selectedTask?.timelineComplete,
    selectedTask?.timeline.length,
    selectedTask?.timelineLoaded,
    selectedTask?.timelineEntryCount,
    selectedTask?.timelineStart,
    taskStateReady,
    taskWorkspacePath,
    workspace.path,
  ]);

  useEffect(() => {
    if (!taskStateReady || workspace.path !== taskWorkspacePath) return;
    const latest = latestTaskStateRef.current;
    if (!latest || latest.path !== taskWorkspacePath) return;
    taskSaveDebouncer.schedule(latest);
  }, [
    activeTaskId,
    taskSaveDebouncer,
    taskStateReady,
    taskWorkspacePath,
    tasks,
    workspace.path,
  ]);

  useEffect(() => {
    if (!taskStateReady) return;
    setTasks((current) => {
      let changed = false;
      const next = current.map((task) => {
        if (task.title !== "New task" || hasUnloadedTimeline(task)) return task;
        const firstPrompt = task.timeline.find(
          (entry) => entry.kind === "user" || entry.kind === "brief",
        );
        const prompt = firstPrompt?.body ?? firstPrompt?.title;
        if (!prompt?.trim()) return task;
        changed = true;
        return { ...task, title: titleFromPrompt(prompt), updatedAt: Date.now(), meta: "Now" };
      });
      return changed ? next : current;
    });
  }, [taskStateReady, taskWorkspacePath]);

  useEffect(() => {
    if (!taskStateReady) return;
    if (activeTaskId) {
      setOpenTaskIds((current) => current.includes(activeTaskId) ? current : [...current, activeTaskId]);
      return;
    }
    setDraftTabOpen(true);
  }, [activeTaskId, taskStateReady]);

  useEffect(() => {
    if (!attentionTaskStateMatchesWorkspace(
      taskStateReady,
      taskWorkspacePath,
      workspace.path,
    )) return;
    setTasks((current) => clearVisibleTaskUnread(current, activePage, activeTaskId));
  }, [activePage, activeTaskId, taskStateReady, taskWorkspacePath]);

  useEffect(() => {
    setOpenTaskIds((current) => {
      const next = current.filter((taskId) => tasks.some((task) => task.id === taskId && !task.archived));
      return next.length === current.length ? current : next;
    });
  }, [tasks]);

  useEffect(
    () => () => {
      const outgoingSave = taskSaveDebouncer.flushOnDispose(latestTaskStateRef.current);
      if (outgoingSave) void outgoingSave.catch(() => undefined);
    },
    [taskSaveDebouncer],
  );

  const updateTaskTimeline = useCallback((taskId: string, timeline: TimelineEntry[]) => {
    const updatedAt = Date.now();
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? completeTimelineMetadata({
              ...task,
              timeline,
              updatedAt,
              meta: "Now",
              group: "Active" as const,
            })
          : task,
      ),
    );
    setDraftTask((current) =>
      current.id === taskId
        ? completeTimelineMetadata({
            ...current,
            timeline,
            updatedAt,
            meta: "Now",
            group: "Active" as const,
          })
        : current,
    );
  }, []);

  const updateTaskPlan = useCallback((taskId: string, plan: AgentPlan | null) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, plan, updatedAt: Date.now(), meta: "Now" } : task,
      ),
    );
    setDraftTask((current) =>
      current.id === taskId ? { ...current, plan, updatedAt: Date.now(), meta: "Now" } : current,
    );
  }, []);

  const updateTaskTitle = useCallback((taskId: string, title: string) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, title, updatedAt: Date.now(), meta: "Now" } : task,
      ),
    );
    setDraftTask((current) =>
      current.id === taskId ? { ...current, title, updatedAt: Date.now(), meta: "Now" } : current,
    );
  }, []);

  const updateTaskGoal = useCallback((taskId: string, goal: AgentGoal | null) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, goal, updatedAt: Date.now(), meta: "Now" } : task,
      ),
    );
    setDraftTask((current) =>
      current.id === taskId ? { ...current, goal, updatedAt: Date.now(), meta: "Now" } : current,
    );
  }, []);

  const markTaskFinished = useCallback(
    (taskId: string, outcome: AgentTurnOutcome) => {
      const finished = tasks.find((task) => task.id === taskId);
      const visible = taskIsVisible(activePage, activeTaskId, taskId);
      if (
        outcome === "completed" &&
        finished &&
        !routineController.routines.some((routine) => routine.taskId === taskId) &&
        !visible &&
        preferences.notifyCompletions &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        new Notification("Xiao finished a task", { body: finished.title });
      }
      setTasks((current) =>
        markTaskUnreadAfterCompletion(current, taskId, visible, Date.now()),
      );
    },
    [activePage, activeTaskId, preferences.notifyCompletions, routineController.routines, tasks],
  );

  const agent = useAgentRuntime(
    workspace.path,
    workspace.execution.environment.id,
    activeTask.id,
    executionTaskId,
    activeTask.title,
    activeTask.timeline,
    activeTaskTimelineReady,
    activeTask.model,
    preferences.fastMode,
    activeTask.approvalPolicy,
    updateTaskTimeline,
    updateTaskPlan,
    updateTaskTitle,
    updateTaskGoal,
    markTaskFinished,
    refresh,
    shouldAutoConnectAgentRuntime(
      codexUpdate.updating,
      taskStateReady,
      workspaceActionable,
      taskWorkspacePath,
      workspace.path,
    ),
  );
  const attentionTaskStateReady = attentionTaskStateMatchesWorkspace(
    taskStateReady,
    taskWorkspacePath,
    workspace.path,
  );
  const attentionItems = useMemo(
    () => attentionTaskStateReady
      ? projectAttentionItems(tasks, agent.runs, agent.pendingInputs)
      : [],
    [agent.pendingInputs, agent.runs, attentionTaskStateReady, tasks],
  );
  const attentionHydrationStatus = attentionHydrationStatusForTaskState(
    taskStateReady,
    taskWorkspacePath,
    workspace.path,
    loading,
    taskLoadError,
    workspaceError,
    agent.attentionHydrationStatus,
  );
  const retryAttention = () => {
    const targets = attentionRetryTargets(
      taskWorkspacePath,
      workspace.path,
      taskLoadError,
      workspaceError,
    );
    if (targets.agent) agent.retryAttentionHydration();
    if (targets.workspace) void refresh();
    if (targets.taskState) {
      taskLoadErrorRef.current = null;
      setTaskLoadError(null);
      setTaskLoadRetryRevision((current) => current + 1);
    }
  };
  const titleBarTabs = [
    ...openTaskIds.flatMap((taskId) => {
      const task = tasks.find((item) => item.id === taskId && !item.archived);
      return task ? [{
        id: task.id,
        title: task.title,
        working: agent.isTaskWorking(task.id),
      }] : [];
    }),
    ...(draftTabOpen ? [{ id: draftTask.id, title: "New task", draft: true, working: false }] : []),
  ];
  const visibleModels = agent.models.filter(
    (model) => !preferences.hiddenModels.includes(model.model) || model.model === activeTask.model,
  );
  const statusModel =
    agent.models.find((model) => model.model === activeTask.model) ??
    agent.models.find((model) => model.isDefault) ??
    agent.models[0];
  const statusContextPercent = contextUsedPercent(
    agent.contextUsage,
    statusModel?.contextWindow,
  );
  const statusReasoningEffort =
    activeTask.reasoningEffort || statusModel?.defaultReasoningEffort || "";

  useEffect(() => {
    const runtimeError = agent.runtime.error;
    if (!runtimeError) {
      notifiedRuntimeErrorRef.current = null;
      return;
    }
    if (
      preferences.notifyErrors &&
      notifiedRuntimeErrorRef.current !== runtimeError &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      notifiedRuntimeErrorRef.current = runtimeError;
      new Notification("Xiao needs attention", { body: runtimeError });
    }
  }, [agent.runtime.error, preferences.notifyErrors]);

  useEffect(() => {
    const approval = [...activeTask.timeline]
      .reverse()
      .find((entry) => entry.kind === "approval" && entry.status === "warning");
    if (!approval) return;
    if (
      preferences.notifyApprovals &&
      notifiedApprovalRef.current !== approval.id &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      notifiedApprovalRef.current = approval.id;
      new Notification("Xiao is waiting for approval", { body: approval.title });
    }
  }, [activeTask.timeline, preferences.notifyApprovals]);

  useEffect(() => {
    const question = agent.questionRequest;
    if (!question) {
      notifiedQuestionRef.current = null;
      return;
    }
    const requestId = String(question.requestId);
    if (
      preferences.notifyApprovals &&
      notifiedQuestionRef.current !== requestId &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      notifiedQuestionRef.current = requestId;
      new Notification("Xiao has a question", { body: question.questions[0]?.question });
    }
  }, [agent.questionRequest, preferences.notifyApprovals]);

  const changeTaskWorkspaceMode = async (workspaceMode: XiaoWorkspaceMode) => {
    if (workspaceMode === activeTask.workspaceMode) return;
    const originPath = workspace.path;
    const currentConfirmation = confirmedNativeTasksRef.current;
    const environmentScope =
      comparableWorkspacePath(currentConfirmation.workspacePath) === comparableWorkspacePath(originPath)
        ? {
            workspacePath: currentConfirmation.workspacePath,
            generation: currentConfirmation.generation,
          }
        : null;
    if (
      comparableWorkspacePath(taskWorkspacePath) !== comparableWorkspacePath(originPath) ||
      !environmentScope
    ) return;
    if (
      !isTauriHost() ||
      !taskStateReady ||
      activeTaskHistoryLoading ||
      activeEnvironmentBusy ||
      activeTask.archived ||
      activeTask.followUps.length > 0 ||
      agent.runtime.phase === "working"
    ) {
      setEnvironmentError("The task environment cannot change while task work is active.");
      return;
    }

    const task = { ...activeTask, meta: "Now" as const, group: "Active" as const };
    const persistedTasks = selectedTask
      ? tasks
      : tasks.some((item) => item.id === task.id)
        ? tasks
        : [task, ...tasks];
    const persistedState = {
      tasks: persistedTasks,
      activeTaskId: task.id,
      showArchived: false,
    };
    setEnvironmentBusyTaskId(task.id);
    setEnvironmentError(null);
    if (!selectedTask) {
      setTasks(persistedTasks);
      setActiveTaskId(task.id);
      setOpenTaskIds((current) => current.includes(task.id) ? current : [...current, task.id]);
      setDraftTabOpen(false);
    }

    try {
      await persistTaskState(originPath, persistedState);
      const context = workspaceMode === "managed-worktree"
        ? await nativeBridge.prepareXiaoManagedWorktree(originPath, task.id)
        : await (async () => {
            const records = await nativeBridge.listXiaoManagedWorktrees(originPath);
            const managed = records.find((record) => record.id === task.managedWorktreeId);
            if (!managed) throw new Error("The task's managed worktree record is unavailable.");
            const confirmed = window.confirm(managedWorktreeCleanupMessage(managed));
            if (!confirmed) return null;
            return nativeBridge.removeXiaoManagedWorktree(
              originPath,
              task.id,
              managed.id,
              true,
            );
          })();
      if (!context) return;
      const updatedAt = Date.now();
      const executionPatch: Partial<WorkbenchTask> = {
        executionEnvironmentId: context.environment.id,
        workspaceMode: context.workspaceMode,
        managedWorktreeId: context.managedWorktree?.id ?? null,
        updatedAt,
        meta: "Now",
      };
      const applied = applyCurrentWorkspaceSaveCompletion(
        confirmedNativeTasksRef.current,
        environmentScope,
        () => {
          setTasks((current) => current.map((item) =>
            item.id === task.id ? { ...item, ...executionPatch } : item,
          ));
          setDraftTask((current) =>
            current.id === task.id ? { ...current, ...executionPatch } : current,
          );
        },
      );
      if (!applied) return;
      await refresh();
    } catch (reason) {
      applyCurrentWorkspaceSaveCompletion(
        confirmedNativeTasksRef.current,
        environmentScope,
        () => setEnvironmentError(reason instanceof Error ? reason.message : String(reason)),
      );
    } finally {
      applyCurrentWorkspaceSaveCompletion(
        confirmedNativeTasksRef.current,
        environmentScope,
        () => setEnvironmentBusyTaskId((current) => current === task.id ? null : current),
      );
    }
  };

  const submitTask = async (prompt: string, attachments: Parameters<typeof agent.submit>[1]) => {
    if (
      !taskStateReady ||
      activeTaskHistoryLoading ||
      activeEnvironmentBusy ||
      taskStateError ||
      workspaceError
    ) return false;

    let persistedTasks = tasks;
    let persistedActiveTaskId = activeTaskId;
    if (!selectedTask) {
      const updatedAt = Date.now();
      const materializedTask: WorkbenchTask = {
        ...activeTask,
        title: activeTask.title === "New task" ? titleFromPrompt(prompt) : activeTask.title,
        updatedAt,
        meta: "Now",
        group: "Active",
        draftText: activeTask.draftText || prompt,
      };
      persistedTasks = tasks.some((task) => task.id === materializedTask.id)
        ? tasks
        : [materializedTask, ...tasks];
      persistedActiveTaskId = materializedTask.id;
      setTasks(persistedTasks);
      setOpenTaskIds((current) => current.includes(materializedTask.id) ? current : [...current, materializedTask.id]);
      setActiveTaskId(materializedTask.id);
      setDraftTabOpen(false);
      setDraftTask(createDraftTask(preferences.taskRunDefaults));
    }
    try {
      await persistTaskState(workspace.path, {
        tasks: persistedTasks,
        activeTaskId: persistedActiveTaskId,
        showArchived: false,
      });
    } catch {
      return false;
    }
    return agent.submit(prompt, attachments);
  };

  const queueTaskFollowUp = async (prompt: string, attachments: AgentAttachment[]) => {
    const cleanPrompt = prompt.trim();
    if (
      !taskStateReady ||
      activeTaskHistoryLoading ||
      activeEnvironmentBusy ||
      taskStateError ||
      workspaceError ||
      activeTask.archived ||
      !cleanPrompt
    ) return false;
    setFailedFollowUpId(null);
    const followUp: AgentFollowUp = {
      id: crypto.randomUUID(),
      prompt: cleanPrompt,
      attachments,
      createdAt: Date.now(),
    };
    const nextTasks = tasks.map((task) => task.id === activeTask.id
      ? { ...task, followUps: [...task.followUps, followUp] }
      : task);
    try {
      await taskSaveDebouncer.persistImmediately({
        path: taskWorkspacePath,
        state: { tasks: nextTasks, activeTaskId, showArchived: false },
      });
    } catch {
      return false;
    }
    setTasks(nextTasks);
    return true;
  };

  const steerTask = async (prompt: string, attachments: AgentAttachment[]) => {
    const cleanPrompt = prompt.trim();
    if (
      !taskStateReady ||
      activeTaskHistoryLoading ||
      activeEnvironmentBusy ||
      taskStateError ||
      workspaceError ||
      activeTask.archived ||
      !cleanPrompt
    ) return false;
    setFailedFollowUpId(null);
    return submitTaskFollowUpAfterPersistence(
      {
        path: taskWorkspacePath,
        state: { tasks, activeTaskId, showArchived: false },
      },
      (snapshot) => taskSaveDebouncer.persistImmediately(snapshot),
      () => agent.steer(cleanPrompt, attachments),
    );
  };

  const removeTaskFollowUp = (followUpId: string) => {
    if (sendingFollowUpId === followUpId) return;
    setTasks((current) => current.map((task) =>
      task.id === activeTask.id
        ? { ...task, followUps: task.followUps.filter((item) => item.id !== followUpId) }
        : task,
    ));
    if (failedFollowUpId === followUpId) setFailedFollowUpId(null);
  };

  const editTaskFollowUp = (followUpId: string, prompt: string) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || sendingFollowUpId === followUpId) return;
    setTasks((current) => current.map((task) =>
      task.id === activeTask.id
        ? {
            ...task,
            followUps: task.followUps.map((item) =>
              item.id === followUpId ? { ...item, prompt: cleanPrompt } : item
            ),
          }
        : task,
    ));
  };

  const sendTaskFollowUpNow = async (followUpId: string) => {
    if (
      sendingFollowUpId ||
      !taskStateReady ||
      !activeTaskTimelineReady ||
      activeEnvironmentBusy ||
      taskStateError ||
      workspaceError
    ) return;
    const followUp = activeTask.followUps.find((item) => item.id === followUpId);
    if (!followUp) return;
    const operationScope = captureTaskOperationScope(
      confirmedNativeTasksRef.current,
      taskWorkspacePath,
      activeTask.id,
    );
    if (!operationScope) return;
    setSendingFollowUpId(followUp.id);
    setFailedFollowUpId(null);
    try {
      const success = await submitTaskFollowUpAfterPersistence(
        {
          path: operationScope.workspacePath,
          state: { tasks, activeTaskId, showArchived: false },
        },
        (snapshot) => taskSaveDebouncer.persistImmediately(snapshot),
        () => agent.runtime.phase === "working"
          ? agent.steer(followUp.prompt, followUp.attachments, followUp.id)
          : agent.submit(followUp.prompt, followUp.attachments, followUp.id),
      );
      if (!success) {
        applyCurrentTaskOperationCompletion(
          confirmedNativeTasksRef.current,
          operationScope,
          () => setFailedFollowUpId(followUp.id),
        );
        return;
      }
      applyCurrentTaskOperationCompletion(
        confirmedNativeTasksRef.current,
        operationScope,
        (taskId) => setTasks((current) => current.map((task) =>
          task.id === taskId
            ? {
                ...task,
                followUps: task.followUps.filter((item) => item.id !== followUp.id),
                updatedAt: Date.now(),
                meta: "Now",
              }
            : task,
        )),
      );
    } finally {
      applyCurrentTaskOperationCompletion(
        confirmedNativeTasksRef.current,
        operationScope,
        () => setSendingFollowUpId((current) => current === followUp.id ? null : current),
      );
    }
  };

  const autoSendFollowUpId = queuedFollowUpIdForAutoSend({
    followUps: activeTask.followUps,
    runtimeReady: agent.runtime.phase === "ready",
    taskStateReady,
    timelineReady: activeTaskTimelineReady,
    environmentBusy: activeEnvironmentBusy,
    taskStateError,
    workspaceError,
    sendingFollowUpId,
    failedFollowUpId,
    nativeTaskConfirmed: Boolean(executionTaskId),
  });

  useEffect(() => {
    if (!autoSendFollowUpId) return;
    void sendTaskFollowUpNow(autoSendFollowUpId);
  }, [activeTask.id, autoSendFollowUpId]);

  const patchActiveTask = (patch: Partial<WorkbenchTask>) => {
    setTasks((current) =>
      current.map((task) => (task.id === activeTask.id ? { ...task, ...patch } : task)),
    );
    setDraftTask((current) =>
      current.id === activeTask.id ? { ...current, ...patch } : current,
    );
  };

  const updateTaskAcceptanceContract = useCallback((saved: SavedAcceptanceContract) => {
    setTasks((current) =>
      applyTaskAcceptanceContractSave(taskWorkspacePathRef.current, current, saved)
    );
  }, []);

  const importTaskHandoff = useCallback(async (bundlePath: string) => {
    if (!isTauriHost()) throw new Error("Handoff import requires the Xiao desktop app.");
    const workspacePath = taskWorkspacePathRef.current;
    const saveBarrier = await taskSaveDebouncer.waitForWorkspacePersistence(workspacePath);
    if (saveBarrier?.error) {
      throw saveBarrier.error instanceof Error
        ? saveBarrier.error
        : new Error(String(saveBarrier.error));
    }
    const result = await nativeBridge.importXiaoHandoff(workspacePath, bundlePath);
    const document = await nativeBridge.loadXiaoWorkspace(workspacePath);
    if (!document) throw new Error("The imported Xiao workspace could not be reloaded.");
    const nextState = ensureValidActiveTask(stateFromDocument(document));
    const snapshot = { path: workspacePath, state: nextState };
    taskSaveDebouncer.adoptPersisted(snapshot);

    if (comparableWorkspacePath(taskWorkspacePathRef.current) === comparableWorkspacePath(workspacePath)) {
      persistedWorkspaceSnapshotsRef.current.set(workspacePath, snapshotFromState(nextState));
      const confirmation = confirmedNativeTasksRef.current;
      if (comparableWorkspacePath(confirmation.workspacePath) === comparableWorkspacePath(workspacePath)) {
        replaceConfirmedNativeTaskIds(
          { workspacePath: confirmation.workspacePath, generation: confirmation.generation },
          nextState.tasks.map((task) => task.id),
        );
      }
      setTasks(nextState.tasks);
      setActiveTaskId(result.taskId);
      setOpenTaskIds((current) => current.includes(result.taskId)
        ? current
        : [...current, result.taskId]);
      setDraftTabOpen(false);
      setTaskLoadError(null);
      setTaskHistoryError(null);
      setTaskSaveError(null);
    }
    return result;
  }, [replaceConfirmedNativeTaskIds, taskSaveDebouncer]);

  const advanceComposerRevision = (workspacePath: string, taskId: string) => {
    const key = workspaceTaskKey(workspacePath, taskId);
    const revision = (composerRevisionByTaskRef.current[key] ?? 0) + 1;
    composerRevisionByTaskRef.current[key] = revision;
    return revision;
  };

  const updateTaskAttachments = (
    workspacePath: string,
    taskId: string,
    attachments: AgentAttachment[],
  ) => {
    const key = workspaceTaskKey(workspacePath, taskId);
    advanceComposerRevision(workspacePath, taskId);
    storeComposerAttachmentRecovery(workspacePath, taskId, []);
    setRestoredAttachmentsByTask((current) => {
      if (attachments.length) return { ...current, [key]: attachments };
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const completeComposerSubmission = async (
    workspacePath: string,
    taskId: string,
    revision: number,
  ) => {
    const key = workspaceTaskKey(workspacePath, taskId);
    if ((composerRevisionByTaskRef.current[key] ?? 0) !== revision) return false;

    const saveBarrier = await taskSaveDebouncer.waitForWorkspacePersistence(workspacePath);
    const originState: StoredTaskState = saveBarrier?.snapshot.state ?? (
      isTauriHost()
        ? await nativeBridge
            .loadXiaoWorkspace(workspacePath, false)
            .then((document) => (document ? stateFromDocument(document) : defaultTaskState()))
        : readBrowserTaskState(workspacePath)
    );
    if ((composerRevisionByTaskRef.current[key] ?? 0) !== revision) return false;

    const claimedRevision = advanceComposerRevision(workspacePath, taskId);
    const nextState = {
      ...originState,
      tasks: originState.tasks.map((task) =>
        task.id === taskId ? { ...task, draftText: "" } : task
      ),
    };
    try {
      await persistTaskState(workspacePath, nextState);
    } catch {
      return false;
    }
    if (composerRevisionByTaskRef.current[key] !== claimedRevision) return false;

    if (comparableWorkspacePath(taskWorkspacePathRef.current) === comparableWorkspacePath(workspacePath)) {
      setTasks((current) =>
        current.map((task) => task.id === taskId ? { ...task, draftText: "" } : task),
      );
      setDraftTask((current) =>
        current.id === taskId ? { ...current, draftText: "" } : current,
      );
    }
    storeComposerAttachmentRecovery(workspacePath, taskId, []);
    setRestoredAttachmentsByTask((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    return true;
  };

  const updateTaskDraft = (workspacePath: string, taskId: string, draftText: string) => {
    advanceComposerRevision(workspacePath, taskId);
    if (comparableWorkspacePath(taskWorkspacePathRef.current) !== comparableWorkspacePath(workspacePath)) return;

    if (selectedTask?.id === taskId) {
      setTasks((current) =>
        current.map((task) => task.id === taskId ? { ...task, draftText } : task),
      );
      return;
    }
    if (draftTask.id !== taskId) return;

    setDraftTask((current) => current.id === taskId ? { ...current, draftText } : current);
    if (!draftText.trim()) return;

    const task = { ...draftTask, draftText };
    setTasks((current) =>
      current.some((item) => item.id === taskId)
        ? current.map((item) => item.id === taskId ? { ...item, draftText } : item)
        : [task, ...current],
    );
    setOpenTaskIds((current) => current.includes(taskId) ? current : [...current, taskId]);
    setActiveTaskId(taskId);
    setDraftTabOpen(false);
  };

  const undoTaskTurn = async () => {
    if (taskWorkspaceStateLoading || taskStateError) return;
    if (!window.confirm("Undo the last turn and revert its captured workspace changes?")) return;
    const operationScope = captureTaskOperationScope(
      confirmedNativeTasksRef.current,
      taskWorkspacePath,
      activeTask.id,
    );
    if (!operationScope) return;
    const key = workspaceTaskKey(operationScope.workspacePath, operationScope.taskId);
    const undoScope: UndoRecoveryScope = {
      workspacePath: operationScope.workspacePath,
      taskId: operationScope.taskId,
      revision: composerRevisionByTaskRef.current[key] ?? 0,
    };
    const result = await agent.undoLastTurn();
    if (!result) return;

    try {
      const recovered = await completeUndoRecovery<WorkbenchTask, StoredTaskState>(
        undoScope,
        result,
        {
          currentWorkspacePath: () => taskWorkspacePathRef.current,
          currentRevision: () => composerRevisionByTaskRef.current[key] ?? 0,
          claimRevision: () => advanceComposerRevision(
            undoScope.workspacePath,
            undoScope.taskId,
          ),
          loadOriginState: async () => {
            const saveBarrier = await taskSaveDebouncer.waitForWorkspacePersistence(
              undoScope.workspacePath,
            );
            return saveBarrier?.snapshot.state ?? (
              isTauriHost()
                ? await nativeBridge
                    .loadXiaoWorkspace(undoScope.workspacePath, false)
                    .then((document) => document
                      ? stateFromDocument(document)
                      : defaultTaskState())
                : readBrowserTaskState(undoScope.workspacePath)
            );
          },
          persistOriginState: async (state) => {
            try {
              await taskSaveDebouncer.persistImmediately({
                path: undoScope.workspacePath,
                state,
              });
            } catch {
              // The tracked snapshot is retried by the workspace barrier when returning.
            }
          },
          restoreTask: restoreTaskAfterUndo,
          applyVisible: (taskId, recovery, restoreComposer) => {
            setTasks((current) => current.map((task) =>
              task.id === taskId
                ? restoreTaskAfterUndo(task, recovery, restoreComposer)
                : task
            ));
            setDraftTask((current) =>
              current.id === taskId
                ? restoreTaskAfterUndo(current, recovery, restoreComposer)
                : current
            );
          },
          storeAttachments: (taskId, attachments) => {
            const attachmentKey = workspaceTaskKey(undoScope.workspacePath, taskId);
            storeComposerAttachmentRecovery(undoScope.workspacePath, taskId, attachments);
            setRestoredAttachmentsByTask((current) => {
              if (attachments.length) return { ...current, [attachmentKey]: attachments };
              if (!current[attachmentKey]) return current;
              const next = { ...current };
              delete next[attachmentKey];
              return next;
            });
          },
        });
      if (
        recovered &&
        comparableWorkspacePath(taskWorkspacePathRef.current) ===
          comparableWorkspacePath(undoScope.workspacePath)
      ) {
        await refresh();
      }
    } catch (reason) {
      if (
        comparableWorkspacePath(taskWorkspacePathRef.current) ===
          comparableWorkspacePath(undoScope.workspacePath)
      ) {
        setTaskSaveError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  };

  const forkTask = (entryId: string) => {
    if (
      !taskStateReady ||
      taskStateError ||
      !activeTaskTimelineReady ||
      activeEnvironmentBusy ||
      activeTask.archived ||
      activeTask.followUps.length > 0 ||
      agent.runtime.phase !== "ready" ||
      agent.compacting ||
      agent.undoing
    ) return;

    const fork = forkTaskFromEntry(
      { ...activeTask, timeline: agent.timeline },
      entryId,
      { id: crypto.randomUUID(), createdAt: Date.now() },
    );
    if (!fork) return;
    if (!window.confirm(
      "Fork this task from the selected prompt?\n\nEarlier conversation history will be copied into a new task. The prompt and attachments will be restored, but workspace files will stay unchanged.",
    )) return;

    setTasks((current) => [fork.task, ...current]);
    setOpenTaskIds((current) => [...current, fork.task.id]);
    setActiveTaskId(fork.task.id);
    setDraftTabOpen(false);
    setDraftTask(createDraftTask(preferences.taskRunDefaults));
    if (fork.attachments.length) {
      const key = workspaceTaskKey(taskWorkspacePath, fork.task.id);
      setRestoredAttachmentsByTask((current) => ({
        ...current,
        [key]: fork.attachments,
      }));
    }
    setActivePage("tasks");
    closeSidebarOnNarrow();
  };

  const stageReviewContext = (attachment: AgentAttachment) => {
    const workspacePath = taskWorkspacePath;
    const taskId = activeTask.id;
    setReviewContextByTask((current) =>
      stageTaskReviewContext(current, workspacePath, taskId, attachment)
    );
  };

  const removeReviewContext = (attachmentId: string) => {
    const workspacePath = taskWorkspacePath;
    const taskId = activeTask.id;
    setReviewContextByTask((current) =>
      removeTaskReviewContext(current, workspacePath, taskId, attachmentId)
    );
  };

  const clearReviewContext = (submitted: AgentAttachment[]) => {
    const workspacePath = taskWorkspacePath;
    const taskId = activeTask.id;
    setReviewContextByTask((current) =>
      clearTaskReviewContext(current, workspacePath, taskId, submitted)
    );
  };

  const openFocusView = (view: FocusView, preserveResourceRequest = false) => {
    if (!preserveResourceRequest) invalidateFocusResourceRequest();
    setFocusView(view);
    setFocusPanelOpen(true);
    closeSidebarOnNarrow();
  };

  const jumpToTimelineEntry = (entryId: string) => {
    closeFocusPanel();
    window.requestAnimationFrame(() => {
      const anchor = document.getElementById(`timeline-entry-${entryId}`);
      (anchor?.firstElementChild ?? anchor)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
  };

  const openTimelineResource = (target: string) => {
    const resource = resolveTimelineResource(target, workspace.execution.executionRoot);
    if (!resource) return false;
    const id = ++focusResourceRequestId.current;
    if (resource.kind === "browser") {
      setFocusResourceRequest({ id, kind: "browser", url: resource.url });
      openFocusView("browser", true);
      return true;
    }
    if (resource.kind === "file") {
      setFocusResourceRequest({ id, kind: "file", path: resource.relativePath });
      openFocusView("files", true);
      return true;
    }

    void nativeBridge
      .openWorkspacePreview(workspace.path, executionTaskId, resource.relativePath)
      .then((url) => {
        applyCurrentFocusResourceCompletion(focusResourceRequestId.current, id, () => {
          setFocusResourceRequest({
            id,
            kind: "browser",
            url: `${url}${resource.fragment}`,
          });
          openFocusView("browser", true);
        });
      })
      .catch(() => {
        applyCurrentFocusResourceCompletion(focusResourceRequestId.current, id, () => {
          setFocusResourceRequest({ id, kind: "file", path: resource.relativePath });
          openFocusView("files", true);
        });
      });
    return true;
  };

  const selectTaskTab = (tabId: string) => {
    setActiveTaskId(tabId === draftTask.id ? null : tabId);
    setActivePage("tasks");
    closeSidebarOnNarrow();
  };

  const closeTaskTab = (tabId: string) => {
    if (tabId === draftTask.id) {
      if (!openTaskIds.length) return;
      setDraftTabOpen(false);
      setDraftTask(createDraftTask(preferences.taskRunDefaults));
      if (activeTaskId === null) setActiveTaskId(openTaskIds.at(-1) ?? null);
      return;
    }

    const index = openTaskIds.indexOf(tabId);
    if (index === -1) return;
    const nextTaskIds = openTaskIds.filter((taskId) => taskId !== tabId);
    setOpenTaskIds(nextTaskIds);
    if (activeTaskId !== tabId) return;

    const nextTaskId = nextTaskIds[Math.min(index, nextTaskIds.length - 1)] ?? null;
    if (nextTaskId) {
      setActiveTaskId(nextTaskId);
      return;
    }
    setActiveTaskId(null);
    setDraftTabOpen(true);
    setDraftTask(createDraftTask(preferences.taskRunDefaults));
  };

  const createTask = (title: string): string | null => {
    if (!taskStateReady) return null;
    const task: WorkbenchTask = {
      ...createDraftTask(preferences.taskRunDefaults),
      title,
    };
    setTasks((current) => [task, ...current]);
    setOpenTaskIds((current) => current.includes(task.id) ? current : [...current, task.id]);
    setActiveTaskId(task.id);
    setDraftTabOpen(false);
    setDraftTask(createDraftTask(preferences.taskRunDefaults));
    setActivePage("tasks");
    return task.id;
  };

  const openNewTaskTab = () => {
    if (!createTask("New task")) return;
    closeFocusPanel();
  };

  const applyRoutineBinding = (
    routine: RoutineSummary,
    operationScope: TaskOperationScope,
  ) => {
    applyCurrentTaskOperationCompletion(
      confirmedNativeTasksRef.current,
      operationScope,
      (taskId) => setTasks((current) => current.map((task) => task.id === taskId ? {
        ...task,
        title: `Routine: ${routine.title}`,
        updatedAt: Date.now(),
        meta: "Now",
        executionEnvironmentId: routine.executionEnvironmentId,
        workspaceMode: routine.workspaceMode,
        managedWorktreeId: routine.managedWorktreeId,
      } : task)),
    );
  };

  const createRoutine = async (draft: RoutineDraft) => {
    if (!isTauriHost() || !taskStateReady) {
      throw new Error("The workspace must finish loading before a routine can be created.");
    }
    const taskTitle = draft.title || titleFromPrompt(draft.prompt);
    const routineTask: WorkbenchTask = {
      ...createDraftTask(preferences.taskRunDefaults),
      title: `Routine: ${taskTitle}`,
    };
    const operationScope = captureTaskOperationScope(
      confirmedNativeTasksRef.current,
      workspace.path,
      routineTask.id,
    );
    if (!operationScope) {
      throw new Error("The workspace must finish loading before a routine can be created.");
    }
    const previousState: StoredTaskState = {
      tasks,
      activeTaskId,
      showArchived: false,
    };
    const nextTasks = [routineTask, ...tasks];
    setTasks(nextTasks);
    let taskPersisted = false;
    try {
      await persistTaskState(operationScope.workspacePath, {
        ...previousState,
        tasks: nextTasks,
      });
      taskPersisted = true;
      const routineModel = routineTask.model
        ? agent.models.find((model) => model.model === routineTask.model)
        : agent.models.find((model) => model.isDefault);
      const routine = await routineController.create({
        projectPath: operationScope.workspacePath,
        taskId: routineTask.id,
        ...draft,
        serviceTier: serviceTierForFastMode(routineModel, preferences.fastMode),
      });
      applyRoutineBinding(routine, operationScope);
    } catch (reason) {
      let rollbackState: StoredTaskState | null = null;
      const current = applyCurrentTaskOperationCompletion(
        confirmedNativeTasksRef.current,
        operationScope,
        () => {
          if (!taskPersisted) {
            setTasks((currentTasks) =>
              removeTaskOperationRevision(currentTasks, operationScope, routineTask)
            );
            return;
          }
          const latest = latestTaskStateRef.current;
          if (!latest || latest.state.tasks === tasks) {
            rollbackState = previousState;
            return;
          }
          const rollbackTasks = removeTaskOperationRevision(
            latest.state.tasks,
            operationScope,
            routineTask,
          );
          if (rollbackTasks !== latest.state.tasks) {
            rollbackState = { ...latest.state, tasks: rollbackTasks };
          }
        },
      );
      if (current && taskPersisted && rollbackState) {
        try {
          await persistTaskState(operationScope.workspacePath, rollbackState);
          applyCurrentTaskOperationCompletion(
            confirmedNativeTasksRef.current,
            operationScope,
            () => setTasks((currentTasks) =>
              removeTaskOperationRevision(currentTasks, operationScope, routineTask)
            ),
          );
        } catch {
          // Keep the task visible if native ownership prevents safe rollback.
        }
      }
      throw reason;
    }
  };

  const updateRoutine = async (routineId: string, draft: RoutineDraft) => {
    const currentRoutine = routineController.routines.find((routine) => routine.id === routineId);
    if (!currentRoutine) {
      throw new Error("The workspace must finish loading before a routine can be updated.");
    }
    const routineTask = tasks.find((task) => task.id === currentRoutine.taskId);
    const operationScope = captureTaskOperationScope(
      confirmedNativeTasksRef.current,
      workspace.path,
      currentRoutine.taskId,
    );
    if (!operationScope) {
      throw new Error("The workspace must finish loading before a routine can be updated.");
    }
    if (taskStateReady) {
      await persistTaskState(operationScope.workspacePath, {
        tasks,
        activeTaskId,
        showArchived: false,
      });
    }
    const modelId = routineTask ? routineTask.model : currentRoutine.model;
    const routineModel = modelId
      ? agent.models.find((model) => model.model === modelId)
      : agent.models.find((model) => model.isDefault);
    const routine = await routineController.update({
      routineId,
      ...draft,
      serviceTier: serviceTierForFastMode(routineModel, preferences.fastMode),
    });
    applyRoutineBinding(routine, operationScope);
  };

  const setTaskArchived = (taskId: string, archived: boolean) => {
    if (
      !taskStateReady ||
      environmentBusyTaskId === taskId ||
      agent.isTaskWorking(taskId)
    ) return;
    const updatedAt = Date.now();
    setTasks((current) => {
      const nextTasks = current.map((task) =>
        task.id === taskId
          ? { ...task, archived, pinned: archived ? false : task.pinned, updatedAt }
          : task,
      );

      if (archived && taskId === activeTaskId) {
        const nextActiveTask = nextTasks.find((task) => !task.archived);
        setActiveTaskId(nextActiveTask?.id ?? null);
        if (!nextActiveTask) setDraftTask(createDraftTask(preferences.taskRunDefaults));
      } else if (!archived && activeTaskId === null) {
        setActiveTaskId(taskId);
      }

      return nextTasks;
    });
  };

  const toggleTaskPinned = (taskId: string) => {
    if (!taskStateReady) return;
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, pinned: !task.pinned, updatedAt: Date.now() } : task,
      ),
    );
  };

  const renameTask = (taskId: string, title: string) => {
    const cleanTitle = title.trim();
    if (!taskStateReady || !cleanTitle) return;
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, title: cleanTitle, updatedAt: Date.now() } : task,
      ),
    );
  };

  const markTaskUnread = (taskId: string, unread: boolean) => {
    if (!taskStateReady) return;
    setTasks((current) =>
      current.map((task) => task.id === taskId ? { ...task, unread } : task),
    );
  };

  const continueInNewTask = (taskId: string) => {
    if (!taskStateReady) return;
    const source = tasks.find((task) => task.id === taskId);
    if (!source) return;
    const createdAt = Date.now();
    if (hasUnloadedTimeline(source)) return;
    const task = createContinuationTask(source, {
      id: crypto.randomUUID(),
      createdAt,
    });
    setTasks((current) => [task, ...current]);
    setActiveTaskId(task.id);
    setActivePage("tasks");
  };

  const updateProjectPreference = (path: string, update: ProjectPreference) => {
    const nextPreferences = {
      ...projectPreferences,
      [path]: { ...projectPreferences[path], ...update },
    };
    setProjectPreferences(nextPreferences);
    projectPreferencesRef.current = nextPreferences;
    writeProjectPreferences(nextPreferences);
    setProjects((current) => applyProjectPreferences(current, nextPreferences));
  };

  const toggleProjectPinned = (path: string) => {
    const project = projects.find((item) => item.path === path);
    updateProjectPreference(path, { pinned: !project?.pinned });
  };

  const renameProject = (path: string, name: string) => {
    updateProjectPreference(path, { name });
  };

  const openProject = (path: string) => {
    if (!isTauriHost()) return;
    void nativeBridge.openXiaoProject(path).catch((reason) => {
      console.error("Could not open project in the file manager.", reason);
    });
  };

  const archiveProjectTasks = async (path: string) => {
    const updatedAt = Date.now();
    if (path === workspace.path) {
      const currentConfirmation = confirmedNativeTasksRef.current;
      const archiveScope =
        comparableWorkspacePath(currentConfirmation.workspacePath) === comparableWorkspacePath(path)
          ? {
              workspacePath: currentConfirmation.workspacePath,
              generation: currentConfirmation.generation,
            }
          : null;
      if (
        !taskStateReady ||
        comparableWorkspacePath(taskWorkspacePath) !== comparableWorkspacePath(path) ||
        !archiveScope
      ) return;
      const nextState = archivedProjectTaskState(tasks, updatedAt);
      try {
        if (isTauriHost()) {
          await persistTaskState(path, nextState);
        } else {
          window.localStorage.setItem(taskStorageKey(path), JSON.stringify(nextState));
        }
      } catch (reason) {
        applyCurrentWorkspaceSaveCompletion(
          confirmedNativeTasksRef.current,
          archiveScope,
          () => console.error("Could not archive project tasks.", reason),
        );
        return;
      }
      applyCurrentWorkspaceArchiveCompletion(
        confirmedNativeTasksRef.current,
        archiveScope,
        nextState,
        (archivedState) => {
          setTasks(archivedState.tasks);
          setActiveTaskId(archivedState.activeTaskId);
          setDraftTask(createDraftTask(preferences.taskRunDefaults));
        },
      );
      setProjects((current) =>
        current.map((project) =>
          project.path === path ? { ...project, updatedAt } : project,
        ),
      );
      return;
    }
    if (!isTauriHost()) return;

    try {
      const document = await nativeBridge.loadXiaoWorkspace(path, false);
      if (!document) return;
      const nextTasks = document.tasks.map((task) =>
        task.archived ? task : { ...task, archived: true, pinned: false, updatedAt },
      );
      await enqueueWorkspaceSave(updateFromDocument({
        ...document,
        activeTaskId: null,
        tasks: nextTasks,
        showArchived: false,
      }));
      setProjects((current) =>
        current.map((project) =>
          project.path === path ? { ...project, updatedAt } : project,
        ),
      );
    } catch (reason) {
      console.error("Could not archive project tasks.", reason);
    }
  };

  const removeProject = (path: string) => {
    if (workspace.path === path && agent.hasActiveRuns) return;
    const fallback = projects.find((project) => project.path !== path);
    updateProjectPreference(path, { hidden: true });
    if (workspace.path === path && fallback) {
      setActiveProjectPath(fallback.path);
      setActivePage("tasks");
      closeFocusPanel();
    }
  };

  const refreshArchivedTasks = useCallback(async () => {
    const refreshId = ++archivedRefreshId.current;
    setArchivedTasksLoading(true);
    setArchivedTasksError(null);

    try {
      const currentProjectName =
        projects.find((project) => project.path === workspace.path)?.name ?? workspace.name;
      const nextItems: ArchivedTaskItem[] = tasks
        .filter((task) => task.archived)
        .map((task) => ({
          taskId: task.id,
          title: task.title,
          updatedAt: task.updatedAt,
          projectPath: workspace.path,
          projectName: currentProjectName,
        }));

      if (isTauriHost()) {
        const otherProjects = projects.filter((project) => project.path !== workspace.path);
        const documents = await Promise.all(
          otherProjects.map(async (project) => ({
            project,
            document: await nativeBridge.loadXiaoWorkspace(project.path, false),
          })),
        );
        for (const { project, document } of documents) {
          if (!document) continue;
          for (const task of document.tasks) {
            if (!task.archived) continue;
            nextItems.push({
              taskId: task.id,
              title: task.title,
              updatedAt: task.updatedAt,
              projectPath: project.path,
              projectName: project.name,
            });
          }
        }
      }

      const uniqueItems = new Map(
        nextItems.map((item) => [`${item.projectPath}\u0000${item.taskId}`, item]),
      );
      if (refreshId !== archivedRefreshId.current) return;
      setArchivedTasks([...uniqueItems.values()].sort((a, b) => b.updatedAt - a.updatedAt));
    } catch (reason) {
      if (refreshId !== archivedRefreshId.current) return;
      setArchivedTasksError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (refreshId === archivedRefreshId.current) setArchivedTasksLoading(false);
    }
  }, [projects, tasks, workspace.name, workspace.path]);

  const restoreArchivedTask = async (item: ArchivedTaskItem) => {
    if (item.projectPath === workspace.path) {
      if (!taskStateReady) return;
      setTaskArchived(item.taskId, false);
      setArchivedTasks((current) =>
        current.filter(
          (task) => task.projectPath !== item.projectPath || task.taskId !== item.taskId,
        ),
      );
      return;
    }
    if (!isTauriHost()) return;

    try {
      const document = await nativeBridge.loadXiaoWorkspace(item.projectPath, false);
      if (!document) return;
      const updatedAt = Date.now();
      const tasks = document.tasks.map((task) =>
        task.id === item.taskId ? { ...task, archived: false, updatedAt } : task,
      );
      await enqueueWorkspaceSave(updateFromDocument({ ...document, tasks, showArchived: false }));
      setArchivedTasks((current) =>
        current.filter(
          (task) => task.projectPath !== item.projectPath || task.taskId !== item.taskId,
        ),
      );
      setProjects((current) =>
        current.map((project) =>
          project.path === item.projectPath ? { ...project, updatedAt } : project,
        ),
      );
    } catch (reason) {
      setArchivedTasksError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const addProject = async () => {
    if (agent.hasActiveRuns) return;
    if (!isTauriHost()) return;
    const selected = await open({ directory: true, multiple: false, title: "Add a project to Xiao" });
    if (typeof selected !== "string") return;
    const name = selected.split(/[\\/]/).filter(Boolean).at(-1) ?? selected;
    const nextPreferences = {
      ...projectPreferences,
      [selected]: { ...projectPreferences[selected], hidden: false },
    };
    setProjectPreferences(nextPreferences);
    projectPreferencesRef.current = nextPreferences;
    writeProjectPreferences(nextPreferences);
    setProjects((current) =>
      applyProjectPreferences(
        mergeProject(current, { path: selected, name, updatedAt: Date.now() }),
        nextPreferences,
      ),
    );
    setActiveProjectPath(selected);
    setActivePage("tasks");
    closeFocusPanel();
  };

  useEffect(() => {
    if (activePage !== "settings") return;
    void refreshArchivedTasks();
    return () => {
      archivedRefreshId.current += 1;
    };
  }, [activePage, refreshArchivedTasks]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setTaskSwitcherOpen(false);
        setCommandMenuOpen((open) => !open);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Tab") {
        event.preventDefault();
        setCommandMenuOpen(false);
        setTaskSwitcherOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "t") {
        event.preventDefault();
        setTaskSwitcherOpen(false);
        openNewTaskTab();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w" && activePage === "tasks") {
        event.preventDefault();
        closeTaskTab(activeTaskId ?? draftTask.id);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "`") {
        event.preventDefault();
        openFocusView("runtime");
      }
      if (event.key === "Escape") {
        setCommandMenuOpen(false);
        setTaskSwitcherOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePage, activeTaskId, draftTask.id, draftTabOpen, openTaskIds, taskStateReady]);

  return (
    <>
      <GlobalContextMenu />
      {taskSwitcherOpen ? (
        <TaskSwitcher
          tasks={tasks}
          activeTaskId={activeTaskId}
          workingTaskIds={agent.workingTaskIds}
          onClose={() => setTaskSwitcherOpen(false)}
          onSelect={(taskId) => {
            setOpenTaskIds((current) => current.includes(taskId) ? current : [...current, taskId]);
            setActiveTaskId(taskId);
            setActivePage("tasks");
            setTaskSwitcherOpen(false);
            closeSidebarOnNarrow();
          }}
        />
      ) : null}
      <AppShell
        sidebarOpen={sidebarOpen}
        focusRailOverlay={focusView === "browser" || focusView === "files"}
        onCloseSidebar={closeSidebar}
        statusBar={
          <StatusBar
            runtimePhase={agent.runtime.phase}
            workspaceName={workspace.name}
            workspacePath={workspace.path}
            branch={workspace.git?.branch ?? null}
            model={statusModel?.displayName ?? activeTask.model ?? "Default model"}
            reasoningEffort={statusReasoningEffort}
            contextPercent={statusContextPercent}
            sandboxMode={activeTask.sandboxMode}
            approvalPolicy={activeTask.approvalPolicy}
            workspaceMode={activeTask.workspaceMode}
            workingTaskCount={agent.workingTaskIds.length}
            onOpenRuntime={() => openFocusView("runtime")}
            onOpenChanges={() => openFocusView("changes")}
            onOpenContext={() => openFocusView("context")}
          />
        }
        titleBar={
          <TitleBar
            tabs={titleBarTabs}
            activeTabId={activeTaskId ?? draftTask.id}
            sidebarOpen={sidebarOpen}
            onOpenMenu={() => setCommandMenuOpen(true)}
            onToggleSidebar={() => setSidebarOpen((open) => !open)}
            onSelectTab={selectTaskTab}
            onCloseTab={closeTaskTab}
            onNewTab={openNewTaskTab}
            update={codexUpdate.status?.updateAvailable && codexUpdate.status.canUpdate ? {
              version: codexUpdate.status.latestVersion,
              installing: codexUpdate.updating,
              disabled: codexUpdate.updating || agent.hasActiveRuns || agent.runtime.phase === "starting",
              onInstall: () => {
                void codexUpdate.install().then((result) => {
                  if (result) void refresh();
                });
              },
            } : undefined}
          />
        }
        sidebar={
          <Sidebar
            activePage={activePage}
            projects={projects}
            activeProjectPath={workspace.path}
            tasks={tasks}
            activeTaskId={selectedTask?.id ?? ""}
            workspace={workspace}
            workingTaskIds={agent.workingTaskIds}
            account={agent.account}
            profile={profile}
            canOpenProjects={isTauriHost()}
            attentionCount={attentionItems.length}
            attentionHydrationStatus={attentionHydrationStatus}
            onOpenMenu={() => setCommandMenuOpen(true)}
            onOpenAttention={() => {
              setActivePage("attention");
              closeFocusPanel();
              closeSidebarOnNarrow();
            }}
            onOpenProfile={() => {
              setActivePage("profile");
              closeFocusPanel();
              closeSidebarOnNarrow();
            }}
            onOpenSettings={() => {
              setActivePage("settings");
              closeFocusPanel();
              closeSidebarOnNarrow();
            }}
            onOpenTasks={() => {
              setActivePage("tasks");
              closeSidebarOnNarrow();
            }}
            onAddProject={() => void addProject()}
            onSelectProject={(path) => {
              if (agent.hasActiveRuns) return;
              setActiveProjectPath(path);
              setActivePage("tasks");
              closeFocusPanel();
              closeSidebarOnNarrow();
            }}
            onSelectTask={(taskId) => {
              setActiveTaskId(taskId);
              setActivePage("tasks");
              closeSidebarOnNarrow();
            }}
            onToggleTaskPinned={toggleTaskPinned}
            onSetTaskArchived={setTaskArchived}
            onRenameTask={renameTask}
            onMarkTaskUnread={markTaskUnread}
            onContinueInNewTask={continueInNewTask}
            onToggleProjectPinned={toggleProjectPinned}
            onOpenProject={openProject}
            onRenameProject={renameProject}
            onArchiveProjectTasks={(path) => void archiveProjectTasks(path)}
            onRemoveProject={removeProject}
          />
        }
        content={
          activePage === "attention" ? (
            <AttentionCenter
              items={attentionItems}
              hydrationStatus={attentionHydrationStatus}
              onRetry={retryAttention}
              onOpenTask={(taskId) => {
                setOpenTaskIds((current) =>
                  current.includes(taskId) ? current : [...current, taskId]
                );
                setActiveTaskId(taskId);
                markTaskUnread(taskId, false);
                setActivePage("tasks");
                closeSidebarOnNarrow();
                focusAppContentNextFrame();
              }}
              onClose={() => {
                setActivePage("tasks");
                focusAppContentNextFrame();
              }}
            />
          ) : activePage === "settings" ? (
            <SettingsPage
              theme={theme}
              preferences={preferences}
              models={agent.models}
              account={agent.account}
              runtime={agent.runtime}
              system={system}
              codexUpdate={codexUpdate.status}
              codexUpdateResult={codexUpdate.result}
              codexUpdateChecking={codexUpdate.checking}
              codexUpdating={codexUpdate.updating}
              codexUpdateError={codexUpdate.error}
              archivedTasks={archivedTasks}
              archivedTasksLoading={archivedTasksLoading}
              archivedTasksError={archivedTasksError}
              onThemeChange={setTheme}
              onPreferencesChange={updatePreferences}
              onRestoreArchivedTask={(item) => void restoreArchivedTask(item)}
              onReloadArchivedTasks={() => void refreshArchivedTasks()}
              onReconnect={() => void agent.connect()}
              onCheckCodexUpdate={() => void codexUpdate.check()}
              onUpdateCodex={() => {
                void codexUpdate.install().then((result) => {
                  if (result) void refresh();
                });
              }}
              onClose={() => setActivePage("tasks")}
            />
          ) : activePage === "profile" ? (
            <ProfilePage
              accountUsage={agent.accountUsage}
              profile={profile}
              runtime={agent.runtime}
              usage={agent.usage}
              onClose={() => setActivePage("tasks")}
              onSaveProfile={saveProfile}
            />
          ) : (
            <TaskWorkspace
              key={workspaceTaskKey(workspace.path, activeTask.id)}
              taskId={activeTask.id}
              executionTaskId={executionTaskId}
              taskTitle={activeTask.title}
              taskArchived={activeTask.archived}
              launchMode={focusedLaunch}
              taskStateError={taskStateError}
              taskStateLoading={taskWorkspaceStateLoading}
              timeline={agent.timeline}
              runtime={agent.runtime}
              rateLimits={agent.rateLimits}
              latestRun={agent.latestRun}
              models={visibleModels}
              selectedModel={activeTask.model}
              selectedReasoningEffort={activeTask.reasoningEffort}
              fastMode={preferences.fastMode}
              mode={activeTask.mode}
              approvalPolicy={activeTask.approvalPolicy}
              sandboxMode={activeTask.sandboxMode}
              workspaceMode={activeTask.workspaceMode}
              environmentBusy={activeEnvironmentBusy}
              environmentError={environmentError ?? workspaceError}
              goal={activeTask.goal}
              plan={activeTask.plan}
              reviewContext={pendingReviewContext}
              questionRequest={agent.questionRequest}
              draftText={activeTask.draftText}
              followUps={activeTask.followUps}
              sendingFollowUpId={sendingFollowUpId}
              failedFollowUpId={failedFollowUpId}
              attachments={restoredAttachmentsByTask[workspaceTaskKey(taskWorkspacePath, activeTask.id)] ?? []}
              canCompact={agent.canCompact}
              compacting={agent.compacting}
              hasThread={agent.hasThread}
              canUndo={agent.canUndo && activeTask.followUps.length === 0}
              undoing={agent.undoing}
              contextUsage={agent.contextUsage}
              showReasoningSummaries={preferences.showReasoningSummaries}
              expandToolOutput={preferences.expandToolOutput}
              launchBrand={preferences.launchBrand}
              workspace={workspace}
              onModelChange={(model) => {
                patchActiveTask({ model, reasoningEffort: null });
                updateTaskRunDefaults({ model, reasoningEffort: null });
              }}
              onReasoningEffortChange={(reasoningEffort) => {
                patchActiveTask({ reasoningEffort });
                updateTaskRunDefaults({ reasoningEffort });
              }}
              onFastModeChange={(fastMode) => updatePreferences({ fastMode })}
              onModeChange={(mode) => {
                patchActiveTask({ mode });
                updateTaskRunDefaults({ mode });
              }}
              onApprovalPolicyChange={(approvalPolicy) => {
                patchActiveTask({ approvalPolicy });
                updateTaskRunDefaults({ approvalPolicy });
                void agent.setApprovalPolicy(approvalPolicy);
              }}
              onSandboxModeChange={(sandboxMode) => {
                patchActiveTask({ sandboxMode });
                updateTaskRunDefaults({ sandboxMode });
              }}
              onWorkspaceModeChange={changeTaskWorkspaceMode}
              onGoalSet={agent.setGoal}
              onGoalClear={agent.clearGoal}
              onInterrupt={agent.interrupt}
              onRetryRun={(runId) => {
                if (taskWorkspaceStateLoading || taskStateError) return;
                void agent.retryRun(runId);
              }}
              onSubmit={submitTask}
              onSteer={steerTask}
              onQueueFollowUp={queueTaskFollowUp}
              onEditFollowUp={editTaskFollowUp}
              onRemoveFollowUp={removeTaskFollowUp}
              onSendFollowUpNow={sendTaskFollowUpNow}
              onRetryFollowUp={() => setFailedFollowUpId(null)}
              onAttachmentsChange={(attachments) =>
                updateTaskAttachments(taskWorkspacePath, activeTask.id, attachments)
              }
              onCompact={agent.compact}
              onUndo={() => void undoTaskTurn()}
              onForkTask={forkTask}
              onRemoveReviewContext={removeReviewContext}
              onReviewContextSent={clearReviewContext}
              onResolveQuestion={agent.resolveQuestion}
              onDraftChange={(draftText) =>
                updateTaskDraft(taskWorkspacePath, activeTask.id, draftText)
              }
              onSubmissionStart={() =>
                composerRevisionByTaskRef.current[
                  workspaceTaskKey(taskWorkspacePath, activeTask.id)
                ] ?? 0
              }
              onSubmissionSucceeded={(revision) =>
                completeComposerSubmission(taskWorkspacePath, activeTask.id, revision)
              }
              onResolveApproval={agent.resolveApproval}
              onFocusView={openFocusView}
              onOpenResource={openTimelineResource}
              onToggleArchived={() => {
                if (selectedTask) setTaskArchived(selectedTask.id, !selectedTask.archived);
              }}
            />
          )
        }
        focusRail={
          activePage === "tasks" && focusPanelOpen ? (
            <FocusRail
              activeView={focusView}
              resourceRequest={focusResourceRequest}
              onViewChange={(view) => openFocusView(view)}
              onClose={closeFocusPanel}
              onOpenBrowser={openTimelineResource}
              onBrowserNavigationStart={invalidateFocusResourceRequest}
              workspace={workspace}
              system={system}
              runtime={agent.runtime}
              task={activeTask}
              executionTaskId={executionTaskId}
              executionTransitioning={activeEnvironmentBusy}
              workspaceActionable={workspaceActionable}
              timeline={agent.timeline}
              models={agent.models}
              contextUsage={agent.contextUsage}
              plan={activeTask.plan}
              runtimeLogs={agent.runtimeLogs}
              runs={agent.runs}
              pendingInputs={agent.pendingInputs}
              onJumpToTimeline={jumpToTimelineEntry}
              onImportHandoff={importTaskHandoff}
              loading={loading || activeEnvironmentBusy}
              error={workspaceError}
              onRefresh={refresh}
              onLoadDirectory={loadDirectory}
              routines={routineController.routines}
              routinesLoading={routineController.loading}
              routinesError={routineController.error}
              routineCreating={routineController.creating}
              routineBusyIds={routineController.busyIds}
              routineOpenRunId={routineOpenTarget?.runId ?? null}
              nativeRoutinesAvailable={isTauriHost()}
              dangerousRoutineAccessDefault={preferences.taskRunDefaults.sandboxMode === "danger-full-access"}
              dangerousRoutineIds={dangerousRoutineIds}
              onCreateRoutine={createRoutine}
              onUpdateRoutine={updateRoutine}
              onSetRoutineEnabled={async (routineId, enabled) => {
                await routineController.setEnabled(routineId, enabled);
              }}
              onRunRoutineNow={async (routineId) => {
                await routineController.runNow(routineId);
              }}
              onDeleteRoutine={routineController.remove}
              onClearRoutineError={routineController.clearError}
              onTaskAcceptanceContractSaved={updateTaskAcceptanceContract}
              reviewContext={pendingReviewContext}
              onStageReviewContext={stageReviewContext}
              onRemoveReviewContext={removeReviewContext}
              obscured={commandMenuOpen}
            />
          ) : null
        }
      />

      <CommandMenu
        open={commandMenuOpen}
        tasks={tasks}
        workspace={workspace}
        onClose={() => setCommandMenuOpen(false)}
        onSelectTask={(taskId) => {
          setActiveTaskId(taskId);
          setActivePage("tasks");
          setCommandMenuOpen(false);
        }}
        onSelectView={(view) => {
          setActivePage("tasks");
          openFocusView(view);
          setCommandMenuOpen(false);
        }}
      />
    </>
  );
}
