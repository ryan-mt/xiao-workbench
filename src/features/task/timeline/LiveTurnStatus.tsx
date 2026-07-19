import { useEffect, useState } from "react";

import type { AgentRuntimeState, TimelineEntry } from "../../../core/models/agent";

const elapsedLabel = (elapsedMs: number) => {
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 1) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

export const statusLabel = (timeline: TimelineEntry[]) => {
  const active = [...timeline]
    .reverse()
    .find((entry) => entry.status === "active" || (entry.kind === "approval" && entry.status === "warning"));
  if (active?.kind === "command") return "Running command";
  if (active?.kind === "explore") return "Exploring workspace";
  if (active?.kind === "change") return "Applying changes";
  if (active?.kind === "agent") {
    if (active.collaborationTool === "wait") return "Waiting for subagent results";
    if (active.collaborationTool === "spawnAgent") return "Subagent working";
    return "Coordinating subagents";
  }
  if (active?.kind === "result" && active.meta === "Context") return "Compacting context";
  if (active?.kind === "result") return "Writing response";
  if (active?.kind === "approval") return "Waiting for approval";
  if (timeline.at(-1)?.kind === "result") return "Finishing";
  return "Thinking";
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
  const [now, setNow] = useState(Date.now);
  const taskWorking = runtime.phase === "working" && runtime.taskId === taskId;

  useEffect(() => {
    if (!taskWorking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [runtime.turnStartedAt, taskWorking]);

  if (!taskWorking) return null;
  const label = statusLabel(timeline);
  const elapsed = runtime.turnStartedAt ? elapsedLabel(now - runtime.turnStartedAt) : null;

  return (
    <div className="live-turn-status" role="status" aria-live="polite">
      <span className="live-turn-status__label">{label}</span>
      {elapsed && <time>{elapsed}</time>}
      <span className="live-turn-status__dots" aria-hidden="true"><i /><i /><i /></span>
    </div>
  );
}
