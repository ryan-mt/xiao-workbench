import { describe, expect, it, vi } from "vitest";

import type { RunEventRecord } from "../../core/models/run";
import { loadRunEvents } from "./ObservatoryPanel";

describe("loadRunEvents", () => {
  it("keeps the newest 10,000 events when a run exceeds the display cap", async () => {
    const availableEvents: RunEventRecord[] = Array.from({ length: 10_050 }, (_, sequence) => ({
      runId: "run-1",
      sequence,
      timestamp: sequence,
      eventType: "test",
      eventKey: null,
      safePayload: null,
    }));
    const loadPage = vi.fn(async (
      _runId: string,
      afterSequence: number | null = null,
      limit = 200,
    ) => {
      const start = (afterSequence ?? -1) + 1;
      const events = availableEvents.slice(start, start + limit);
      return {
        events,
        nextSequence: events.at(-1)?.sequence ?? null,
      };
    });

    const events = await loadRunEvents("run-1", -1, loadPage);

    expect(events).toHaveLength(10_000);
    expect(events[0]?.sequence).toBe(50);
    expect(events.at(-1)?.sequence).toBe(10_049);
    expect(loadPage).toHaveBeenCalledTimes(51);
  });
});
