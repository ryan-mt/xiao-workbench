import type {
  ObservatoryActivity,
  ObservatoryActivityCategory,
  ObservatoryAgentNode,
  ObservatoryAgentStatus,
  ObservatorySnapshot,
} from "../../core/models/observatory";
import type {
  PendingInputSnapshot,
  RunEventRecord,
  RunSnapshot,
} from "../../core/models/run";

type MutableNode = Omit<ObservatoryAgentNode, "depth">;

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? value as Record<string, unknown> : null;

const protocolMessage = (event: RunEventRecord) => {
  const payload = objectValue(event.safePayload);
  if (!payload) return null;
  if (event.eventType.startsWith("agent.")) return payload;
  return objectValue(payload.protocol);
};

const rootStatus = (status: RunSnapshot["status"]): ObservatoryAgentStatus => {
  if (status === "waiting_for_input") return "waiting";
  if (["queued", "preparing", "running", "verifying"].includes(status)) return "running";
  if (status === "completed" || status === "needs_attention") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "interrupted") return "interrupted";
  return "unknown";
};

const collaboratorStatus = (status: unknown): ObservatoryAgentStatus => {
  if (status === "pendingInit") return "pending";
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "errored" || status === "notFound") return "failed";
  if (status === "interrupted") return "interrupted";
  if (status === "shutdown") return "shutdown";
  return "unknown";
};

const eventStatus = (eventType: string): ObservatoryActivity["status"] => {
  if (eventType.includes("failed") || eventType.includes("cancelled")) return "error";
  if (eventType.includes("interrupted") || eventType.includes("blocked") || eventType.includes("waiting")) {
    return "warning";
  }
  if (eventType.includes("queued") || eventType.includes("running") || eventType.includes("verifying")) {
    return "active";
  }
  return "success";
};

const readable = (value: string) => value
  .replace(/^agent\./, "")
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/[._/]+/g, " ")
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const itemTitle = (item: Record<string, unknown>, completed: boolean) => {
  const type = typeof item.type === "string" ? item.type : "activity";
  if (type === "commandExecution") return completed ? "Command completed" : "Running a command";
  if (type === "fileChange") return completed ? "Workspace changes recorded" : "Changing files";
  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    return completed ? `${tool} completed` : `Using ${tool}`;
  }
  if (type === "webSearch") return "Web search";
  if (type === "collabAgentToolCall") {
    const tool = typeof item.tool === "string" ? item.tool : "collaboration";
    return readable(tool);
  }
  if (type === "agentMessage") return "Agent response";
  if (type === "reasoning") return completed ? "Reasoning completed" : "Reasoning";
  return readable(type);
};

const itemCategory = (item: Record<string, unknown>): ObservatoryActivityCategory => {
  if (item.type === "fileChange") return "changes";
  if (["commandExecution", "mcpToolCall", "dynamicToolCall", "webSearch"].includes(String(item.type))) {
    return "tools";
  }
  return "status";
};

const itemDetail = (item: Record<string, unknown>) => {
  if (typeof item.prompt === "string" && item.prompt.trim()) return item.prompt.trim().slice(0, 240);
  if (typeof item.command === "string" && item.command.trim()) return item.command.trim().slice(0, 240);
  if (typeof item.message === "string" && item.message.trim()) return item.message.trim().slice(0, 240);
  return null;
};

const ensureNode = (
  nodes: Map<string, MutableNode>,
  threadId: string,
  fallbackStartedAt: number,
) => {
  const existing = nodes.get(threadId);
  if (existing) return existing;
  const node: MutableNode = {
    threadId,
    parentThreadId: null,
    label: "Subagent",
    status: "unknown",
    model: null,
    reasoningEffort: null,
    startedAt: fallbackStartedAt,
    finishedAt: null,
    latestAction: null,
    latestTimelineEntryId: null,
    totalTokens: null,
    pendingInputIds: [],
  };
  nodes.set(threadId, node);
  return node;
};

const activityForLifecycle = (run: RunSnapshot, event: RunEventRecord): ObservatoryActivity => ({
  id: `${run.id}:${event.sequence}`,
  runId: run.id,
  sequence: event.sequence,
  timestamp: event.timestamp,
  category: event.eventType.startsWith("verification.") ? "verification"
    : event.eventType.includes("input") || event.eventType.includes("waiting_for_input") ? "approvals"
      : event.eventType === "time_travel.restored" ? "changes" : "status",
  status: eventStatus(event.eventType),
  title: readable(event.eventType),
  detail: null,
  threadId: run.threadId,
  timelineEntryId: null,
});

const nodeDepth = (
  node: MutableNode,
  nodes: Map<string, MutableNode>,
) => {
  let depth = 0;
  let parent = node.parentThreadId;
  const visited = new Set([node.threadId]);
  while (parent && nodes.has(parent) && !visited.has(parent)) {
    visited.add(parent);
    depth += 1;
    parent = nodes.get(parent)?.parentThreadId ?? null;
  }
  return depth;
};

export const projectObservatory = (
  run: RunSnapshot,
  events: RunEventRecord[],
  pendingInputs: PendingInputSnapshot[],
): ObservatorySnapshot => {
  const rootThreadId = run.threadId ?? `run:${run.id}`;
  const nodes = new Map<string, MutableNode>();
  nodes.set(rootThreadId, {
    threadId: rootThreadId,
    parentThreadId: null,
    label: "Primary agent",
    status: rootStatus(run.status),
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    startedAt: run.startedAt ?? run.queuedAt,
    finishedAt: run.finishedAt,
    latestAction: null,
    latestTimelineEntryId: null,
    totalTokens: null,
    pendingInputIds: [],
  });
  const activities: ObservatoryActivity[] = [];

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const message = protocolMessage(event);
    const method = typeof message?.method === "string" ? message.method : null;
    const params = objectValue(message?.params);
    const item = objectValue(params?.item);
    if (!method || !item) {
      if (method === "thread/tokenUsage/updated") {
        const threadId = typeof params?.threadId === "string" ? params.threadId : rootThreadId;
        const total = objectValue(objectValue(params?.tokenUsage)?.total)?.totalTokens;
        if (typeof total === "number" && total >= 0) {
          ensureNode(nodes, threadId, event.timestamp).totalTokens = total;
        }
      }
      activities.push(activityForLifecycle(run, event));
      continue;
    }

    const completed = method === "item/completed";
    const itemId = typeof item.id === "string" ? item.id : null;
    const ownerThreadId = typeof item.senderThreadId === "string"
      ? item.senderThreadId
      : typeof params?.threadId === "string" ? params.threadId : rootThreadId;
    const owner = ensureNode(nodes, ownerThreadId, event.timestamp);
    const title = itemTitle(item, completed);
    owner.latestAction = title;
    owner.latestTimelineEntryId = itemId;

    if (item.type === "collabAgentToolCall") {
      const receiverIds = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter((value): value is string => typeof value === "string")
        : [];
      const states = objectValue(item.agentsStates) ?? {};
      for (const threadId of new Set([...receiverIds, ...Object.keys(states)])) {
        const child = ensureNode(nodes, threadId, event.timestamp);
        if (threadId !== ownerThreadId) child.parentThreadId = ownerThreadId;
        child.label = typeof item.prompt === "string" && item.prompt.trim()
          ? item.prompt.trim().slice(0, 72)
          : "Subagent";
        if (typeof item.model === "string" && item.model.trim()) child.model = item.model.trim();
        if (typeof item.reasoningEffort === "string" && item.reasoningEffort.trim()) {
          child.reasoningEffort = item.reasoningEffort.trim();
        }
        const state = objectValue(states[threadId]);
        child.status = collaboratorStatus(state?.status);
        if (["completed", "failed", "interrupted", "shutdown"].includes(child.status)) {
          child.finishedAt = event.timestamp;
        } else {
          child.finishedAt = null;
        }
        if (typeof state?.message === "string" && state.message.trim()) {
          child.latestAction = state.message.trim().slice(0, 160);
        }
      }
    }

    activities.push({
      id: `${run.id}:${event.sequence}`,
      runId: run.id,
      sequence: event.sequence,
      timestamp: event.timestamp,
      category: itemCategory(item),
      status: item.status === "failed" || item.status === "declined" ? "error"
        : completed ? "success" : "active",
      title,
      detail: itemDetail(item),
      threadId: ownerThreadId,
      timelineEntryId: itemId,
    });
  }

  for (const pending of pendingInputs.filter((input) => input.runId === run.id)) {
    const owner = ensureNode(nodes, pending.threadId || rootThreadId, pending.openedAt);
    owner.status = "waiting";
    if (!owner.pendingInputIds.includes(pending.id)) owner.pendingInputIds.push(pending.id);
    owner.latestAction = pending.kind === "question" ? "Waiting for an answer" : "Waiting for approval";
    owner.latestTimelineEntryId = pending.itemId || owner.latestTimelineEntryId;
    activities.push({
      id: `pending:${pending.id}`,
      runId: run.id,
      sequence: Number.MAX_SAFE_INTEGER,
      timestamp: pending.openedAt,
      category: "approvals",
      status: "warning",
      title: pending.kind === "question" ? "Question needs an answer" : "Approval needed",
      detail: null,
      threadId: owner.threadId,
      timelineEntryId: pending.itemId || null,
    });
  }

  return {
    nodes: [...nodes.values()]
      .map((node) => ({ ...node, depth: nodeDepth(node, nodes) }))
      .sort((left, right) => left.depth - right.depth || left.startedAt - right.startedAt),
    activities: activities.sort((left, right) => right.timestamp - left.timestamp || right.sequence - left.sequence),
  };
};
