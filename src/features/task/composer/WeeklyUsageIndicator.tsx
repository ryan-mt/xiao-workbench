import type {
  AgentRateLimitSnapshot,
  AgentRateLimitWindow,
} from "../../../core/models/agent";

const weeklyWindowMinutes = 7 * 24 * 60;

export const weeklyRateLimitWindow = (
  rateLimits: AgentRateLimitSnapshot | null,
): AgentRateLimitWindow | null => {
  if (!rateLimits) return null;
  const windows = [rateLimits.primary, rateLimits.secondary].filter(
    (window): window is AgentRateLimitWindow => Boolean(window),
  );
  return windows.find((window) => window.windowDurationMins === weeklyWindowMinutes)
    ?? (windows.length === 1 ? windows[0] : null);
};

const remainingPercent = (usedPercent: number) =>
  Math.min(100, Math.max(0, Math.round(100 - usedPercent)));

const resetText = (resetsAt: number | null) => {
  if (!resetsAt) return "Reset time unavailable";
  return `Resets ${new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetsAt * 1_000))}`;
};

type WeeklyUsageIndicatorProps = {
  rateLimits: AgentRateLimitSnapshot | null;
};

export function WeeklyUsageIndicator({ rateLimits }: WeeklyUsageIndicatorProps) {
  const weekly = weeklyRateLimitWindow(rateLimits);
  if (!weekly) return null;
  const remaining = remainingPercent(weekly.usedPercent);
  const description = `Codex weekly usage, ${remaining}% remaining. ${resetText(weekly.resetsAt)}`;

  return (
    <span
      className="weekly-usage-chip"
      aria-label={description}
      aria-live="polite"
      title={description}
    >
      <span>Week</span>
      <strong>{remaining}%</strong>
    </span>
  );
}
