import { useEffect, useMemo, useState, type ReactNode } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { TimelineEntry } from "../../../core/models/agent";

const formatElapsed = (milliseconds: number) => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

export const turnWorkLabel = (
  entries: TimelineEntry[],
  live: boolean,
  now = Date.now(),
) => {
  const timestamps = entries
    .map((entry) => entry.createdAt)
    .filter((value): value is number => typeof value === "number");
  const startedAt = timestamps.length ? Math.min(...timestamps) : null;
  const endedAt = timestamps.length > 1 ? Math.max(...timestamps) : null;
  const duration = startedAt == null
    ? null
    : live
      ? now - startedAt
      : endedAt != null && endedAt > startedAt
        ? endedAt - startedAt
        : null;
  return `${live ? "Working" : "Worked"}${duration == null ? "" : ` for ${formatElapsed(duration)}`}`;
};

const workSummary = (entries: TimelineEntry[]) => {
  const commands = entries.filter((entry) => entry.kind === "command").length;
  const files = new Set(
    entries
      .filter((entry) => entry.kind === "change")
      .flatMap((entry) => entry.files?.map((file) => file.path) ?? []),
  ).size;
  const parts = [
    commands ? `${commands} ${commands === 1 ? "tool" : "tools"}` : null,
    files ? `${files} ${files === 1 ? "file" : "files"} changed` : null,
  ].filter(Boolean);
  return parts.join(" · ");
};

export function TurnWorkGroup({
  entries,
  live,
  children,
}: {
  entries: TimelineEntry[];
  live: boolean;
  children: ReactNode;
}) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(live);
  const summary = useMemo(() => workSummary(entries), [entries]);

  useEffect(() => {
    if (!live) return;
    setExpanded(true);
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);

  return (
    <article className={`turn-work-group${live ? " is-live" : ""}`} aria-busy={live}>
      <details
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          <span className={`turn-work-group__label${live ? " is-active" : ""}`}>
            {turnWorkLabel(entries, live, now)}
          </span>
          {summary ? <span className="turn-work-group__summary">{summary}</span> : null}
          <span className="turn-work-group__line" aria-hidden="true" />
          <XiaoIcon className="turn-work-group__caret" name="caret" size={12} />
        </summary>
        <div className="turn-work-group__content">{children}</div>
      </details>
    </article>
  );
}
