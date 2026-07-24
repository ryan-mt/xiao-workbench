import { describe, expect, it } from "vitest";

import {
  addTerminalSession,
  advanceTerminalOutputSequence,
  cleanupLateTerminalStart,
  normalizeTerminalSessions,
  removeTerminalSession,
  restartTerminalSession,
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

  it("replaces a restarted native session ID without disturbing sibling tabs", () => {
    expect(restartTerminalSession(["one", "two"], "one", "one", "replacement")).toEqual({
      sessionIds: ["replacement", "two"],
      activeSessionId: "replacement",
    });
  });

  it("stops a PTY whose async start completes after its terminal was closed", async () => {
    const stopped: string[] = [];

    expect(await cleanupLateTerminalStart(
      true,
      "closed-session",
      async (sessionId) => {
        stopped.push(sessionId);
      },
    )).toBe(true);
    expect(stopped).toEqual(["closed-session"]);
  });
});
