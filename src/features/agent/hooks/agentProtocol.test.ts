import { describe, expect, it } from "vitest";

import {
  approvalResponse,
  contextCompactionTimelineEntry,
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
