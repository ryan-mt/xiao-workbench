import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { completedTurnFiles, timelineRows } from "./TaskTimeline";

const entry = (id: string, kind: TimelineEntry["kind"]): TimelineEntry => ({
  id,
  kind,
  title: id,
});

describe("timelineRows", () => {
  it("groups adjacent commands without crossing conversation boundaries", () => {
    const rows = timelineRows([
      entry("user", "user"),
      entry("command-1", "command"),
      entry("command-2", "command"),
      entry("result", "result"),
      entry("command-3", "command"),
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "entry",
      "execution",
      "entry",
      "entry",
    ]);
    expect(rows[1]).toMatchObject({
      kind: "execution",
      index: 1,
      entries: [{ id: "command-1" }, { id: "command-2" }],
    });
  });

  it("keeps a single command as a normal timeline entry", () => {
    expect(timelineRows([entry("command", "command")])).toEqual([
      { kind: "entry", entry: entry("command", "command"), index: 0 },
    ]);
  });
});

describe("completedTurnFiles", () => {
  it("summarizes successful file changes for the matching completed turn", () => {
    const timeline: TimelineEntry[] = [
      entry("user-1", "user"),
      {
        ...entry("change-1", "change"),
        status: "success",
        files: [
          { path: "src/App.tsx", additions: 4, deletions: 1 },
          { path: "src/app.css", additions: 2, deletions: 0 },
        ],
      },
      {
        ...entry("change-2", "change"),
        status: "success",
        files: [{ path: "src/App.tsx", additions: 1, deletions: 2 }],
      },
      {
        ...entry("result-1", "result"),
        title: "Agent response",
        status: "success",
      },
      entry("user-2", "user"),
      {
        ...entry("change-failed", "change"),
        status: "error",
        files: [{ path: "src/ignored.ts", additions: 8, deletions: 0 }],
      },
      {
        ...entry("result-2", "result"),
        title: "Agent response",
        status: "success",
      },
    ];

    expect(completedTurnFiles(timeline, 3)).toEqual([
      { path: "src/App.tsx", additions: 5, deletions: 3 },
      { path: "src/app.css", additions: 2, deletions: 0 },
    ]);
    expect(completedTurnFiles(timeline, 6)).toEqual([]);
  });

  it("stays hidden until the final Markdown response succeeds", () => {
    const timeline: TimelineEntry[] = [
      entry("user", "user"),
      {
        ...entry("change", "change"),
        status: "success",
        files: [{ path: "src/App.tsx", additions: 1, deletions: 0 }],
      },
      {
        ...entry("result", "result"),
        title: "Agent response",
        status: "active",
      },
    ];

    expect(completedTurnFiles(timeline, 2)).toEqual([]);
  });
});
