import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentRuntimeState, RuntimePhase } from "../../../core/models/agent";
import type { RunSnapshot } from "../../../core/models/run";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { FocusView } from "../../focus-rail/focus-rail.types";
import { runPresentation } from "../../verification/runPresentation";

type TaskHeaderProps = {
  taskId: string;
  executionTaskId: string | null;
  taskTitle: string;
  taskArchived: boolean;
  workspace: WorkspaceSnapshot;
  runtime: AgentRuntimeState;
  latestRun: RunSnapshot | null;
  contextPercent: number | null;
  actionsDisabled: boolean;
  archiveDisabled: boolean;
  canUndo: boolean;
  undoing: boolean;
  onFocusView: (view: FocusView) => void;
  onRetryRun: (runId: string) => void;
  onToggleArchived: () => void;
  onUndo: () => void;
};

type TaskAcceptanceActionProps = {
  executionTaskId: string | null;
  label: string;
  iconSize: number;
  className?: string;
  onOpen: () => void;
};

export function TaskAcceptanceAction({
  executionTaskId,
  label,
  iconSize,
  className,
  onOpen,
}: TaskAcceptanceActionProps) {
  const unavailable = executionTaskId === null;
  const title = unavailable
    ? "Acceptance is unavailable until this task starts"
    : "Acceptance contract";

  return (
    <button
      aria-label={title}
      className={className}
      type="button"
      disabled={unavailable}
      title={title}
      onClick={unavailable ? undefined : onOpen}
    >
      <XiaoIcon name="check" size={iconSize} />
      <span>{label}</span>
    </button>
  );
}

const runtimeLabels: Record<RuntimePhase, string> = {
  offline: "Offline",
  starting: "Connecting",
  ready: "Ready",
  working: "Working",
  error: "Needs attention",
};


export function TaskHeader({
  taskId,
  executionTaskId,
  taskTitle,
  taskArchived,
  workspace,
  runtime,
  latestRun,
  contextPercent,
  actionsDisabled,
  archiveDisabled,
  canUndo,
  undoing,
  onFocusView,
  onRetryRun,
  onToggleArchived,
  onUndo,
}: TaskHeaderProps) {
  const branch = workspace.git?.branch ?? "No Git branch";
  const taskWorking = runtime.phase === "working" && runtime.taskId === taskId;
  const presentedRun = latestRun ? runPresentation(latestRun) : null;
  const runtimeLabel = presentedRun?.label ?? (
    runtime.phase === "working" && !taskWorking
      ? "Busy in another task"
      : runtimeLabels[runtime.phase]
  );
  const runtimeTone = presentedRun?.kind ?? runtime.phase;
  const canRetry = latestRun?.status === "failed"
    || (latestRun?.status === "interrupted" && latestRun.agentOutcome !== "completed");

  return (
    <header className="task-header">
      <div className="task-header__copy">
        <h1>{taskTitle}</h1>
        <div className="task-header__context-row">
          <button className="task-header__branch" onClick={() => onFocusView("changes")}>
            <XiaoIcon name="branch" size={13} />
            <span>{branch}</span>
          </button>
          <span
            className="task-header__environment"
            title={workspace.execution.executionRoot}
          >
            <XiaoIcon name="workspace" size={12} />
            {workspace.execution.workspaceMode === "managed-worktree" ? "Isolated" : "Local"}
          </span>
        </div>
      </div>

      <div className="task-header__actions">
        <span
          className={`task-header__runtime task-header__runtime--${runtimeTone}`}
          role="status"
          aria-live="polite"
          title={runtime.error ?? presentedRun?.description}
        >
          <i />
          {runtimeLabel}
        </span>
        <button
          className="task-header__context"
          type="button"
          aria-label={contextPercent === null ? "View context usage" : `View context usage, ${contextPercent}% used`}
          title={contextPercent === null ? "Context usage" : `${contextPercent}% context used`}
          onClick={() => onFocusView("context")}
        >
          <i style={{ "--usage": `${contextPercent ?? 0}%` } as React.CSSProperties} />
          <span>{contextPercent === null ? "Context" : `${contextPercent}%`}</span>
        </button>
        <TaskAcceptanceAction
          className="button button--quiet"
          executionTaskId={executionTaskId}
          iconSize={15}
          label="Contract"
          onOpen={() => onFocusView("verification")}
        />
        {canRetry ? (
          <button
            className="button button--quiet"
            type="button"
            disabled={actionsDisabled}
            onClick={() => onRetryRun(latestRun.id)}
          >
            <XiaoIcon name="refresh" size={15} />
            <span>Retry</span>
          </button>
        ) : null}
        <button
          aria-label="Review workspace changes"
          className="button button--quiet"
          title="Review workspace changes"
          onClick={() => onFocusView("changes")}
        >
          <XiaoIcon name="changes" size={16} />
          <span>Review</span>
        </button>
        {canUndo || undoing ? (
          <button
            className="button button--quiet task-header__undo"
            type="button"
            disabled={actionsDisabled || !canUndo || undoing}
            title="Remove the last turn and safely revert its workspace patch"
            onClick={onUndo}
          >
            <XiaoIcon className={undoing ? "is-spinning" : undefined} name={undoing ? "pending" : "undo"} size={15} />
            <span>{undoing ? "Undoing" : "Undo"}</span>
          </button>
        ) : null}
        <button
          aria-label={taskArchived ? "Restore task" : "Archive task"}
          className="icon-button task-header__archive"
          disabled={archiveDisabled || taskWorking}
          onClick={onToggleArchived}
          title={taskArchived ? "Restore task" : "Archive task"}
        >
          <XiaoIcon name={taskArchived ? "refresh" : "archive"} size={15} />
        </button>
      </div>
    </header>
  );
}
