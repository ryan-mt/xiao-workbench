import {
  companionReducer,
  type CompanionCommand,
  type CompanionCommandFailure,
  type CompanionIncrementalUpdate,
  type CompanionSnapshot,
  type CompanionState,
} from "./companionContract";

export type CompanionSessionReference = {
  referenceId: string;
  endpoint: string;
  deviceId: string;
  sessionId: string;
  generation: number;
  certificateFingerprint: string;
};

export type CompanionPairingRequest = {
  pairingCode: string;
  deviceId: string;
  deviceName: string;
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

export type CompanionPinnedExchangeRequest = CompanionPairingBundle & {
  deviceId: string;
  deviceName: string;
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

export type CompanionPollPage = {
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

export type CompanionCommandResult =
  | { status: "acknowledged"; acknowledgedAt: number }
  | { status: "rejected"; rejectedAt: number; error: CompanionCommandFailure };

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

/**
 * Implemented by the native layer. Pairing performs the pinned exchange and
 * writes all credentials and trust material to the keyring before returning.
 * Later calls resolve that material internally from this non-secret reference.
 */
export type NativeCompanionClient = {
  pair(
    request: CompanionPinnedExchangeRequest,
  ): Promise<{
    session: CompanionSessionReference;
    certificateFingerprint: string;
  }>;
  poll(
    session: CompanionSessionReference,
    cursor: CompanionReconnectCursor | null,
  ): Promise<CompanionPollPage>;
  confirmReconciled(
    session: CompanionSessionReference,
    cursor: CompanionReconnectCursor,
  ): Promise<CompanionPollPage>;
  pollNotifications(
    session: CompanionSessionReference,
    cursor: CompanionNotificationCursor | null,
  ): Promise<CompanionNotificationPage>;
  command(
    session: CompanionSessionReference,
    command: CompanionCommand,
  ): Promise<CompanionCommandResult>;
  installRotation(
    session: CompanionSessionReference,
    rotationCode: string,
  ): Promise<CompanionSessionReference>;
  delete(session: CompanionSessionReference): Promise<void>;
};

export const normalizeCompanionEndpoint = (value: string) => {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw new Error("Enter the primary host HTTPS address.");
  }
  if (endpoint.protocol !== "https:") {
    throw new Error("Companion access requires an HTTPS primary host.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Use an HTTPS host address without credentials, query parameters, or fragments.");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  return endpoint.toString().replace(/\/$/, "");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const parseCompanionPairingBundle = (
  pairingCode: string,
  now = Date.now(),
): CompanionPairingBundle => {
  let value: unknown;
  try {
    value = JSON.parse(pairingCode.trim());
  } catch {
    throw new Error("The pairing bundle is malformed.");
  }
  if (!isRecord(value)) throw new Error("The pairing bundle is malformed.");
  const {
    endpoint,
    serverName,
    certificatePem,
    certificateFingerprint,
    pairingId,
    ownerCredential,
    expiresAt,
  } = value;
  if (
    typeof endpoint !== "string"
    || typeof serverName !== "string"
    || typeof certificatePem !== "string"
    || typeof certificateFingerprint !== "string"
    || typeof pairingId !== "string"
    || typeof ownerCredential !== "string"
    || typeof expiresAt !== "number"
    || !Number.isSafeInteger(expiresAt)
  ) {
    throw new Error("The pairing bundle is malformed.");
  }
  const normalizedEndpoint = normalizeCompanionEndpoint(endpoint);
  let parsedServerName: URL;
  try {
    parsedServerName = new URL(`https://${serverName}`);
  } catch {
    throw new Error("The pairing bundle has an invalid TLS server name.");
  }
  if (
    !serverName
    || parsedServerName.hostname !== serverName.toLowerCase()
    || parsedServerName.port
    || parsedServerName.pathname !== "/"
    || parsedServerName.username
    || parsedServerName.password
    || parsedServerName.search
    || parsedServerName.hash
  ) {
    throw new Error("The pairing bundle has an invalid TLS server name.");
  }
  if (
    !certificatePem.trim().startsWith("-----BEGIN CERTIFICATE-----")
    || !certificatePem.trim().endsWith("-----END CERTIFICATE-----")
    || !/^sha256:[a-f0-9]{64}$/i.test(certificateFingerprint)
    || !ownerCredential.trim()
    || !pairingId.trim()
  ) {
    throw new Error("The pairing bundle is malformed.");
  }
  if (expiresAt <= now) throw new Error("The pairing bundle has expired.");
  return {
    endpoint: normalizedEndpoint,
    serverName: serverName.toLowerCase(),
    certificatePem,
    certificateFingerprint: certificateFingerprint.toLowerCase(),
    pairingId: pairingId.trim(),
    ownerCredential: ownerCredential.trim(),
    expiresAt,
  };
};

const encodeBase64Url = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const buildCompanionBrowserPairingUrl = (
  pairingCode: string,
  now = Date.now(),
) => {
  const bundle = parseCompanionPairingBundle(pairingCode, now);
  return `${bundle.endpoint}/#pair=${encodeBase64Url(pairingCode.trim())}`;
};

export const pairCompanionDevice = async (
  request: CompanionPairingRequest,
  nativeClient: NativeCompanionClient,
  now = Date.now(),
) => {
  const bundle = parseCompanionPairingBundle(request.pairingCode, now);
  const exchangeRequest = {
    ...bundle,
    deviceId: request.deviceId,
    deviceName: request.deviceName.trim(),
  };
  if (!exchangeRequest.deviceName) {
    throw new Error("Device name is required.");
  }
  const exchanged = await nativeClient.pair(exchangeRequest);
  const session: CompanionSessionReference = {
    referenceId: exchanged.session.referenceId,
    endpoint: exchanged.session.endpoint,
    deviceId: exchanged.session.deviceId,
    sessionId: exchanged.session.sessionId,
    generation: exchanged.session.generation,
    certificateFingerprint: exchanged.session.certificateFingerprint,
  };
  if (exchanged.certificateFingerprint.toLowerCase() !== bundle.certificateFingerprint) {
    await nativeClient.delete(session).catch(() => undefined);
    throw new Error("The primary host certificate does not match the pairing bundle.");
  }
  if (
    !session.referenceId
    || !session.sessionId
    || session.endpoint !== bundle.endpoint
    || session.deviceId !== request.deviceId
  ) {
    await nativeClient.delete(session).catch(() => undefined);
    throw new Error("The primary host returned a session for a different Companion device.");
  }
  return session;
};

export const reconcileCompanion = async (
  state: CompanionState,
  session: CompanionSessionReference,
  nativeClient: NativeCompanionClient,
  onState?: (next: CompanionState) => void,
) => {
  let next = companionReducer(state, { type: "connected" });
  onState?.(next);
  let cursor: CompanionReconnectCursor | null =
    state.hostGeneration === null || state.cursor === null
      ? null
      : { generation: state.hostGeneration, sequence: state.cursor, snapshot: null };
  let hasMore = true;
  while (hasMore) {
    const beforePageCursor = cursor;
    const page = await nativeClient.poll(session, cursor);
    if (
      cursor !== null
      && page.generation === cursor.generation
      && page.fromSequence !== cursor.sequence
    ) {
      throw new Error("The primary host returned a discontinuous Companion page.");
    }
    if (page.isSnapshot && (cursor === null || cursor.generation !== page.generation)) {
      next = companionReducer(next, {
        type: "snapshot_received",
        snapshot: {
          hostGeneration: page.generation,
          cursor: page.fromSequence,
          capturedAt: Date.now(),
          projection: emptyProjection(),
        },
      });
      onState?.(next);
    }
    if (page.cursor > (next.cursor ?? -1)) {
      next = companionReducer(next, {
        type: "increment_received",
        update: projectionDelta(page),
      });
      onState?.(next);
    }
    cursor = {
      generation: page.generation,
      sequence: page.cursor,
      snapshot: page.nextSnapshot,
    };
    if (
      page.hasMore
      && beforePageCursor?.sequence === cursor.sequence
      && beforePageCursor.snapshot?.baseSequence === cursor.snapshot?.baseSequence
    ) {
      throw new Error("The primary host returned an empty Companion page without advancing.");
    }
    hasMore = page.hasMore;
  }

  if (next.cursor === null || cursor === null || cursor.snapshot) {
    throw new Error("The primary host did not provide a reconciliation cursor.");
  }
  const confirmed = await nativeClient.confirmReconciled(session, cursor);
  next = companionReducer(next, {
    type: "reconciliation_completed",
    cursor: confirmed.cursor,
  });
  onState?.(next);
  return next;
};

const emptyProjection = (): CompanionSnapshot["projection"] => ({
  projects: [],
  tasks: [],
  runs: [],
  pendingInputs: [],
  attention: [],
  timeline: [],
  verification: [],
  observatory: [],
});

const projectionDelta = (page: CompanionPollPage): CompanionIncrementalUpdate => {
  const projection: CompanionIncrementalUpdate["projection"] = {};
  const removals: NonNullable<CompanionIncrementalUpdate["removals"]> = {};
  const keyForKind = (kind: CompanionProjectionUpdate["kind"]) => {
    switch (kind) {
      case "project": return "projects";
      case "task":
      case "task_stage": return "tasks";
      case "run": return "runs";
      case "pending_input": return "pendingInputs";
      case "attention": return "attention";
      case "safe_timeline": return "timeline";
      case "verification": return "verification";
      case "observatory": return "observatory";
    }
  };
  for (const update of page.updates) {
    if (update.generation !== page.generation || !isRecord(update.payload)) {
      throw new Error("The primary host sent an invalid Companion projection update.");
    }
    const key = keyForKind(update.kind);
    if (update.payload.deleted === true) {
      (removals[key] ??= []).push(update.entityId);
    } else {
      const values = (projection[key] ??= []) as unknown[];
      values.push(update.payload);
    }
  }
  const occurredAt = page.updates.at(-1)?.occurredAt;
  return {
    hostGeneration: page.generation,
    cursor: page.cursor,
    capturedAt: occurredAt === undefined ? Date.now() : occurredAt,
    projection,
    removals,
  };
};

export const executeCompanionCommand = async (
  state: CompanionState,
  session: CompanionSessionReference,
  command: CompanionCommand,
  nativeClient: NativeCompanionClient,
  onState?: (next: CompanionState) => void,
) => {
  if (state.connection !== "live" || state.stale) {
    throw new Error("Reconnect and reconcile Companion data before taking action.");
  }
  if (command.deviceId !== session.deviceId) {
    throw new Error("The command belongs to a different Companion device.");
  }
  let next = companionReducer(state, { type: "command_sent", command });
  onState?.(next);
  let result: CompanionCommandResult;
  try {
    result = await nativeClient.command(session, command);
  } catch (reason) {
    next = companionReducer(next, {
      type: "command_rejected",
      commandId: command.commandId,
      rejectedAt: Date.now(),
      error: {
        scope: "The primary host acknowledgement could not be confirmed.",
        durableEffect:
          "The action may have reached the host; Xiao will not report it as successful.",
        recovery:
          "Reconnect, reconcile canonical state, and reuse the same idempotency key if retrying.",
      },
    });
    onState?.(next);
    throw reason;
  }
  next = result.status === "acknowledged"
    ? companionReducer(next, {
      type: "command_acknowledged",
      commandId: command.commandId,
      acknowledgedAt: result.acknowledgedAt,
    })
    : companionReducer(next, {
      type: "command_rejected",
      commandId: command.commandId,
      rejectedAt: result.rejectedAt,
      error: result.error,
    });
  onState?.(next);
  return next;
};
