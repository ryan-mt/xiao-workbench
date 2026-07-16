import { describe, expect, it } from "vitest";

import {
  approvalResponse,
  mcpElicitationDeclineResponse,
  needsAgentSession,
  permissionGrantFromRequest,
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
