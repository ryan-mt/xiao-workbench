import { describe, expect, it } from "vitest";

import {
  addTerminalSession,
  advanceTerminalOutputSequence,
  normalizeTerminalSessions,
  removeTerminalSession,
} from "./terminalSessions";

describe("Task terminal sessions", () => {
  it("keeps a durable active session inside the Task-owned session list", () => {
    expect(normalizeTerminalSessions(["one", "two"], "missing")).toEqual({
      sessionIds: ["one", "two"],
      activeSessionId: "one",
    });
  });

  it("adds and removes sessions without closing the remaining Task sessions", () => {
    const added = addTerminalSession(["one"], "two");
    expect(added).toEqual({ sessionIds: ["one", "two"], activeSessionId: "two" });
    expect(removeTerminalSession(added.sessionIds, "two", "two")).toEqual({
      sessionIds: ["one"],
      activeSessionId: "one",
    });
  });

  it("drops replayed or delayed terminal output that was already rendered", () => {
    expect(advanceTerminalOutputSequence(8, 8)).toBeNull();
    expect(advanceTerminalOutputSequence(8, 7)).toBeNull();
    expect(advanceTerminalOutputSequence(8, 9)).toBe(9);
  });
});
