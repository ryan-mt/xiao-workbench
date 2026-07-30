import { describe, expect, it } from "vitest";

import {
  formatThoughtDuration,
  reasoningSummary,
  thoughtTraceTitle,
} from "./reasoningSummary";

describe("reasoningSummary", () => {
  it("extracts an OpenAI-style bold title block", () => {
    expect(reasoningSummary("**Inspecting PR workflow**\n\nLooking at CI.")).toEqual({
      title: "Inspecting PR workflow",
      body: "Looking at CI.",
    });
  });

  it("keeps freeform prose entirely in the body", () => {
    expect(reasoningSummary("The user wants a mobile rewrite.")).toEqual({
      title: null,
      body: "The user wants a mobile rewrite.",
    });
  });
});

describe("thoughtTraceTitle", () => {
  it("never surfaces freeform reasoning as the disclosure label", () => {
    expect(thoughtTraceTitle("The user wants a mobile rewrite.")).toBe("Thought");
  });

  it("includes a structured bold title when present", () => {
    expect(thoughtTraceTitle("**Mobile shell**\n\nDetails")).toBe("Thought: Mobile shell");
  });
});

describe("formatThoughtDuration", () => {
  it("formats whole seconds and larger units", () => {
    expect(formatThoughtDuration(0)).toBe("0s");
    expect(formatThoughtDuration(43_000)).toBe("43s");
    expect(formatThoughtDuration(65_000)).toBe("1m 5s");
  });
});
