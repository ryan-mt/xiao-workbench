import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentAccountUsage,
  AgentRuntimeState,
  CodexUsageSnapshot,
} from "../../../core/models/agent";
import { ProfilePage } from "./ProfilePage";

const runtime: AgentRuntimeState = {
  phase: "ready",
  profileId: null,
  taskId: null,
  threadId: null,
  turnId: null,
  turnStartedAt: null,
  error: null,
  eventsSeen: 1,
};

const usage: CodexUsageSnapshot = {
  days: [],
  totals: {
    totalTokens: 21_574,
    inputTokens: 21_560,
    cachedInputTokens: 0,
    outputTokens: 14,
    reasoningOutputTokens: 0,
  },
  activeDays: 79,
  currentStreak: 13,
  longestStreak: 54,
};

const accountUsage: AgentAccountUsage = {
  lifetimeTokens: 11_413_655_391,
  peakDailyTokens: 722_860_000,
  longestRunningTurnSec: 6_300,
  currentStreakDays: 13,
  longestStreakDays: 54,
  dailyUsageBuckets: [],
};

describe("ProfilePage", () => {
  afterEach(() => vi.useRealTimers());

  it("separates account-wide and on-device usage into independent sources", () => {
    const markup = renderToStaticMarkup(
      <ProfilePage
        accountUsage={accountUsage}
        profile={{ name: "Xiao", avatarDataUrl: null }}
        runtime={runtime}
        usage={usage}
        onClose={() => undefined}
        onSaveProfile={() => undefined}
      />,
    );

    expect(markup).toContain('class="profile-shell"');
    expect(markup).toContain('class="profile-source profile-account"');
    expect(markup).toContain('class="profile-source profile-device"');
    expect(markup).toContain("Codex account");
    expect(markup).toContain("This device");
    expect(markup).toContain("Edit profile");
    expect(markup).toContain("Activity");
    expect(markup).toContain("Recorded locally");
    expect(markup).toContain("Sources are independent");
    expect(markup).toContain("11.41B");
    expect(markup).toContain('role="grid"');
    expect(markup).not.toContain("profile-sidebar");
    expect(markup).not.toContain("Runtime</dt>");
  });

  it("renders 365 real local dates aligned to the Sunday-first grid", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 20, 12));
    const calendarUsage: CodexUsageSnapshot = {
      ...usage,
      days: [
        {
          date: "2025-07-21",
          totalTokens: 10,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        {
          date: "2026-07-20",
          totalTokens: 5,
          inputTokens: 5,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <ProfilePage
        accountUsage={null}
        profile={{ name: "Xiao", avatarDataUrl: null }}
        runtime={runtime}
        usage={calendarUsage}
        onClose={() => undefined}
        onSaveProfile={() => undefined}
      />,
    );

    expect(markup.match(/data-date="/g)).toHaveLength(365);
    expect(markup.match(/contribution-day--placeholder/g)).toHaveLength(1);
    expect(markup).toMatch(/class="contribution-day level-4"[^>]*data-date="2025-07-21"/);
    expect(markup).toMatch(/class="contribution-day level-2"[^>]*data-date="2026-07-20"/);
  });
});
