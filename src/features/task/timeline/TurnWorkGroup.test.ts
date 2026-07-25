import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { turnWorkLabel } from "./TurnWorkGroup";

const entry = (id: string, createdAt: number): TimelineEntry => ({
  id,
  kind: "command",
  title: id,
  createdAt,
});

describe("turnWorkLabel", () => {
  it("ticks a live turn from its real start time", () => {
    expect(turnWorkLabel(
      [entry("command", 1_000)],
      true,
      66_000,
    )).toBe("Working for 1m 5s");
  });

  it("uses recorded entry bounds for completed work", () => {
    expect(turnWorkLabel(
      [entry("start", 1_000), entry("finish", 92_000)],
      false,
    )).toBe("Worked for 1m 31s");
  });
});
