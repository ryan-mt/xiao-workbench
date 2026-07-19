import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import {
  appendLiveTimelineDelta,
  applyLiveTimelineDeltas,
  reconcileCompletedStreamBody,
  type LiveTimelineDelta,
} from "./liveTimelineDeltas";

describe("live timeline deltas", () => {
  it("coalesces adjacent chunks and appends them exactly once", () => {
    const queue: LiveTimelineDelta[] = [];
    appendLiveTimelineDelta(queue, { kind: "assistant", entryId: "answer", delta: "Hel" });
    appendLiveTimelineDelta(queue, { kind: "assistant", entryId: "answer", delta: "lo" });

    expect(queue).toEqual([{ kind: "assistant", entryId: "answer", delta: "Hello" }]);
    expect(applyLiveTimelineDeltas([], queue, 10)).toMatchObject([{
      id: "answer",
      body: "Hello",
      status: "active",
    }]);
  });

  it("settles reasoning before the first assistant text without touching older rows", () => {
    const user: TimelineEntry = {
      id: "user",
      kind: "user",
      title: "Question",
      status: "success",
    };
    const reasoning: TimelineEntry = {
      id: "reasoning",
      kind: "thought",
      title: "Thinking",
      body: "Checked the code",
      status: "active",
    };

    const result = applyLiveTimelineDeltas([user, reasoning], [{
      kind: "assistant",
      entryId: "answer",
      delta: "Done",
      settleThinkingEntryId: "reasoning",
    }], 20);

    expect(result[0]).toBe(user);
    expect(result[1]).toMatchObject({ id: "reasoning", status: "success" });
    expect(result[2]).toMatchObject({ id: "answer", body: "Done" });
  });

  it("lets a reasoning summary replace content within the same batch", () => {
    const queue: LiveTimelineDelta[] = [];
    appendLiveTimelineDelta(queue, {
      kind: "reasoning",
      entryId: "reasoning",
      delta: "private detail",
      replace: false,
    });
    appendLiveTimelineDelta(queue, {
      kind: "reasoning",
      entryId: "reasoning",
      delta: "Public summary",
      replace: true,
    });

    expect(applyLiveTimelineDeltas([], queue)[0].body).toBe("Public summary");
  });

  it("uses the completed item as the authoritative repair for missing or duplicate chunks", () => {
    expect(reconcileCompletedStreamBody("Hel", "Hello")).toBe("Hello");
    expect(reconcileCompletedStreamBody("HelloHello", "Hello")).toBe("Hello");
    expect(reconcileCompletedStreamBody("Hello", undefined)).toBe("Hello");
  });
});
