export type CompanionGrant =
  | "read_projects"
  | "read_tasks"
  | "read_runs"
  | "read_attention"
  | "read_safe_timeline"
  | "read_verification"
  | "read_observatory"
  | "resolve_pending_input"
  | "stop_run"
  | "retry_run"
  | "send_follow_up"
  | "acknowledge_attention"
  | "accept_outcome";

export type CompanionPairingCredential = {
  pairingId: string;
  ownerCredential: string;
  expiresAt: number;
};

export type CompanionPairingBundle = {
  endpoint: string;
  serverName: string;
  certificatePem: string;
  certificateFingerprint: string;
  pairingId: string;
  ownerCredential: string;
  expiresAt: number;
};

export type CompanionSessionReference = {
  referenceId: string;
  sessionId: string;
  deviceId: string;
  generation: number;
  endpoint: string;
  certificateFingerprint: string;
};

export type CompanionSessionCredential = {
  sessionId: string;
  deviceId: string;
  generation: number;
  secret: string;
};

export type CompanionSession = {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  grants: CompanionGrant[];
  generation: number;
  createdAt: number;
  lastSeenAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
};

export type ExchangedCompanionSession = {
  credential: CompanionSessionCredential;
  session: CompanionSession;
};

export type CompanionReconnectCursor = {
  generation: number;
  sequence: number;
  snapshot?: { baseSequence: number } | null;
};

export type CompanionProjectionUpdate = {
  sequence: number;
  eventId: string;
  generation: number;
  kind:
    | "project"
    | "task"
    | "task_stage"
    | "run"
    | "pending_input"
    | "attention"
    | "safe_timeline"
    | "verification"
    | "observatory";
  entityId: string;
  entityVersion: number;
  payload: unknown;
  occurredAt: number;
};

export type CompanionSyncBatch = {
  phase: "stale" | "reconciling" | "live";
  generation: number;
  fromSequence: number;
  cursor: number;
  latestSequence: number;
  isSnapshot: boolean;
  hasMore: boolean;
  nextSnapshot: { baseSequence: number } | null;
  updates: CompanionProjectionUpdate[];
};

export type CompanionNotificationCursor = {
  createdAt: number;
  attentionId: string;
};

export type CompanionNotificationPage = {
  notifications: Array<{
    attentionId: string;
    kind: string;
    title: string;
    body: string;
    deepLink: string;
    createdAt: number;
  }>;
  nextCursor: CompanionNotificationCursor | null;
  hasMore: boolean;
};

export type CompanionCommandEnvelope = {
  sessionId: string;
  sessionGeneration: number;
  deviceId: string;
  commandId: string;
  idempotencyKey: string;
  expectedVersion: number;
  target: { kind: string; id: string; projectId?: string };
  auditTimestamp: number;
  capability: string;
  payload: unknown;
};

export type CompanionCommandResult = {
  commandId: string;
  state: "pending_host_acknowledgement" | "succeeded" | "refused";
  acknowledgement: {
    acknowledgementId: string;
    resultingVersion: number;
    acknowledgedAt: number;
    detail: unknown;
  } | null;
  refusalCode: string | null;
  message: string | null;
};

export type CompanionAuditRecord = {
  id: string;
  commandId: string | null;
  sessionId: string | null;
  deviceId: string;
  capability: string;
  target: { kind: string; id: string };
  decision: string;
  reason: string;
  createdAt: number;
};
