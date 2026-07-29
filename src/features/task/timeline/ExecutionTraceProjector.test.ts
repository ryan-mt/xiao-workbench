import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { projectExecutionTraces } from "./ExecutionTraceProjector";

const entry = (
  id: string,
  kind: TimelineEntry["kind"],
  body?: string,
): TimelineEntry => ({ id, kind, title: id, body });

describe("execution trace projection", () => {
  it("groups the full execution stream beneath one latest trace heading", () => {
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

  it("never exposes the full reasoning body as an execution row", () => {
    const traces = projectExecutionTraces([
      entry("trace", "thought", "Visible trace title\nHidden reasoning body"),
      entry("command", "command"),
    ]);
    expect(traces[0].title).toBe("Ran a command");
    expect(traces[0].entries.map((item) => item.id)).toEqual(["command"]);
  });

  it("uses the latest trace title only while the turn is live", () => {
    const traces = projectExecutionTraces([
      entry("trace", "thought", "Investigating missing command entries"),
      entry("command", "command"),
    ], true);
    expect(traces[0].title).toBe("Investigating missing command entries");
    expect(traces[0].thoughtTitled).toBe(true);
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
    expect(after[0].title).toBe("Optimizing the canvas");
  });
});
