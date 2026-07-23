import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { completedTurnFiles, timelineRows } from "./TaskTimeline";

const entry = (id: string, kind: TimelineEntry["kind"]): TimelineEntry => ({
  id,
  kind,
  title: id,
});

describe("timelineRows", () => {
  it("groups every adjacent command tool, including failures", () => {
    const rows = timelineRows([
      entry("user", "user"),
      { ...entry("command-1", "command"), meta: "Dynamic tool" },
      { ...entry("command-2", "command"), command: "npm test", status: "error" },
      { ...entry("command-3", "command"), meta: "Plugin tool" },
      entry("result", "result"),
      entry("command-4", "command"),
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "entry",
      "toolGroup",
      "entry",
      "entry",
    ]);
    expect(rows[1]).toMatchObject({
      kind: "toolGroup",
      index: 1,
      entries: [
        { id: "command-1" },
        { id: "command-2", status: "error" },
        { id: "command-3" },
      ],
    });
    expect(rows[3]).toMatchObject({ kind: "entry", index: 5, entry: { id: "command-4" } });
  });

  it("groups adjacent browser searches with other context tools", () => {
    const browserTool = (id: string): TimelineEntry => ({
      ...entry(id, "result"),
      meta: "Browser tool",
    });
    const rows = timelineRows([
      entry("read-1", "explore"),
      browserTool("search-1"),
      browserTool("search-2"),
      entry("command", "command"),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["exploration", "entry"]);
    expect(rows[0]).toMatchObject({
      kind: "exploration",
      index: 0,
      entries: [
        { id: "read-1" },
        { id: "search-1" },
        { id: "search-2" },
      ],
    });
  });

  it("groups only adjacent context-gathering parts", () => {
    const rows = timelineRows([
      entry("read-1", "explore"),
      entry("read-2", "explore"),
      entry("reasoning", "thought"),
      entry("read-3", "explore"),
    ]);

    expect(rows).toEqual([
      {
        kind: "exploration",
        entries: [entry("read-1", "explore"), entry("read-2", "explore")],
        index: 0,
      },
      { kind: "entry", entry: entry("reasoning", "thought"), index: 2 },
      { kind: "exploration", entries: [entry("read-3", "explore")], index: 3 },
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

  it("reuses completed file summaries when unrelated live entries append", () => {
    const result: TimelineEntry = {
      ...entry("result", "result"),
      title: "Agent response",
      status: "success",
    };
    const timeline: TimelineEntry[] = [
      entry("user", "user"),
      {
        ...entry("change", "change"),
        status: "success",
        files: [{ path: "src/App.tsx", additions: 1, deletions: 0 }],
      },
      result,
    ];

    const before = completedTurnFiles(timeline, 2);
    const after = completedTurnFiles(
      [...timeline, { ...entry("thinking", "thought"), status: "active" }],
      2,
    );

    expect(after).toBe(before);
  });
});
