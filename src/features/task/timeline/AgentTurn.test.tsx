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
      files: [],
      startIndex: 0,
      endIndex: 1,
    };

    render(
      <AgentTurn
        turn={turn}
        index={0}
        runtime={idleRuntime}
        liveEligible={false}
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

    expect(screen.queryByText("Checking chronological projection")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Worked for 1s/ }));

    expect(screen.getAllByText("Checking chronological projection").length).toBeGreaterThan(0);
  });
});
