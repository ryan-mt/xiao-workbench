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
        id: "trace",
        title: "Edited files, ran commands",
        entries: [entry("setup", "command"), entry("edit", "change"), entry("test", "command")],
      },
    ]);
  });

  it("never exposes the full reasoning body as an execution row", () => {
    const traces = projectExecutionTraces([
      entry("trace", "thought", "Visible trace title\nHidden reasoning body"),
      entry("command", "command"),
    ]);
    expect(traces[0].title).toBe("Ran commands");
    expect(traces[0].entries.map((item) => item.id)).toEqual(["command"]);
  });

  it("uses the latest trace title only while the turn is live", () => {
    const traces = projectExecutionTraces([
      entry("trace", "thought", "Investigating missing command entries"),
      entry("command", "command"),
    ], true);
    expect(traces[0].title).toBe("Investigating missing command entries");
  });
});
