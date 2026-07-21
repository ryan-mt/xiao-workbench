import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentRuntimeState, TimelineEntry } from "../../../core/models/agent";
import type { RunSnapshot } from "../../../core/models/run";
import { ActivityItem } from "./ActivityItem";
import { compactCommandAttempts } from "./commandPresentation";
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
  canUndo: boolean;
  undoing: boolean;
  onUndo: () => void;
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

export const completedTurnFiles = (
  timeline: TimelineEntry[],
  resultIndex: number,
): NonNullable<TimelineEntry["files"]> => {
  const result = timeline[resultIndex];
  if (
    result?.kind !== "result" ||
    result.title !== "Agent response" ||
    result.status !== "success"
  ) {
    return [];
  }

  let start = resultIndex - 1;
  while (start >= 0 && timeline[start].kind !== "user" && timeline[start].kind !== "brief") {
    start -= 1;
  }

  const files = new Map<string, NonNullable<TimelineEntry["files"]>[number]>();
  for (const entry of timeline.slice(start + 1, resultIndex)) {
    if (entry.kind !== "change" || entry.status === "error" || !entry.files) continue;
    for (const file of entry.files) {
      const current = files.get(file.path);
      files.set(file.path, current
        ? {
            ...file,
            additions: current.additions + file.additions,
            deletions: current.deletions + file.deletions,
          }
        : { ...file });
    }
  }
  return [...files.values()];
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
  canUndo,
  undoing,
  onUndo,
}: TaskTimelineProps) {
  const rows = timelineRows(timeline);
  let latestCompletedResponseIndex = -1;
  for (let index = 0; index < timeline.length; index += 1) {
    const entry = timeline[index];
    if (entry.kind === "result" && entry.title === "Agent response" && entry.status === "success") {
      latestCompletedResponseIndex = index;
    }
  }
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
              key={`exploration-${row.entries[0]?.id ?? row.index}`}
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
          const attempts = compactCommandAttempts(row.entries);
          return (
            <ExecutionGroup
              entries={row.entries}
              expandByDefault={expandToolOutput}
              index={row.index}
              key={`execution-${row.entries[0]?.id ?? row.index}`}
            >
              {attempts.map(({ entry, entryIds, attempts: attemptCount }, offset) => (
                <div
                  className="execution-group__entry"
                  id={`timeline-entry-${entry.id}`}
                  key={entry.id}
                >
                  {entryIds.filter((id) => id !== entry.id).map((id) => (
                    <span
                      aria-hidden="true"
                      className="timeline-entry-anchor-target"
                      id={`timeline-entry-${id}`}
                      key={id}
                    />
                  ))}
                  <ActivityItem
                    entry={entry}
                    attemptCount={attemptCount}
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
                    canUndo={false}
                    undoing={undoing}
                    onUndo={onUndo}
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
              turnFiles={completedTurnFiles(timeline, row.index)}
              canUndo={canUndo && row.index === latestCompletedResponseIndex}
              undoing={undoing}
              onUndo={onUndo}
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
