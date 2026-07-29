export type CompanionConnection = "disconnected" | "reconciling" | "live";
export type CompanionTaskStage =
  | "draft"
  | "in_progress"
  | "ready_for_review"
  | "published"
  | "completed";

export type CompanionDevice = {
  id: string;
  name: string;
  version: number;
  createdAt: number;
  lastSeenAt: number | null;
  grants: string[];
  revokedAt: number | null;
  sessions: Array<{
    id: string;
    version: number;
    createdAt: number;
    lastSeenAt: number | null;
    rotatedAt: number | null;
    revokedAt: number | null;
  }>;
};

export type CompanionPairing = {
  status: "idle" | "creating" | "ready" | "exchanging" | "expired" | "failed";
  ownerCredential: string | null;
  expiresAt: number | null;
  error: string | null;
};

export type CompanionProjectSummary = {
  id: string;
  name: string;
  taskCount: number;
  attentionCount: number;
};

export type CompanionTaskSummary = {
  id: string;
  projectId: string;
  title: string;
  stage: CompanionTaskStage;
  version: number;
  currentRunId: string | null;
  outcomeAcceptancePermitted: boolean;
};

export type CompanionRunSummary = {
  id: string;
  projectId?: string;
  taskId: string;
  status: string;
  version: number;
  canStop: boolean;
  canRetry: boolean;
  canFollowUp: boolean;
  safeSummary: string;
};

export type CompanionPendingInputSummary = {
  id: string;
  runId: string;
  version: number;
  kind: "approval" | "question" | "mcp_elicitation";
  safePrompt: string;
  options: Array<{ id: string; label: string }>;
};

export type CompanionAttentionSummary = {
  id: string;
  projectId: string;
  taskId: string;
  runId: string | null;
  version: number;
  kind: string;
  title: string;
  safeSummary: string;
  acknowledged: boolean;
};

export type CompanionTimelineSummary = {
  id: string;
  taskId: string;
  runId: string;
  occurredAt: number;
  kind: string;
  safeSummary: string;
};

export type CompanionVerificationSummary = {
  runId: string;
  status: "not_run" | "running" | "passed" | "failed" | "blocked";
  safeSummary: string;
};

export type CompanionObservatorySummary = {
  runId: string;
  activeAgents: number;
  waitingAgents: number;
  safeLatestActivity: string | null;
};

export type CompanionProjection = {
  projects: CompanionProjectSummary[];
  tasks: CompanionTaskSummary[];
  runs: CompanionRunSummary[];
  pendingInputs: CompanionPendingInputSummary[];
  attention: CompanionAttentionSummary[];
  timeline: CompanionTimelineSummary[];
  verification: CompanionVerificationSummary[];
  observatory: CompanionObservatorySummary[];
};

export type CompanionSnapshot = {
  hostGeneration: number;
  cursor: number;
  capturedAt: number;
  projection: CompanionProjection;
};

export type CompanionIncrementalUpdate = {
  hostGeneration: number;
  cursor: number;
  capturedAt: number;
  projection: Partial<CompanionProjection>;
  removals?: Partial<Record<keyof CompanionProjection, string[]>>;
};

export type CompanionTargetScope = {
  projectId?: string;
  taskId?: string;
  runId?: string;
  attentionId?: string;
  pendingInputId?: string;
};

export type CompanionAction =
  | {
      kind: "resolve_pending_input";
      pendingInputId: string;
      inputKind: CompanionPendingInputSummary["kind"];
      optionId: string;
    }
  | { kind: "stop_run"; runId: string }
  | { kind: "retry_run"; runId: string }
  | { kind: "follow_up"; runId: string; message: string }
  | { kind: "acknowledge_attention"; attentionId: string }
  | { kind: "accept_outcome"; taskId: string };

export type CompanionCommand = {
  deviceId: string;
  commandId: string;
  idempotencyKey: string;
  expectedEntityVersion: number;
  targetScope: CompanionTargetScope;
  auditTimestamp: number;
  action: CompanionAction;
};

export type CompanionCommandFailure = {
  scope: string;
  durableEffect: string;
  recovery: string;
};

export type CompanionCommandStatus =
  | { state: "awaiting_host"; command: CompanionCommand }
  | { state: "acknowledged"; command: CompanionCommand; acknowledgedAt: number }
  | {
      state: "rejected";
      command: CompanionCommand;
      rejectedAt: number;
      error: CompanionCommandFailure;
    };

export type CompanionNotification = {
  attentionId: string;
  safeTitle: string;
  grantVersion: number;
  deepLink: { kind: "attention"; attentionId: string };
};

export const isPrivacyBoundedNotification = (notification: CompanionNotification) =>
  notification.attentionId === notification.deepLink.attentionId
  && notification.deepLink.kind === "attention"
  && notification.safeTitle.trim().length > 0
  && notification.safeTitle.length <= 120;

export const authorizedCompanionNotificationDeepLink = (
  notification: CompanionNotification,
  currentGrantVersion: number,
  sessionActive: boolean,
) => sessionActive
  && notification.grantVersion === currentGrantVersion
  && isPrivacyBoundedNotification(notification)
  ? notification.deepLink
  : null;

export type CompanionState = {
  connection: CompanionConnection;
  stale: boolean;
  hostGeneration: number | null;
  cursor: number | null;
  capturedAt: number | null;
  projection: CompanionProjection;
  commands: Record<string, CompanionCommandStatus>;
  lastAnnouncement: string;
};

export const emptyCompanionProjection = (): CompanionProjection => ({
  projects: [],
  tasks: [],
  runs: [],
  pendingInputs: [],
  attention: [],
  timeline: [],
  verification: [],
  observatory: [],
});

export const initialCompanionState = (): CompanionState => ({
  connection: "disconnected",
  stale: true,
  hostGeneration: null,
  cursor: null,
  capturedAt: null,
  projection: emptyCompanionProjection(),
  commands: {},
  lastAnnouncement: "Disconnected. Cached Companion data is stale.",
});

export type CompanionStateEvent =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "snapshot_received"; snapshot: CompanionSnapshot }
  | { type: "increment_received"; update: CompanionIncrementalUpdate }
  | { type: "reconciliation_completed"; cursor: number }
  | { type: "command_sent"; command: CompanionCommand }
  | { type: "command_acknowledged"; commandId: string; acknowledgedAt: number }
  | {
      type: "command_rejected";
      commandId: string;
      rejectedAt: number;
      error: CompanionCommandFailure;
    };

const mergeProjection = (
  projection: CompanionProjection,
  update: Partial<CompanionProjection>,
  removals: CompanionIncrementalUpdate["removals"] = {},
): CompanionProjection => {
  const merge = <T>(
    current: T[],
    incoming: T[] | undefined,
    removed: string[] | undefined,
    key: (value: T) => string,
  ) => {
    const values = new Map(current.map((value) => [key(value), value]));
    for (const id of removed ?? []) values.delete(id);
    for (const value of incoming ?? []) values.set(key(value), value);
    return [...values.values()];
  };
  return {
    projects: merge(projection.projects, update.projects, removals.projects, (value) => value.id),
    tasks: merge(
      projection.tasks,
      update.tasks,
      removals.tasks,
      (value) => `${value.projectId}/${value.id}`,
    ),
    runs: merge(projection.runs, update.runs, removals.runs, (value) => value.id),
    pendingInputs: merge(
      projection.pendingInputs,
      update.pendingInputs,
      removals.pendingInputs,
      (value) => value.id,
    ),
    attention: merge(
      projection.attention,
      update.attention,
      removals.attention,
      (value) => value.id,
    ),
    timeline: merge(
      projection.timeline,
      update.timeline,
      removals.timeline,
      (value) => value.id,
    ).slice(-200),
    verification: merge(
      projection.verification,
      update.verification,
      removals.verification,
      (value) => value.runId,
    ),
    observatory: merge(
      projection.observatory,
      update.observatory,
      removals.observatory,
      (value) => value.runId,
    ),
  };
};

export const companionReducer = (
  state: CompanionState,
  event: CompanionStateEvent,
): CompanionState => {
  if (event.type === "disconnected") {
    return {
      ...state,
      connection: "disconnected",
      stale: true,
      lastAnnouncement: "Disconnected. Cached Companion data is stale.",
    };
  }
  if (event.type === "connected") {
    return {
      ...state,
      connection: "reconciling",
      stale: true,
      lastAnnouncement: "Connected. Reconciling missed updates before going live.",
    };
  }
  if (event.type === "snapshot_received") {
    if (state.hostGeneration !== null && event.snapshot.hostGeneration < state.hostGeneration) {
      return state;
    }
    if (
      event.snapshot.hostGeneration === state.hostGeneration
      && state.cursor !== null
      && event.snapshot.cursor <= state.cursor
    ) return state;
    return {
      ...state,
      connection: "reconciling",
      stale: true,
      hostGeneration: event.snapshot.hostGeneration,
      cursor: event.snapshot.cursor,
      capturedAt: event.snapshot.capturedAt,
      projection: event.snapshot.projection,
    };
  }
  if (event.type === "increment_received") {
    if (state.hostGeneration !== null && event.update.hostGeneration < state.hostGeneration) {
      return state;
    }
    if (event.update.hostGeneration !== state.hostGeneration) {
      return {
        ...state,
        connection: "reconciling",
        stale: true,
        lastAnnouncement: "The primary host generation changed. A fresh snapshot is required.",
      };
    }
    if (state.cursor !== null && event.update.cursor <= state.cursor) return state;
    if (state.cursor === null) {
      return {
        ...state,
        connection: "reconciling",
        stale: true,
        lastAnnouncement: "An update gap was found. Reconciliation is required.",
      };
    }
    return {
      ...state,
      cursor: event.update.cursor,
      capturedAt: event.update.capturedAt,
      projection: mergeProjection(
        state.projection,
        event.update.projection,
        event.update.removals,
      ),
    };
  }
  if (event.type === "reconciliation_completed") {
    if (event.cursor !== state.cursor || state.connection === "disconnected") return state;
    return {
      ...state,
      connection: "live",
      stale: false,
      lastAnnouncement: "Companion data is live.",
    };
  }
  if (event.type === "command_sent") {
    return {
      ...state,
      commands: {
        ...state.commands,
        [event.command.commandId]: { state: "awaiting_host", command: event.command },
      },
      lastAnnouncement: "Action sent. Waiting for the primary host.",
    };
  }
  const current = state.commands[event.commandId];
  if (!current || current.state !== "awaiting_host") return state;
  if (event.type === "command_acknowledged") {
    return {
      ...state,
      commands: {
        ...state.commands,
        [event.commandId]: {
          state: "acknowledged",
          command: current.command,
          acknowledgedAt: event.acknowledgedAt,
        },
      },
      lastAnnouncement: "The primary host acknowledged the action.",
    };
  }
  return {
    ...state,
    commands: {
      ...state.commands,
      [event.commandId]: {
        state: "rejected",
        command: current.command,
        rejectedAt: event.rejectedAt,
        error: event.error,
      },
    },
    lastAnnouncement: `${event.error.scope}: ${event.error.durableEffect} ${event.error.recovery}`,
  };
};

export type CompanionCommandIdentity = {
  deviceId: string;
  commandId: string;
  idempotencyKey: string;
  auditTimestamp: number;
};

export const buildCompanionCommand = (
  identity: CompanionCommandIdentity,
  expectedEntityVersion: number,
  targetScope: CompanionTargetScope,
  action: CompanionAction,
): CompanionCommand => ({
  ...identity,
  expectedEntityVersion,
  targetScope,
  action,
});
