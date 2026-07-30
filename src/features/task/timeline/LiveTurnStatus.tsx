import { useEffect, useRef } from "react";

import type { AgentRuntimeState, TimelineEntry } from "../../../core/models/agent";
import { formatThoughtDuration } from "./reasoningSummary";

const entryHasVisibleContent = (entry: TimelineEntry) => {
  if (entry.kind === "user" || entry.kind === "brief") return false;
  if (entry.kind === "thought") return Boolean(entry.body?.trim());
  if (entry.kind === "explore") return Boolean(entry.exploration?.length);
  if (entry.kind === "change") return Boolean(entry.files?.length || entry.body?.trim());
  if (entry.kind === "result" && entry.title === "Agent response") return Boolean(entry.body?.trim());
  return true;
};

export const currentTurnHasVisibleContent = (timeline: TimelineEntry[]) => {
  let start = timeline.length - 1;
  while (start >= 0 && timeline[start].kind !== "user" && timeline[start].kind !== "brief") start -= 1;
  return timeline.slice(start + 1).some(entryHasVisibleContent);
};

export function LiveTurnStatus({
  taskId,
  runtime,
  timeline,
}: {
  taskId: string;
  runtime: AgentRuntimeState;
  timeline: TimelineEntry[];
}) {
  const taskWorking = runtime.phase === "working" && runtime.taskId === taskId;
  const labelRef = useRef<HTMLSpanElement>(null);
  const fallbackStartedAt = useRef(Date.now());
  const startedAt = runtime.turnStartedAt ?? fallbackStartedAt.current;
  const waitingForFirstContent = taskWorking && !currentTurnHasVisibleContent(timeline);

  useEffect(() => {
    if (!taskWorking) return;
    const update = () => {
      if (labelRef.current) {
        labelRef.current.textContent = formatThoughtDuration(Date.now() - startedAt);
      }
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [taskWorking, startedAt]);

  if (!taskWorking) return null;

  return (
    <div className="live-turn-status" role="status" aria-live="polite">
      <span className="live-turn-status__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="live-turn-status__label is-active">
        {waitingForFirstContent ? "Thinking" : "Working"} for{" "}
        <span ref={labelRef} className="live-turn-status__timer">
          {formatThoughtDuration(Date.now() - startedAt)}
        </span>
      </span>
    </div>
  );
}
