import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  AgentAccountUsage,
  AgentRuntimeState,
  CodexUsageSnapshot,
} from "../../../core/models/agent";
import { ProfilePage } from "./ProfilePage";

const runtime: AgentRuntimeState = {
  phase: "ready",
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
  it("uses a compact desktop profile hierarchy instead of the previous dashboard hero", () => {
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
    expect(markup).toContain('aria-label="Local profile"');
    expect(markup).toContain("Profile &amp; usage");
    expect(markup).toContain("Edit local profile");
    expect(markup).toContain("Activity");
    expect(markup).toContain("Token breakdown");
    expect(markup).toContain("11.41B");
    expect(markup).not.toContain("profile-hero");
    expect(markup).not.toContain("profile-dashboard");
    expect(markup).not.toContain("Codex lifetime");
    expect(markup).not.toContain("Token flow through Xiao");
  });
});
