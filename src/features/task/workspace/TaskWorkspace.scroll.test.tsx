// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntimeState, TimelineEntry } from "../../../core/models/agent";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import { TaskWorkspace } from "./TaskWorkspace";

vi.mock("../composer/Composer", () => ({
  Composer: () => null,
}));

vi.mock("../timeline/TaskTimeline", () => ({
  TaskTimeline: ({ timeline }: { timeline: TimelineEntry[] }) => (
    <div data-timeline-size={timeline.length} />
  ),
}));

vi.mock("./TaskHeader", () => ({
  TaskHeader: () => null,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const runtime: AgentRuntimeState = {
  phase: "ready",
  profileId: null,
  taskId: "task-a",
  threadId: "thread-a",
  turnId: "turn-a",
  turnStartedAt: 1,
  error: null,
  eventsSeen: 1,
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

const taskWorkspaceProps = (
  timeline: TimelineEntry[],
  initialTimelineScrollTop: number | null,
): ComponentProps<typeof TaskWorkspace> => ({
  taskId: "task-a",
  executionTaskId: "task-a",
  taskTitle: "Task",
  taskArchived: false,
  taskStage: "in_progress",
  hasAcceptanceContract: false,
  hasActiveRuns: true,
  launchMode: false,
  taskStateError: null,
  taskStateLoading: false,
  initialTimelineScrollTop,
  timeline,
  runtime,
  rateLimits: null,
  latestRun: null,
  models: [],
  selectedModel: null,
  selectedReasoningEffort: null,
  fastMode: false,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  workspaceMode: "local",
  environmentBusy: false,
  environmentError: null,
  goal: null,
  plan: null,
  reviewContext: [],
  questionRequest: null,
  mcpElicitationRequest: null,
  draftText: "",
  followUps: [],
  sendingFollowUpId: null,
  failedFollowUpId: null,
  attachments: [],
  canCompact: false,
  compacting: false,
  hasThread: true,
  canUndo: false,
  undoing: false,
  definitionOfDoneAvailable: false,
  definitionOfDone: null,
  definitionOfDoneError: null,
  contextUsage: null,
  showReasoningSummaries: true,
  expandToolOutput: false,
  launchBrand: "logo",
  workspace,
  launchProjects: [],
  canChangeLaunchProject: false,
  onLaunchProjectChange: vi.fn(),
  onSubmit: vi.fn().mockResolvedValue(true),
  onSteer: vi.fn().mockResolvedValue(true),
  onQueueFollowUp: vi.fn().mockResolvedValue(true),
  onEditFollowUp: vi.fn(),
  onRemoveFollowUp: vi.fn(),
  onSendFollowUpNow: vi.fn().mockResolvedValue(undefined),
  onRetryFollowUp: vi.fn(),
  onAttachmentsChange: vi.fn(),
  onCompact: vi.fn().mockResolvedValue(true),
  onUndo: vi.fn(),
  onDefinitionOfDoneChange: vi.fn(),
  onForkTask: vi.fn(),
  onRemoveReviewContext: vi.fn(),
  onReviewContextSent: vi.fn(),
  onDraftChange: vi.fn(),
  onSubmissionStart: vi.fn(() => 1),
  onSubmissionSucceeded: vi.fn().mockResolvedValue(true),
  onResolveQuestion: vi.fn().mockResolvedValue(true),
  onResolveMcpElicitation: vi.fn().mockResolvedValue(true),
  onModelChange: vi.fn(),
  onReasoningEffortChange: vi.fn(),
  onFastModeChange: vi.fn(),
  onModeChange: vi.fn(),
  onApprovalPolicyChange: vi.fn(),
  onSandboxModeChange: vi.fn(),
  onWorkspaceModeChange: vi.fn().mockResolvedValue(undefined),
  onGoalSet: vi.fn().mockResolvedValue(true),
  onGoalClear: vi.fn().mockResolvedValue(true),
  onInterrupt: vi.fn().mockResolvedValue(undefined),
  onRetryRun: vi.fn(),
  onResolveApproval: vi.fn().mockResolvedValue(undefined),
  onFocusView: vi.fn(),
  onOpenResource: vi.fn(() => true),
  onToggleArchived: vi.fn(),
  onTransitionTaskStage: vi.fn().mockResolvedValue(undefined),
  onTimelineScrollTopChange: vi.fn(),
});

describe("TaskWorkspace live output scrolling", () => {
  it("continues following output when the persisted scroll position updates", () => {
    let scrollHeight = 1_000;
    const initialTimeline = [
      { id: "entry-a", kind: "agent", title: "First output" },
    ] satisfies TimelineEntry[];
    const view = render(
      <TaskWorkspace {...taskWorkspaceProps(initialTimeline, 900)} />,
    );
    const scrollArea = view.container.querySelector<HTMLElement>(".task-workspace__scroll");
    expect(scrollArea).not.toBeNull();
    if (!scrollArea) return;
    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    scrollArea.scrollTop = 900;
    fireEvent.scroll(scrollArea);

    scrollHeight = 1_200;
    view.rerender(
      <TaskWorkspace
        {...taskWorkspaceProps([
          ...initialTimeline,
          { id: "entry-b", kind: "agent", title: "New output" },
        ], 900)}
      />,
    );

    expect(scrollArea.scrollTop).toBe(1_200);
  });

  it("flushes a pending scroll position to the task that produced it", () => {
    vi.useFakeTimers();
    const firstSave = vi.fn();
    const secondSave = vi.fn();
    const entries = [{ id: "entry-a", kind: "agent", title: "Output" }] satisfies TimelineEntry[];
    const firstProps = {
      ...taskWorkspaceProps(entries, 0),
      onTimelineScrollTopChange: firstSave,
    };
    const view = render(<TaskWorkspace {...firstProps} />);
    const scrollArea = view.container.querySelector<HTMLElement>(".task-workspace__scroll")!;
    scrollArea.scrollTop = 42;
    fireEvent.scroll(scrollArea);

    view.rerender(
      <TaskWorkspace
        {...taskWorkspaceProps(entries, 0)}
        taskId="task-b"
        executionTaskId="task-b"
        onTimelineScrollTopChange={secondSave}
      />,
    );

    expect(firstSave).toHaveBeenCalledWith(42);
    expect(secondSave).not.toHaveBeenCalled();
  });

  it("uses the latest persistence callback inside the debounce", () => {
    vi.useFakeTimers();
    const firstSave = vi.fn();
    const latestSave = vi.fn();
    const entries = [{ id: "entry-a", kind: "agent", title: "Output" }] satisfies TimelineEntry[];
    const view = render(
      <TaskWorkspace
        {...taskWorkspaceProps(entries, 0)}
        onTimelineScrollTopChange={firstSave}
      />,
    );
    const scrollArea = view.container.querySelector<HTMLElement>(".task-workspace__scroll")!;
    scrollArea.scrollTop = 64;
    fireEvent.scroll(scrollArea);
    view.rerender(
      <TaskWorkspace
        {...taskWorkspaceProps(entries, 0)}
        onTimelineScrollTopChange={latestSave}
      />,
    );
    vi.advanceTimersByTime(700);

    expect(firstSave).not.toHaveBeenCalled();
    expect(latestSave).toHaveBeenCalledWith(64);
  });

  it("distinguishes a saved top position from an unseen task", () => {
    const entries = [{ id: "entry-a", kind: "agent", title: "Output" }] satisfies TimelineEntry[];
    const view = render(<TaskWorkspace {...taskWorkspaceProps(entries, 10)} />);
    const scrollArea = view.container.querySelector<HTMLElement>(".task-workspace__scroll")!;
    Object.defineProperty(scrollArea, "scrollHeight", { configurable: true, value: 900 });

    view.rerender(
      <TaskWorkspace
        {...taskWorkspaceProps(entries, 0)}
        taskId="task-b"
        executionTaskId="task-b"
      />,
    );
    expect(scrollArea.scrollTop).toBe(0);

    view.rerender(
      <TaskWorkspace
        {...taskWorkspaceProps(entries, null)}
        taskId="task-c"
        executionTaskId="task-c"
      />,
    );
    expect(scrollArea.scrollTop).toBe(900);
  });
});
