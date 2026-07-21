import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { activeCollaboratorsFromTimeline } from "./TaskWorkspace";

const collaboratorEntry = (
  id: string,
  threadId: string,
  status: NonNullable<TimelineEntry["collaborators"]>[number]["status"],
): TimelineEntry => ({
  id,
  kind: "agent",
  title: "Collaboration update",
  collaborators: [{ threadId, status, message: threadId }],
});

describe("activeCollaboratorsFromTimeline", () => {
  it("keeps independently spawned agents until each receives a terminal status", () => {
    const timeline = [
      collaboratorEntry("spawn-a", "thread-a", "running"),
      collaboratorEntry("spawn-b", "thread-b", "running"),
      collaboratorEntry("wait-a", "thread-a", "completed"),
    ];

    expect(activeCollaboratorsFromTimeline(timeline)).toEqual([
      { threadId: "thread-b", status: "running", message: "thread-b" },
    ]);
  });

  it("includes every independently spawned agent that is still running", () => {
    const timeline = [
      collaboratorEntry("spawn-a", "thread-a", "running"),
      collaboratorEntry("spawn-b", "thread-b", "pendingInit"),
    ];

    expect(activeCollaboratorsFromTimeline(timeline)).toHaveLength(2);
  });
});
