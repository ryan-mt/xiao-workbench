import type {
  AgentApprovalPolicy,
  AgentFollowUp,
  AgentGoal,
  AgentMode,
  AgentPlan,
  AgentSandboxMode,
  TimelineEntry,
} from "./agent";
import type { AcceptanceContractVersionSummary } from "./verification";

export type XiaoThreadPersistence = "ephemeral" | "persistent" | "legacy-untrusted";
export type XiaoWorkspaceMode = "local" | "managed-worktree";
export type TaskStage =
  | "draft"
  | "in_progress"
  | "ready_for_review"
  | "published"
  | "completed";

export type TaskWorkbenchState = {
  focusView?: string;
  focusPanelOpen?: boolean;
  timelineScrollTop?: number;
  terminalSessionIds?: string[];
  activeTerminalSessionId?: string;
  terminalSessionNames?: Record<string, string>;
  previewTarget?: string;
  previewZoom?: number;
  previewTabs?: Array<{ id: string; target: string }>;
  activePreviewTabId?: string;
  previewViewport?: "responsive" | "desktop" | "tablet" | "mobile";
  previewConsole?: Record<string, Array<{ level: string; text: string; at: number }>>;
  activeFile?: string | null;
};

export type XiaoThreadBinding = {
  threadId: string;
  persistence: XiaoThreadPersistence;
  materialized: boolean;
  threadSource: string | null;
  cliVersion: string | null;
};

export type XiaoTaskDocument = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  stage?: TaskStage;
  stageVersion?: number;
  codexProfileId?: string | null;
  workbenchState?: TaskWorkbenchState;
  draftText?: string;
  followUps?: AgentFollowUp[];
  archived: boolean;
  pinned: boolean;
  unread: boolean;
  model: string | null;
  reasoningEffort: string | null;
  /** Legacy transport field. New writes use threadBinding instead. */
  threadId?: string | null;
  threadBinding?: XiaoThreadBinding | null;
  mode?: AgentMode;
  approvalPolicy?: AgentApprovalPolicy;
  sandboxMode?: AgentSandboxMode;
  goal?: AgentGoal | null;
  acceptanceContract?: AcceptanceContractVersionSummary | null;
  timeline: TimelineEntry[];
  timelineLoaded: boolean;
  timelineComplete: boolean;
  timelineStart: number;
  timelineEntryCount: number;
  plan?: AgentPlan | null;
  executionEnvironmentId?: string | null;
  workspaceMode?: XiaoWorkspaceMode;
  managedWorktreeId?: string | null;
};

export type XiaoProjectSummary = {
  path: string;
  name: string;
  updatedAt: number;
  pinned?: boolean;
  hidden?: boolean;
  projectGroupId?: string | null;
  projectGroupPosition?: number;
};

export type ProjectGroup = {
  id: string;
  name: string;
  position: number;
  createdAt: number;
  updatedAt: number;
};

export type ProjectGroupUpdate = Pick<ProjectGroup, "id" | "name" | "position">;

export type ProjectPresentationUpdate = {
  path: string;
  displayName: string | null;
  pinned: boolean;
  hidden: boolean;
  projectGroupId: string | null;
  projectGroupPosition: number;
};

export type CodexProfile = {
  id: string;
  displayName: string;
  codexHome: string | null;
  authenticationHome: string | null;
  environment: Record<string, string>;
  availability: "unknown" | "available" | "unavailable" | "incompatible" | "unauthenticated";
  authenticatedIdentity: unknown;
  models: unknown;
  capabilities: unknown;
  usage: unknown;
  rateLimits: unknown;
  diagnostic: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type CodexProfileUpdate = Omit<CodexProfile, "version" | "createdAt" | "updatedAt"> & {
  expectedVersion: number | null;
};

export type TaskCodexProfileBinding = {
  taskId: string;
  codexProfileId: string | null;
  stageVersion: number;
};

export type TaskStageTransition = {
  id: string;
  taskId: string;
  fromStage: TaskStage | null;
  toStage: TaskStage;
  expectedVersion: number | null;
  resultingVersion: number;
  actor: string;
  reason: string;
  sourceRunId: string | null;
  idempotencyKey: string;
  createdAt: number;
};

export type TaskStageTransitionRequest = {
  workspacePath: string;
  taskId: string;
  expectedVersion: number;
  toStage: TaskStage;
  actor: string;
  reason: string;
  sourceRunId: string | null;
  idempotencyKey: string;
};

export type XiaoWorkspaceDocument = {
  schemaVersion: 1;
  workspacePath: string;
  activeTaskId: string | null;
  showArchived: boolean;
  tasks: XiaoTaskDocument[];
};

export type XiaoWorkspaceUpdate = {
  schemaVersion: 1;
  workspacePath: string;
  activeTaskId: string | null;
  showArchived: boolean;
  taskIds: string[];
  tasks: XiaoTaskDocument[];
};

export type XiaoTimelinePage = {
  entries: TimelineEntry[];
  start: number;
  total: number;
  hasMore: boolean;
};

export type XiaoHistorySearchResult = {
  projectPath: string;
  projectName: string;
  taskId: string;
  taskTitle: string;
  taskArchived: boolean;
  entryId: string;
  role: "task" | "user" | "assistant";
  matchKind: "title" | "message";
  snippet: string;
  createdAt: number;
};
