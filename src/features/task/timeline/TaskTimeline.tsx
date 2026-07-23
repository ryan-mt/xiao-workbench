import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentRuntimeState, TimelineEntry } from "../../../core/models/agent";
import type { RunSnapshot } from "../../../core/models/run";
import { ActivityItem, TimelineImages } from "./ActivityItem";
import { ExplorationGroup } from "./ExplorationGroup";
import { LiveTurnStatus } from "./LiveTurnStatus";
import { ToolCallGroup } from "./ToolCallGroup";
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
  onFixVerificationFailures: (prompt: string) => Promise<boolean>;
  fixVerificationFailuresDisabled: boolean;
  canUndo: boolean;
  undoing: boolean;
  onUndo: () => void;
};

export type TimelineRow =
  | { kind: "entry"; entry: TimelineEntry; index: number }
  | { kind: "exploration"; entries: TimelineEntry[]; index: number }
  | { kind: "toolGroup"; entries: TimelineEntry[]; index: number };

const isContextEntry = (entry: TimelineEntry) =>
  entry.kind === "explore" ||
  (
    entry.kind === "result" &&
    entry.meta?.toLowerCase() === "browser tool"
  );

const isCompactToolEntry = (entry: TimelineEntry) => entry.kind === "command";

export const timelineRows = (timeline: TimelineEntry[]): TimelineRow[] => {
  const rows: TimelineRow[] = [];
  let index = 0;

  while (index < timeline.length) {
    const entry = timeline[index];
    if (!isContextEntry(entry)) {
      if (isCompactToolEntry(entry)) {
        let end = index + 1;
        while (end < timeline.length && isCompactToolEntry(timeline[end])) end += 1;
        if (end - index > 1) {
          rows.push({ kind: "toolGroup", entries: timeline.slice(index, end), index });
          index = end;
          continue;
        }
      }
      rows.push({ kind: "entry", entry, index });
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < timeline.length && isContextEntry(timeline[end])) end += 1;
    rows.push({ kind: "exploration", entries: timeline.slice(index, end), index });
    index = end;
  }

  return rows;
};

type CompletedTurnFilesCacheEntry = {
  changes: TimelineEntry[];
  files: NonNullable<TimelineEntry["files"]>;
};

const emptyCompletedTurnFiles: NonNullable<TimelineEntry["files"]> = [];
const completedTurnFilesCache = new WeakMap<TimelineEntry, CompletedTurnFilesCacheEntry>();

const sameEntries = (left: TimelineEntry[], right: TimelineEntry[]) =>
  left.length === right.length &&
  left.every((entry, index) => entry === right[index]);

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
    return emptyCompletedTurnFiles;
  }

  let start = resultIndex - 1;
  while (start >= 0 && timeline[start].kind !== "user" && timeline[start].kind !== "brief") {
    start -= 1;
  }

  const changes: TimelineEntry[] = [];
  for (let index = start + 1; index < resultIndex; index += 1) {
    const entry = timeline[index];
    if (entry.kind === "change" && entry.status !== "error" && entry.files) {
      changes.push(entry);
    }
  }
  const cached = completedTurnFilesCache.get(result);
  if (cached && sameEntries(cached.changes, changes)) return cached.files;

  const files = new Map<string, NonNullable<TimelineEntry["files"]>[number]>();
  for (const entry of changes) {
    for (const file of entry.files ?? []) {
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
  const summary = [...files.values()];
  completedTurnFilesCache.set(result, { changes, files: summary });
  return summary;
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
  onFixVerificationFailures,
  fixVerificationFailuresDisabled,
  canUndo,
  undoing,
  onUndo,
}: TaskTimelineProps) {
  const rows = timelineRows(timeline);
  let latestCompletedResponseIndex = -1;
  let latestTurnStartIndex = -1;
  for (let index = 0; index < timeline.length; index += 1) {
    const entry = timeline[index];
    if (entry.kind === "user" || entry.kind === "brief") latestTurnStartIndex = index;
    if (entry.kind === "result" && entry.title === "Agent response" && entry.status === "success") {
      latestCompletedResponseIndex = index;
    }
  }
  const taskWorking = runtime.phase === "working" && runtime.taskId === taskId;
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
                isLive={taskWorking && row.index >= latestTurnStartIndex}
              />
            </div>
          );
        }

        if (row.kind === "toolGroup") {
          return (
            <div
              className="timeline-tool-group-anchor"
              key={`tools-${row.entries[0]?.id ?? row.index}`}
            >
              {row.entries.map((entry) => (
                <span
                  aria-hidden="true"
                  className="timeline-entry-anchor-target"
                  id={`timeline-entry-${entry.id}`}
                  key={entry.id}
                />
              ))}
              <ToolCallGroup
                entries={row.entries}
                expandByDefault={expandToolOutput}
                index={row.index}
                isLive={taskWorking && row.index >= latestTurnStartIndex}
              >
                {row.entries.map((entry, entryOffset) => (
                  <ActivityItem
                    entry={{
                      ...entry,
                      attachments: entry.attachments?.filter((attachment) => attachment.kind !== "image"),
                    }}
                    index={row.index + entryOffset}
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
                    undoing={false}
                    isLive={taskWorking && row.index >= latestTurnStartIndex}
                    key={entry.id}
                  />
                ))}
              </ToolCallGroup>
              <TimelineImages
                attachments={row.entries.flatMap((entry) =>
                  entry.attachments?.filter((attachment) => attachment.kind === "image") ?? []
                )}
              />
            </div>
          );
        }

        const latestCompletedResponse = row.index === latestCompletedResponseIndex;
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
              canUndo={canUndo && latestCompletedResponse}
              undoing={latestCompletedResponse && undoing}
              onUndo={latestCompletedResponse ? onUndo : undefined}
              isLive={taskWorking && row.index >= latestTurnStartIndex}
            />
          </div>
        );
      })}
      <LiveTurnStatus taskId={taskId} runtime={runtime} timeline={timeline} />
      {latestRun ? (
        <VerificationEvidenceCard
          run={latestRun}
          onReviewChanges={onReviewChanges}
          onFixFailures={onFixVerificationFailures}
          fixFailuresDisabled={fixVerificationFailuresDisabled}
        />
      ) : null}
    </div>
  );
}
