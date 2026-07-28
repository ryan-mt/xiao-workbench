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
  it("projects exactly one stable turn and removes reasoning from the visible canvas", () => {
    const rows = projectConversation([
      entry("user", "user", 1_000),
      entry("thought", "thought", 2_000),
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
        work: [{ id: "command" }],
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
});
