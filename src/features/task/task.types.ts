import type {
  AgentApprovalPolicy,
  AgentFollowUp,
  AgentGoal,
  AgentMode,
  AgentPlan,
  AgentSandboxMode,
  TimelineEntry,
} from "../../core/models/agent";
import type {
  TaskStage,
  TaskWorkbenchState,
  XiaoThreadBinding,
  XiaoWorkspaceMode,
} from "../../core/models/xiao";
import type { AcceptanceContractVersionSummary } from "../../core/models/verification";

export type TaskGroup = "Active" | "Recent" | "Yesterday" | "This week" | "Older";

const DAY_MS = 86_400_000;

export const taskGroupForUpdatedAt = (
  updatedAt: number,
  active: boolean,
  now: number,
): TaskGroup => {
  if (active) return "Active";
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < DAY_MS) return "Recent";
  if (elapsed < DAY_MS * 2) return "Yesterday";
  if (elapsed <= DAY_MS * 7) return "This week";
  return "Older";
};

export type WorkbenchTask = {
  id: string;
  title: string;
  meta: string;
  group: TaskGroup;
  archived: boolean;
  pinned: boolean;
  unread: boolean;
  createdAt: number;
  updatedAt: number;
  stage: TaskStage;
  stageVersion: number;
  codexProfileId: string | null;
  workbenchState: TaskWorkbenchState;
  draftText: string;
  followUps: AgentFollowUp[];
  model: string | null;
  reasoningEffort: string | null;
  threadId: string | null;
  threadBinding: XiaoThreadBinding | null;
  mode: AgentMode;
  approvalPolicy: AgentApprovalPolicy;
  sandboxMode: AgentSandboxMode;
  goal: AgentGoal | null;
  acceptanceContract: AcceptanceContractVersionSummary | null;
  timeline: TimelineEntry[];
  timelineLoaded: boolean;
  timelineComplete: boolean;
  timelineStart: number;
  timelineEntryCount: number;
  plan: AgentPlan | null;
  executionEnvironmentId: string | null;
  workspaceMode: XiaoWorkspaceMode;
  managedWorktreeId: string | null;
};
