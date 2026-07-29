// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentRuntimeState, TimelineEntry } from "../../../core/models/agent";
import type { ConversationTurn } from "./ConversationTurnProjector";
import { AgentTurn } from "./AgentTurn";

afterEach(cleanup);

const idleRuntime: AgentRuntimeState = {
  phase: "offline",
  profileId: null,
  taskId: null,
  threadId: null,
  turnId: null,
  turnStartedAt: null,
  error: null,
  eventsSeen: 0,
};

describe("AgentTurn completed reasoning", () => {
  const renderTurn = (
    turn: ConversationTurn,
    runtime: AgentRuntimeState,
    liveEligible = true,
  ) => render(
    <AgentTurn
      turn={turn}
      index={0}
      runtime={runtime}
      liveEligible={liveEligible}
      taskId="task-1"
      workspacePath="C:\\work\\xiao"
      expandToolOutput={false}
      showReasoningSummaries
      canFork={false}
      canUndo={false}
      undoing={false}
      onForkTask={() => undefined}
      onOpenResource={() => true}
      onReviewChanges={() => undefined}
      onUndo={() => undefined}
      onResolveApproval={async () => undefined}
    />,
  );

  it("keeps later active work live after a successful interim response", () => {
    const user: TimelineEntry = {
      id: "user-live",
      kind: "user",
      title: "Run the checks",
      turnId: "turn-1",
      createdAt: 1_000,
    };
    const response: TimelineEntry = {
      id: "response-live",
      kind: "result",
      title: "Agent response",
      body: "Initial result.",
      turnId: "turn-1",
      status: "success",
      createdAt: 2_000,
    };
    const command: TimelineEntry = {
      id: "command-live",
      kind: "command",
      title: "Run tests",
      command: "npm test",
      turnId: "turn-1",
      status: "active",
      createdAt: 3_000,
    };
    const turn: ConversationTurn = {
      id: user.id,
      user,
      flow: [command],
      commentary: [],
      work: [command],
      response,
      responseFlowIndex: 0,
      files: [{ path: "src/App.tsx", additions: 2, deletions: 0 }],
      startIndex: 0,
      endIndex: 2,
    };

    const { container } = renderTurn(turn, {
      ...idleRuntime,
      phase: "working",
      taskId: "task-1",
      turnId: "turn-1",
      turnStartedAt: Date.now() - 1_000,
    });

    expect(container.querySelector(".conversation-turn.is-live")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Working for/ }).getAttribute("aria-expanded"))
      .toBe("true");
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(container.querySelector(".edited-files")).toBeNull();
  });

  it("does not revive historical active work from a different runtime turn", () => {
    const user: TimelineEntry = {
      id: "user-complete",
      kind: "user",
      title: "Completed task",
      turnId: "turn-old",
    };
    const response: TimelineEntry = {
      id: "response-complete",
      kind: "result",
      title: "Agent response",
      body: "Done.",
      turnId: "turn-old",
      status: "success",
    };
    const staleCommand: TimelineEntry = {
      id: "command-stale",
      kind: "command",
      title: "Old command",
      command: "npm test",
      turnId: "turn-old",
      status: "active",
    };
    const turn: ConversationTurn = {
      id: user.id,
      user,
      flow: [staleCommand],
      commentary: [],
      work: [staleCommand],
      response,
      responseFlowIndex: 0,
      files: [],
      startIndex: 0,
      endIndex: 2,
    };

    const { container } = renderTurn(turn, {
      ...idleRuntime,
      phase: "working",
      taskId: "task-1",
      turnId: "turn-new",
      turnStartedAt: Date.now() - 1_000,
    });

    expect(container.querySelector(".conversation-turn.is-live")).toBeNull();
    expect(screen.getByRole("button", { name: "Worked" }).getAttribute("aria-expanded"))
      .toBe("false");
  });

  it("keeps the timeline anchor on a live thought disclosure", () => {
    const user: TimelineEntry = {
      id: "user-thought-live",
      kind: "user",
      title: "Inspect the flow",
      turnId: "turn-thought-live",
    };
    const thought: TimelineEntry = {
      id: "thought-live",
      kind: "thought",
      title: "Reasoning",
      body: "Inspecting the active flow",
      turnId: "turn-thought-live",
      status: "active",
    };
    const turn: ConversationTurn = {
      id: user.id,
      user,
      flow: [thought],
      commentary: [],
      work: [thought],
      response: null,
      responseFlowIndex: null,
      files: [],
      startIndex: 0,
      endIndex: 1,
    };

    const { container } = renderTurn(turn, {
      ...idleRuntime,
      phase: "working",
      taskId: "task-1",
      turnId: "turn-thought-live",
    });

    expect(container.querySelector("#timeline-entry-thought-live")?.textContent).toContain(
      "Inspecting the active flow",
    );
  });

  it("preserves live behavior before entries acquire a runtime turn id", () => {
    const user: TimelineEntry = {
      id: "user-pending-id",
      kind: "user",
      title: "Start the task",
    };
    const command: TimelineEntry = {
      id: "command-pending-id",
      kind: "command",
      title: "Run checks",
      command: "npm test",
      status: "active",
    };
    const turn: ConversationTurn = {
      id: user.id,
      user,
      flow: [command],
      commentary: [],
      work: [command],
      response: null,
      responseFlowIndex: null,
      files: [],
      startIndex: 0,
      endIndex: 1,
    };

    const { container } = renderTurn(turn, {
      ...idleRuntime,
      phase: "working",
      taskId: "task-1",
      turnId: "runtime-turn-not-imported-yet",
    });

    expect(container.querySelector(".conversation-turn.is-live")).toBeTruthy();
    expect(screen.getByText("npm test")).toBeTruthy();
  });

  it("keeps a completed thought-only group available after expansion", () => {
    const user: TimelineEntry = {
      id: "user",
      kind: "user",
      title: "Inspect the flow",
      createdAt: 1_000,
    };
    const thought: TimelineEntry = {
      id: "thought",
      kind: "thought",
      title: "Reasoning",
      body: "Checking chronological projection",
      status: "success",
      createdAt: 2_000,
    };
    const turn: ConversationTurn = {
      id: user.id,
      user,
      flow: [thought],
      commentary: [],
      work: [thought],
      response: null,
      responseFlowIndex: null,
      files: [],
      startIndex: 0,
      endIndex: 1,
    };

    renderTurn(turn, idleRuntime, false);

    expect(screen.queryByText("Checking chronological projection")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Worked for 1s/ }));

    expect(screen.getAllByText("Checking chronological projection").length).toBeGreaterThan(0);
  });
});
