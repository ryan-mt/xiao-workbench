import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentRuntimeState } from "../../../core/models/agent";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { WorkbenchTask } from "../../task/task.types";
import { FocusRail } from "./FocusRail";

vi.mock("./VerificationPanel", () => ({
  VerificationPanel: ({ taskId }: { taskId: string }) => (
    <div data-verification-task-id={taskId}>Verification panel</div>
  ),
}));

const terminalPanelState = vi.hoisted(() => ({
  render: vi.fn(),
}));

vi.mock("./TerminalPanel", () => ({
  TerminalPanel: ({ taskId }: { taskId: string }) => {
    terminalPanelState.render(taskId);
    return <div data-terminal-task-id={taskId}>Terminal panel</div>;
  },
}));

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
const changedWorkspace: WorkspaceSnapshot = {
  ...workspace,
  git: {
    branch: "main",
    repositoryRoot: workspace.path,
    workspaceScoped: true,
    added: 0,
    modified: 1,
    deleted: 0,
    untracked: 0,
    clean: false,
    changesTruncated: false,
    changes: [{
      path: "src/task-a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "+changed",
      patchTruncated: false,
    }],
  },
};


const task: WorkbenchTask = {
  id: "in-memory-task-id",
  title: "New task",
  meta: "Now",
  group: "Active",
  archived: false,
  pinned: false,
  unread: false,
  createdAt: 1,
  updatedAt: 1,
  draftText: "",
  followUps: [],
  model: null,
  reasoningEffort: null,
  threadId: null,
  threadBinding: null,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
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

const renderFocusView = (
  activeView: "changes" | "terminal" | "verification",
  executionTaskId: string | null,
  workspaceActionable = true,
  currentWorkspace = workspace,
) => renderToStaticMarkup(
  <FocusRail
    activeView={activeView}
    onViewChange={() => undefined}
    onClose={() => undefined}
    workspace={currentWorkspace}
    system={{ platform: "Windows", shell: "PowerShell", codexVersion: null }}
    runtime={runtime}
    task={task}
    executionTaskId={executionTaskId}
    executionTransitioning={false}
    workspaceActionable={workspaceActionable}
    timeline={[]}
    models={[]}
    contextUsage={null}
    plan={null}
    runtimeLogs={[]}
    loading={false}
    error={null}
    onRefresh={() => undefined}
    onLoadDirectory={async () => []}
    routines={[]}
    routinesLoading={false}
    routinesError={null}
    routineCreating={false}
    routineBusyIds={new Set()}
    routineOpenRunId={null}
    nativeRoutinesAvailable
    dangerousRoutineAccessDefault={false}
    dangerousRoutineIds={new Set()}
    onCreateRoutine={async () => undefined}
    onUpdateRoutine={async () => undefined}
    onSetRoutineEnabled={async () => undefined}
    onRunRoutineNow={async () => undefined}
    onDeleteRoutine={async () => undefined}
    onClearRoutineError={() => undefined}
    onTaskAcceptanceContractSaved={() => undefined}
    reviewContext={[]}
    onStageReviewContext={() => undefined}
    onRemoveReviewContext={() => undefined}
    obscured={false}
  />,
);

describe("FocusRail acceptance availability", () => {
  it("disables the menu item and does not mount a restored verification view for a draft", () => {
    const markup = renderFocusView("verification", null);

    expect(markup).toContain('aria-label="Acceptance is unavailable until this task starts"');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("data-verification-task-id");
  });

  it("mounts verification against the materialized execution task", () => {
    const markup = renderFocusView("verification", "native-task-id");

    expect(markup).not.toContain("Acceptance is unavailable until this task starts");
    expect(markup).toContain('data-verification-task-id="native-task-id"');
    expect(markup).not.toContain('data-verification-task-id="in-memory-task-id"');
  });
});

describe("FocusRail terminal availability", () => {
  it("disables Terminal and does not mount a restored terminal view for a draft", () => {
    terminalPanelState.render.mockClear();

    const markup = renderFocusView("terminal", null);

    expect(markup).toMatch(
      /<button aria-label="Terminal is unavailable until this task starts"[^>]*disabled=""/,
    );
    expect(markup).not.toContain("data-terminal-task-id");
    expect(terminalPanelState.render).not.toHaveBeenCalled();
  });

  it("enables and mounts Terminal against the materialized execution task", async () => {
    terminalPanelState.render.mockClear();

    renderFocusView("terminal", "native-task-id");
    // Exercise FocusRail's intentional lazy-loading boundary before asserting the mounted panel.
    await import("./TerminalPanel");
    await Promise.resolve();
    const markup = renderFocusView("terminal", "native-task-id");

    expect(markup).not.toContain("Terminal is unavailable until this task starts");
    const terminalAction = markup.match(/<button[^>]*title="Run workspace commands"[^>]*>/)?.[0];
    expect(terminalAction).toBeDefined();
    expect(terminalAction).not.toContain("disabled");
    expect(markup).toContain('data-terminal-task-id="native-task-id"');
    expect(markup).not.toContain('data-terminal-task-id="in-memory-task-id"');
    expect(terminalPanelState.render).toHaveBeenCalledWith("native-task-id");
  });
});

describe("FocusRail changes snapshot availability", () => {
  it("wires a stale workspace snapshot through as non-actionable", () => {
    const markup = renderFocusView("changes", "task-b", false, changedWorkspace);

    expect(markup).toMatch(/<button[^>]*title="src\/task-a\.ts"[^>]*disabled=""/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Stage<\/button>/);
    expect(markup).toMatch(/aria-label="Refresh changes"[^>]*disabled=""/);
  });

  it("re-enables task B controls once its snapshot is current", () => {
    const taskBWorkspace: WorkspaceSnapshot = {
      ...changedWorkspace,
      path: "C:/workspace/task-b",
      git: {
        ...changedWorkspace.git!,
        changes: [{
          ...changedWorkspace.git!.changes[0]!,
          path: "src/task-b.ts",
        }],
      },
    };
    const markup = renderFocusView("changes", "task-b", true, taskBWorkspace);

    const taskBPath = markup.match(/<button[^>]*title="src\/task-b\.ts"[^>]*>/)?.[0];
    expect(taskBPath).toBeDefined();
    expect(taskBPath).not.toContain("disabled");
    const stage = markup.match(/<button[^>]*>Stage<\/button>/)?.[0];
    expect(stage).toBeDefined();
    expect(stage).not.toContain("disabled");
  });
});
