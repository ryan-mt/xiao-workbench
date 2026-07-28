import { useEffect, useState } from "react";

import type { AgentRuntimeState } from "../../../core/models/agent";
import { ActivityItem, TimelineImages } from "./ActivityItem";
import type { ConversationTurn } from "./ConversationTurnProjector";
import { EditedFilesSummary } from "./EditedFilesSummary";
import { toolCallRecovery } from "./ToolCallGroup";
import { TurnDurationHeader } from "./TurnDurationHeader";

type SharedProps = {
  turn: ConversationTurn;
  index: number;
  runtime: AgentRuntimeState;
  taskId: string;
  workspacePath: string;
  expandToolOutput: boolean;
  canFork: boolean;
  canUndo: boolean;
  undoing: boolean;
  onForkTask: (entryId: string) => void;
  onOpenResource: (target: string) => boolean;
  onReviewChanges: () => void;
  onUndo: () => void;
  onResolveApproval: (
    taskId: string,
    entryId: string,
    requestId: number | string,
    decision: "accept" | "decline",
  ) => Promise<void>;
};

export function AgentTurn(props: SharedProps) {
  const { turn, runtime, taskId } = props;
  const live = runtime.phase === "working" &&
    runtime.taskId === taskId &&
    (!turn.response || turn.response.status === "active");
  const [expanded, setExpanded] = useState(live);
  const recovery = toolCallRecovery(turn.work.filter((entry) => entry.kind === "command"));

  useEffect(() => {
    if (live) setExpanded(true);
  }, [live]);

  const item = (entry: ConversationTurn["user"], offset: number, turnFiles = false) => (
    <ActivityItem
      entry={entry}
      index={props.index + offset}
      showReasoningSummaries={false}
      expandToolOutput={props.expandToolOutput}
      workspacePath={props.workspacePath}
      onOpenResource={props.onOpenResource}
      taskId={taskId}
      canFork={entry === turn.user && props.canFork}
      onForkTask={props.onForkTask}
      onResolveApproval={props.onResolveApproval}
      onReviewChanges={props.onReviewChanges}
      turnFiles={turnFiles ? [] : undefined}
      canUndo={false}
      undoing={false}
      isLive={live}
      recovered={recovery.recoveredIds.has(entry.id)}
    />
  );

  return (
    <section className={`conversation-turn${live ? " is-live" : ""}`}>
      <span className="timeline-entry-anchor" id={`timeline-entry-${turn.user.id}`}>
        {item(turn.user, 0)}
      </span>
      <TurnDurationHeader
        user={turn.user}
        entries={turn.work}
        response={turn.response}
        live={live}
        runtimeStartedAt={live ? runtime.turnStartedAt : null}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
      {expanded && turn.work.length ? (
        <div className="conversation-turn__execution">
          {turn.work.map((entry, offset) => (
            <span className="timeline-entry-anchor" id={`timeline-entry-${entry.id}`} key={entry.id}>
              {item(entry, offset + 1)}
            </span>
          ))}
        </div>
      ) : null}
      <TimelineImages
        attachments={turn.work.flatMap((entry) =>
          entry.attachments?.filter((attachment) => attachment.kind === "image") ?? []
        )}
      />
      {turn.response ? (
        <span className="timeline-entry-anchor" id={`timeline-entry-${turn.response.id}`}>
          {item(turn.response, turn.work.length + 1, true)}
        </span>
      ) : null}
      {turn.files.length ? (
        <EditedFilesSummary
          files={turn.files}
          workspacePath={props.workspacePath}
          canUndo={props.canUndo}
          undoing={props.undoing}
          onUndo={props.onUndo}
          onReview={props.onReviewChanges}
          onOpenResource={props.onOpenResource}
        />
      ) : null}
    </section>
  );
}
