import { describe, expect, it } from "vitest";

import { collaborationTimelineEntry } from "./collaborationTimeline";

describe("collaboration timeline", () => {
  it("keeps a completed spawn call active while its child agent is running", () => {
    expect(collaborationTimelineEntry({
      type: "collabAgentToolCall",
      id: "collab-1",
      tool: "spawnAgent",
      status: "completed",
      receiverThreadIds: ["thread-child"],
      agentsStates: {
        "thread-child": { status: "running", message: "Inspecting the runtime" },
      },
      prompt: "Inspect streaming",
      model: "gpt-test",
    }, 10)).toMatchObject({
      id: "collab-1",
      kind: "agent",
      title: "Delegated a subagent task",
      status: "active",
      meta: "1 subagent - gpt-test",
      collaborators: [{
        threadId: "thread-child",
        status: "running",
        message: "Inspecting the runtime",
      }],
    });
  });

  it("surfaces child failures even when the collaboration call completed", () => {
    expect(collaborationTimelineEntry({
      type: "collabAgentToolCall",
      id: "collab-2",
      tool: "wait",
      status: "completed",
      receiverThreadIds: ["thread-child"],
      agentsStates: {
        "thread-child": { status: "errored", message: "Test failed" },
      },
    })).toMatchObject({
      status: "error",
      collaborators: [{ status: "errored", message: "Test failed" }],
    });
  });
});
