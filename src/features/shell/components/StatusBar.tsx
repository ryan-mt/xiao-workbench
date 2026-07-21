import type {
  AgentApprovalPolicy,
  AgentSandboxMode,
  RuntimePhase,
} from "../../../core/models/agent";
import type { XiaoWorkspaceMode } from "../../../core/models/xiao";
import { XiaoIcon } from "../../../components/icons/XiaoIcon";

type StatusBarProps = {
  runtimePhase: RuntimePhase;
  workspaceName: string;
  workspacePath: string;
  branch: string | null;
  model: string;
  reasoningEffort: string;
  contextPercent: number | null;
  sandboxMode: AgentSandboxMode;
  approvalPolicy: AgentApprovalPolicy;
  workspaceMode: XiaoWorkspaceMode;
  workingTaskCount: number;
  onOpenRuntime: () => void;
  onOpenChanges: () => void;
  onOpenContext: () => void;
};

const runtimeLabels: Record<RuntimePhase, string> = {
  offline: "Offline",
  starting: "Connecting",
  ready: "Ready",
  working: "Working",
  error: "Needs attention",
};

const sandboxLabels: Record<AgentSandboxMode, string> = {
  "workspace-write": "Workspace",
  "read-only": "Read only",
  "danger-full-access": "Full access",
};

const approvalLabels: Record<AgentApprovalPolicy, string> = {
  "on-request": "Ask approval",
  untrusted: "Untrusted only",
  never: "Never ask",
};

const reasoningLabel = (effort: string) =>
  effort
    ? effort.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase())
    : "Default";

export function StatusBar({
  runtimePhase,
  workspaceName,
  workspacePath,
  branch,
  model,
  reasoningEffort,
  contextPercent,
  sandboxMode,
  approvalPolicy,
  workspaceMode,
  workingTaskCount,
  onOpenRuntime,
  onOpenChanges,
  onOpenContext,
}: StatusBarProps) {
  const contextLabel = contextPercent === null ? "Context —" : `Context ${contextPercent}%`;
  const permissionLabel = `${sandboxLabels[sandboxMode]} · ${approvalLabels[approvalPolicy]}`;
  const workspaceLabel = workspaceMode === "managed-worktree" ? "Worktree" : workspaceName;

  return (
    <footer className="status-bar" aria-label="Application status">
      <div className="status-bar__left">
        <button
          className={`status-bar__runtime is-${runtimePhase}`}
          type="button"
          title="Open runtime details"
          onClick={onOpenRuntime}
        >
          <i className="status-bar__runtime-mark" aria-hidden="true" />
          <span>{runtimeLabels[runtimePhase]}</span>
        </button>
        <button
          className="status-bar__workspace"
          type="button"
          title={workspacePath}
          onClick={onOpenChanges}
        >
          <XiaoIcon name="workspace" size={11} />
          <span>{workspaceLabel}</span>
        </button>
        {branch ? (
          <button
            className="status-bar__branch"
            type="button"
            title={`Open changes on ${branch}`}
            onClick={onOpenChanges}
          >
            <XiaoIcon name="branch" size={11} />
            <span>{branch}</span>
          </button>
        ) : null}
      </div>

      <div className="status-bar__right">
        {workingTaskCount > 0 ? (
          <span className="status-bar__runs" title={`${workingTaskCount} active task${workingTaskCount === 1 ? "" : "s"}`}>
            <XiaoIcon className="spin" name="pending" size={11} />
            <span>{workingTaskCount} active</span>
          </span>
        ) : null}
        <span className="status-bar__model" title={`${model} · ${reasoningLabel(reasoningEffort)} reasoning`}>
          <XiaoIcon name="cpu" size={11} />
          <span>{model}</span>
          <small>{reasoningLabel(reasoningEffort)}</small>
        </span>
        <button
          className="status-bar__context"
          type="button"
          title="Inspect session context"
          onClick={onOpenContext}
        >
          <span className="status-bar__usage" aria-hidden="true">
            <i style={{ width: `${contextPercent ?? 0}%` }} />
          </span>
          <span>{contextLabel}</span>
        </button>
        <span className="status-bar__permissions" title={permissionLabel}>
          <XiaoIcon name="secure" size={11} />
          <span>{permissionLabel}</span>
        </span>
      </div>
    </footer>
  );
}
