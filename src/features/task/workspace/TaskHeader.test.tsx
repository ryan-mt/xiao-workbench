import type { ButtonHTMLAttributes, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentRuntimeState } from "../../../core/models/agent";
import type { RunSnapshot } from "../../../core/models/run";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";

import { TaskAcceptanceAction, TaskHeader } from "./TaskHeader";
const runtime: AgentRuntimeState = {
  phase: "ready",
  taskId: null,
  threadId: null,
  turnId: null,
  turnStartedAt: null,
  error: null,
  eventsSeen: 0,
};

const workspace: WorkspaceSnapshot = {
  name: "Xiao",
  path: "C:/workspace/xiao",
  execution: {
    projectPath: "C:/workspace/xiao",
    executionRoot: "C:/workspace/xiao",
    environment: {
      id: "windows",
      kind: "windows",
      label: "Windows",
      availability: "available",
    },
    workspaceMode: "local",
    managedWorktree: null,
    isolationAvailable: true,
    isolationUnavailableReason: null,
  },
  files: [],
  git: null,
};

const run = (patch: Partial<RunSnapshot>): RunSnapshot => ({
  id: "run-a",
  workspacePath: "C:/workspace/xiao",
  taskId: "task-a",
  idempotencyKey: "key-a",
  parentRunId: null,
  candidateGroupId: null,
  routineOccurrenceId: null,
  acceptanceContractSourceVersionId: null,
  acceptanceContractSnapshot: null,
  acceptanceContractSnapshotSha256: null,
  verificationBaselineState: "notRequired",
  verificationBaselineArtifactId: null,
  verificationBaselineDiagnostic: null,
  latestVerificationAttemptId: null,
  status: "queued",
  agentOutcome: "pending",
  verificationOutcome: "not_requested",
  executionEnvironmentId: "windows",
  executionRoot: "C:/workspace/xiao",
  managedWorktreeId: null,
  prompt: "Do work",
  model: "gpt-test",
  reasoningEffort: "medium",
  serviceTier: null,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  threadId: null,
  threadSource: null,
  cliVersion: null,
  runtimeGeneration: null,
  turnId: null,
  cancelRequested: false,
  queuedAt: 1,
  startedAt: null,
  finishedAt: null,
  version: 0,
  ...patch,
});

const renderHeader = (latestRun: RunSnapshot) => renderToStaticMarkup(
  <TaskHeader
    taskId="task-a"
    executionTaskId="task-a"
    taskTitle="Task"
    taskArchived={false}
    workspace={workspace}
    runtime={runtime}
    latestRun={latestRun}
    contextPercent={null}
    archiveDisabled={false}
    canUndo={false}
    undoing={false}
    onFocusView={vi.fn()}
    onRetryRun={vi.fn()}
    onToggleArchived={vi.fn()}
    onUndo={vi.fn()}
  />,
);

const retryLabel = "<span>Retry</span>";


const actionProps = (executionTaskId: string | null, onOpen: () => void) => (
  TaskAcceptanceAction({
    executionTaskId,
    iconSize: 13,
    label: "Acceptance",
    onOpen,
  }) as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>
).props;

const renderAction = (executionTaskId: string | null, onOpen: () => void) => renderToStaticMarkup(
  <TaskAcceptanceAction
    executionTaskId={executionTaskId}
    iconSize={13}
    label="Acceptance"
    onOpen={onOpen}
  />,
);

describe("TaskAcceptanceAction", () => {
  it("cannot open acceptance for an unmaterialized draft task", () => {
    const onOpen = vi.fn();
    const props = actionProps(null, onOpen);
    const markup = renderAction(null, onOpen);

    expect(props.disabled).toBe(true);
    expect(props.onClick).toBeUndefined();
    expect(props.title).toBe("Acceptance is unavailable until this task starts");
    expect(props["aria-label"]).toBe("Acceptance is unavailable until this task starts");
    expect(markup).toContain('disabled=""');
  });

  it("opens acceptance for a materialized task", () => {
    const onOpen = vi.fn();
    const props = actionProps("task-1", onOpen);
    const markup = renderAction("task-1", onOpen);

    expect(props.disabled).toBe(false);
    expect(props.title).toBe("Acceptance contract");
    expect(props["aria-label"]).toBe("Acceptance contract");
    expect(markup).not.toContain('disabled=""');

    (props.onClick as (() => void) | undefined)?.();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("TaskHeader retry action", () => {
  it("hides full Retry when verification is interrupted after agent completion", () => {
    const markup = renderHeader(run({
      status: "interrupted",
      agentOutcome: "completed",
      verificationOutcome: "blocked",
    }));

    expect(markup).toContain("Verification blocked");
    expect(markup).not.toContain(retryLabel);
  });

  it("offers Retry when agent work is interrupted", () => {
    const markup = renderHeader(run({
      status: "interrupted",
      agentOutcome: "interrupted",
    }));

    expect(markup).toContain(retryLabel);
  });

  it("offers Retry when the agent run fails", () => {
    const markup = renderHeader(run({
      status: "failed",
      agentOutcome: "failed",
    }));

    expect(markup).toContain(retryLabel);
  });
});
