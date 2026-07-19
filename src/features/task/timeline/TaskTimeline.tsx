import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentRuntimeState, TimelineEntry } from "../../../core/models/agent";
import type { RunSnapshot } from "../../../core/models/run";
import { ActivityItem } from "./ActivityItem";
import { ExecutionGroup } from "./ExecutionGroup";
import { ExplorationGroup } from "./ExplorationGroup";
import { LiveTurnStatus } from "./LiveTurnStatus";
import { VerificationEvidenceCard } from "../../verification/VerificationEvidenceCard";

type TaskTimelineProps = {
  timeline: TimelineEntry[];
  runtime: AgentRuntimeState;
  latestRun: RunSnapshot | null;
  showReasoningSummaries: boolean;
  expandToolOutput: boolean;
  workspacePath: string;
  onOpenResource: (target: string) => boolean;
  historyLoading: boolean;
  canFork: boolean;
  onForkTask: (entryId: string) => void;
  onResolveApproval: (
    taskId: string,
    entryId: string,
    requestId: number | string,
    decision: "accept" | "decline",
  ) => Promise<void>;
  taskId: string;
  onReviewChanges: () => void;
};

export type TimelineRow =
  | { kind: "entry"; entry: TimelineEntry; index: number }
  | { kind: "exploration"; entries: TimelineEntry[]; index: number }
  | { kind: "execution"; entries: TimelineEntry[]; index: number };

export const timelineRows = (timeline: TimelineEntry[]): TimelineRow[] => {
  const rows: TimelineRow[] = [];
  let index = 0;

  while (index < timeline.length) {
    const entry = timeline[index];
    if (entry.kind === "command") {
      let end = index + 1;
      while (end < timeline.length && timeline[end].kind === "command") end += 1;
      const entries = timeline.slice(index, end);
      if (entries.length > 1) rows.push({ kind: "execution", entries, index });
      else rows.push({ kind: "entry", entry, index });
      index = end;
      continue;
    }

    if (entry.kind !== "explore" && entry.kind !== "thought") {
      rows.push({ kind: "entry", entry, index });
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < timeline.length && ["explore", "thought"].includes(timeline[end].kind)) {
      end += 1;
    }
    const segment = timeline.slice(index, end);
    const explorationEntries = segment.filter((item) => item.kind === "explore");
    if (!explorationEntries.length) {
      segment.forEach((item, offset) =>
        rows.push({ kind: "entry", entry: item, index: index + offset }),
      );
      index = end;
      continue;
    }

    const lastExplorationId = explorationEntries.at(-1)?.id;
    for (let offset = 0; offset < segment.length; offset += 1) {
      const item = segment[offset];
      if (item.kind === "thought") {
        rows.push({ kind: "entry", entry: item, index: index + offset });
      } else if (item.id === lastExplorationId) {
        rows.push({ kind: "exploration", entries: explorationEntries, index: index + offset });
      }
    }
    index = end;
  }

  return rows;
};

export function TaskTimeline({
  timeline,
  runtime,
  latestRun,
  showReasoningSummaries,
  expandToolOutput,
  workspacePath,
  onOpenResource,
  historyLoading,
  canFork,
  onForkTask,
  taskId,
  onResolveApproval,
  onReviewChanges,
}: TaskTimelineProps) {
  const rows = timelineRows(timeline);
  return (
    <div className="timeline" aria-live="polite">
      {historyLoading ? (
        <div className="timeline__history-loading">Loading earlier task activity…</div>
      ) : null}
      {!timeline.length && !historyLoading ? (
        <div className="timeline__empty">
          <span className="timeline__empty-mark"><XiaoIcon name="command" size={22} /></span>
          <h2>What are we building?</h2>
          <p>Describe the outcome below. Xiao will keep the work, commands, and changes in this task.</p>
        </div>
      ) : null}
      {rows.map((row) => {
        if (row.kind === "exploration") {
          return (
            <div
              className="timeline-exploration-anchor"
              key={`exploration-${row.entries.map((entry) => entry.id).join("-")}`}
            >
              {row.entries.map((entry) => (
                <span
                  aria-hidden="true"
                  className="timeline-entry-anchor-target"
                  id={`timeline-entry-${entry.id}`}
                  key={entry.id}
                />
              ))}
              <ExplorationGroup
                entries={row.entries}
                expandByDefault={expandToolOutput}
                index={row.index}
              />
            </div>
          );
        }

        if (row.kind === "execution") {
          return (
            <ExecutionGroup
              entries={row.entries}
              expandByDefault={expandToolOutput}
              index={row.index}
              key={`execution-${row.entries.map((entry) => entry.id).join("-")}`}
            >
              {row.entries.map((entry, offset) => (
                <div
                  className="execution-group__entry"
                  id={`timeline-entry-${entry.id}`}
                  key={entry.id}
                >
                  <ActivityItem
                    entry={entry}
                    index={row.index + offset}
                    showReasoningSummaries={showReasoningSummaries}
                    expandToolOutput={expandToolOutput}
                    workspacePath={workspacePath}
                    onOpenResource={onOpenResource}
                    taskId={taskId}
                    canFork={canFork}
                    onForkTask={onForkTask}
                    onResolveApproval={onResolveApproval}
                    onReviewChanges={onReviewChanges}
                  />
                </div>
              ))}
            </ExecutionGroup>
          );
        }

        return (
          <div
            className="timeline-entry-anchor"
            id={`timeline-entry-${row.entry.id}`}
            key={row.entry.id}
          >
            <ActivityItem
              entry={row.entry}
              index={row.index}
              showReasoningSummaries={showReasoningSummaries}
              expandToolOutput={expandToolOutput}
              workspacePath={workspacePath}
              onOpenResource={onOpenResource}
              taskId={taskId}
              canFork={canFork}
              onForkTask={onForkTask}
              onResolveApproval={onResolveApproval}
              onReviewChanges={onReviewChanges}
            />
          </div>
        );
      })}
      <LiveTurnStatus taskId={taskId} runtime={runtime} timeline={timeline} />
      {latestRun ? (
        <VerificationEvidenceCard run={latestRun} onReviewChanges={onReviewChanges} />
      ) : null}
    </div>
  );
}
