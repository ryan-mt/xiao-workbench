import { useEffect, useRef } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { TimelineEntry } from "../../../core/models/agent";

const formatElapsed = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
};

export const turnDuration = (
  user: TimelineEntry,
  entries: TimelineEntry[],
  response: TimelineEntry | null,
  live: boolean,
  runtimeStartedAt: number | null,
  now = Date.now(),
) => {
  const protocolDuration = user.turnDurationMs ?? response?.turnDurationMs;
  if (!live && typeof protocolDuration === "number" && protocolDuration >= 0) {
    return protocolDuration;
  }
  const timestamps = [user, ...entries, ...(response ? [response] : [])]
    .map((entry) => entry.createdAt)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const startedAt = runtimeStartedAt ?? user.createdAt ?? (timestamps.length ? Math.min(...timestamps) : now);
  const endedAt = live ? now : response?.createdAt ?? (timestamps.length ? Math.max(...timestamps) : startedAt);
  const duration = Math.max(0, endedAt - startedAt);
  return live || duration > 0 ? duration : null;
};

export function TurnDurationHeader({
  user,
  entries,
  response,
  live,
  runtimeStartedAt,
  expanded,
  onToggle,
}: {
  user: TimelineEntry;
  entries: TimelineEntry[];
  response: TimelineEntry | null;
  live: boolean;
  runtimeStartedAt: number | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const fallbackStartedAt = useRef(Date.now());
  const liveStartedAt = runtimeStartedAt ?? user.createdAt ?? entries
    .map((entry) => entry.createdAt)
    .find((value): value is number => typeof value === "number" && Number.isFinite(value)) ??
    fallbackStartedAt.current;
  const label = () => {
    const duration = turnDuration(user, entries, response, live, runtimeStartedAt);
    return duration === null
      ? "Worked"
      : `${live ? "Working" : "Worked"} for ${formatElapsed(duration)}`;
  };

  useEffect(() => {
    if (!live) return;
    const update = () => {
      if (labelRef.current) {
        labelRef.current.textContent = `Working for ${formatElapsed(Date.now() - liveStartedAt)}`;
      }
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [live, liveStartedAt]);

  return (
    <button
      className={`turn-duration${live ? " is-live" : ""}`}
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {live ? (
        <span className="turn-duration__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : null}
      <span ref={labelRef}>{label()}</span>
      <XiaoIcon className="turn-duration__caret" name="caret" size={12} />
      <i aria-hidden="true" />
    </button>
  );
}
