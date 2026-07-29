import { memo, useMemo } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type {
  AgentAttachment,
  AgentRuntimeState,
  TimelineEntry,
} from "../../../core/models/agent";
import type { RunSnapshot } from "../../../core/models/run";
import { VerificationEvidenceCard } from "../../verification/VerificationEvidenceCard";
import { ActivityItem } from "./ActivityItem";
import { AgentTurn } from "./AgentTurn";
import { projectConversation } from "./ConversationTurnProjector";
import { LiveTurnStatus } from "./LiveTurnStatus";

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
  onEditUserMessage?: (text: string, attachments: AgentAttachment[]) => void;
};

function TaskTimelineView({
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
  onEditUserMessage,
}: TaskTimelineProps) {
  const rows = useMemo(() => projectConversation(timeline), [timeline]);
  const lastTurnIndex = rows.reduce(
    (latest, row, index) => row.kind === "turn" ? index : latest,
    -1,
  );

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
      {rows.map((row, rowIndex) => {
        if (row.kind === "turn") {
          return (
            <AgentTurn
              key={row.turn.id}
              turn={row.turn}
              index={row.turn.startIndex}
              runtime={runtime}
              liveEligible={rowIndex === lastTurnIndex}
              taskId={taskId}
              workspacePath={workspacePath}
              expandToolOutput={expandToolOutput}
              showReasoningSummaries={showReasoningSummaries}
              canFork={canFork}
              canUndo={canUndo && rowIndex === lastTurnIndex && Boolean(row.turn.response)}
              undoing={undoing && rowIndex === lastTurnIndex}
              onForkTask={onForkTask}
              onOpenResource={onOpenResource}
              onReviewChanges={onReviewChanges}
              onUndo={onUndo}
              onEditUserMessage={rowIndex === lastTurnIndex ? onEditUserMessage : undefined}
              onResolveApproval={onResolveApproval}
            />
          );
        }

        return (
          <span className="timeline-entry-anchor" id={`timeline-entry-${row.entry.id}`} key={row.entry.id}>
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
              canUndo={false}
              undoing={false}
              isLive={false}
            />
          </span>
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

export const TaskTimeline = memo(TaskTimelineView);
TaskTimeline.displayName = "TaskTimeline";
