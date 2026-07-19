import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { timelineRows } from "./TaskTimeline";

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
