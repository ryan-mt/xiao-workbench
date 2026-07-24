import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { isTauriHost, nativeBridge } from "../../../core/bridges/tauri";
import { visiblePromptFromSelectedContext } from "../../../core/models/agent";
import type {
  AgentAccountSummary,
  AgentAccountUsage,
  AgentAttachment,
  AgentApprovalPolicy,
  AgentGoal,
  AgentMcpElicitationRequest,
  AgentMcpElicitationResponse,
  AgentMessage,
  AgentModelSummary,
  AgentPlan,
  AgentQuestionRequest,
  AgentRateLimitSnapshot,
  AgentRateLimitWindow,
  AgentRuntimeState,
  AgentTurnOutcome,
  AgentUndoResult,
  RuntimeLogEntry,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  TimelineEntry,
  XiaoHistoryItem,
} from "../../../core/models/agent";
import type {
  PendingInputSnapshot,
  RunEventRecord,
  RunProtocolEnvelope,
  RunSnapshot,
  RunStatus,
  RunUpdateEnvelope,
} from "../../../core/models/run";
import {
  workspaceServiceErrorMessage,
  type WorkspaceServiceError,
} from "../../../core/models/service";
import { useCodexUsage } from "../../profile/hooks/useCodexUsage";
import {
  approvalResponse,
  contextCompactionTimelineEntry,
  invalidateUndoHistory,
  isInactiveApprovalResolutionError,
  latestUndoableTurn,
  permissionGrantFromRequest,
  reconcilePendingApprovalEntries,
  reviewContextText,
  serviceTierForFastMode,
  settleResolvedApprovalEntry,
  threadCompactRequest,
  userInput,
} from "./agentProtocol";
import {
  acceptRunProtocol,
  activePendingInputIdsForRestore,
  activeRunForTask,
  emptyRunProjection,
  latestRunForTask,
  pruneRunProjection,
  reconcileListedPendingInputs,
  reconcileListedRunSnapshots,
  projectRunSnapshots,
  projectRunUpdate,
  runProjectionUiChanged,
  runSnapshotBaselineForIds,
  runStatusIsActive,
  shouldRestorePendingInput,
  type RunProjection,
} from "./runProjection";
import {
  appendLiveTimelineDelta,
  applyLiveTimelineDeltas,
  reconcileCompletedStreamBody,
  type LiveTimelineDelta,
} from "./liveTimelineDeltas";
import { collaborationTimelineEntry } from "./collaborationTimeline";
import {
  enqueueAgentMcpElicitationRequest,
  readMcpElicitationRequest,
  removeAgentMcpElicitationRequest,
} from "./mcpElicitation";

const MAX_RUNTIME_LOGS = 240;
const LIVE_DELTA_FLUSH_MS = 33;
const WORKSPACE_REFRESH_DEBOUNCE_MS = 180;
const RUN_EVENT_PAGE_SIZE = 200;
type LiveDeltaBatch = {
  deltas: LiveTimelineDelta[];
  eventCount: number;
  methodCounts: Map<string, number>;
  stdout: string;
};
type RuntimeMessageEnvelope = {
  environmentId: string;
  generation: number;
  message: AgentMessage;
};
type RuntimeDiagnosticEnvelope = {
  environmentId: string;
  generation: number;
  message: string;
};
type RuntimeStoppedEnvelope = { environmentId: string; generation: number };

export const agentRuntimeEnvelopeMatches = (
  expectedEnvironmentId: string,
  expectedGeneration: number | null,
  envelope: { environmentId: string; generation: number },
) => (
  envelope.environmentId === expectedEnvironmentId &&
  (expectedGeneration === null || envelope.generation === expectedGeneration)
);

const initialRuntime: AgentRuntimeState = {
  phase: "offline",
  taskId: null,
  threadId: null,
  turnId: null,
  turnStartedAt: null,
  error: null,
  eventsSeen: 0,
  profileId: null,
};

export type AgentRuntimeWorkspaceScope = {
  workspacePath: string;
  generation: number;
};

export const advanceAgentRuntimeWorkspaceScope = (
  current: AgentRuntimeWorkspaceScope,
  workspacePath: string,
): AgentRuntimeWorkspaceScope =>
  current.workspacePath === workspacePath
    ? current
    : { workspacePath, generation: current.generation + 1 };

export const agentRuntimeWorkspaceScopeMatches = (
  current: AgentRuntimeWorkspaceScope,
  workspacePath: string,
  generation: number,
) => current.workspacePath === workspacePath && current.generation === generation;

export type AttentionHydrationStatus = "loading" | "ready" | "partial";

export const attentionHydrationStatusFromSettlements = (
  settlements: readonly PromiseSettledResult<unknown>[],
  listenersAvailable = true,
): Exclude<AttentionHydrationStatus, "loading"> =>
  listenersAvailable && settlements.every((result) => result.status === "fulfilled")
    ? "ready"
    : "partial";

export type AgentRuntimeTaskScope = AgentRuntimeWorkspaceScope & {
  taskId: string;
};

type RunProjectionPublicationOptions = {
  operationScope?: AgentRuntimeTaskScope;
  force?: boolean;
};

export const runtimeAfterListenerAttachSuccess = (
  current: AgentRuntimeState,
  listenerOwnedError: AgentRuntimeState | null,
): AgentRuntimeState => current === listenerOwnedError
  ? { ...current, phase: "offline", error: null }
  : current;

export const listenerRecoveryPendingAfterConnect = (
  current: boolean,
  succeeded: boolean,
) => succeeded ? false : current;

export const runtimeForPublishedActiveRun = (
  current: AgentRuntimeState,
  activeRun: RunSnapshot,
  listenerRecoveryPending = false,
): AgentRuntimeState => {
  if (
    listenerRecoveryPending &&
    (current.phase === "error" || current.phase === "offline")
  ) return current;
  return {
    ...current,
    phase: "working",
    taskId: activeRun.taskId,
    threadId: activeRun.threadId,
    turnId: activeRun.turnId,
    turnStartedAt: activeRun.startedAt,
    error: null,
  };
};

export const resetPendingInputReplayForTaskRestore = (replayed: Set<string>) => {
  replayed.clear();
};

export const agentRuntimeTaskWorkspaceScopeMatches = (
  current: AgentRuntimeWorkspaceScope,
  scope: AgentRuntimeTaskScope,
) => agentRuntimeWorkspaceScopeMatches(current, scope.workspacePath, scope.generation);

export const agentRuntimeTaskScopeMatches = (
  current: AgentRuntimeWorkspaceScope,
  activeTaskId: string,
  scope: AgentRuntimeTaskScope,
) =>
  activeTaskId === scope.taskId &&
  agentRuntimeTaskWorkspaceScopeMatches(current, scope);

export const agentRuntimeApprovalRequestKey = (
  scope: AgentRuntimeTaskScope,
  pendingInputId: string,
) => [scope.workspacePath, scope.generation, scope.taskId, pendingInputId].join("\u0000");

export const handleAgentApprovalRequest = (
  taskId: string,
  approvalPolicy: AgentApprovalPolicy | undefined,
  approvalEntry: TimelineEntry,
  updateTimeline: (
    taskId: string,
    update: (current: TimelineEntry[]) => TimelineEntry[],
  ) => void,
  declineWithoutPrompt: (
    taskId: string,
    requestId: number | string,
    approvalKind: TimelineEntry["approvalKind"],
    entryId: string,
  ) => Promise<boolean>,
) => {
  updateTimeline(taskId, (current) =>
    current.some((entry) => entry.id === approvalEntry.id)
      ? current
      : [...current, approvalEntry],
  );
  if (
    approvalPolicy !== "never" ||
    approvalEntry.requestId == null ||
    !approvalEntry.pendingInputId
  ) return null;
  return declineWithoutPrompt(
    taskId,
    approvalEntry.requestId,
    approvalEntry.approvalKind,
    approvalEntry.id,
  );
};

export const agentQuestionRequestMatches = (
  current: AgentQuestionRequest | null,
  expected: Pick<
    AgentQuestionRequest,
    "pendingInputId" | "requestId" | "runId" | "taskId"
  >,
) =>
  current?.pendingInputId === expected.pendingInputId &&
  String(current.requestId) === String(expected.requestId) &&
  current.runId === expected.runId &&
  current.taskId === expected.taskId;

export const clearResolvedAgentQuestionRequest = (
  current: AgentQuestionRequest | null,
  resolved: Pick<
    AgentQuestionRequest,
    "pendingInputId" | "requestId" | "runId" | "taskId"
  >,
) => agentQuestionRequestMatches(current, resolved) ? null : current;

export const settleAutoTitleAfterUndo = (
  autoTitledTaskIds: Set<string>,
  taskId: string,
  resetTitle: boolean,
) => {
  if (resetTitle) autoTitledTaskIds.delete(taskId);
};

export const shouldClearAgentPlan = (outcome: AgentTurnOutcome) => outcome === "completed";

export const loadAllXiaoRunEvents = async (
  runId: string,
  loadPage: typeof nativeBridge.loadXiaoRunEvents = nativeBridge.loadXiaoRunEvents,
) => {
  const events: RunEventRecord[] = [];
  let afterSequence = -1;

  while (true) {
    const page = await loadPage(runId, afterSequence, RUN_EVENT_PAGE_SIZE);
    events.push(...page.events);
    if (page.events.length < RUN_EVENT_PAGE_SIZE) return events;
    if (page.nextSequence === null || page.nextSequence <= afterSequence) {
      throw new Error("Xiao run event pagination did not advance.");
    }
    afterSequence = page.nextSequence;
  }
};

const readMessageThreadId = (message: AgentMessage) => {
  const id = message.params?.threadId;
  return typeof id === "string" ? id : null;
};

const readItem = (message: AgentMessage) => {
  const item = message.params?.item;
  return item && typeof item === "object" ? (item as Record<string, unknown>) : null;
};

const readItemId = (message: AgentMessage) => {
  const id = message.params?.itemId;
  return typeof id === "string" ? id : null;
};

export const agentMessageRequiresWorkspaceRefresh = (message: AgentMessage) => {
  if (message.method === "turn/completed") return true;
  if (message.method === "item/fileChange/patchUpdated") {
    return Array.isArray(message.params?.changes) && message.params.changes.length > 0;
  }
  if (message.method !== "item/completed") return false;
  return readItem(message)?.type === "fileChange";
};

const readExplorationActions = (item: Record<string, unknown>) => {
  if (!Array.isArray(item.commandActions) || !item.commandActions.length) return null;
  const fallbackCommand = typeof item.command === "string" ? item.command : "";
  const actions: NonNullable<TimelineEntry["exploration"]> = [];

  for (const rawAction of item.commandActions) {
    if (!rawAction || typeof rawAction !== "object") return null;
    const action = rawAction as Record<string, unknown>;
    const command = typeof action.command === "string" ? action.command : fallbackCommand;
    const path = typeof action.path === "string" ? action.path : undefined;

    if (action.type === "read") {
      const name = typeof action.name === "string" ? action.name : undefined;
      actions.push({
        kind: "read",
        command,
        label: name || path?.split(/[\\/]/).filter(Boolean).at(-1) || "file",
        path,
      });
      continue;
    }
    if (action.type === "listFiles") {
      actions.push({ kind: "list", command, label: path || "workspace", path });
      continue;
    }
    if (action.type === "search") {
      const query = typeof action.query === "string" ? action.query : undefined;
      actions.push({ kind: "search", command, label: query || path || "workspace", path, query });
      continue;
    }

    // Mixed or unknown command actions stay visible as a normal command.
    return null;
  }

  return actions.length ? actions : null;
};

const readQuestionRequest = (
  message: AgentMessage,
  taskId: string,
  pendingInputId: string,
  runId: string,
): AgentQuestionRequest | null => {
  if (message.id == null || !Array.isArray(message.params?.questions)) return null;
  const questions = message.params.questions.flatMap((rawQuestion) => {
    if (!rawQuestion || typeof rawQuestion !== "object") return [];
    const question = rawQuestion as Record<string, unknown>;
    if (
      typeof question.id !== "string" ||
      typeof question.header !== "string" ||
      typeof question.question !== "string"
    ) {
      return [];
    }
    const options = Array.isArray(question.options)
      ? question.options.flatMap((rawOption) => {
          if (!rawOption || typeof rawOption !== "object") return [];
          const option = rawOption as Record<string, unknown>;
          return typeof option.label === "string" && typeof option.description === "string"
            ? [{ label: option.label, description: option.description }]
            : [];
        })
      : [];
    return [{
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      options,
    }];
  });
  if (!questions.length) return null;

  const autoResolutionMs = message.params.autoResolutionMs;
  return {
    requestId: message.id,
    pendingInputId,
    runId,
    taskId,
    threadId: typeof message.params.threadId === "string" ? message.params.threadId : "",
    turnId: typeof message.params.turnId === "string" ? message.params.turnId : "",
    itemId: typeof message.params.itemId === "string" ? message.params.itemId : "",
    questions,
    autoResolutionMs:
      typeof autoResolutionMs === "number" && autoResolutionMs >= 0 ? autoResolutionMs : null,
    receivedAt: Date.now(),
  };
};

const messageFromPendingInput = (pending: PendingInputSnapshot): AgentMessage => {
  let requestId: number | string = pending.requestId;
  try {
    const parsed = JSON.parse(pending.requestId) as unknown;
    if (typeof parsed === "number" || typeof parsed === "string") requestId = parsed;
  } catch {
    // Keep the canonical string when an older row is not JSON encoded.
  }
  const method = pending.kind === "command_approval"
    ? "item/commandExecution/requestApproval"
    : pending.kind === "file_approval"
      ? "item/fileChange/requestApproval"
      : pending.kind === "permissions"
        ? "item/permissions/requestApproval"
        : pending.kind === "question"
          ? "item/tool/requestUserInput"
          : "mcpServer/elicitation/request";
  const summary = pending.safeSummary && typeof pending.safeSummary === "object"
    ? pending.safeSummary as Record<string, unknown>
    : {};
  return {
    id: requestId,
    method,
    params: {
      ...summary,
      threadId: pending.threadId,
      turnId: pending.turnId,
      itemId: pending.itemId,
    },
  };
};

const messageFromRunEvent = (event: RunEventRecord): AgentMessage | null => {
  if (!event.safePayload || typeof event.safePayload !== "object") return null;
  if (event.eventType.startsWith("agent.")) return event.safePayload as AgentMessage;
  const protocol = (event.safePayload as Record<string, unknown>).protocol;
  return protocol && typeof protocol === "object" ? protocol as AgentMessage : null;
};

export const restoredRunProtocolEnvelope = (
  run: RunSnapshot,
  event: RunEventRecord,
): RunProtocolEnvelope | null => {
  const message = messageFromRunEvent(event);
  if (!message || run.runtimeGeneration == null || !run.threadId) return null;
  const safePayload = event.safePayload as Record<string, unknown>;
  const turnDiff = typeof safePayload.turnDiff === "string" ? safePayload.turnDiff : null;
  return {
    runId: run.id,
    taskId: run.taskId,
    executionEnvironmentId: run.executionEnvironmentId,
    runtimeGeneration: run.runtimeGeneration,
    threadId: run.threadId,
    turnId: run.turnId,
    itemId: null,
    sequence: event.sequence,
    message,
    turnDiff,
    pendingInput: null,
  };
};

const timelineStatusForRun = (status: RunStatus): NonNullable<TimelineEntry["status"]> => {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "error";
  if (status === "interrupted" || status === "needs_attention") return "warning";
  return "active";
};

export const projectTimelineRunStatus = (
  timeline: TimelineEntry[],
  settlement: {
    entryId?: string | null;
    runId?: string | null;
    turnId?: string | null;
    turnDiff?: string;
    status: NonNullable<TimelineEntry["status"]>;
    matchUnscopedActive?: boolean;
  },
): TimelineEntry[] => timeline.map((entry) => {
  const matches =
    (settlement.entryId != null && entry.id === settlement.entryId) ||
    (settlement.runId != null && entry.runId === settlement.runId) ||
    (settlement.turnId != null && entry.turnId === settlement.turnId) ||
    (settlement.matchUnscopedActive === true && entry.status === "active");
  if (!matches) return entry;

  const settled = entry.status === "active"
    ? { ...entry, status: settlement.status }
    : entry;
  if (settled.kind !== "user") return settled;
  return {
    ...settled,
    meta: "You",
    ...(settlement.turnId != null ? { turnId: settlement.turnId } : {}),
    ...(settlement.turnDiff !== undefined ? { turnDiff: settlement.turnDiff } : {}),
  };
});

export const projectTimelineRunSnapshot = (
  timeline: TimelineEntry[],
  run: Pick<RunSnapshot, "id" | "idempotencyKey" | "status" | "turnId">,
): TimelineEntry[] => run.status === "queued"
  ? timeline
  : projectTimelineRunStatus(timeline, {
      entryId: run.idempotencyKey,
      runId: run.id,
      turnId: run.turnId,
      status: timelineStatusForRun(run.status),
    });

const countDiffLines = (diff: string) => {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
};

type FileChangeKind = "add" | "delete" | "update" | null;

const textLines = (text: string) => {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized) return [];
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
};

export const normalizeFileChangeDiff = (diff: string, kind: FileChangeKind) => {
  if (kind !== "add" && kind !== "delete") {
    return { ...countDiffLines(diff), patch: diff };
  }

  const lines = textLines(diff);
  if (!lines.length) return { additions: 0, deletions: 0, patch: "" };
  if (kind === "add") {
    return {
      additions: lines.length,
      deletions: 0,
      patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`,
    };
  }
  return {
    additions: 0,
    deletions: lines.length,
    patch: `@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join("\n")}`,
  };
};

const fileChangeKind = (value: unknown): FileChangeKind => {
  if (!value || typeof value !== "object") return null;
  const type = (value as Record<string, unknown>).type;
  return type === "add" || type === "delete" || type === "update" ? type : null;
};

export const fileChangeTimelineEntry = (
  item: Record<string, unknown>,
): TimelineEntry | null => {
  if (item.type !== "fileChange" || !Array.isArray(item.changes)) return null;
  const files = item.changes.flatMap((change) => {
    if (!change || typeof change !== "object") return [];
    const value = change as Record<string, unknown>;
    if (typeof value.path !== "string") return [];
    const diff = typeof value.diff === "string" ? value.diff : "";
    const normalized = normalizeFileChangeDiff(diff, fileChangeKind(value.kind));
    return [{ path: value.path, ...normalized }];
  });
  if (!files.length) return null;

  const active = item.status === "inProgress";
  const failed = item.status === "failed" || item.status === "declined";
  const fileLabel = `${files.length} ${files.length === 1 ? "file" : "files"}`;
  return {
    id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
    kind: "change",
    createdAt: Date.now(),
    title: active
      ? `Editing ${fileLabel}`
      : failed
        ? `Could not update ${fileLabel}`
        : `Updated ${fileLabel}`,
    meta: active ? "Streaming workspace changes" : "Workspace changes",
    status: active ? "active" : failed ? "error" : "success",
    files,
  };
};

export const projectFileChangePatchUpdate = (
  timeline: TimelineEntry[],
  itemId: string,
  changes: unknown,
): TimelineEntry[] => {
  const entry = fileChangeTimelineEntry({
    type: "fileChange",
    id: itemId,
    status: "inProgress",
    changes,
  });
  if (!entry) return timeline;
  return timeline.some((currentEntry) => currentEntry.id === itemId)
    ? timeline.map((currentEntry) => currentEntry.id === itemId
      ? { ...entry, createdAt: currentEntry.createdAt ?? entry.createdAt }
      : currentEntry)
    : [...timeline, entry];
};

const readTokenUsage = (value: unknown): TokenUsageBreakdown | null => {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const fields: Array<keyof TokenUsageBreakdown> = [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ];
  if (!fields.every((field) => typeof usage[field] === "number" && usage[field] >= 0)) {
    return null;
  }
  return Object.fromEntries(fields.map((field) => [field, usage[field]])) as TokenUsageBreakdown;
};

const readRateLimitWindow = (value: unknown): AgentRateLimitWindow | null => {
  if (!value || typeof value !== "object") return null;
  const window = value as Record<string, unknown>;
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) {
    return null;
  }
  return {
    usedPercent: window.usedPercent,
    windowDurationMins:
      typeof window.windowDurationMins === "number" && Number.isFinite(window.windowDurationMins)
        ? window.windowDurationMins
        : null,
    resetsAt:
      typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
        ? window.resetsAt
        : null,
  };
};

const readRateLimitSnapshot = (value: unknown): AgentRateLimitSnapshot | null => {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Record<string, unknown>;
  const primary = readRateLimitWindow(snapshot.primary);
  const secondary = readRateLimitWindow(snapshot.secondary);
  if (!primary && !secondary) return null;
  return {
    limitId: typeof snapshot.limitId === "string" ? snapshot.limitId : null,
    limitName: typeof snapshot.limitName === "string" ? snapshot.limitName : null,
    primary,
    secondary,
  };
};

const mergeRateLimitWindow = (
  current: AgentRateLimitWindow | null,
  update: AgentRateLimitWindow | null,
) => {
  if (!update) return current;
  if (!current) return update;
  return {
    usedPercent: update.usedPercent,
    windowDurationMins: update.windowDurationMins ?? current.windowDurationMins,
    resetsAt: update.resetsAt ?? current.resetsAt,
  };
};

export const mergeAgentRateLimits = (
  current: AgentRateLimitSnapshot | null,
  update: AgentRateLimitSnapshot,
): AgentRateLimitSnapshot => ({
  limitId: update.limitId ?? current?.limitId ?? null,
  limitName: update.limitName ?? current?.limitName ?? null,
  primary: mergeRateLimitWindow(current?.primary ?? null, update.primary),
  secondary: mergeRateLimitWindow(current?.secondary ?? null, update.secondary),
});

export const reconcileFetchedAgentRateLimits = (
  current: AgentRateLimitSnapshot | null,
  fetched: AgentRateLimitSnapshot,
) => current ? mergeAgentRateLimits(current, fetched) : fetched;

export const accountRateLimitsRefreshIntervalMs = 30_000;

export const projectAgentRateLimitsUpdate = (
  current: AgentRateLimitSnapshot | null,
  message: AgentMessage,
) => {
  if (message.method !== "account/rateLimits/updated") return current;
  const update = readRateLimitSnapshot(message.params?.rateLimits);
  if (!update) return current;
  if (update.limitId && update.limitId !== "codex") return current;
  if (current?.limitId && update.limitId && current.limitId !== update.limitId) {
    return current;
  }
  return mergeAgentRateLimits(current, update);
};

const imageMimeFromUrl = (url: string) =>
  /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?,/i.exec(url)?.[1]?.toLowerCase();

const toolImageAttachment = (
  itemId: string,
  index: number,
  imageUrl: string,
  mime?: string,
): AgentAttachment | null => {
  const url = imageUrl.trim();
  const imageMime = imageMimeFromUrl(url) ?? (
    mime?.toLowerCase().startsWith("image/") ? mime.toLowerCase() : undefined
  );
  if (!imageMime && !/^https?:\/\//i.test(url)) return null;
  return {
    id: `${itemId}-image-${index + 1}`,
    name: `Image output ${index + 1}`,
    path: `tool-output:${itemId}:image:${index + 1}`,
    kind: "image",
    url,
    mime: imageMime,
  };
};

const dynamicToolOutput = (
  itemId: string,
  contentItems: unknown,
): Pick<TimelineEntry, "attachments" | "body"> => {
  if (!Array.isArray(contentItems)) return {};
  const text: string[] = [];
  const attachments: AgentAttachment[] = [];
  for (const content of contentItems) {
    if (!content || typeof content !== "object") continue;
    const value = content as Record<string, unknown>;
    if (value.type === "inputText" && typeof value.text === "string") {
      text.push(value.text);
      continue;
    }
    if (value.type === "inputImage" && typeof value.imageUrl === "string") {
      const attachment = toolImageAttachment(itemId, attachments.length, value.imageUrl);
      if (attachment) attachments.push(attachment);
    }
  }
  const body = text.join("\n\n").slice(0, 8_000);
  return {
    body: body || undefined,
    attachments: attachments.length ? attachments : undefined,
  };
};

const mcpToolOutput = (
  itemId: string,
  result: unknown,
): Pick<TimelineEntry, "attachments" | "body"> => {
  if (!result || typeof result !== "object") {
    return {
      body: result == null ? undefined : JSON.stringify(result, null, 2).slice(0, 8_000),
    };
  }
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return { body: JSON.stringify(result, null, 2).slice(0, 8_000) };
  }
  const text: string[] = [];
  const attachments: AgentAttachment[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const value = part as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      text.push(value.text);
      continue;
    }
    if (
      value.type === "image" &&
      typeof value.data === "string" &&
      typeof value.mimeType === "string" &&
      value.mimeType.toLowerCase().startsWith("image/")
    ) {
      const imageUrl = imageMimeFromUrl(value.data)
        ? value.data
        : `data:${value.mimeType.toLowerCase()};base64,${value.data}`;
      const attachment = toolImageAttachment(
        itemId,
        attachments.length,
        imageUrl,
        value.mimeType,
      );
      if (attachment) attachments.push(attachment);
    }
  }
  const body = text.join("\n\n").slice(0, 8_000);
  return {
    body: body || (attachments.length ? undefined : JSON.stringify(result, null, 2).slice(0, 8_000)),
    attachments: attachments.length ? attachments : undefined,
  };
};

export const timelineEntryFromItem = (item: Record<string, unknown>): TimelineEntry | null => {
  const contextCompaction = contextCompactionTimelineEntry(item, "completed");
  if (contextCompaction) return contextCompaction;
  const collaboration = collaborationTimelineEntry(item);
  if (collaboration) return collaboration;
  const fileChange = fileChangeTimelineEntry(item);
  if (fileChange) return fileChange;

  const id = typeof item.id === "string" ? item.id : crypto.randomUUID();
  const createdAt = Date.now();

  if (item.type === "agentMessage" && typeof item.text === "string") {
    return {
      id,
      kind: "result",
      title: "Agent response",
      createdAt,
      body: item.text,
      meta: "Xiao",
      status: "success",
    };
  }

  if (item.type === "plan" && typeof item.text === "string") {
    return {
      id,
      kind: "thought",
      title: "Plan",
      createdAt,
      body: item.text,
      meta: "Plan",
      status: "success",
    };
  }

  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.filter((part): part is string => typeof part === "string").join("\n\n")
      : "";
    const content = Array.isArray(item.content)
      ? item.content.filter((part): part is string => typeof part === "string").join("\n\n")
      : "";
    return {
      id,
      kind: "thought",
      title: "Reasoning complete",
      createdAt,
      body: summary || content || undefined,
      meta: "Xiao",
      status: "success",
    };
  }

  if (item.type === "commandExecution") {
    const commandStatus = typeof item.status === "string" ? item.status : "inProgress";
    const command = typeof item.command === "string" ? item.command : "Running command";
    const payload = /(?:^|\s)(?:-Command|\/c)\s+(?:"|')?(.+)$/i.exec(command)?.[1] ?? command;
    const commandTool = payload
      .match(/^\s*(?:&\s*)?["']?([^\s"';&|]+)/)?.[1]
      ?.split(/[\\/]/)
      .at(-1)
      ?.replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
      .toLowerCase();
    const rawFailed = commandStatus === "failed" || commandStatus === "declined";
    const noSearchMatches =
      rawFailed &&
      item.exitCode === 1 &&
      (commandTool === "rg" || commandTool === "ripgrep");
    const failed = rawFailed && !noSearchMatches;
    const exploration = readExplorationActions(item);
    if (exploration) {
      return {
        id,
        kind: "explore",
        createdAt,
        title:
          commandStatus === "inProgress"
            ? "Exploring workspace"
            : noSearchMatches
              ? "No workspace matches"
              : failed
                ? "Exploration failed"
                : "Explored workspace",
        command: typeof item.command === "string" ? item.command : undefined,
        body: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined,
        meta: typeof item.cwd === "string" ? item.cwd : "Workspace",
        status: commandStatus === "inProgress" ? "active" : failed ? "error" : "success",
        exploration,
      };
    }
    return {
      id,
      kind: "command",
      createdAt,
      title:
        commandStatus === "inProgress"
          ? "Xiao is running a command"
          : noSearchMatches
            ? "Search found no matches"
          : failed
            ? "Command did not complete"
            : "Command completed",
      command,
      body: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined,
      meta: typeof item.cwd === "string" ? item.cwd : "Workspace",
      status: commandStatus === "inProgress" ? "active" : failed ? "error" : "success",
    };
  }

  if (item.type === "mcpToolCall") {
    const server = typeof item.server === "string" ? item.server : "MCP";
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    const failed = item.status === "failed";
    const output = mcpToolOutput(id, item.result);
    const error =
      typeof item.error === "string"
        ? item.error
        : item.error &&
            typeof item.error === "object" &&
            typeof (item.error as Record<string, unknown>).message === "string"
          ? String((item.error as Record<string, unknown>).message)
          : null;
    return {
      id,
      kind: "command",
      createdAt,
      title: `${server} · ${tool}`,
      body: error ?? output.body,
      attachments: error ? undefined : output.attachments,
      meta: "Plugin tool",
      status: failed ? "error" : item.status === "inProgress" ? "active" : "success",
    };
  }

  if (item.type === "dynamicToolCall") {
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    const namespace = typeof item.namespace === "string" && item.namespace.trim()
      ? item.namespace.trim()
      : null;
    const output = dynamicToolOutput(id, item.contentItems);
    const failed = item.status === "failed" || item.success === false;
    const duration = typeof item.durationMs === "number" ? `${Math.round(item.durationMs)} ms` : null;
    return {
      id,
      kind: "command",
      createdAt,
      title: namespace ? `${namespace} · ${tool}` : tool,
      body: output.body,
      attachments: output.attachments,
      meta: ["Dynamic tool", duration].filter(Boolean).join(" · "),
      status: failed ? "error" : item.status === "inProgress" ? "active" : "success",
    };
  }

  if (item.type === "webSearch") {
    return {
      id,
      kind: "result",
      createdAt,
      title: typeof item.query === "string" ? `Searched: ${item.query}` : "Web search",
      meta: "Browser tool",
      status: "success",
    };
  }

  return null;
};

const historyFromTimeline = (timeline: TimelineEntry[]): XiaoHistoryItem[] =>
  timeline.flatMap<XiaoHistoryItem>((entry) => {
    if (entry.kind === "user" && entry.title.trim()) {
      const reviews = entry.attachments?.filter((attachment) => attachment.kind === "review") ?? [];
      return [{
        role: "user" as const,
        text: [entry.title, ...reviews.map(reviewContextText)].filter(Boolean).join("\n\n"),
      }];
    }
    if (entry.kind === "result" && entry.body?.trim()) {
      return [{ role: "assistant" as const, text: entry.body }];
    }
    return [];
  });

export const titleFromPrompt = (prompt: string) => {
  const singleLine = visiblePromptFromSelectedContext(prompt).replace(/\s+/g, " ").trim();
  if (singleLine.length <= 56) return singleLine;
  const shortened = singleLine.slice(0, 56).replace(/\s+\S*$/, "").trimEnd();
  return `${shortened || singleLine.slice(0, 56)}…`;
};

export function useAgentRuntime(
  workspacePath: string,
  workspaceEnvironmentId: string,
  activeTaskId: string,
  executionTaskId: string | null,
  activeTaskTitle: string,
  activeTaskTimeline: TimelineEntry[],
  activeTaskTimelineComplete: boolean,
  activeTaskModel: string | null,
  fastMode: boolean,
  activeTaskApprovalPolicy: AgentApprovalPolicy,
  onTimelineChange: (taskId: string, timeline: TimelineEntry[]) => void,
  onPlanChange: (taskId: string, plan: AgentPlan | null) => void,
  onTaskTitleChange: (taskId: string, title: string) => void,
  onTaskGoalChange: (taskId: string, goal: AgentGoal | null) => void,
  onTaskFinished: (taskId: string, outcome: AgentTurnOutcome) => void,
  onWorkspaceChange: () => void,
  autoConnect = true,
) {
  const [runtime, setRuntime] = useState<AgentRuntimeState>(initialRuntime);
  const [account, setAccount] = useState<AgentAccountSummary | null>(null);
  const [accountUsage, setAccountUsage] = useState<AgentAccountUsage | null>(null);
  const [rateLimits, setRateLimits] = useState<AgentRateLimitSnapshot | null>(null);
  const [models, setModels] = useState<AgentModelSummary[]>([]);
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeLogEntry[]>([]);
  const [threadUsage, setThreadUsage] = useState<Record<string, ThreadTokenUsage>>({});
  const [questionRequest, setQuestionRequest] = useState<AgentQuestionRequest | null>(null);
  const [mcpElicitationRequests, setMcpElicitationRequests] =
    useState<AgentMcpElicitationRequest[]>([]);
  const [compactingTaskId, setCompactingTaskId] = useState<string | null>(null);
  const [undoingScope, setUndoingScope] = useState<AgentRuntimeTaskScope | null>(null);
  const [listenersReady, setListenersReady] = useState(!isTauriHost());
  const [listenerRetryRevision, setListenerRetryRevision] = useState(0);
  const [attentionHydrationRevision, setAttentionHydrationRevision] = useState(0);
  const [runProjection, setRunProjection] = useState<RunProjection>(emptyRunProjection);
  const [attentionHydrationStatus, setAttentionHydrationStatus] =
    useState<AttentionHydrationStatus>(() => isTauriHost() ? "loading" : "ready");
  const [stateWorkspacePath, setStateWorkspacePath] = useState(workspacePath);
  const { usage, recordUsage } = useCodexUsage();
  const activeTaskIdRef = useRef(activeTaskId);
  const executionTaskIdRef = useRef(executionTaskId);
  const activeTimelineReadyRef = useRef(activeTaskTimelineComplete);
  const questionRequestRef = useRef<AgentQuestionRequest | null>(null);
  const mcpElicitationRequestsRef = useRef<AgentMcpElicitationRequest[]>([]);
  const runProjectionRef = useRef<RunProjection>(emptyRunProjection());
  const workspaceListedRunIds = useRef(new Set<string>());
  const expectedEnvironmentIdRef = useRef(workspaceEnvironmentId);
  const activeEnvironmentIdRef = useRef<string | null>(null);
  const activeGenerationRef = useRef<number | null>(null);
  const rateLimitsRefreshRevision = useRef(0);
  const finishedRunIds = useRef(new Set<string>());
  const replayedPendingInputs = useRef(new Set<string>());
  const sessionIds = useRef(new Map<string, string>());
  const syncedGoals = useRef(new Map<string, string>());
  const threadTasks = useRef(new Map<string, string>());
  const liveAgentEntries = useRef(new Map<string, string>());
  const activeThinkingEntries = useRef(new Map<string, string>());
  const reasoningEntries = useRef(new Map<string, string>());
  const reasoningChannels = useRef(new Map<string, "summary" | "content">());
  const autoTitledTasks = useRef(new Set<string>());
  const activeTurnIds = useRef(new Map<string, string>());
  const activeTurnDiffs = useRef(new Map<string, string>());
  const pendingUserEntries = useRef(new Map<string, string>());
  const taskApprovalPolicies = useRef(new Map<string, AgentApprovalPolicy>());
  const autoResolvingRequests = useRef(new Set<string>());
  const reconnectAttempt = useRef(0);
  const runtimeStopError = useRef<string | null>(null);
  const listenerRecoveryPendingRef = useRef(false);
  const listenerRegistrationErrorRef = useRef<AgentRuntimeState | null>(null);
  const compactingTasks = useRef(new Set<string>());
  const undoingScopeRef = useRef<AgentRuntimeTaskScope | null>(null);
  const timelineCache = useRef(new Map<string, TimelineEntry[]>());
  const liveDeltaBatches = useRef(new Map<string, LiveDeltaBatch>());
  const liveDeltaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const planCache = useRef(new Map<string, AgentPlan>());
  const onTimelineChangeRef = useRef(onTimelineChange);
  const onPlanChangeRef = useRef(onPlanChange);
  const onTaskTitleChangeRef = useRef(onTaskTitleChange);
  const onTaskGoalChangeRef = useRef(onTaskGoalChange);
  const onTaskFinishedRef = useRef(onTaskFinished);
  const onWorkspaceChangeRef = useRef(onWorkspaceChange);
  const workspaceScopeRef = useRef<AgentRuntimeWorkspaceScope>({
    workspacePath,
    generation: 0,
  });
  const updateMcpElicitationRequests = useCallback((
    update: (current: AgentMcpElicitationRequest[]) => AgentMcpElicitationRequest[],
  ) => {
    const current = mcpElicitationRequestsRef.current;
    const next = update(current);
    if (next === current) return;
    mcpElicitationRequestsRef.current = next;
    setMcpElicitationRequests(next);
  }, []);
  const previousWorkspaceScope = workspaceScopeRef.current;
  const nextWorkspaceScope = advanceAgentRuntimeWorkspaceScope(
    previousWorkspaceScope,
    workspacePath,
  );
  const workspaceChanged = nextWorkspaceScope !== previousWorkspaceScope;
  workspaceScopeRef.current = nextWorkspaceScope;
  expectedEnvironmentIdRef.current = workspaceEnvironmentId;
  activeTaskIdRef.current = activeTaskId;
  executionTaskIdRef.current = executionTaskId;

  if (workspaceChanged) {
    activeTaskIdRef.current = activeTaskId;
    executionTaskIdRef.current = executionTaskId;
    activeTimelineReadyRef.current = activeTaskTimelineComplete;
    questionRequestRef.current = null;
    mcpElicitationRequestsRef.current = [];
    runProjectionRef.current = emptyRunProjection();
    workspaceListedRunIds.current.clear();
    expectedEnvironmentIdRef.current = workspaceEnvironmentId;
    activeEnvironmentIdRef.current = null;
    activeGenerationRef.current = null;
    finishedRunIds.current.clear();
    replayedPendingInputs.current.clear();
    sessionIds.current.clear();
    syncedGoals.current.clear();
    threadTasks.current.clear();
    liveAgentEntries.current.clear();
    activeThinkingEntries.current.clear();
    reasoningEntries.current.clear();
    reasoningChannels.current.clear();
    autoTitledTasks.current.clear();
    activeTurnIds.current.clear();
    activeTurnDiffs.current.clear();
    pendingUserEntries.current.clear();
    taskApprovalPolicies.current.clear();
    autoResolvingRequests.current.clear();
    compactingTasks.current.clear();
    timelineCache.current.clear();
    if (liveDeltaTimer.current) clearTimeout(liveDeltaTimer.current);
    liveDeltaTimer.current = null;
    if (workspaceRefreshTimer.current) clearTimeout(workspaceRefreshTimer.current);
    workspaceRefreshTimer.current = null;
    liveDeltaBatches.current.clear();
    timelineCache.current.set(activeTaskId, activeTaskTimeline);
    taskApprovalPolicies.current.set(activeTaskId, activeTaskApprovalPolicy);
    reconnectAttempt.current = 0;
    runtimeStopError.current = null;
    listenerRecoveryPendingRef.current = false;
    listenerRegistrationErrorRef.current = null;
    undoingScopeRef.current = null;
  }

  useLayoutEffect(() => {
    if (stateWorkspacePath === workspacePath) return;
    setStateWorkspacePath(workspacePath);
    setRuntime(initialRuntime);
    setAccount(null);
    setAccountUsage(null);
    setRateLimits(null);
    setModels([]);
    setRuntimeLogs([]);
    setThreadUsage({});
    setQuestionRequest(null);
    setMcpElicitationRequests([]);
    setCompactingTaskId(null);
    setUndoingScope(null);
    setListenersReady(!isTauriHost());
    setRunProjection(emptyRunProjection());
    setAttentionHydrationStatus(isTauriHost() ? "loading" : "ready");
  }, [stateWorkspacePath, workspacePath]);

  useEffect(() => {
    onTimelineChangeRef.current = onTimelineChange;
  }, [onTimelineChange]);

  useEffect(() => {
    questionRequestRef.current = questionRequest;
  }, [questionRequest]);

  useEffect(() => {
    onPlanChangeRef.current = onPlanChange;
  }, [onPlanChange]);

  useEffect(() => {
    onTaskTitleChangeRef.current = onTaskTitleChange;
  }, [onTaskTitleChange]);

  useEffect(() => {
    onTaskGoalChangeRef.current = onTaskGoalChange;
  }, [onTaskGoalChange]);

  useLayoutEffect(() => {
    onTaskFinishedRef.current = onTaskFinished;
  }, [onTaskFinished]);

  useEffect(() => {
    onWorkspaceChangeRef.current = onWorkspaceChange;
  }, [onWorkspaceChange]);

  const scheduleWorkspaceRefresh = useCallback(() => {
    if (workspaceRefreshTimer.current) clearTimeout(workspaceRefreshTimer.current);
    const scope = workspaceScopeRef.current;
    workspaceRefreshTimer.current = setTimeout(() => {
      workspaceRefreshTimer.current = null;
      if (workspaceScopeRef.current !== scope) return;
      onWorkspaceChangeRef.current();
    }, WORKSPACE_REFRESH_DEBOUNCE_MS);
  }, []);

  const appendRuntimeLog = useCallback(
    (stream: RuntimeLogEntry["stream"], text: string) => {
      const cleanText = text.trimEnd();
      if (!cleanText) return;
      const entry: RuntimeLogEntry = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        stream,
        text: cleanText.slice(0, 8_000),
      };
      setRuntimeLogs((current) => [...current, entry].slice(-MAX_RUNTIME_LOGS));
    },
    [],
  );

  useEffect(() => {
    activeTaskIdRef.current = activeTaskId;
    activeTimelineReadyRef.current = activeTaskTimelineComplete;
    timelineCache.current.set(activeTaskId, activeTaskTimeline);
    taskApprovalPolicies.current.set(activeTaskId, activeTaskApprovalPolicy);
    setQuestionRequest((current) => current?.taskId === activeTaskId ? current : null);
    updateMcpElicitationRequests((current) => {
      const next = current.filter((request) => request.taskId === activeTaskId);
      return next.length === current.length ? current : next;
    });
    setRuntime((current) => ({
      ...current,
      threadId:
        current.phase === "working"
          ? current.threadId
          : sessionIds.current.get(activeTaskId) ?? null,
    }));
  }, [
    activeTaskApprovalPolicy,
    activeTaskId,
    activeTaskTimeline,
    activeTaskTimelineComplete,
    updateMcpElicitationRequests,
  ]);

  const updateTimeline = useCallback(
    (taskId: string, update: (current: TimelineEntry[]) => TimelineEntry[]) => {
      const current = timelineCache.current.get(taskId) ?? [];
      let next = update(current);
      const turnId = activeTurnIds.current.get(taskId);
      if (turnId) {
        const existingIds = new Set(current.map((entry) => entry.id));
        next = next.map((entry) =>
          existingIds.has(entry.id) || entry.turnId ? entry : { ...entry, turnId },
        );
      }
      timelineCache.current.set(taskId, next);
      onTimelineChangeRef.current(taskId, next);
    },
    [],
  );

  const settleThinking = useCallback(
    (taskId: string) => {
      const entryId = activeThinkingEntries.current.get(taskId);
      if (!entryId) return;
      activeThinkingEntries.current.delete(taskId);
      updateTimeline(taskId, (current) =>
        current.flatMap((entry) => {
          if (entry.id !== entryId) return [entry];
          if (!entry.body?.trim()) return [];
          return [{ ...entry, title: "Reasoning complete", meta: "Xiao", status: "success" }];
        }),
      );
    },
    [updateTimeline],
  );

  const flushLiveDeltas = useCallback(() => {
    if (liveDeltaTimer.current) clearTimeout(liveDeltaTimer.current);
    liveDeltaTimer.current = null;
    if (!liveDeltaBatches.current.size) return;

    const batches = [...liveDeltaBatches.current.entries()];
    liveDeltaBatches.current.clear();
    let eventCount = 0;
    const logs: RuntimeLogEntry[] = [];

    for (const [taskId, batch] of batches) {
      eventCount += batch.eventCount;
      if (batch.deltas.length) {
        updateTimeline(taskId, (current) => applyLiveTimelineDeltas(current, batch.deltas));
      }
      for (const [method, count] of batch.methodCounts) {
        logs.push({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          stream: "event",
          text: count > 1 ? `${method} x${count}` : method,
        });
      }
      if (batch.stdout.trimEnd()) {
        logs.push({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          stream: "stdout",
          text: batch.stdout.trimEnd().slice(-8_000),
        });
      }
    }

    setRuntime((current) => ({ ...current, eventsSeen: current.eventsSeen + eventCount }));
    if (logs.length) {
      setRuntimeLogs((current) => [...current, ...logs].slice(-MAX_RUNTIME_LOGS));
    }
  }, [updateTimeline]);

  const queueLiveDelta = useCallback((taskId: string, message: AgentMessage) => {
    const method = message.method;
    const delta = message.params?.delta;
    if (
      typeof delta !== "string" ||
      ![
        "item/agentMessage/delta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/textDelta",
        "item/commandExecution/outputDelta",
      ].includes(method ?? "")
    ) return false;

    let batch = liveDeltaBatches.current.get(taskId);
    if (!batch) {
      batch = { deltas: [], eventCount: 0, methodCounts: new Map(), stdout: "" };
      liveDeltaBatches.current.set(taskId, batch);
    }
    batch.eventCount += 1;
    batch.methodCounts.set(method!, (batch.methodCounts.get(method!) ?? 0) + 1);

    if (method === "item/agentMessage/delta") {
      let entryId = liveAgentEntries.current.get(taskId);
      if (!entryId) {
        const itemId = message.params?.itemId;
        entryId = typeof itemId === "string" ? itemId : crypto.randomUUID();
        liveAgentEntries.current.set(taskId, entryId);
      }
      const settleThinkingEntryId = activeThinkingEntries.current.get(taskId);
      if (settleThinkingEntryId) activeThinkingEntries.current.delete(taskId);
      appendLiveTimelineDelta(batch.deltas, {
        kind: "assistant",
        entryId,
        delta,
        settleThinkingEntryId,
      });
    } else if (
      method === "item/reasoning/summaryTextDelta" ||
      method === "item/reasoning/textDelta"
    ) {
      const itemId = readItemId(message);
      const channel = method === "item/reasoning/summaryTextDelta" ? "summary" : "content";
      const previousChannel = itemId ? reasoningChannels.current.get(itemId) : undefined;
      if (previousChannel === "summary" && channel === "content") {
        if (!liveDeltaTimer.current) {
          liveDeltaTimer.current = setTimeout(flushLiveDeltas, LIVE_DELTA_FLUSH_MS);
        }
        return true;
      }
      const replace = previousChannel === "content" && channel === "summary";
      if (itemId) reasoningChannels.current.set(itemId, channel);
      let entryId = itemId ? reasoningEntries.current.get(itemId) : undefined;
      if (!entryId) {
        entryId = itemId ?? activeThinkingEntries.current.get(taskId) ?? crypto.randomUUID();
        activeThinkingEntries.current.set(taskId, entryId);
        if (itemId) reasoningEntries.current.set(itemId, entryId);
      }
      appendLiveTimelineDelta(batch.deltas, {
        kind: "reasoning",
        entryId,
        delta,
        replace,
      });
    } else {
      const itemId = readItemId(message);
      if (itemId) {
        appendLiveTimelineDelta(batch.deltas, {
          kind: "command-output",
          entryId: itemId,
          delta,
        });
      }
      batch.stdout = `${batch.stdout}${delta}`.slice(-8_000);
    }

    if (!liveDeltaTimer.current) {
      liveDeltaTimer.current = setTimeout(flushLiveDeltas, LIVE_DELTA_FLUSH_MS);
    }
    return true;
  }, [flushLiveDeltas]);

  const declineWithoutPrompt = useCallback(
    async (
      taskId: string,
      requestId: number | string,
      approvalKind: TimelineEntry["approvalKind"] = "action",
      entryId?: string,
    ) => {
      const scope: AgentRuntimeTaskScope = {
        workspacePath,
        generation: workspaceScopeRef.current.generation,
        taskId,
      };
      if (!agentRuntimeTaskWorkspaceScopeMatches(workspaceScopeRef.current, scope)) return false;
      const approval = (timelineCache.current.get(taskId) ?? []).find((entry) =>
        entryId ? entry.id === entryId : String(entry.requestId) === String(requestId)
      );
      const pendingInputId = approval?.pendingInputId;
      const requestKey = pendingInputId
        ? agentRuntimeApprovalRequestKey(scope, pendingInputId)
        : null;
      if (requestKey && autoResolvingRequests.current.has(requestKey)) return true;
      if (requestKey) autoResolvingRequests.current.add(requestKey);
      if (entryId) {
        updateTimeline(taskId, (current) => current.map((entry) =>
          entry.id === entryId
            ? { ...entry, status: "active", meta: "Declining under Never ask" }
            : entry,
        ));
      }
      try {
        if (
          !pendingInputId ||
          approval?.requestId == null ||
          String(approval.requestId) !== String(requestId)
        ) {
          throw new Error("The native approval request is no longer active.");
        }
        await nativeBridge.resolveXiaoRunInput(
          pendingInputId,
          approvalResponse(approvalKind, undefined, "decline"),
        );
        if (!agentRuntimeTaskWorkspaceScopeMatches(workspaceScopeRef.current, scope)) return false;
        if (entryId) {
          updateTimeline(taskId, (current) => current.map((entry) =>
            entry.id === entryId
              ? { ...entry, status: "success", meta: "Declined by Never ask" }
              : entry,
          ));
        }
        if (agentRuntimeTaskScopeMatches(
          workspaceScopeRef.current,
          activeTaskIdRef.current,
          scope,
        )) {
          setRuntime((current) => ({ ...current, error: null }));
        }
        return true;
      } catch (reason) {
        if (!agentRuntimeTaskWorkspaceScopeMatches(workspaceScopeRef.current, scope)) return false;
        const message = reason instanceof Error ? reason.message : String(reason);
        const inactive = isInactiveApprovalResolutionError(reason);
        if (entryId) {
          updateTimeline(taskId, (current) => current.map((entry) =>
            entry.id === entryId
              ? inactive
                ? { ...entry, status: "success", meta: "Request no longer active" }
                : { ...entry, status: "warning", meta: "Automatic decline failed - decide manually" }
              : entry,
          ));
        }
        if (inactive) {
          if (agentRuntimeTaskScopeMatches(
            workspaceScopeRef.current,
            activeTaskIdRef.current,
            scope,
          )) {
            setRuntime((current) => ({ ...current, error: null }));
          }
          return true;
        }
        if (agentRuntimeTaskScopeMatches(
          workspaceScopeRef.current,
          activeTaskIdRef.current,
          scope,
        )) {
          setRuntime((current) => ({ ...current, error: message }));
        }
        return false;
      } finally {
        if (requestKey) autoResolvingRequests.current.delete(requestKey);
      }
    },
    [updateTimeline, workspacePath],
  );

  const refreshAccountUsage = useCallback(async () => {
    const scope = workspaceScopeRef.current;
    try {
      const nextUsage = await nativeBridge.readAgentUsage(
        workspacePath,
        executionTaskIdRef.current,
      );
      if (!agentRuntimeWorkspaceScopeMatches(
        workspaceScopeRef.current,
        workspacePath,
        scope.generation,
      )) return;
      setAccountUsage(nextUsage);
    } catch {
      if (agentRuntimeWorkspaceScopeMatches(
        workspaceScopeRef.current,
        workspacePath,
        scope.generation,
      )) {
        setAccountUsage(null);
      }
    }
  }, [workspacePath]);

  const refreshAccountRateLimits = useCallback(async () => {
    const scope = workspaceScopeRef.current;
    const revision = ++rateLimitsRefreshRevision.current;
    try {
      const response = await nativeBridge.readAgentRateLimits(
        workspacePath,
        executionTaskIdRef.current,
      );
      if (!agentRuntimeWorkspaceScopeMatches(
        workspaceScopeRef.current,
        workspacePath,
        scope.generation,
      ) || revision !== rateLimitsRefreshRevision.current) return;
      const snapshot = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
      setRateLimits((current) => reconcileFetchedAgentRateLimits(current, snapshot));
    } catch {
      if (agentRuntimeWorkspaceScopeMatches(
        workspaceScopeRef.current,
        workspacePath,
        scope.generation,
      ) && revision === rateLimitsRefreshRevision.current) {
        setRateLimits(null);
      }
    }
  }, [workspacePath]);

  useEffect(() => {
    if (!isTauriHost()) return;
    const timer = window.setInterval(() => {
      void refreshAccountRateLimits();
    }, accountRateLimitsRefreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [refreshAccountRateLimits]);

  const refreshRuntimeIdentity = useCallback(async () => {
    const scope = workspaceScopeRef.current;
    try {
      const [nextAccount, nextModels] = await Promise.all([
        nativeBridge.readAgentAccount(workspacePath, executionTaskIdRef.current),
        nativeBridge.listAgentModels(workspacePath, executionTaskIdRef.current),
      ]);
      if (!agentRuntimeWorkspaceScopeMatches(
        workspaceScopeRef.current,
        workspacePath,
        scope.generation,
      )) return;
      setAccount(nextAccount);
      setModels(nextModels);
      void refreshAccountUsage();
      void refreshAccountRateLimits();
      setRuntime((current) => ({
        ...current,
        error:
          !nextAccount.authenticated && nextAccount.requiresOpenaiAuth
            ? "Sign in with Codex CLI, then reconnect Xiao."
            : null,
      }));
    } catch (reason) {
      if (!agentRuntimeWorkspaceScopeMatches(
        workspaceScopeRef.current,
        workspacePath,
        scope.generation,
      )) return;
      setRuntime((current) => ({
        ...current,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
    }
  }, [refreshAccountRateLimits, refreshAccountUsage, workspacePath]);

  const resolveTaskId = useCallback((message: AgentMessage) => {
    const threadId = readMessageThreadId(message);
    if (threadId) {
      const taskId = threadTasks.current.get(threadId);
      if (taskId) return taskId;
    }
    return activeTaskIdRef.current;
  }, []);

  const handleMessage = useCallback(
    async (
      message: AgentMessage,
      route?: {
        taskId: string;
        runId: string;
        pendingInput: PendingInputSnapshot | null;
        turnDiff?: string | null;
        replayed?: boolean;
      },
    ) => {
      const taskId = route?.taskId ?? resolveTaskId(message);
      if (!route?.replayed && agentMessageRequiresWorkspaceRefresh(message)) {
        scheduleWorkspaceRefresh();
      }
      if (queueLiveDelta(taskId, message)) return;
      flushLiveDeltas();
      setRuntime((current) => ({ ...current, eventsSeen: current.eventsSeen + 1 }));

      const outputDelta =
        message.method === "item/commandExecution/outputDelta" &&
        typeof message.params?.delta === "string"
          ? message.params.delta
          : null;
      if (outputDelta) appendRuntimeLog("stdout", outputDelta);
      else if (message.method) appendRuntimeLog("event", message.method);
      else if (message.id != null) {
        appendRuntimeLog(message.error ? "stderr" : "event", `response ${String(message.id)}`);
      }

      if (message.method === "serverRequest/resolved") {
        const requestId = message.params?.requestId;
        if (
          (typeof requestId !== "number" && typeof requestId !== "string") ||
          !route
        ) return;
        const pendingInput = [
          ...(route.pendingInput ? [route.pendingInput] : []),
          ...Object.values(runProjectionRef.current.pendingInputsById),
        ].find((pending) =>
          pending.runId === route.runId &&
          String(messageFromPendingInput(pending).id) === String(requestId)
        );
        const resolvedMcpRequest = mcpElicitationRequestsRef.current.find((request) =>
          request.runId === route.runId &&
          request.taskId === route.taskId &&
          String(request.requestId) === String(requestId)
        );
        if (resolvedMcpRequest) {
          updateMcpElicitationRequests((current) =>
            removeAgentMcpElicitationRequest(current, resolvedMcpRequest)
          );
        }
        if (!pendingInput) return;
        if (pendingInput.kind === "mcp_elicitation") {
          return;
        }
        if (pendingInput.kind !== "question") {
          updateTimeline(route.taskId, (current) =>
            settleResolvedApprovalEntry(current, pendingInput.id)
          );
          return;
        }
        const resolvedRequest = {
          requestId,
          pendingInputId: pendingInput.id,
          runId: route.runId,
          taskId: route.taskId,
        };
        questionRequestRef.current = clearResolvedAgentQuestionRequest(
          questionRequestRef.current,
          resolvedRequest,
        );
        setQuestionRequest((current) =>
          clearResolvedAgentQuestionRequest(current, resolvedRequest)
        );
        return;
      }

      if (message.id === 0) {
        if (message.error) {
          const error = message.error.message || "Codex initialization failed.";
          reconnectAttempt.current += 1;
          runtimeStopError.current = error;
          setRuntime((current) => ({
            ...current,
            phase: "error",
            taskId: null,
            turnStartedAt: null,
            error,
          }));
          void nativeBridge.stopAgent(workspacePath, executionTaskIdRef.current).catch(() => {
            runtimeStopError.current = null;
          });
          return;
        }
        if (message.result) {
          reconnectAttempt.current = 0;
          listenerRecoveryPendingRef.current = listenerRecoveryPendingAfterConnect(
            listenerRecoveryPendingRef.current,
            true,
          );
          listenerRegistrationErrorRef.current = null;
          const activeRun = activeRunForTask(
            runProjectionRef.current,
            activeTaskIdRef.current,
          );
          setRuntime((current) => activeRun
            ? {
                ...current,
                phase: "working",
                taskId: activeRun.taskId,
                threadId: activeRun.threadId,
                turnId: activeRun.turnId,
                turnStartedAt: activeRun.startedAt,
                error: null,
              }
            : {
                ...current,
                phase: "ready",
                taskId: null,
                turnStartedAt: null,
                error: null,
              });
          void refreshRuntimeIdentity();
          return;
        }
      }

      if (message.method === "item/tool/requestUserInput") {
        const pendingInput = route?.pendingInput;
        const request = pendingInput
          ? readQuestionRequest(message, taskId, pendingInput.id, route.runId)
          : null;
        if (request && taskId === activeTaskIdRef.current) {
          questionRequestRef.current = request;
          setQuestionRequest(request);
        } else if (!request && taskId === activeTaskIdRef.current) {
          setRuntime((current) => ({
            ...current,
            error: "Codex sent an invalid question request.",
          }));
        }
        return;
      }

      if (message.method === "mcpServer/elicitation/request" && message.id != null) {
        const pendingInput = route?.pendingInput;
        const request = pendingInput
          ? readMcpElicitationRequest(message, taskId, pendingInput.id, route.runId)
          : null;
        if (request && taskId === activeTaskIdRef.current) {
          updateMcpElicitationRequests((current) =>
            enqueueAgentMcpElicitationRequest(current, request)
          );
        } else if (!request && taskId === activeTaskIdRef.current) {
          setRuntime((current) => ({
            ...current,
            error: "Codex sent an invalid MCP elicitation request.",
          }));
        }
        return;
      }

      if (message.method === "thread/goal/updated") {
        const value = message.params?.goal;
        const goal = value && typeof value === "object" ? value as Record<string, unknown> : null;
        const status = goal?.status;
        if (
          goal &&
          typeof goal.objective === "string" &&
          ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(String(status))
        ) {
          const nextGoal: AgentGoal = {
            objective: goal.objective,
            status: status as AgentGoal["status"],
            tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : null,
            tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
            timeUsedSeconds: typeof goal.timeUsedSeconds === "number" ? goal.timeUsedSeconds : 0,
          };
          syncedGoals.current.set(taskId, `${nextGoal.status}:${nextGoal.objective}`);
          onTaskGoalChangeRef.current(taskId, nextGoal);
        }
        return;
      }

      if (message.method === "thread/goal/cleared") {
        syncedGoals.current.delete(taskId);
        onTaskGoalChangeRef.current(taskId, null);
        return;
      }

      if (message.method === "turn/started") {
        planCache.current.delete(taskId);
        onPlanChangeRef.current(taskId, null);
        const turn = message.params?.turn;
        const turnId =
          turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).id === "string"
            ? String((turn as Record<string, unknown>).id)
            : null;
        const threadId = readMessageThreadId(message);
        if (turnId) {
          activeTurnIds.current.set(taskId, turnId);
          const pendingEntryId = (route
            ? runProjectionRef.current.runsById[route.runId]?.idempotencyKey
            : null) ?? pendingUserEntries.current.get(taskId);
          updateTimeline(taskId, (current) => projectTimelineRunStatus(current, {
            entryId: pendingEntryId,
            runId: route?.runId,
            turnId,
            status: "active",
          }));
        }
        if (!route || taskId === activeTaskIdRef.current) {
          setRuntime((current) =>
            listenerRecoveryPendingRef.current &&
              (current.phase === "error" || current.phase === "offline")
              ? current
              : {
                  ...current,
                  phase: "working",
                  taskId,
                  threadId: threadId ?? current.threadId,
                  turnId,
                }
          );
        }
      }

      if (
        message.method === "turn/diff/updated" &&
        typeof message.params?.turnId === "string" &&
        typeof message.params.diff === "string"
      ) {
        activeTurnDiffs.current.set(message.params.turnId, message.params.diff);
      }

      if (
        message.method === "item/fileChange/patchUpdated" &&
        typeof message.params?.itemId === "string" &&
        Array.isArray(message.params.changes)
      ) {
        settleThinking(taskId);
        updateTimeline(taskId, (current) => projectFileChangePatchUpdate(
          current,
          message.params!.itemId as string,
          message.params!.changes,
        ));
        return;
      }

      if (message.method === "thread/name/updated") {
        const threadId = readMessageThreadId(message);
        const threadName = message.params?.threadName;
        const namedTaskId = threadId ? threadTasks.current.get(threadId) : null;
        if (
          namedTaskId &&
          autoTitledTasks.current.has(namedTaskId) &&
          typeof threadName === "string" &&
          threadName.trim()
        ) {
          onTaskTitleChangeRef.current(namedTaskId, threadName.trim());
          autoTitledTasks.current.delete(namedTaskId);
        }
      }

      if (message.method === "thread/tokenUsage/updated") {
        const threadId = readMessageThreadId(message);
        const tokenUsage = message.params?.tokenUsage;
        const tokenUsageValue =
          tokenUsage && typeof tokenUsage === "object"
            ? tokenUsage as Record<string, unknown>
            : null;
        const total =
          tokenUsageValue ? readTokenUsage(tokenUsageValue.total) : null;
        const last =
          tokenUsageValue ? readTokenUsage(tokenUsageValue.last) : null;
        const rawContextWindow = tokenUsageValue?.modelContextWindow;
        const modelContextWindow =
          typeof rawContextWindow === "number" && Number.isFinite(rawContextWindow) && rawContextWindow > 0
            ? rawContextWindow
            : null;
        if (threadId && total) {
          recordUsage(threadId, total);
          setThreadUsage((current) => ({
            ...current,
            [threadId]: {
              total,
              last: last ?? current[threadId]?.last ?? total,
              modelContextWindow: modelContextWindow ?? current[threadId]?.modelContextWindow ?? null,
            },
          }));
        }
      }

      if (message.method === "account/rateLimits/updated") {
        rateLimitsRefreshRevision.current += 1;
        setRateLimits((current) => projectAgentRateLimitsUpdate(current, message));
      }

      if (message.method === "turn/plan/updated" && Array.isArray(message.params?.plan)) {
        const steps = message.params.plan.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const value = item as Record<string, unknown>;
          if (
            typeof value.step !== "string" ||
            !["pending", "inProgress", "completed"].includes(String(value.status))
          ) {
            return [];
          }
          return [{
            step: value.step,
            status: value.status as "pending" | "inProgress" | "completed",
          }];
        });
        const nextPlan: AgentPlan = {
          explanation:
            typeof message.params.explanation === "string"
              ? message.params.explanation
              : null,
          steps,
        };
        planCache.current.set(taskId, nextPlan);
        onPlanChangeRef.current(taskId, nextPlan);
      }

      if (message.method === "item/started") {
        const item = readItem(message);
        if (!item) return;
        if (item.type === "contextCompaction") {
          const entry = contextCompactionTimelineEntry(item, "started");
          if (entry) {
            updateTimeline(taskId, (current) =>
              current.some((currentEntry) => currentEntry.id === entry.id)
                ? current.map((currentEntry) => currentEntry.id === entry.id ? entry : currentEntry)
                : [...current, entry],
            );
          }
          return;
        }
        if (item.type === "reasoning") {
          const itemId = typeof item.id === "string" ? item.id : crypto.randomUUID();
          const entryId = reasoningEntries.current.get(itemId) ?? itemId;
          activeThinkingEntries.current.set(taskId, entryId);
          reasoningEntries.current.set(itemId, entryId);
          updateTimeline(taskId, (current) =>
            current.some((entry) => entry.id === entryId)
              ? current.map((entry) =>
                  entry.id === entryId
                    ? { ...entry, title: "Thinking", meta: "Live reasoning", status: "active" }
                    : entry,
                )
              : [
                  ...current,
                  {
                     id: entryId,
                     kind: "thought",
                     title: "Thinking",
                     createdAt: Date.now(),
                     meta: "Live reasoning",
                    status: "active",
                  },
                ],
          );
          return;
        }
        if (
          item.type === "commandExecution" ||
          item.type === "fileChange" ||
          item.type === "collabAgentToolCall" ||
          item.type === "mcpToolCall" ||
          item.type === "dynamicToolCall"
        ) {
          settleThinking(taskId);
          const entry = timelineEntryFromItem(item);
          if (entry) {
            updateTimeline(taskId, (current) =>
              current.some((currentEntry) => currentEntry.id === entry.id)
                ? current
                : [...current, entry],
            );
          }
        }
      }

      if (message.method === "item/completed") {
        const item = readItem(message);
        if (!item || item.type === "userMessage") return;
        const entry = timelineEntryFromItem(item);
        if (!entry) return;

        if (item.type === "reasoning" && !entry.body?.trim()) {
          if (typeof item.id === "string") {
            reasoningEntries.current.delete(item.id);
            reasoningChannels.current.delete(item.id);
          }
          settleThinking(taskId);
          return;
        }

        const reasoningEntryId =
          item.type === "reasoning" && typeof item.id === "string"
            ? reasoningEntries.current.get(item.id)
            : null;
        const liveEntryId =
          item.type === "agentMessage" ? liveAgentEntries.current.get(taskId) : null;
        const completedEntry = reasoningEntryId
          ? { ...entry, id: reasoningEntryId }
          : liveEntryId
            ? { ...entry, id: liveEntryId }
            : entry;
        if (item.type === "agentMessage") liveAgentEntries.current.delete(taskId);
        if (item.type === "reasoning") {
          if (typeof item.id === "string") {
            reasoningEntries.current.delete(item.id);
            reasoningChannels.current.delete(item.id);
          }
          activeThinkingEntries.current.delete(taskId);
        }
        updateTimeline(taskId, (current) => {
          const timeline = item.type === "contextCompaction"
            ? invalidateUndoHistory(current)
            : current;
          return timeline.some((currentEntry) => currentEntry.id === completedEntry.id)
            ? timeline.map((currentEntry) => {
                if (currentEntry.id !== completedEntry.id) return currentEntry;
                const streamedBody = currentEntry.body;
                const completedBody = completedEntry.body;
                return {
                  ...completedEntry,
                  body:
                    item.type === "agentMessage" || item.type === "reasoning"
                      ? reconcileCompletedStreamBody(streamedBody, completedBody)
                      : completedBody ?? streamedBody,
                };
              })
            : [...timeline, completedEntry];
        });
      }

      if (
        (message.method === "item/commandExecution/requestApproval" ||
          message.method === "item/fileChange/requestApproval" ||
          message.method === "item/permissions/requestApproval") &&
        message.id != null
      ) {
        const fileApproval = message.method === "item/fileChange/requestApproval";
        const permissionApproval = message.method === "item/permissions/requestApproval";
        const approvalKind = permissionApproval ? "permissions" : "action";
        const requestedPermissions = permissionApproval
          ? permissionGrantFromRequest(message.params?.permissions)
          : undefined;
        const approvalEntry: TimelineEntry = {
          id: `approval-${route?.pendingInput?.id ?? String(message.id)}`,
          kind: "approval",
          title: permissionApproval
            ? "Additional permissions requested"
            : fileApproval
              ? "File change permission requested"
              : "Command permission requested",
          createdAt: Date.now(),
          body:
            typeof message.params?.reason === "string"
              ? message.params.reason
              : permissionApproval
                ? "Codex requested additional network or filesystem access for this turn."
                : "Xiao wants to run an action outside the current permission boundary.",
          command:
            typeof message.params?.command === "string"
              ? message.params.command
              : undefined,
          requestId: message.id,
          pendingInputId: route?.pendingInput?.id,
          runId: route?.runId,
          approvalKind,
          approvalPermissions: requestedPermissions,
          turnId: typeof message.params?.turnId === "string" ? message.params.turnId : undefined,
          meta: "Waiting for your decision",
          status: "warning",
        };
        void handleAgentApprovalRequest(
          taskId,
          taskApprovalPolicies.current.get(taskId),
          approvalEntry,
          updateTimeline,
          declineWithoutPrompt,
        );
      }

      if (message.method === "turn/completed") {
        const value = message.params?.turn;
        const turn = value && typeof value === "object" ? value as Record<string, unknown> : null;
        const status = turn?.status;
        const hasFinalStatus = status === "completed" || status === "failed" || status === "interrupted";
        const outcome: AgentTurnOutcome = hasFinalStatus ? status : "failed";
        const manualCompaction = compactingTasks.current.delete(taskId);
        if (manualCompaction) {
          setCompactingTaskId((current) => current === taskId ? null : current);
          if (outcome === "completed") {
            updateTimeline(taskId, invalidateUndoHistory);
          }
        } else {
          if (shouldClearAgentPlan(outcome)) {
            planCache.current.delete(taskId);
            onPlanChangeRef.current(taskId, null);
          }
        }
        const errorValue = turn?.error;
        const errorMessage = outcome === "failed"
          ? errorValue &&
              typeof errorValue === "object" &&
              typeof (errorValue as Record<string, unknown>).message === "string"
            ? String((errorValue as Record<string, unknown>).message)
            : hasFinalStatus
              ? "Agent turn failed."
              : "Agent turn ended without a valid final status."
          : null;
        const completedTurnId = typeof turn?.id === "string"
          ? turn.id
          : activeTurnIds.current.get(taskId) ?? null;
        const completedTurnDiff = route?.turnDiff ?? (completedTurnId
          ? activeTurnDiffs.current.get(completedTurnId)
          : undefined);
        const pendingEntryId = (route
          ? runProjectionRef.current.runsById[route.runId]?.idempotencyKey
           : null) ?? pendingUserEntries.current.get(taskId);
        const goalContinues = Boolean(
          route && runProjectionRef.current.runsById[route.runId]?.status === "running"
        );
        settleThinking(taskId);
        liveAgentEntries.current.delete(taskId);
        setQuestionRequest((current) => current?.taskId === taskId ? null : current);
        updateMcpElicitationRequests((current) => {
          const next = current.filter((request) => request.taskId !== taskId);
          return next.length === current.length ? current : next;
        });
        if (!route) {
          setRuntime((current) => ({
            ...current,
            phase: "ready",
            taskId: null,
            threadId: sessionIds.current.get(activeTaskIdRef.current) ?? null,
            turnId: null,
            turnStartedAt: null,
            error: errorMessage,
          }));
        } else if (
          errorMessage &&
          !route.replayed &&
          taskId === activeTaskIdRef.current
        ) {
          setRuntime((current) => ({ ...current, error: errorMessage }));
        }
        if (
          !manualCompaction &&
          !goalContinues &&
          !route?.replayed &&
          (!route || !finishedRunIds.current.has(route.runId))
        ) {
          if (route) finishedRunIds.current.add(route.runId);
          onTaskFinishedRef.current(taskId, outcome);
        }
        if (!route?.replayed) void refreshAccountUsage();
        updateTimeline(taskId, (current) => {
          const settledStatus: NonNullable<TimelineEntry["status"]> =
            outcome === "completed" ? "success" : outcome === "failed" ? "error" : "warning";
          const settled = projectTimelineRunStatus(current, {
            entryId: pendingEntryId,
            runId: route?.runId,
            turnId: completedTurnId,
            turnDiff: completedTurnDiff,
            status: settledStatus,
            matchUnscopedActive: !route,
          });
          if (!errorMessage) return settled;
          const errorTurnId = completedTurnId ?? crypto.randomUUID();
          const errorId = `turn-error-${errorTurnId}`;
          if (settled.some((entry) => entry.id === errorId)) return settled;
          return [
            ...settled,
            {
              id: errorId,
              kind: "result",
              title: "Turn failed",
              createdAt: Date.now(),
              body: errorMessage,
              meta: "Xiao",
              status: "error",
              turnId: completedTurnId ?? undefined,
            },
          ];
        });
        if (pendingUserEntries.current.get(taskId) === pendingEntryId) {
          pendingUserEntries.current.delete(taskId);
        }
        activeTurnIds.current.delete(taskId);
        if (completedTurnId) activeTurnDiffs.current.delete(completedTurnId);
      }
    },
    [
      appendRuntimeLog,
      declineWithoutPrompt,
      flushLiveDeltas,
      queueLiveDelta,
      recordUsage,
      refreshAccountRateLimits,
      refreshAccountUsage,
      refreshRuntimeIdentity,
      resolveTaskId,
      scheduleWorkspaceRefresh,
      settleThinking,
      updateMcpElicitationRequests,
      updateTimeline,
      workspacePath,
    ],
  );

  const publishRunProjection = useCallback((
    next: RunProjection,
    { operationScope, force = false }: RunProjectionPublicationOptions = {},
  ) => {
    const previous = runProjectionRef.current;
    if (!force && !runProjectionUiChanged(previous, next)) {
      runProjectionRef.current = next;
      return;
    }
    const bounded = pruneRunProjection(next);
    runProjectionRef.current = bounded;
    if (bounded !== next) {
      const retainedRunIds = new Set(Object.keys(bounded.runsById));
      for (const runId of finishedRunIds.current) {
        if (!retainedRunIds.has(runId)) finishedRunIds.current.delete(runId);
      }
      const retainedPendingInputIds = new Set(Object.keys(bounded.pendingInputsById));
      for (const pendingInputId of replayedPendingInputs.current) {
        if (!retainedPendingInputIds.has(pendingInputId)) {
          replayedPendingInputs.current.delete(pendingInputId);
        }
      }
    }
    if (!force && !runProjectionUiChanged(previous, bounded)) return;
    setRunProjection(bounded);
    if (
      operationScope &&
      !agentRuntimeTaskScopeMatches(
        workspaceScopeRef.current,
        activeTaskIdRef.current,
        operationScope,
      )
    ) return;
    const activeRun = activeRunForTask(bounded, activeTaskIdRef.current);
    if (activeRun) {
      activeEnvironmentIdRef.current = activeRun.executionEnvironmentId;
      activeGenerationRef.current = activeRun.runtimeGeneration;
      if (activeRun.threadId) {
        sessionIds.current.set(activeRun.taskId, activeRun.threadId);
        threadTasks.current.set(activeRun.threadId, activeRun.taskId);
      }
      if (activeRun.turnId) activeTurnIds.current.set(activeRun.taskId, activeRun.turnId);
      const listenerRecoveryPending = listenerRecoveryPendingRef.current;
      setRuntime((current) => runtimeForPublishedActiveRun(
        current,
        activeRun,
        listenerRecoveryPending,
      ));
    } else {
      activeTurnIds.current.delete(activeTaskIdRef.current);
      setRuntime((current) =>
        current.phase === "offline" || current.phase === "starting" || current.phase === "error"
          ? current
          : {
              ...current,
              phase: "ready",
              taskId: null,
              threadId: sessionIds.current.get(activeTaskIdRef.current) ?? null,
              turnId: null,
              turnStartedAt: null,
            },
      );
    }
  }, []);

  useEffect(() => {
    publishRunProjection(runProjectionRef.current, { force: true });
  }, [activeTaskId, publishRunProjection]);

  const retryAttentionHydration = useCallback(() => {
    if (!isTauriHost()) {
      setAttentionHydrationStatus("ready");
      return;
    }
    setAttentionHydrationStatus("loading");
    if (listenersReady) {
      setAttentionHydrationRevision((current) => current + 1);
    } else {
      setListenerRetryRevision((current) => current + 1);
    }
  }, [listenersReady]);

  useEffect(() => {
    if (!isTauriHost()) return;
    let disposed = false;
    const listenerScope = workspaceScopeRef.current;
    const listenerIsCurrent = () =>
      !disposed &&
      agentRuntimeWorkspaceScopeMatches(
        workspaceScopeRef.current,
        workspacePath,
        listenerScope.generation,
      );
    const cleanups: Array<() => void> = [];

    const addCleanup = (cleanup: () => void) => {
      if (disposed) cleanup();
      else cleanups.push(cleanup);
    };

    const attachListeners = async () => {
      try {
        addCleanup(
          await listen<RunUpdateEnvelope>("xiao://run-update", (event) => {
            if (
              !listenerIsCurrent() ||
              event.payload.snapshot.workspacePath !== workspacePath
            ) return;
            flushLiveDeltas();
            const next = projectRunUpdate(runProjectionRef.current, event.payload);
            publishRunProjection(next);
            const pending = event.payload.pendingInput;
            if (pending?.resolvedAt != null || pending?.invalidatedAt != null) {
              setQuestionRequest((current) =>
                current?.pendingInputId === pending.id ? null : current,
              );
              updateMcpElicitationRequests((current) => {
                const next = current.filter((request) => request.pendingInputId !== pending.id);
                return next.length === current.length ? current : next;
              });
            }
            const run = event.payload.snapshot;
            const runIsTerminal =
              run.status === "completed" ||
              run.status === "failed" ||
              run.status === "cancelled" ||
              run.status === "interrupted";
            if (
              run.status !== "queued" &&
              run.taskId === activeTaskIdRef.current &&
              activeTimelineReadyRef.current
            ) {
              updateTimeline(run.taskId, (current) => {
                const projected = projectTimelineRunSnapshot(current, run);
                return runIsTerminal
                  ? reconcilePendingApprovalEntries(projected, null, run.id)
                  : projected;
              });
            }
            if (runIsTerminal) {
              setQuestionRequest((current) => current?.runId === run.id ? null : current);
              updateMcpElicitationRequests((current) => {
                const next = current.filter((request) => request.runId !== run.id);
                return next.length === current.length ? current : next;
              });
              const outcome: AgentTurnOutcome = run.status === "completed"
                ? "completed"
                : run.status === "failed"
                  ? "failed"
                  : "interrupted";
              if (!finishedRunIds.current.has(run.id)) {
                finishedRunIds.current.add(run.id);
                onTaskFinishedRef.current(run.taskId, outcome);
              }
            }
          }),
        );
        addCleanup(
          await listen<RunProtocolEnvelope>("xiao://run-protocol", (event) => {
            if (
              !listenerIsCurrent() ||
              event.payload.taskId !== activeTaskIdRef.current ||
              !activeTimelineReadyRef.current
            ) return;
            const accepted = acceptRunProtocol(runProjectionRef.current, event.payload);
            if (!accepted.accepted) return;
            publishRunProjection(accepted.projection);
            void handleMessage(event.payload.message, {
              taskId: event.payload.taskId,
              runId: event.payload.runId,
              pendingInput: event.payload.pendingInput,
              turnDiff: event.payload.turnDiff,
            });
          }),
        );
        addCleanup(
          await listen<RuntimeMessageEnvelope>("agent://runtime-message", (event) => {
            const activeGeneration = activeGenerationRef.current;
            if (
              listenerIsCurrent() &&
              agentRuntimeEnvelopeMatches(
                expectedEnvironmentIdRef.current,
                activeGeneration,
                event.payload,
              ) &&
              (event.payload.message.id === 0 || compactingTasks.current.size > 0)
            ) {
              void handleMessage(event.payload.message);
            }
          }),
        );
        addCleanup(
          await listen<RuntimeDiagnosticEnvelope>("agent://runtime-stderr", (event) => {
            if (
              listenerIsCurrent() &&
              event.payload.message.trim() &&
              agentRuntimeEnvelopeMatches(
                expectedEnvironmentIdRef.current,
                activeGenerationRef.current,
                event.payload,
              )
            ) {
              appendRuntimeLog("stderr", event.payload.message);
            }
          }),
        );
        addCleanup(
          await listen<RuntimeStoppedEnvelope>("agent://runtime-stopped", (event) => {
            if (
              !listenerIsCurrent() ||
              !agentRuntimeEnvelopeMatches(
                expectedEnvironmentIdRef.current,
                activeGenerationRef.current,
                event.payload,
              )
            ) return;
            flushLiveDeltas();
            const stopError = runtimeStopError.current;
            runtimeStopError.current = null;
            if (!stopError) reconnectAttempt.current += 1;
            activeGenerationRef.current = null;
            sessionIds.current.clear();
            threadTasks.current.clear();
            liveAgentEntries.current.clear();
            activeThinkingEntries.current.clear();
            reasoningEntries.current.clear();
            reasoningChannels.current.clear();
            compactingTasks.current.clear();
            syncedGoals.current.clear();
            questionRequestRef.current = null;
            mcpElicitationRequestsRef.current = [];
            undoingScopeRef.current = null;
            appendRuntimeLog("system", "Agent runtime stopped.");
            setAccount(null);
            setAccountUsage(null);
            setRateLimits(null);
            setModels([]);
            setThreadUsage({});
            setQuestionRequest(null);
            setMcpElicitationRequests([]);
            setCompactingTaskId(null);
            setUndoingScope(null);
            setRuntime(
              stopError
                ? { ...initialRuntime, phase: "error", error: stopError }
                : initialRuntime,
            );
          }),
        );
        addCleanup(
          await listen<WorkspaceServiceError>("xiao://run-service-error", (event) => {
            if (!listenerIsCurrent()) return;
            const message = workspaceServiceErrorMessage(workspacePath, event.payload);
            if (!message) return;
            flushLiveDeltas();
            appendRuntimeLog("stderr", message);
            setRuntime((current) => ({ ...current, error: message }));
          }),
        );
        if (listenerIsCurrent()) {
          const listenerOwnedError = listenerRegistrationErrorRef.current;
          listenerRegistrationErrorRef.current = null;
          setRuntime((current) => runtimeAfterListenerAttachSuccess(
            current,
            listenerOwnedError,
          ));
          setListenersReady(true);
        }
      } catch (reason) {
        cleanups.splice(0).forEach((cleanup) => cleanup());
        if (listenerIsCurrent()) {
          const message = reason instanceof Error ? reason.message : String(reason);
          listenerRecoveryPendingRef.current = true;
          setAttentionHydrationStatus(
            attentionHydrationStatusFromSettlements([], false),
          );
          setRuntime((current) => {
            const listenerOwnedError = {
              ...current,
              phase: "error" as const,
              error: message,
            };
            listenerRegistrationErrorRef.current = listenerOwnedError;
            return listenerOwnedError;
          });
        }
      }
    };

    void attachListeners();

    return () => {
      disposed = true;
      setListenersReady(false);
      if (liveDeltaTimer.current) clearTimeout(liveDeltaTimer.current);
      liveDeltaTimer.current = null;
      if (workspaceRefreshTimer.current) clearTimeout(workspaceRefreshTimer.current);
      workspaceRefreshTimer.current = null;
      liveDeltaBatches.current.clear();
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [
    appendRuntimeLog,
    flushLiveDeltas,
    handleMessage,
    listenerRetryRevision,
    publishRunProjection,
    updateMcpElicitationRequests,
    workspacePath,
  ]);

  useEffect(() => {
    if (
      !isTauriHost() ||
      !listenersReady ||
      stateWorkspacePath !== workspacePath
    ) return;
    let cancelled = false;
    const listScope = workspaceScopeRef.current;
    const listIsCurrent = () =>
      !cancelled &&
      agentRuntimeWorkspaceScopeMatches(
        workspaceScopeRef.current,
        workspacePath,
        listScope.generation,
      );
    setAttentionHydrationStatus("loading");
    const runsBaseline = runSnapshotBaselineForIds(
      runProjectionRef.current,
      workspaceListedRunIds.current,
    );
    const pendingBaseline = runProjectionRef.current.pendingInputsById;
    const runsRequest = Promise.resolve().then(() =>
      nativeBridge.listXiaoRuns(workspacePath, null, 100)
    );
    const pendingInputsRequest = Promise.resolve().then(() =>
      nativeBridge.listXiaoPendingInputs(workspacePath, null)
    );
    const runsPublication = runsRequest.then((runs) => {
      if (!listIsCurrent()) return;
      const scopedRuns = runs.filter((run) => run.workspacePath === workspacePath);
      for (const run of scopedRuns) {
        if (run.threadId && runStatusIsActive(run.status)) {
          sessionIds.current.set(run.taskId, run.threadId);
          threadTasks.current.set(run.threadId, run.taskId);
          if (run.turnId) activeTurnIds.current.set(run.taskId, run.turnId);
        }
      }
      publishRunProjection(reconcileListedRunSnapshots(
        runProjectionRef.current,
        scopedRuns,
        runsBaseline,
      ));
      workspaceListedRunIds.current = new Set(scopedRuns.map((run) => run.id));
    });
    const pendingInputsPublication = pendingInputsRequest.then((pendingInputs) => {
      if (!listIsCurrent()) return;
      publishRunProjection(reconcileListedPendingInputs(
        runProjectionRef.current,
        pendingInputs,
        pendingBaseline,
      ));
    });

    void Promise.allSettled([
      runsPublication,
      pendingInputsPublication,
    ]).then((settlements) => {
      if (!listIsCurrent()) return;
      setAttentionHydrationStatus(
        attentionHydrationStatusFromSettlements(settlements),
      );
    });
    return () => { cancelled = true; };
  }, [
    attentionHydrationRevision,
    listenersReady,
    publishRunProjection,
    stateWorkspacePath,
    workspacePath,
  ]);

  useEffect(() => {
    if (!isTauriHost() || !listenersReady || !activeTaskTimelineComplete) return;
    resetPendingInputReplayForTaskRestore(replayedPendingInputs.current);
    let cancelled = false;
    const restoreScope = workspaceScopeRef.current;
    const restoreIsCurrent = () =>
      !cancelled &&
      agentRuntimeWorkspaceScopeMatches(
        workspaceScopeRef.current,
        workspacePath,
        restoreScope.generation,
      );
    const restore = async () => {
      const [runs, pendingInputs] = await Promise.all([
        nativeBridge.listXiaoRuns(workspacePath, activeTaskId, 50),
        nativeBridge.listXiaoPendingInputs(workspacePath, activeTaskId),
      ]);
      if (!restoreIsCurrent()) return;
      const scopedRuns = runs.filter((run) => run.workspacePath === workspacePath);
      const scopedRunIds = new Set(scopedRuns.map((run) => run.id));
      const scopedPendingInputs = pendingInputs.filter((pending) =>
        scopedRunIds.has(pending.runId)
      );
      publishRunProjection(
        projectRunSnapshots(runProjectionRef.current, scopedRuns),
      );
      const orderedRuns = [...scopedRuns].sort(
        (left, right) => left.queuedAt - right.queuedAt || left.id.localeCompare(right.id),
      );
      const activePendingInputIds = activePendingInputIdsForRestore(
        runProjectionRef.current,
        scopedPendingInputs,
      );
      updateTimeline(activeTaskId, (current) => {
        let next = current;
        for (const run of orderedRuns) {
          const status = timelineStatusForRun(run.status);
          const existing = next.find(
            (entry) => entry.id === run.idempotencyKey || entry.runId === run.id,
          );
          if (existing) {
            next = next.map((entry) =>
              entry.id === existing.id
                ? {
                    ...entry,
                    runId: run.id,
                    status,
                    turnId: run.turnId ?? entry.turnId,
                    meta: run.status === "queued" ? "Queued" : "You",
                  }
                : entry,
            );
            continue;
          }
          next = [
            ...next,
            {
              id: run.idempotencyKey,
              runId: run.id,
              kind: "user",
              title: run.prompt,
              createdAt: run.queuedAt,
              meta: run.status === "queued" ? "Queued" : "You",
              status,
              turnId: run.turnId ?? undefined,
            },
          ];
        }
        return reconcilePendingApprovalEntries(next, activePendingInputIds);
      });

      for (const run of orderedRuns) {
        if (!restoreIsCurrent()) return;
        if (run.runtimeGeneration == null || !run.threadId) continue;
        if (run.turnId) activeTurnIds.current.set(run.taskId, run.turnId);
        const events = await loadAllXiaoRunEvents(run.id);
        for (const event of events) {
          if (!restoreIsCurrent()) return;
          const envelope = restoredRunProtocolEnvelope(run, event);
          if (!envelope) continue;
          const accepted = acceptRunProtocol(runProjectionRef.current, envelope);
          if (!accepted.accepted) continue;
          publishRunProjection(accepted.projection);
          if (run.turnId) activeTurnIds.current.set(run.taskId, run.turnId);
          await handleMessage(envelope.message, {
            taskId: run.taskId,
            runId: run.id,
            pendingInput: null,
            turnDiff: envelope.turnDiff,
            replayed: true,
          });
        }
      }

      for (const pending of scopedPendingInputs) {
        if (
          !restoreIsCurrent() ||
          replayedPendingInputs.current.has(pending.id) ||
          !shouldRestorePendingInput(runProjectionRef.current, pending)
        ) continue;
        const run = scopedRuns.find((item) => item.id === pending.runId);
        if (!run) continue;
        replayedPendingInputs.current.add(pending.id);
        await handleMessage(messageFromPendingInput(pending), {
          taskId: run.taskId,
          runId: run.id,
          pendingInput: pending,
        });
      }
    };
    void restore().catch((reason) => {
      if (restoreIsCurrent()) {
        setRuntime((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      }
    });
    return () => { cancelled = true; };
  }, [
    activeTaskId,
    activeTaskTimelineComplete,
    handleMessage,
    listenersReady,
    publishRunProjection,
    updateTimeline,
    workspacePath,
  ]);

  const connect = useCallback(async () => {
    const scope = workspaceScopeRef.current;
    if (!isTauriHost()) {
      setRuntime((current) => ({
        ...current,
        phase: "error",
        error: "Run npm run tauri dev to connect the native agent runtime.",
      }));
      return;
    }

    activeEnvironmentIdRef.current = expectedEnvironmentIdRef.current;
    activeGenerationRef.current = null;
    setRuntime((current) => ({ ...current, phase: "starting", error: null }));
    appendRuntimeLog("system", "Starting Codex app-server.");
    try {
      const result = await nativeBridge.startAgent(workspacePath, executionTaskIdRef.current);
      if (!agentRuntimeWorkspaceScopeMatches(
        workspaceScopeRef.current,
        workspacePath,
        scope.generation,
      )) return;
      if (result.environmentId !== expectedEnvironmentIdRef.current) {
        throw new Error("Codex connected to an unexpected execution environment.");
      }
      activeEnvironmentIdRef.current = result.environmentId;
      activeGenerationRef.current = result.generation;
      setRuntime((current) => ({ ...current, profileId: result.profileId }));
      appendRuntimeLog("system", `Codex ${result.version} connected.`);
      if (result.alreadyRunning) {
        reconnectAttempt.current = 0;
        listenerRecoveryPendingRef.current = listenerRecoveryPendingAfterConnect(
          listenerRecoveryPendingRef.current,
          true,
        );
        listenerRegistrationErrorRef.current = null;
        setRuntime((current) => ({ ...current, phase: "ready", error: null }));
        await refreshRuntimeIdentity();
      }
    } catch (reason) {
      if (!agentRuntimeWorkspaceScopeMatches(
        workspaceScopeRef.current,
        workspacePath,
        scope.generation,
      )) return;
      reconnectAttempt.current += 1;
      listenerRecoveryPendingRef.current = listenerRecoveryPendingAfterConnect(
        listenerRecoveryPendingRef.current,
        false,
      );
      setRuntime((current) => ({
        ...current,
        phase: "error",
        error: reason instanceof Error ? reason.message : String(reason),
      }));
    }
  }, [appendRuntimeLog, refreshRuntimeIdentity, workspacePath]);

  useEffect(() => {
    if (
      !isTauriHost() ||
      !autoConnect ||
      !listenersReady ||
      (runtime.phase !== "offline" && runtime.phase !== "error")
    ) {
      return;
    }
    const delay =
      runtime.phase === "offline" && reconnectAttempt.current === 0
        ? 0
        : Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt.current, 5));
    const timer = window.setTimeout(() => void connect(), delay);
    return () => window.clearTimeout(timer);
  }, [autoConnect, connect, listenersReady, runtime.phase]);

  const submit = useCallback(
    async (
      prompt: string,
      attachments: AgentAttachment[],
      idempotencyKey: string = crypto.randomUUID(),
    ) => {
      const cleanPrompt = prompt.trim();
      if (!cleanPrompt || !isTauriHost()) return false;
      const scope: AgentRuntimeTaskScope = {
        workspacePath,
        generation: workspaceScopeRef.current.generation,
        taskId: activeTaskId,
      };
      const operationWorkspaceIsCurrent = () =>
        agentRuntimeTaskWorkspaceScopeMatches(workspaceScopeRef.current, scope);
      const operationIsActive = () => agentRuntimeTaskScopeMatches(
        workspaceScopeRef.current,
        activeTaskIdRef.current,
        scope,
      );
      if (!operationWorkspaceIsCurrent()) return false;
      const currentTimeline = timelineCache.current.get(scope.taskId) ?? activeTaskTimeline;
      const userEntryId = idempotencyKey;
      const existingUserEntry = currentTimeline.some((entry) => entry.id === userEntryId);
      updateTimeline(scope.taskId, (current) =>
        current.some((entry) => entry.id === userEntryId)
          ? current
          : [
              ...current,
              {
                id: userEntryId,
                kind: "user",
                title: cleanPrompt,
                createdAt: Date.now(),
                attachments: attachments.length ? attachments : undefined,
                meta: "Queued",
                status: "active",
              },
            ],
      );
      pendingUserEntries.current.set(scope.taskId, userEntryId);
      const requestedModel = activeTaskModel
        ? models.find((model) => model.model === activeTaskModel)
        : models.find((model) => model.isDefault);
      try {
        const run = await nativeBridge.enqueueXiaoRun({
          projectPath: workspacePath,
          taskId: scope.taskId,
          idempotencyKey: userEntryId,
          prompt: cleanPrompt,
          input: userInput(cleanPrompt, attachments),
          history: historyFromTimeline(currentTimeline),
          defaultModel: requestedModel?.model ?? null,
          defaultReasoningEffort: requestedModel?.defaultReasoningEffort ?? null,
          serviceTier: serviceTierForFastMode(requestedModel, fastMode),
        });
        if (run.workspacePath !== workspacePath || run.taskId !== scope.taskId) {
          throw new Error("The queued run did not match its originating task.");
        }
        if (!operationWorkspaceIsCurrent()) return true;
        if (activeTaskTitle === "New task") {
          autoTitledTasks.current.add(scope.taskId);
          onTaskTitleChangeRef.current(scope.taskId, titleFromPrompt(cleanPrompt));
        }
        updateTimeline(scope.taskId, (current) => {
          const withRun = current.map((entry) =>
            entry.id === userEntryId
              ? { ...entry, runId: run.id, turnId: run.turnId ?? entry.turnId }
              : entry,
          );
          if (run.status === "queued") return withRun;
          return projectTimelineRunStatus(withRun, {
            entryId: userEntryId,
            runId: run.id,
            turnId: run.turnId,
            status: timelineStatusForRun(run.status),
          });
        });
        return true;
      } catch (reason) {
        if (!operationWorkspaceIsCurrent()) return false;
        pendingUserEntries.current.delete(scope.taskId);
        if (!existingUserEntry) {
          updateTimeline(scope.taskId, (current) =>
            current.filter((entry) => entry.id !== userEntryId),
          );
        }
        if (operationIsActive()) {
          setRuntime((current) => ({
            ...current,
            error: reason instanceof Error ? reason.message : String(reason),
          }));
        }
        return false;
      }
    },
    [
      activeTaskId,
      activeTaskModel,
      activeTaskTimeline,
      activeTaskTitle,
      fastMode,
      models,
      updateTimeline,
      workspacePath,
    ],
  );

  const steer = useCallback(
    async (
      prompt: string,
      attachments: AgentAttachment[],
      clientUserMessageId: string = crypto.randomUUID(),
    ) => {
      const cleanPrompt = prompt.trim();
      if (!cleanPrompt || !isTauriHost()) return false;
      const scope: AgentRuntimeTaskScope = {
        workspacePath,
        generation: workspaceScopeRef.current.generation,
        taskId: activeTaskId,
      };
      const operationWorkspaceIsCurrent = () =>
        agentRuntimeTaskWorkspaceScopeMatches(workspaceScopeRef.current, scope);
      const operationIsActive = () => agentRuntimeTaskScopeMatches(
        workspaceScopeRef.current,
        activeTaskIdRef.current,
        scope,
      );
      const activeRun = activeRunForTask(runProjectionRef.current, scope.taskId);
      if (!operationIsActive() || !activeRun?.turnId) return false;

      const currentTimeline = timelineCache.current.get(scope.taskId) ?? activeTaskTimeline;
      const existingUserEntry = currentTimeline.some((entry) => entry.id === clientUserMessageId);
      updateTimeline(scope.taskId, (current) =>
        current.some((entry) => entry.id === clientUserMessageId)
          ? current
          : [
              ...current,
              {
                id: clientUserMessageId,
                runId: activeRun.id,
                turnId: activeRun.turnId ?? undefined,
                kind: "user",
                title: cleanPrompt,
                createdAt: Date.now(),
                attachments: attachments.length ? attachments : undefined,
                meta: "You",
                status: "active",
              },
            ],
      );
      try {
        const acceptedTurnId = await nativeBridge.steerXiaoRun({
          projectPath: workspacePath,
          taskId: scope.taskId,
          runId: activeRun.id,
          clientUserMessageId,
          input: userInput(cleanPrompt, attachments),
        });
        if (acceptedTurnId !== activeRun.turnId) {
          throw new Error("The steered message was accepted by a different turn.");
        }
        return operationWorkspaceIsCurrent();
      } catch (reason) {
        if (!operationWorkspaceIsCurrent()) return false;
        if (!existingUserEntry) {
          updateTimeline(scope.taskId, (current) =>
            current.filter((entry) => entry.id !== clientUserMessageId),
          );
        }
        if (operationIsActive()) {
          setRuntime((current) => ({
            ...current,
            error: reason instanceof Error ? reason.message : String(reason),
          }));
        }
        return false;
      }
    },
    [activeTaskId, activeTaskTimeline, updateTimeline, workspacePath],
  );

  const compact = useCallback(async () => {
    const scope: AgentRuntimeTaskScope = {
      workspacePath,
      generation: workspaceScopeRef.current.generation,
      taskId: activeTaskId,
    };
    const operationWorkspaceIsCurrent = () =>
      agentRuntimeTaskWorkspaceScopeMatches(workspaceScopeRef.current, scope);
    const operationIsActive = () => agentRuntimeTaskScopeMatches(
      workspaceScopeRef.current,
      activeTaskIdRef.current,
      scope,
    );
    const threadId = sessionIds.current.get(scope.taskId);
    if (
      !operationIsActive() ||
      runtime.phase !== "ready" ||
      !threadId ||
      compactingTasks.current.size > 0
    ) {
      return false;
    }

    compactingTasks.current.add(scope.taskId);
    setCompactingTaskId(scope.taskId);
    setRuntime((current) => ({
      ...current,
      phase: "working",
      taskId: scope.taskId,
      threadId,
      turnId: null,
      turnStartedAt: Date.now(),
      error: null,
    }));

    const request = threadCompactRequest(threadId);
    try {
      await nativeBridge.agentRequest(
        request.method,
        request.params,
        { projectPath: workspacePath, taskId: scope.taskId },
      );
      return operationWorkspaceIsCurrent();
    } catch (reason) {
      if (!operationWorkspaceIsCurrent()) return false;
      compactingTasks.current.delete(scope.taskId);
      setCompactingTaskId((current) => current === scope.taskId ? null : current);
      if (operationIsActive()) {
        const failure = reason instanceof Error ? reason.message : String(reason);
        setRuntime((current) => ({
          ...current,
          phase: current.taskId === scope.taskId ? "ready" : current.phase,
          taskId: current.taskId === scope.taskId ? null : current.taskId,
          turnId: current.taskId === scope.taskId ? null : current.turnId,
          turnStartedAt: current.taskId === scope.taskId ? null : current.turnStartedAt,
          error: `Could not compact context: ${failure}`,
        }));
      }
      return false;
    }
  }, [activeTaskId, runtime.phase, workspacePath]);

  const interrupt = useCallback(async () => {
    const scope: AgentRuntimeTaskScope = {
      workspacePath,
      generation: workspaceScopeRef.current.generation,
      taskId: activeTaskId,
    };
    const activeRun = activeRunForTask(runProjectionRef.current, scope.taskId);
    if (
      !agentRuntimeTaskScopeMatches(workspaceScopeRef.current, activeTaskIdRef.current, scope) ||
      !activeRun ||
      activeRun.workspacePath !== workspacePath ||
      activeRun.taskId !== scope.taskId
    ) return;
    try {
      const snapshot = await nativeBridge.cancelXiaoRun(activeRun.id);
      if (
        snapshot.workspacePath !== workspacePath ||
        snapshot.taskId !== scope.taskId ||
        !agentRuntimeTaskWorkspaceScopeMatches(workspaceScopeRef.current, scope)
      ) return;
      publishRunProjection(projectRunUpdate(runProjectionRef.current, {
        snapshot,
        event: null,
        pendingInput: null,
      }), { operationScope: scope });
    } catch (reason) {
      if (agentRuntimeTaskScopeMatches(
        workspaceScopeRef.current,
        activeTaskIdRef.current,
        scope,
      )) {
        setRuntime((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      }
    }
  }, [activeTaskId, publishRunProjection, workspacePath]);

  const retryRun = useCallback(async (runId: string) => {
    const currentRun = runProjectionRef.current.runsById[runId];
    if (!currentRun || currentRun.workspacePath !== workspacePath) return false;
    const scope: AgentRuntimeTaskScope = {
      workspacePath,
      generation: workspaceScopeRef.current.generation,
      taskId: currentRun.taskId,
    };
    if (!agentRuntimeTaskScopeMatches(
      workspaceScopeRef.current,
      activeTaskIdRef.current,
      scope,
    )) return false;
    try {
      const snapshot = await nativeBridge.retryXiaoRun(runId, `retry:${runId}`);
      if (
        snapshot.workspacePath !== workspacePath ||
        snapshot.taskId !== scope.taskId ||
        !agentRuntimeTaskWorkspaceScopeMatches(workspaceScopeRef.current, scope)
      ) return false;
      publishRunProjection(projectRunUpdate(runProjectionRef.current, {
        snapshot,
        event: null,
        pendingInput: null,
      }), { operationScope: scope });
      return true;
    } catch (reason) {
      if (agentRuntimeTaskScopeMatches(
        workspaceScopeRef.current,
        activeTaskIdRef.current,
        scope,
      )) {
        setRuntime((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      }
      return false;
    }
  }, [publishRunProjection, workspacePath]);

  const setApprovalPolicy = useCallback(
    async (approvalPolicy: AgentApprovalPolicy) => {
      const scope: AgentRuntimeTaskScope = {
        workspacePath,
        generation: workspaceScopeRef.current.generation,
        taskId: activeTaskId,
      };
      const operationIsActive = () => agentRuntimeTaskScopeMatches(
        workspaceScopeRef.current,
        activeTaskIdRef.current,
        scope,
      );
      if (!operationIsActive()) return false;
      taskApprovalPolicies.current.set(scope.taskId, approvalPolicy);
      if (approvalPolicy === "never") {
        const activeTurnId = activeTurnIds.current.get(scope.taskId);
        const pendingApprovals = (timelineCache.current.get(scope.taskId) ?? [])
          .filter((entry) =>
            entry.kind === "approval" &&
            entry.status === "warning" &&
            entry.requestId != null &&
            activeTurnId != null &&
            entry.turnId === activeTurnId,
          );
        pendingApprovals.forEach((entry) => {
          void declineWithoutPrompt(scope.taskId, entry.requestId!, entry.approvalKind, entry.id);
        });
      }

      const threadId = sessionIds.current.get(scope.taskId);
      if (!threadId) return true;
      try {
        await nativeBridge.agentRequest(
          "thread/settings/update",
          { threadId, approvalPolicy },
          { projectPath: workspacePath, taskId: scope.taskId },
        );
        if (!operationIsActive()) return false;
        setRuntime((current) => ({ ...current, error: null }));
        return true;
      } catch (reason) {
        if (!operationIsActive()) return false;
        setRuntime((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
        return false;
      }
    },
    [activeTaskId, declineWithoutPrompt, workspacePath],
  );

  const undoLastTurn = useCallback(async (): Promise<AgentUndoResult | null> => {
    const scope: AgentRuntimeTaskScope = {
      workspacePath,
      generation: workspaceScopeRef.current.generation,
      taskId: activeTaskId,
    };
    const operationWorkspaceIsCurrent = () =>
      agentRuntimeTaskWorkspaceScopeMatches(workspaceScopeRef.current, scope);
    const operationIsActive = () => agentRuntimeTaskScopeMatches(
      workspaceScopeRef.current,
      activeTaskIdRef.current,
      scope,
    );
    const timeline = timelineCache.current.get(scope.taskId) ?? activeTaskTimeline;
    const target = latestUndoableTurn(timeline);
    const threadId = sessionIds.current.get(scope.taskId);
    if (
      !operationIsActive() ||
      undoingScopeRef.current ||
      runtime.phase !== "ready" ||
      !target?.turnId ||
      !threadId
    ) {
      return null;
    }

    const turnEntries = timeline.filter((entry) => entry.turnId === target.turnId);
    const prompt = turnEntries
      .filter((entry) => entry.kind === "user")
      .map((entry) => entry.title.trim())
      .filter(Boolean)
      .join("\n\n");
    const attachments = [...new Map(
      turnEntries
        .flatMap((entry) => entry.attachments ?? [])
        .map((attachment) => [`${attachment.kind}:${attachment.path}`, attachment] as const),
    ).values()];
    const patch = target.turnDiff ?? "";
    let patchReverted = false;
    let stage: "check" | "files" | "history" = "check";

    undoingScopeRef.current = scope;
    setUndoingScope(scope);
    setRuntime((current) => ({ ...current, error: null }));
    try {
      if (patch.trim()) {
        await nativeBridge.applyGitPatch(workspacePath, scope.taskId, patch, true, true);
        stage = "files";
        await nativeBridge.applyGitPatch(workspacePath, scope.taskId, patch, true, false);
        patchReverted = true;
      }

      stage = "history";
      await nativeBridge.agentRequest(
        "thread/rollback",
        { threadId, numTurns: 1 },
        { projectPath: workspacePath, taskId: scope.taskId },
      );

      const firstTurnIndex = timeline.findIndex((entry) => entry.turnId === target.turnId);
      const remaining = firstTurnIndex < 0
        ? timeline.filter((entry) => entry.turnId !== target.turnId)
        : timeline.slice(0, firstTurnIndex);
      const resetTitle = !remaining.some((entry) => entry.kind === "user");
      settleAutoTitleAfterUndo(autoTitledTasks.current, scope.taskId, resetTitle);
      if (operationIsActive()) {
        setRuntime((current) => ({ ...current, error: null }));
      }
      return { prompt, attachments, timeline: remaining, resetTitle };
    } catch (reason) {
      const failure = reason instanceof Error ? reason.message : String(reason);
      let message = stage === "check"
        ? `Cannot undo safely because the workspace changed after this turn: ${failure}`
        : stage === "files"
          ? `Could not revert the turn's file changes: ${failure}`
          : `Could not rollback the Codex turn: ${failure}`;

      if (patchReverted) {
        try {
          await nativeBridge.applyGitPatch(workspacePath, scope.taskId, patch, false, true);
          await nativeBridge.applyGitPatch(workspacePath, scope.taskId, patch, false, false);
          message += " Xiao restored the workspace changes.";
        } catch (restoreReason) {
          const restoreFailure = restoreReason instanceof Error
            ? restoreReason.message
            : String(restoreReason);
          message += ` The history was not rolled back, and the workspace patch could not be restored: ${restoreFailure}`;
        }
        if (operationWorkspaceIsCurrent()) onWorkspaceChangeRef.current();
      }
      if (operationIsActive()) {
        setRuntime((current) => ({ ...current, error: message }));
      }
      return null;
    } finally {
      if (undoingScopeRef.current === scope) undoingScopeRef.current = null;
      setUndoingScope((current) => current === scope ? null : current);
    }
  }, [
    activeTaskId,
    activeTaskTimeline,
    runtime.phase,
    workspacePath,
  ]);

  const setGoal = useCallback(
    async (objective: string, status: AgentGoal["status"] = "active") => {
      const cleanObjective = objective.trim();
      if (!cleanObjective) return false;
      const scope: AgentRuntimeTaskScope = {
        workspacePath,
        generation: workspaceScopeRef.current.generation,
        taskId: activeTaskId,
      };
      const operationWorkspaceIsCurrent = () =>
        agentRuntimeTaskWorkspaceScopeMatches(workspaceScopeRef.current, scope);
      const operationIsActive = () => agentRuntimeTaskScopeMatches(
        workspaceScopeRef.current,
        activeTaskIdRef.current,
        scope,
      );
      if (!operationWorkspaceIsCurrent()) return false;
      const goal = { objective: cleanObjective, status } satisfies AgentGoal;
      const threadId = sessionIds.current.get(scope.taskId);
      if (!threadId) {
        onTaskGoalChangeRef.current(scope.taskId, goal);
        return true;
      }
      try {
        await nativeBridge.agentRequest(
          "thread/goal/set",
          { threadId, objective: cleanObjective, status },
          { projectPath: workspacePath, taskId: scope.taskId },
        );
        if (!operationWorkspaceIsCurrent()) return false;
        syncedGoals.current.set(scope.taskId, `${status}:${cleanObjective}`);
        onTaskGoalChangeRef.current(scope.taskId, goal);
        return operationIsActive();
      } catch (reason) {
        if (!operationWorkspaceIsCurrent()) return false;
        if (operationIsActive()) {
          setRuntime((current) => ({
            ...current,
            error: reason instanceof Error ? reason.message : String(reason),
          }));
        }
        return false;
      }
    },
    [activeTaskId, workspacePath],
  );

  const clearGoal = useCallback(async () => {
    const scope: AgentRuntimeTaskScope = {
      workspacePath,
      generation: workspaceScopeRef.current.generation,
      taskId: activeTaskId,
    };
    const operationWorkspaceIsCurrent = () =>
      agentRuntimeTaskWorkspaceScopeMatches(workspaceScopeRef.current, scope);
    const operationIsActive = () => agentRuntimeTaskScopeMatches(
      workspaceScopeRef.current,
      activeTaskIdRef.current,
      scope,
    );
    if (!operationWorkspaceIsCurrent()) return false;
    const threadId = sessionIds.current.get(scope.taskId);
    if (!threadId) {
      onTaskGoalChangeRef.current(scope.taskId, null);
      syncedGoals.current.delete(scope.taskId);
      return true;
    }
    try {
      await nativeBridge.agentRequest(
        "thread/goal/clear",
        { threadId },
        { projectPath: workspacePath, taskId: scope.taskId },
      );
      if (!operationWorkspaceIsCurrent()) return false;
      onTaskGoalChangeRef.current(scope.taskId, null);
      syncedGoals.current.delete(scope.taskId);
      return operationIsActive();
    } catch (reason) {
      if (!operationWorkspaceIsCurrent()) return false;
      if (operationIsActive()) {
        setRuntime((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      }
      return false;
    }
  }, [activeTaskId, workspacePath]);

  const resolveApproval = useCallback(
    async (
      taskId: string,
      entryId: string,
      requestId: number | string,
      decision: "accept" | "decline",
    ) => {
      const scope: AgentRuntimeTaskScope = {
        workspacePath,
        generation: workspaceScopeRef.current.generation,
        taskId,
      };
      const operationWorkspaceIsCurrent = () =>
        agentRuntimeTaskWorkspaceScopeMatches(workspaceScopeRef.current, scope);
      if (!operationWorkspaceIsCurrent()) return;
      updateTimeline(taskId, (current) =>
        current.map((entry) =>
          entry.id === entryId
            ? {
                ...entry,
                status: "active",
                meta: "Submitting decision",
              }
            : entry,
        ),
      );
      try {
        const approval = (timelineCache.current.get(taskId) ?? []).find(
          (entry) => entry.id === entryId,
        );
        if (!approval?.pendingInputId) {
          throw new Error(`Approval ${String(requestId)} is no longer active.`);
        }
        await nativeBridge.resolveXiaoRunInput(
          approval.pendingInputId,
          approvalResponse(approval.approvalKind, approval.approvalPermissions, decision),
        );
        if (!operationWorkspaceIsCurrent()) return;
        updateTimeline(taskId, (current) =>
          current.map((entry) =>
            entry.id === entryId
              ? {
                  ...entry,
                  status: "success",
                  meta: decision === "accept" ? "Approved" : "Declined",
                }
              : entry,
          ),
        );
        if (agentRuntimeTaskScopeMatches(
          workspaceScopeRef.current,
          activeTaskIdRef.current,
          scope,
        )) {
          setRuntime((current) => ({ ...current, error: null }));
        }
      } catch (reason) {
        if (!operationWorkspaceIsCurrent()) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        const inactive = isInactiveApprovalResolutionError(reason);
        updateTimeline(taskId, (current) =>
          current.map((entry) =>
            entry.id === entryId
              ? inactive
                ? { ...entry, status: "success", meta: "Request no longer active" }
                : { ...entry, status: "warning", meta: "Decision failed - try again" }
              : entry,
          ),
        );
        if (inactive) {
          if (agentRuntimeTaskScopeMatches(
            workspaceScopeRef.current,
            activeTaskIdRef.current,
            scope,
          )) {
            setRuntime((current) => ({ ...current, error: null }));
          }
          return;
        }
        if (agentRuntimeTaskScopeMatches(
          workspaceScopeRef.current,
          activeTaskIdRef.current,
          scope,
        )) {
          setRuntime((current) => ({ ...current, error: message }));
        }
      }
    },
    [updateTimeline, workspacePath],
  );

  const resolveQuestion = useCallback(
    async (requestId: number | string, answers: Record<string, string[]>) => {
      const scope: AgentRuntimeTaskScope = {
        workspacePath,
        generation: workspaceScopeRef.current.generation,
        taskId: activeTaskId,
      };
      const operationIsActive = () => agentRuntimeTaskScopeMatches(
        workspaceScopeRef.current,
        activeTaskIdRef.current,
        scope,
      );
      if (!operationIsActive()) return false;
      try {
        const request = questionRequestRef.current;
        if (
          !request ||
          request.taskId !== scope.taskId ||
          String(request.requestId) !== String(requestId)
        ) {
          throw new Error("This question is no longer attached to a live Xiao run.");
        }
        await nativeBridge.resolveXiaoRunInput(request.pendingInputId, {
          answers: Object.fromEntries(
            Object.entries(answers).map(([questionId, values]) => [
              questionId,
              { answers: values },
            ]),
          ),
        });
        if (!operationIsActive()) return false;
        if (agentQuestionRequestMatches(questionRequestRef.current, request)) {
          questionRequestRef.current = null;
        }
        setQuestionRequest((current) =>
          agentQuestionRequestMatches(current, request) ? null : current
        );
        setRuntime((current) => ({ ...current, error: null }));
        return true;
      } catch (reason) {
        if (operationIsActive()) {
          setRuntime((current) => ({
            ...current,
            error: reason instanceof Error ? reason.message : String(reason),
          }));
        }
        return false;
      }
    },
    [activeTaskId, workspacePath],
  );

  const resolveMcpElicitation = useCallback(
    async (
      requestId: number | string,
      response: AgentMcpElicitationResponse,
    ) => {
      const scope: AgentRuntimeTaskScope = {
        workspacePath,
        generation: workspaceScopeRef.current.generation,
        taskId: activeTaskId,
      };
      const operationIsActive = () => agentRuntimeTaskScopeMatches(
        workspaceScopeRef.current,
        activeTaskIdRef.current,
        scope,
      );
      if (!operationIsActive()) return false;
      try {
        const request = mcpElicitationRequestsRef.current.find((candidate) =>
          candidate.taskId === scope.taskId &&
          String(candidate.requestId) === String(requestId)
        );
        if (!request) {
          throw new Error("This MCP form is no longer attached to a live Xiao run.");
        }
        await nativeBridge.resolveXiaoRunInput(request.pendingInputId, response);
        if (!operationIsActive()) return false;
        updateMcpElicitationRequests((current) =>
          removeAgentMcpElicitationRequest(current, request)
        );
        setRuntime((current) => ({ ...current, error: null }));
        return true;
      } catch (reason) {
        if (operationIsActive()) {
          setRuntime((current) => ({
            ...current,
            error: reason instanceof Error ? reason.message : String(reason),
          }));
        }
        return false;
      }
    },
    [activeTaskId, updateMcpElicitationRequests, workspacePath],
  );

  const stateIsCurrentWorkspace = stateWorkspacePath === workspacePath;
  const scopedRunProjection = stateIsCurrentWorkspace
    ? runProjection
    : emptyRunProjection();
  const scopedRuntime = stateIsCurrentWorkspace ? runtime : initialRuntime;
  const activeThreadId = stateIsCurrentWorkspace
    ? sessionIds.current.get(activeTaskId) ?? null
    : null;
  const activeRun = activeRunForTask(scopedRunProjection, activeTaskId);
  const latestRun = latestRunForTask(scopedRunProjection, activeTaskId);
  const compacting = stateIsCurrentWorkspace && compactingTaskId === activeTaskId;
  const canCompact =
    scopedRuntime.phase === "ready" &&
    Boolean(activeThreadId) &&
    compactingTaskId === null;
  const canUndo = scopedRuntime.phase === "ready" && Boolean(
    activeThreadId && latestUndoableTurn(activeTaskTimeline),
  );

  return {
    runtime: scopedRuntime,
    account: stateIsCurrentWorkspace ? account : null,
    accountUsage: stateIsCurrentWorkspace ? accountUsage : null,
    rateLimits: stateIsCurrentWorkspace ? rateLimits : null,
    models: stateIsCurrentWorkspace ? models : [],
    timeline: activeTaskTimeline,
    runtimeLogs: stateIsCurrentWorkspace ? runtimeLogs : [],
    questionRequest:
      stateIsCurrentWorkspace && questionRequest?.taskId === activeTaskId
        ? questionRequest
        : null,
    mcpElicitationRequest:
      stateIsCurrentWorkspace
        ? mcpElicitationRequests.find((request) => request.taskId === activeTaskId) ?? null
        : null,
    contextUsage: activeThreadId && stateIsCurrentWorkspace
      ? threadUsage[activeThreadId] ?? null
      : null,
    hasThread: Boolean(activeThreadId),
    canCompact,
    compacting,
    canUndo,
    undoing:
      stateIsCurrentWorkspace &&
      Boolean(undoingScope && agentRuntimeTaskScopeMatches(
        workspaceScopeRef.current,
        activeTaskId,
        undoingScope,
      )),
    usage,
    activeRun,
    latestRun,
    runs: Object.values(scopedRunProjection.runsById).sort(
      (left, right) => right.queuedAt - left.queuedAt || right.id.localeCompare(left.id),
    ),
    pendingInputs: Object.values(scopedRunProjection.pendingInputsById),
    attentionHydrationStatus: stateIsCurrentWorkspace
      ? attentionHydrationStatus
      : isTauriHost() ? "loading" : "ready",
    retryAttentionHydration,
    hasActiveRuns: Object.values(scopedRunProjection.runsById).some((run) =>
      runStatusIsActive(run.status)
    ),
    workingTaskIds: [...new Set(
      Object.values(scopedRunProjection.runsById)
        .filter((run) => runStatusIsActive(run.status))
        .map((run) => run.taskId),
    )],
    isTaskWorking: (taskId: string) => Boolean(activeRunForTask(scopedRunProjection, taskId)),
    connect,
    submit,
    steer,
    compact,
    interrupt,
    retryRun,
    setApprovalPolicy,
    undoLastTurn,
    setGoal,
    clearGoal,
    resolveQuestion,
    resolveMcpElicitation,
    resolveApproval,
  };
}
