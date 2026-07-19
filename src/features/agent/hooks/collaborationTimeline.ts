import type {
  AgentCollaborator,
  AgentCollaboratorStatus,
  TimelineEntry,
} from "../../../core/models/agent";

const collaboratorStatuses = new Set<AgentCollaboratorStatus>([
  "pendingInit",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
]);

const collaborationTools = new Set<NonNullable<TimelineEntry["collaborationTool"]>>([
  "spawnAgent",
  "sendInput",
  "resumeAgent",
  "wait",
  "closeAgent",
]);

const activeTitles: Record<NonNullable<TimelineEntry["collaborationTool"]>, string> = {
  spawnAgent: "Delegating to a subagent",
  sendInput: "Sending context to a subagent",
  resumeAgent: "Resuming a subagent",
  wait: "Waiting for subagent results",
  closeAgent: "Closing a subagent",
};

const settledTitles: Record<NonNullable<TimelineEntry["collaborationTool"]>, string> = {
  spawnAgent: "Delegated a subagent task",
  sendInput: "Sent context to a subagent",
  resumeAgent: "Resumed a subagent",
  wait: "Received subagent status",
  closeAgent: "Closed a subagent",
};

const readCollaborators = (item: Record<string, unknown>): AgentCollaborator[] => {
  const receiverIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((value): value is string => typeof value === "string")
    : [];
  const rawStates = item.agentsStates && typeof item.agentsStates === "object"
    ? item.agentsStates as Record<string, unknown>
    : {};
  const threadIds = [...new Set([...receiverIds, ...Object.keys(rawStates)])];

  return threadIds.map((threadId) => {
    const rawState = rawStates[threadId];
    const state = rawState && typeof rawState === "object"
      ? rawState as Record<string, unknown>
      : null;
    const status = typeof state?.status === "string" && collaboratorStatuses.has(
      state.status as AgentCollaboratorStatus,
    )
      ? state.status as AgentCollaboratorStatus
      : "unknown";
    return {
      threadId,
      status,
      message: typeof state?.message === "string" ? state.message : null,
    };
  });
};

export const collaborationTimelineEntry = (
  item: Record<string, unknown>,
  createdAt = Date.now(),
): TimelineEntry | null => {
  if (item.type !== "collabAgentToolCall" || typeof item.id !== "string") return null;
  const tool = typeof item.tool === "string" && collaborationTools.has(
    item.tool as NonNullable<TimelineEntry["collaborationTool"]>,
  )
    ? item.tool as NonNullable<TimelineEntry["collaborationTool"]>
    : null;
  if (!tool) return null;

  const collaborators = readCollaborators(item);
  const callStatus = typeof item.status === "string" ? item.status : "inProgress";
  const hasActiveAgent = collaborators.some((agent) =>
    agent.status === "pendingInit" || agent.status === "running"
  );
  const hasFailedAgent = collaborators.some((agent) =>
    agent.status === "errored" || agent.status === "interrupted" || agent.status === "notFound"
  );
  const status: TimelineEntry["status"] = callStatus === "failed" || hasFailedAgent
    ? "error"
    : callStatus === "inProgress" || hasActiveAgent
      ? "active"
      : "success";
  const model = typeof item.model === "string" && item.model.trim() ? item.model.trim() : null;
  const metaParts = [
    collaborators.length
      ? `${collaborators.length} ${collaborators.length === 1 ? "subagent" : "subagents"}`
      : "Subagent",
    model,
  ].filter(Boolean);

  return {
    id: item.id,
    kind: "agent",
    createdAt,
    title: callStatus === "inProgress" ? activeTitles[tool] : settledTitles[tool],
    body: typeof item.prompt === "string" && item.prompt.trim() ? item.prompt : undefined,
    meta: metaParts.join(" - "),
    status,
    collaborators,
    collaborationTool: tool,
  };
};
