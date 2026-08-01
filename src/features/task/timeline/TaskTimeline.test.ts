import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { projectConversation } from "./ConversationTurnProjector";
import { turnDuration } from "./TurnDurationHeader";

const entry = (
  id: string,
  kind: TimelineEntry["kind"],
  createdAt?: number,
): TimelineEntry => ({ id, kind, title: id, createdAt });

describe("conversation projection", () => {
  it("projects exactly one stable turn and keeps commentary flat outside execution", () => {
    const rows = projectConversation([
      entry("user", "user", 1_000),
      entry("thought", "thought", 2_000),
      {
        ...entry("commentary", "result", 2_500),
        title: "Agent response",
        meta: "Commentary",
      },
      entry("command", "command", 3_000),
      {
        ...entry("response", "result", 6_000),
        title: "Agent response",
        status: "success",
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "turn",
      turn: {
        user: { id: "user" },
        commentary: [{ id: "commentary" }],
        work: [{ id: "thought" }, { id: "command" }],
        response: { id: "response" },
      },
    });
  });

  it("aggregates edited files inside their owning turn", () => {
    const rows = projectConversation([
      entry("user", "user"),
      {
        ...entry("change-1", "change"),
        status: "success",
        files: [{ path: "src/App.tsx", additions: 4, deletions: 1 }],
      },
      {
        ...entry("change-2", "change"),
        status: "success",
        files: [{ path: "src/App.tsx", additions: 2, deletions: 3 }],
      },
    ]);

    expect(rows[0]).toMatchObject({
      kind: "turn",
      turn: {
        files: [{ path: "src/App.tsx", additions: 6, deletions: 4 }],
      },
    });
  });

  it("keeps steered user messages inside the same backend turn", () => {
    const rows = projectConversation([{
      ...entry("user", "user"),
      turnId: "turn-1",
    }, {
      ...entry("commentary", "result"),
      title: "Agent response",
      meta: "Commentary",
      turnId: "turn-1",
    }, {
      ...entry("steer", "user"),
      turnId: "turn-1",
    }, {
      ...entry("change", "change"),
      turnId: "turn-1",
      files: [{ path: "src/App.tsx", additions: 1, deletions: 0 }],
    }]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "turn",
      turn: {
        user: { id: "user" },
        flow: [{ id: "commentary" }, { id: "steer" }, { id: "change" }],
        work: [{ id: "change" }],
      },
    });
  });

  it("preserves every assistant response in a steered backend turn", () => {
    const rows = projectConversation([{
      ...entry("user", "user"),
      turnId: "turn-1",
    }, {
      ...entry("response-1", "result"),
      title: "Agent response",
      turnId: "turn-1",
    }, {
      ...entry("command", "command"),
      turnId: "turn-1",
    }, {
      ...entry("steer", "user"),
      turnId: "turn-1",
    }, {
      ...entry("response-2", "result"),
      title: "Agent response",
      turnId: "turn-1",
    }]);

    expect(rows).toMatchObject([{
      kind: "turn",
      turn: {
        flow: [
          { id: "response-1" },
          { id: "command" },
          { id: "steer" },
        ],
        response: { id: "response-2" },
        responseFlowIndex: 3,
      },
    }]);
  });

  it("records the final response source position when later entries share its timestamp", () => {
    const rows = projectConversation([{
      ...entry("user", "user", 1_000),
      turnId: "turn-1",
    }, {
      ...entry("response", "result", 2_000),
      title: "Agent response",
      turnId: "turn-1",
    }, {
      ...entry("command", "command", 2_000),
      turnId: "turn-1",
    }, {
      ...entry("steer", "user", 2_000),
      turnId: "turn-1",
    }]);

    expect(rows[0]).toMatchObject({
      kind: "turn",
      turn: {
        response: { id: "response" },
        responseFlowIndex: 0,
        flow: [{ id: "command" }, { id: "steer" }],
      },
    });
  });

  it("derives completed duration from user and response timestamps", () => {
    expect(turnDuration(
      entry("user", "user", 10_000),
      [entry("command", "command", 20_000)],
      { ...entry("response", "result", 75_000), title: "Agent response" },
      false,
      null,
      99_000,
    )).toBe(65_000);
  });

  it("prefers the app-server turn duration over projected item timestamps", () => {
    expect(turnDuration(
      { ...entry("user", "user", 10_000), turnDurationMs: 42_350 },
      [entry("command", "command", 10_000)],
      { ...entry("response", "result", 10_000), title: "Agent response" },
      false,
      null,
      99_000,
    )).toBe(42_350);
  });
});
