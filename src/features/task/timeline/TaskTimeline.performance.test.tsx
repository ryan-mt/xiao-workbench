// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentRuntimeState,
  TimelineEntry,
} from "../../../core/models/agent";
import { TaskTimeline } from "./TaskTimeline";

const { markdownRenders } = vi.hoisted(() => ({
  markdownRenders: new Map<string, number>(),
}));

vi.mock("./MarkdownBody", () => ({
  CopyButton: () => null,
  MarkdownBody: ({ content }: { content: string }) => {
    markdownRenders.set(content, (markdownRenders.get(content) ?? 0) + 1);
    return content;
  },
}));

const runtime: AgentRuntimeState = {
  phase: "working",
  profileId: "profile-1",
  taskId: "task-1",
  threadId: "thread-1",
  turnId: "turn-live",
  turnStartedAt: Date.now() - 1_000,
  error: null,
  eventsSeen: 0,
};

const renderTimeline = (timeline: TimelineEntry[]) => (
  <TaskTimeline
    timeline={timeline}
    runtime={runtime}
    latestRun={null}
    showReasoningSummaries
    expandToolOutput={false}
    workspacePath="C:\\work\\xiao"
    onOpenResource={() => true}
    historyLoading={false}
    canFork={false}
    onForkTask={() => undefined}
    onResolveApproval={async () => undefined}
    taskId="task-1"
    onReviewChanges={() => undefined}
    onFixVerificationFailures={async () => true}
    fixVerificationFailuresDisabled={false}
    canUndo={false}
    undoing={false}
    onUndo={() => undefined}
  />
);

describe("TaskTimeline long Task updates", () => {
  afterEach(() => {
    cleanup();
    markdownRenders.clear();
  });

  it("does not re-render completed turns when only the live turn changes", () => {
    const completed = Array.from({ length: 80 }, (_, index): TimelineEntry[] => [{
      id: `user-${index}`,
      kind: "user",
      title: `Prompt ${index}`,
      turnId: `turn-${index}`,
    }, {
      id: `response-${index}`,
      kind: "result",
      title: "Agent response",
      body: `Historical response ${index}`,
      status: "success",
      turnId: `turn-${index}`,
    }]).flat();
    const liveUser: TimelineEntry = {
      id: "user-live",
      kind: "user",
      title: "Current prompt",
      turnId: "turn-live",
    };
    const view = render(renderTimeline([...completed, liveUser]));

    markdownRenders.clear();
    view.rerender(renderTimeline([...completed, liveUser, {
      id: "thought-live",
      kind: "thought",
      title: "Reasoning",
      body: "Inspecting the current change",
      status: "active",
      turnId: "turn-live",
    }]));

    const historicalRenders = [...markdownRenders.entries()]
      .filter(([content]) => content.startsWith("Historical response "))
      .reduce((total, [, count]) => total + count, 0);
    expect(historicalRenders).toBe(0);
  });
});
