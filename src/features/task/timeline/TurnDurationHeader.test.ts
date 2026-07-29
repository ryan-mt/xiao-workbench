import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { turnDuration } from "./TurnDurationHeader";

const user: TimelineEntry = {
  id: "user",
  kind: "user",
  title: "Run",
  createdAt: 1_000,
  turnDurationMs: 0,
};

describe("turnDuration", () => {
  it("preserves an explicit zero-duration completed turn", () => {
    expect(turnDuration(user, [], null, false, null, 5_000)).toBe(0);
  });
});
