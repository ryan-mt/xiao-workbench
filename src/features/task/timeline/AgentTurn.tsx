import { memo, useEffect, useState } from "react";

import type {
  AgentAttachment,
  AgentRuntimeState,
  TimelineEntry,
} from "../../../core/models/agent";
import { ActivityItem } from "./ActivityItem";
import type { ConversationTurn } from "./ConversationTurnProjector";
import { EditedFilesSummary } from "./EditedFilesSummary";
import { ExecutionTraceGroup } from "./ExecutionTraceGroup";
import { projectExecutionTraces } from "./ExecutionTraceProjector";
import { ThinkingBlock } from "./ThinkingBlock";
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
  showReasoningSummaries: boolean;
  canFork: boolean;
  canUndo: boolean;
  undoing: boolean;
  onForkTask: (entryId: string) => void;
  onOpenResource: (target: string) => boolean;
  onReviewChanges: () => void;
  onUndo: () => void;
  onEditUserMessage?: (text: string, attachments: AgentAttachment[]) => void;
  onResolveApproval: (
    taskId: string,
    entryId: string,
    requestId: number | string,
    decision: "accept" | "decline",
  ) => Promise<void>;
};

type TurnFlowGroup =
  | { kind: "commentary"; entry: TimelineEntry }
  | { kind: "response"; entry: TimelineEntry }
  | { kind: "user"; entry: TimelineEntry }
  | { kind: "status"; entry: TimelineEntry }
  | { kind: "execution"; id: string; entries: TimelineEntry[] };

const groupTurnFlow = (
  flow: TimelineEntry[],
  commentary: TimelineEntry[],
  response: TimelineEntry | null,
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
    if (
      entry === response ||
      (entry.kind === "result" && entry.title === "Agent response" && entry.meta !== "Commentary")
    ) {
      flushExecution();
      groups.push({ kind: "response", entry });
    } else if (entry.kind === "user" || entry.kind === "brief") {
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

const sameEntries = (left: TimelineEntry[], right: TimelineEntry[]) =>
  left.length === right.length &&
  left.every((entry, index) => entry === right[index]);

const sameTurn = (left: ConversationTurn, right: ConversationTurn) =>
  left.id === right.id &&
  left.user === right.user &&
  left.response === right.response &&
  left.responseFlowIndex === right.responseFlowIndex &&
  left.startIndex === right.startIndex &&
  left.endIndex === right.endIndex &&
  sameEntries(left.flow, right.flow) &&
  sameEntries(left.commentary, right.commentary) &&
  sameEntries(left.work, right.work);

const sameRuntimeState = (
  left: AgentRuntimeState,
  right: AgentRuntimeState,
) =>
  left.phase === right.phase &&
  left.taskId === right.taskId &&
  left.turnId === right.turnId &&
  left.turnStartedAt === right.turnStartedAt;

const sameAgentTurnProps = (left: SharedProps, right: SharedProps) =>
  sameTurn(left.turn, right.turn) &&
  left.index === right.index &&
  left.liveEligible === right.liveEligible &&
  (!left.liveEligible || sameRuntimeState(left.runtime, right.runtime)) &&
  left.taskId === right.taskId &&
  left.workspacePath === right.workspacePath &&
  left.expandToolOutput === right.expandToolOutput &&
  left.showReasoningSummaries === right.showReasoningSummaries &&
  left.canFork === right.canFork &&
  left.canUndo === right.canUndo &&
  left.undoing === right.undoing &&
  left.onForkTask === right.onForkTask &&
  left.onOpenResource === right.onOpenResource &&
  left.onReviewChanges === right.onReviewChanges &&
  left.onUndo === right.onUndo &&
  left.onEditUserMessage === right.onEditUserMessage &&
  left.onResolveApproval === right.onResolveApproval;

function AgentTurnView(props: SharedProps) {
  const { turn, runtime, taskId } = props;
  const responseFlowIndex = turn.responseFlowIndex ?? turn.flow.length;
  // Latest turn stays live for the whole runtime turn — including after interim
  // assistant text — so the header keeps "Working for Xs" instead of flipping
  // to "Worked" while tools/thinking continue.
  const belongsToRuntimeTurn = (() => {
    if (!runtime.turnId) return true;
    const stamped = [
      turn.user.turnId,
      turn.response?.turnId,
      ...turn.flow.map((entry) => entry.turnId),
      ...turn.work.map((entry) => entry.turnId),
    ].filter((value): value is string => Boolean(value));
    if (!stamped.length) return true;
    return stamped.includes(runtime.turnId);
  })();
  const live = props.liveEligible &&
    runtime.phase === "working" &&
    runtime.taskId === taskId &&
    belongsToRuntimeTurn;
  const activeWorkAfterResponse = Boolean(
    live &&
    turn.response &&
    turn.responseFlowIndex !== null &&
    responseFlowIndex < turn.flow.length &&
    turn.flow.slice(responseFlowIndex).some((entry) =>
      entry.status === "active" &&
      (!runtime.turnId || entry.turnId === runtime.turnId)
    )
  );
  const [expanded, setExpanded] = useState(live);
  const recovery = toolCallRecovery(turn.work.filter((entry) => entry.kind === "command"));
  const responseBeforeLaterFlow = Boolean(
    turn.response &&
    turn.responseFlowIndex !== null &&
    responseFlowIndex < turn.flow.length
  );
  const chronologicalFlow = turn.response && responseBeforeLaterFlow
    ? [
        ...turn.flow.slice(0, responseFlowIndex),
        turn.response,
        ...turn.flow.slice(responseFlowIndex),
      ]
    : turn.flow;
  const flowGroups = groupTurnFlow(chronologicalFlow, turn.commentary, turn.response);
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
      showReasoningSummaries={props.showReasoningSummaries}
      expandToolOutput={props.expandToolOutput}
      workspacePath={props.workspacePath}
      onOpenResource={props.onOpenResource}
      taskId={taskId}
      canFork={(entry === turn.user || entry.kind === "user") && props.canFork}
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
    if (flowGroup.kind === "response") {
      return (
        <span
          className="timeline-entry-anchor"
          id={`timeline-entry-${flowGroup.entry.id}`}
          key={flowGroup.entry.id}
        >
          {item(flowGroup.entry, responseFlowIndex + 1, true)}
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

    const groupLive = live && flowGroupIndex === latestExecutionGroupIndex;
    // Keep chronological order: Thought blocks stand alone; tools/commands
    // get their own action-titled groups — never nested under Thought.
    const segments: Array<
      | { kind: "thought"; entry: TimelineEntry }
      | { kind: "work"; entries: TimelineEntry[] }
    > = [];
    for (const entry of flowGroup.entries) {
      if (entry.kind === "thought") {
        segments.push({ kind: "thought", entry });
        continue;
      }
      const last = segments.at(-1);
      if (last?.kind === "work") last.entries.push(entry);
      else segments.push({ kind: "work", entries: [entry] });
    }
    if (!segments.length) return null;
    return (
      <div className="conversation-turn__execution" key={flowGroup.id}>
        {segments.map((segment, segmentIndex) => {
          if (segment.kind === "thought") {
            const thoughtLive = groupLive &&
              segmentIndex === segments.length - 1 &&
              segment.entry.status === "active";
            return (
              <ThinkingBlock
                key={segment.entry.id}
                entry={segment.entry}
                live={thoughtLive || (groupLive && segment.entry.status === "active")}
                showBody={props.showReasoningSummaries}
                onOpenResource={props.onOpenResource}
              />
            );
          }
          const executionGroups = projectExecutionTraces(segment.entries, groupLive);
          return executionGroups.map((group) => {
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
                thought={false}
              >
                {content}
              </ExecutionTraceGroup>
            ) : (
              <div className="execution-trace__ungrouped" key={group.id}>{content}</div>
            );
          });
        })}
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
      {turn.response && !responseBeforeLaterFlow ? (
        <span className="timeline-entry-anchor" id={`timeline-entry-${turn.response.id}`}>
          {item(turn.response, turn.flow.length + 1, true)}
        </span>
      ) : null}
      {turn.files.length &&
        turn.response?.status === "success" &&
        !activeWorkAfterResponse ? (
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

export const AgentTurn = memo(AgentTurnView, sameAgentTurnProps);
AgentTurn.displayName = "AgentTurn";
