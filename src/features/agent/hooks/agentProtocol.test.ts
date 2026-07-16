import { describe, expect, it } from "vitest";

import {
  approvalResponse,
  contextCompactionTimelineEntry,
  invalidateUndoHistory,
  latestUndoableTurn,
  mcpElicitationDeclineResponse,
  needsAgentSession,
  permissionGrantFromRequest,
  threadCompactRequest,
} from "./agentProtocol";

describe("approvalResponse", () => {
  it("declines command and file approvals under Never ask", () => {
    expect(approvalResponse("action", undefined, "decline")).toEqual({
      decision: "decline",
    });
  });

  it("grants only the permissions requested for the current turn", () => {
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: ["C:/workspace"], write: null },
    };

    expect(approvalResponse("permissions", permissions, "accept")).toEqual({
      permissions,
      scope: "turn",
    });
    expect(approvalResponse("permissions", permissions, "decline")).toEqual({
      permissions: {},
      scope: "turn",
    });
  });
});

describe("permissionGrantFromRequest", () => {
  it("drops null and unknown permission fields", () => {
    expect(permissionGrantFromRequest({
      network: { enabled: true },
      fileSystem: null,
      unexpected: { enabled: true },
    })).toEqual({ network: { enabled: true } });
  });
});

describe("mcpElicitationDeclineResponse", () => {
  it("returns a terminal protocol response instead of leaving the turn waiting", () => {
    expect(mcpElicitationDeclineResponse()).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
  });
});

describe("needsAgentSession", () => {
  it("does not resume a default-model thread after its null selection is cached", () => {
    expect(needsAgentSession("thread-1", true, null, null)).toBe(false);
  });

  it("resumes when the thread is new or the requested model changes", () => {
    expect(needsAgentSession(undefined, true, null, null)).toBe(true);
    expect(needsAgentSession("thread-1", false, undefined, null)).toBe(true);
    expect(needsAgentSession("thread-1", true, "gpt-old", "gpt-new")).toBe(true);
  });
});

describe("undo history", () => {
  const changedTurn = {
    id: "user-1",
    kind: "user" as const,
    title: "Change a file",
    turnId: "turn-1",
    turnDiff: "diff --git a/file b/file",
  };

  it("treats an empty captured patch as an undoable latest turn", () => {
    const noFileTurn = {
      id: "user-2",
      kind: "user" as const,
      title: "Explain the code",
      turnId: "turn-2",
      turnDiff: "",
    };

    expect(latestUndoableTurn([changedTurn, noFileTurn])).toBe(noFileTurn);
  });

  it("does not skip an untracked latest turn to roll back an older turn", () => {
    const injectedTurn = {
      id: "user-2",
      kind: "user" as const,
      title: "History from an isolated session",
      turnId: "old-turn",
    };

    expect(latestUndoableTurn([changedTurn, injectedTurn])).toBeNull();
  });

  it("invalidates patches that belong to a previous or compacted session", () => {
    const timeline = invalidateUndoHistory([changedTurn]);

    expect(timeline[0]).not.toHaveProperty("turnDiff");
    expect(latestUndoableTurn(timeline)).toBeNull();
  });
});

describe("threadCompactRequest", () => {
  it("uses the native app-server compaction method and thread payload", () => {
    expect(threadCompactRequest("thread-1")).toEqual({
      method: "thread/compact/start",
      params: { threadId: "thread-1" },
    });
  });
});

describe("contextCompactionTimelineEntry", () => {
  it("projects the official item lifecycle without inventing a summary prompt", () => {
    const item = { type: "contextCompaction", id: "compact-1" };

    expect(contextCompactionTimelineEntry(item, "started")).toMatchObject({
      id: "compact-1",
      kind: "result",
      title: "Compacting context",
      meta: "Context",
      status: "active",
    });
    expect(contextCompactionTimelineEntry(item, "completed")).toMatchObject({
      id: "compact-1",
      kind: "result",
      title: "Context compacted",
      meta: "Context",
      status: "success",
    });
  });

  it("ignores unrelated or malformed items", () => {
    expect(contextCompactionTimelineEntry({ type: "agentMessage", id: "message-1" }, "completed"))
      .toBeNull();
    expect(contextCompactionTimelineEntry({ type: "contextCompaction" }, "completed"))
      .toBeNull();
  });
});
