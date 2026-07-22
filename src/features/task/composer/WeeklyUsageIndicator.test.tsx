import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WeeklyUsageIndicator, weeklyRateLimitWindow } from "./WeeklyUsageIndicator";

describe("WeeklyUsageIndicator", () => {
  it("uses the seven-day window even when it is the primary limit", () => {
    const rateLimits = {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: null },
      secondary: null,
    };

    expect(weeklyRateLimitWindow(rateLimits)).toBe(rateLimits.primary);
    const markup = renderToStaticMarkup(<WeeklyUsageIndicator rateLimits={rateLimits} />);
    expect(markup).toContain("83%");
    expect(markup).toContain("left</span>");
    expect(markup).not.toContain("5h");
    expect(markup).toContain("class=\"weekly-usage-chip is-normal\"");
  });

  it("finds the weekly window without assuming primary or secondary ordering", () => {
    const weekly = { usedPercent: 40, windowDurationMins: 10_080, resetsAt: null };
    expect(weeklyRateLimitWindow({
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null },
      secondary: weekly,
    })).toBe(weekly);
  });

  it("does not label a known five-hour limit as weekly", () => {
    const rateLimits = {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
      secondary: null,
    };

    expect(weeklyRateLimitWindow(rateLimits)).toBeNull();
    expect(renderToStaticMarkup(<WeeklyUsageIndicator rateLimits={rateLimits} />)).toBe("");
  });

  it("uses warning and critical tones only when remaining quota is low", () => {
    const renderRemaining = (usedPercent: number) => renderToStaticMarkup(
      <WeeklyUsageIndicator rateLimits={{
        limitId: "codex",
        limitName: null,
        primary: { usedPercent, windowDurationMins: 10_080, resetsAt: null },
        secondary: null,
      }} />,
    );

    expect(renderRemaining(80)).toContain("is-low");
    expect(renderRemaining(92)).toContain("is-critical");
  });
});
