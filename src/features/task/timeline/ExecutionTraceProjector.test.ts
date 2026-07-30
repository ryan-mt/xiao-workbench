import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { projectExecutionTraces } from "./ExecutionTraceProjector";

const entry = (
  id: string,
  kind: TimelineEntry["kind"],
  body?: string,
): TimelineEntry => ({ id, kind, title: id, body });

describe("execution trace projection", () => {
  it("groups tools under an action summary and ignores thought markers", () => {
    expect(projectExecutionTraces([
      entry("setup", "command"),
      entry("trace", "thought", "Planning staged commits with patch hunks\nprivate detail"),
      entry("edit", "change"),
      entry("test", "command"),
    ])).toEqual([
      {
        id: "execution-setup",
        title: "Edited a file, ran commands",
        thoughtTitled: false,
        entries: [entry("setup", "command"), entry("edit", "change"), entry("test", "command")],
      },
    ]);
  });

  it("never uses reasoning text as an execution title", () => {
    const traces = projectExecutionTraces([
      entry("trace", "thought", "Visible trace title\nHidden reasoning body"),
      entry("command", "command"),
    ]);
    expect(traces[0].title).toBe("Ran a command");
    expect(traces[0].thoughtTitled).toBe(false);
    expect(traces[0].entries.map((item) => item.id)).toEqual(["command"]);
  });

  it("returns no trace when the segment is thought-only", () => {
    expect(projectExecutionTraces([
      entry("trace", "thought", "**Investigating**\n\nPrivate detail"),
    ])).toEqual([]);
  });

  it("keeps the disclosure identity stable when a newer live thought arrives", () => {
    const before = projectExecutionTraces([
      entry("command", "command"),
      entry("thought-one", "thought", "Inspecting the renderer"),
    ], true);
    const after = projectExecutionTraces([
      entry("command", "command"),
      entry("thought-one", "thought", "Inspecting the renderer"),
      entry("thought-two", "thought", "Optimizing the canvas"),
    ], true);

    expect(before[0].id).toBe("execution-command");
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].title).toBe("Ran a command");
  });

  it("keeps duration-bearing dynamic tools and image views out of shell counts", () => {
    const dynamic = {
      ...entry("dynamic", "command"),
      meta: "Dynamic tool · 25 ms",
    };
    const image = {
      ...entry("image", "command"),
      meta: "Image tool",
    };
    const trace = projectExecutionTraces([dynamic, image])[0];
    expect(trace.title).not.toContain("command");
    expect(trace.entries).toEqual([dynamic, image]);
  });

  it("classifies both Browser tool and Web search events as tools", () => {
    const browser = {
      ...entry("browser", "result"),
      title: "Searched: browser event",
      meta: "Browser tool",
    };
    const search = {
      ...entry("search", "command"),
      title: "Searched: command event",
      meta: "Web search",
    };

    const trace = projectExecutionTraces([browser, search])[0];

    expect(trace.title).not.toContain("Ran a command");
    expect(trace.entries).toEqual([browser, search]);
  });
});
