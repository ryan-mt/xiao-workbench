import { describe, expect, it } from "vitest";

import {
  addTerminalSession,
  advanceTerminalOutputSequence,
  cancelTerminalStart,
  normalizeTerminalSessions,
  registerTerminalStartCancellation,
  removeTerminalSession,
  restartTerminalSession,
  terminalStartCleanupSessionId,
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

  it("does not recreate a terminal closed while restart is stopping its old PTY", () => {
    expect(restartTerminalSession(
      ["sibling"],
      "sibling",
      "closed-session",
      "replacement",
    )).toBeNull();
  });

  it("identifies a PTY whose start completed after synchronous disposal", () => {
    expect(terminalStartCleanupSessionId(true, "closed-session")).toBe("closed-session");
    expect(terminalStartCleanupSessionId(false, "live-session")).toBeNull();
  });

  it("cancels an in-flight PTY start before React unmount cleanup runs", () => {
    const registry = new Map<string, () => void>();
    let cancelled = false;
    const unregister = registerTerminalStartCancellation(
      registry,
      "starting-session",
      () => {
        cancelled = true;
      },
    );

    cancelTerminalStart(registry, "starting-session");
    expect(cancelled).toBe(true);

    unregister();
    expect(registry.has("starting-session")).toBe(false);
  });
});
