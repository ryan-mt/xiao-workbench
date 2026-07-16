import type { AgentApprovalRequestKind, TimelineEntry } from "../../../core/models/agent";

export const permissionGrantFromRequest = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object") return {};
  const request = value as Record<string, unknown>;
  const grant: Record<string, unknown> = {};
  if (request.network && typeof request.network === "object") {
    grant.network = request.network;
  }
  if (request.fileSystem && typeof request.fileSystem === "object") {
    grant.fileSystem = request.fileSystem;
  }
  return grant;
};

export const approvalResponse = (
  kind: AgentApprovalRequestKind | undefined,
  requestedPermissions: Record<string, unknown> | undefined,
  decision: "accept" | "decline",
): Record<string, unknown> => {
  if (kind === "permissions") {
    return {
      permissions: decision === "accept" ? requestedPermissions ?? {} : {},
      scope: "turn",
    };
  }
  return { decision };
};

export const mcpElicitationDeclineResponse = (): Record<string, unknown> => ({
  action: "decline",
  content: null,
  _meta: null,
});

export const needsAgentSession = (
  threadId: string | undefined,
  hasRequestedModel: boolean,
  previousRequestedModel: string | null | undefined,
  requestedModel: string | null,
) => !threadId || !hasRequestedModel || previousRequestedModel !== requestedModel;

export const threadCompactRequest = (threadId: string) => ({
  method: "thread/compact/start" as const,
  params: { threadId },
});

export const contextCompactionTimelineEntry = (
  item: Record<string, unknown>,
  lifecycle: "started" | "completed",
): TimelineEntry | null => {
  if (item.type !== "contextCompaction" || typeof item.id !== "string") return null;
  const completed = lifecycle === "completed";
  return {
    id: item.id,
    kind: "result",
    title: completed ? "Context compacted" : "Compacting context",
    createdAt: Date.now(),
    meta: "Context",
    status: completed ? "success" : "active",
  };
};
