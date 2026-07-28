import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { projectLiveFileChanges } from "./liveFileChanges";

describe("live file change projection", () => {
  it("aggregates only the latest turn and counts unique files", () => {
    const timeline: TimelineEntry[] = [{
      id: "old-user",
      kind: "user",
      title: "Old turn",
    }, {
      id: "old-change",
      kind: "change",
      title: "Old edits",
      files: [{ path: "old.ts", additions: 100, deletions: 50 }],
    }, {
      id: "current-user",
      kind: "user",
      title: "Current turn",
    }, {
      id: "current-change-1",
      kind: "change",
      title: "Current edits",
      files: [
        { path: "src/App.tsx", additions: 12, deletions: 2 },
        { path: "src/app.css", additions: 5, deletions: 1 },
      ],
    }, {
      id: "current-change-2",
      kind: "change",
      title: "More edits",
      files: [{ path: "src/App.tsx", additions: 3, deletions: 0 }],
    }];

    expect(projectLiveFileChanges(timeline)).toEqual({
      fileCount: 2,
      additions: 20,
      deletions: 3,
    });
  });

  it("ignores failed file changes", () => {
    expect(projectLiveFileChanges([{
      id: "user",
      kind: "user",
      title: "Current turn",
    }, {
      id: "failed-change",
      kind: "change",
      title: "Failed edits",
      status: "error",
      files: [{ path: "src/App.tsx", additions: 3, deletions: 2 }],
    }])).toBeNull();
  });
});
