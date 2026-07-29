import { useEffect, useState } from "react";

import type { AgentRuntimeState, TimelineEntry } from "../../../core/models/agent";
import { ActivityItem } from "./ActivityItem";
import type { ConversationTurn } from "./ConversationTurnProjector";
import { EditedFilesSummary } from "./EditedFilesSummary";
import { ExecutionTraceGroup } from "./ExecutionTraceGroup";
import { projectExecutionTraces } from "./ExecutionTraceProjector";
import { toolCallRecovery } from "./ToolCallGroup";
import { TurnDurationHeader } from "./TurnDurationHeader";

type SharedProps = {
  turn: ConversationTurn;
  index: number;
  runtime: AgentRuntimeState;
  liveEligible: boolean;
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
  onEditUserMessage?: (text: string) => void;
  onResolveApproval: (
    taskId: string,
    entryId: string,
    requestId: number | string,
    decision: "accept" | "decline",
  ) => Promise<void>;
};

type TurnFlowGroup =
  | { kind: "commentary"; entry: TimelineEntry }
  | { kind: "user"; entry: TimelineEntry }
  | { kind: "status"; entry: TimelineEntry }
  | { kind: "execution"; id: string; entries: TimelineEntry[] };

const groupTurnFlow = (
  flow: TimelineEntry[],
  commentary: TimelineEntry[],
): TurnFlowGroup[] => {
  const commentaryIds = new Set(commentary.map((entry) => entry.id));
  const groups: TurnFlowGroup[] = [];
  let execution: TimelineEntry[] = [];
  const flushExecution = () => {
    if (!execution.length) return;
    groups.push({
      kind: "execution",
      id: `execution-segment:${execution[0].id}`,
      entries: execution,
    });
    execution = [];
  };

  for (const entry of flow) {
    if (entry.kind === "user" || entry.kind === "brief") {
      flushExecution();
      groups.push({ kind: "user", entry });
    } else if (entry.kind === "result" && entry.meta === "Context") {
      flushExecution();
      groups.push({ kind: "status", entry });
    } else if (commentaryIds.has(entry.id)) {
      flushExecution();
      groups.push({ kind: "commentary", entry });
    } else if (entry.kind === "thought") {
      flushExecution();
      execution.push(entry);
    } else {
      execution.push(entry);
    }
  }
  flushExecution();
  return groups;
};

const liveThoughtLabel = (entry: TimelineEntry) =>
  entry.body
    ?.split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+|^\s*[-*]\s+|\*\*|__/g, "").trim())
    .find(Boolean) ?? entry.title;

export function AgentTurn(props: SharedProps) {
  const { turn, runtime, taskId } = props;
  const live = props.liveEligible &&
    runtime.phase === "working" &&
    runtime.taskId === taskId &&
    (!turn.response || turn.response.status === "active");
  const [expanded, setExpanded] = useState(live);
  const recovery = toolCallRecovery(turn.work.filter((entry) => entry.kind === "command"));
  const flowGroups = groupTurnFlow(turn.flow, turn.commentary);
  let latestExecutionGroupIndex = -1;
  for (let index = flowGroups.length - 1; index >= 0; index -= 1) {
    if (flowGroups[index].kind === "execution") {
      latestExecutionGroupIndex = index;
      break;
    }
  }

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
      onEditUserMessage={entry === turn.user ? props.onEditUserMessage : undefined}
      showMessageActions={entry.meta !== "Commentary"}
    />
  );

  const flow = flowGroups.map((flowGroup, flowGroupIndex) => {
    if (flowGroup.kind === "user") {
      return (
        <span
          className="timeline-entry-anchor conversation-turn__follow-up"
          id={`timeline-entry-${flowGroup.entry.id}`}
          key={flowGroup.entry.id}
        >
          {item(flowGroup.entry, turn.flow.indexOf(flowGroup.entry) + 1)}
        </span>
      );
    }
    if (!expanded) return null;
    if (flowGroup.kind === "status") {
      return (
        <span
          className="timeline-entry-anchor conversation-turn__status"
          id={`timeline-entry-${flowGroup.entry.id}`}
          key={flowGroup.entry.id}
        >
          {item(flowGroup.entry, turn.flow.indexOf(flowGroup.entry) + 1)}
        </span>
      );
    }
    if (flowGroup.kind === "commentary") {
      const offset = turn.flow.indexOf(flowGroup.entry) + 1;
      return (
        <span
          className="timeline-entry-anchor conversation-turn__commentary"
          id={`timeline-entry-${flowGroup.entry.id}`}
          key={flowGroup.entry.id}
        >
          {item(flowGroup.entry, offset)}
        </span>
      );
    }

    let executionEnd = flowGroup.entries.length;
    while (executionEnd > 0 && flowGroup.entries[executionEnd - 1].kind === "thought") {
      executionEnd -= 1;
    }
    const groupLive = live && flowGroupIndex === latestExecutionGroupIndex;
    const latestThought = groupLive
      ? flowGroup.entries.slice(executionEnd).at(-1)
      : null;
    const executionGroups = projectExecutionTraces(
      latestThought ? flowGroup.entries.slice(0, executionEnd) : flowGroup.entries,
      latestThought ? false : groupLive,
    );
    if (!executionGroups.length && !latestThought) return null;
    return (
      <div className="conversation-turn__execution" key={flowGroup.id}>
        {executionGroups.map((group) => {
          const content = group.entries.map((entry) => (
            <span className="timeline-entry-anchor" id={`timeline-entry-${entry.id}`} key={entry.id}>
              {item(entry, turn.flow.indexOf(entry) + 1)}
            </span>
          ));
          return group.title ? (
            <ExecutionTraceGroup
              key={group.id}
              title={group.title}
              live={groupLive}
              thought={group.thoughtTitled}
            >
              {content}
            </ExecutionTraceGroup>
          ) : <div className="execution-trace__ungrouped" key={group.id}>{content}</div>;
        })}
        {latestThought ? (
          <div className="conversation-turn__thinking" role="status">
            {liveThoughtLabel(latestThought)}
          </div>
        ) : null}
      </div>
    );
  });

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
      <div className="conversation-turn__body">{flow}</div>
      {turn.response ? (
        <span className="timeline-entry-anchor" id={`timeline-entry-${turn.response.id}`}>
          {item(turn.response, turn.commentary.length + turn.work.length + 1, true)}
        </span>
      ) : null}
      {turn.files.length && turn.response ? (
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
