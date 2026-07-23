import { useEffect, useRef, useState } from "react";

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
  runtimeError: string | null;
  onOpenRuntime: () => void;
  onOpenCapabilities: () => void;
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

type StatusPopoverProps = Pick<
  StatusBarProps,
  | "runtimePhase"
  | "runtimeError"
  | "workspaceName"
  | "workspacePath"
  | "branch"
  | "model"
  | "reasoningEffort"
  | "contextPercent"
  | "sandboxMode"
  | "approvalPolicy"
  | "workspaceMode"
  | "workingTaskCount"
  | "onOpenRuntime"
  | "onOpenCapabilities"
>;

export function StatusPopover({
  runtimePhase,
  runtimeError,
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
  onOpenCapabilities,
}: StatusPopoverProps) {
  const workspaceLabel = workspaceMode === "managed-worktree" ? "Managed worktree" : workspaceName;
  const contextLabel = contextPercent === null ? "Not reported" : `${contextPercent}% used`;

  return (
    <section id="status-popover" className="status-popover" aria-label="System status">
      <div className="status-popover__header">
        <div>
          <span className="status-popover__eyebrow">System status</span>
          <strong>
            <i className={`status-popover__mark is-${runtimePhase}`} aria-hidden="true" />
            {runtimeLabels[runtimePhase]}
          </strong>
        </div>
        <span className={workingTaskCount > 0 ? "is-active" : undefined}>
          {workingTaskCount > 0 ? `${workingTaskCount} active` : "Idle"}
        </span>
      </div>

      {runtimeError ? (
        <p className="status-popover__error" title={runtimeError}>
          {runtimeError}
        </p>
      ) : null}

      <dl className="status-popover__facts">
        <div>
          <dt>Workspace</dt>
          <dd title={workspacePath}>
            <span>{workspaceLabel}</span>
            <small>{branch ?? workspacePath}</small>
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd title={model}>
            <span>{model}</span>
            <small>{reasoningLabel(reasoningEffort)} reasoning</small>
          </dd>
        </div>
        <div>
          <dt>Context</dt>
          <dd>
            <span>{contextLabel}</span>
            <span
              className="status-popover__usage"
              role="progressbar"
              aria-label="Context used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={contextPercent ?? undefined}
            >
              <i style={{ width: `${contextPercent ?? 0}%` }} />
            </span>
          </dd>
        </div>
        <div>
          <dt>Permissions</dt>
          <dd>
            <span>{sandboxLabels[sandboxMode]}</span>
            <small>{approvalLabels[approvalPolicy]}</small>
          </dd>
        </div>
      </dl>

      <div className="status-popover__actions">
        <button className="status-popover__action" type="button" onClick={onOpenRuntime}>
          <XiaoIcon name="runtime" size={12} />
          Runtime logs
        </button>
        <button className="status-popover__action" type="button" onClick={onOpenCapabilities}>
          <XiaoIcon name="capability" size={12} />
          Tools
        </button>
      </div>
    </section>
  );
}

export function StatusBar({
  runtimePhase,
  runtimeError,
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
  onOpenCapabilities,
  onOpenChanges,
  onOpenContext,
}: StatusBarProps) {
  const [statusOpen, setStatusOpen] = useState(false);
  const statusRootRef = useRef<HTMLDivElement>(null);
  const statusTriggerRef = useRef<HTMLButtonElement>(null);
  const contextLabel = contextPercent === null ? "Context —" : `Context ${contextPercent}%`;
  const permissionLabel = `${sandboxLabels[sandboxMode]} · ${approvalLabels[approvalPolicy]}`;
  const workspaceLabel = workspaceMode === "managed-worktree" ? "Worktree" : workspaceName;

  useEffect(() => {
    if (!statusOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !statusRootRef.current?.contains(event.target)) {
        setStatusOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setStatusOpen(false);
      statusTriggerRef.current?.focus();
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [statusOpen]);

  const closeAndOpen = (open: () => void) => {
    setStatusOpen(false);
    open();
  };

  return (
    <footer className="status-bar" aria-label="Application status">
      <div className="status-bar__left">
        <div className="status-bar__runtime-shell" ref={statusRootRef}>
          <button
            ref={statusTriggerRef}
            className={`status-bar__runtime is-${runtimePhase}`}
            type="button"
            title="Show system status"
            aria-controls="status-popover"
            aria-expanded={statusOpen}
            onClick={() => setStatusOpen((open) => !open)}
          >
            <i className="status-bar__runtime-mark" aria-hidden="true" />
            <span>{runtimeLabels[runtimePhase]}</span>
          </button>
          {statusOpen ? (
            <StatusPopover
              runtimePhase={runtimePhase}
              runtimeError={runtimeError}
              workspaceName={workspaceName}
              workspacePath={workspacePath}
              branch={branch}
              model={model}
              reasoningEffort={reasoningEffort}
              contextPercent={contextPercent}
              sandboxMode={sandboxMode}
              approvalPolicy={approvalPolicy}
              workspaceMode={workspaceMode}
              workingTaskCount={workingTaskCount}
              onOpenRuntime={() => closeAndOpen(onOpenRuntime)}
              onOpenCapabilities={() => closeAndOpen(onOpenCapabilities)}
            />
          ) : null}
        </div>
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
