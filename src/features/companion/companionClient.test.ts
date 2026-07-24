import { describe, expect, it, vi } from "vitest";

import {
  executeCompanionCommand,
  normalizeCompanionEndpoint,
  parseCompanionPairingBundle,
  pairCompanionDevice,
  reconcileCompanion,
  type CompanionSessionReference,
  type NativeCompanionClient,
} from "./companionClient";
import {
  buildCompanionCommand,
  emptyCompanionProjection,
  initialCompanionState,
  type CompanionSnapshot,
  type CompanionState,
} from "./companionContract";

const snapshot = (cursor: number): CompanionSnapshot => ({
  hostGeneration: 4,
  cursor,
  capturedAt: 1_800_000_000_000 + cursor,
  projection: {
    ...emptyCompanionProjection(),
    projects: [{ id: "project-1", name: "Xiao", taskCount: 1, attentionCount: 0 }],
  },
});

const certificatePem = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n";
const certificateFingerprint = `sha256:${"ab".repeat(32)}`;
const pairingCode = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  endpoint: "https://xiao.local:4318/",
  serverName: "xiao.local",
  certificatePem,
  certificateFingerprint,
  pairingId: "pairing-once",
  ownerCredential: "owner-once",
  expiresAt: 1_900_000_000_000,
  ...overrides,
});

const nativeClient = (
  overrides: Partial<NativeCompanionClient> = {},
): NativeCompanionClient => ({
  pair: vi.fn(async (request) => ({
    certificateFingerprint: request.certificateFingerprint,
    session: {
      referenceId: `session-${request.deviceId}`,
      endpoint: request.endpoint,
      deviceId: request.deviceId,
      sessionId: `session-${request.deviceId}`,
      generation: 1,
      certificateFingerprint: request.certificateFingerprint,
      secret: "must-not-cross-the-native-boundary",
    },
  })),
  poll: vi.fn(async () => ({
    phase: "reconciling" as const,
    generation: 4,
    fromSequence: 0,
    cursor: 1,
    latestSequence: 1,
    isSnapshot: true,
    hasMore: false,
    nextSnapshot: null,
    updates: [{
      sequence: 1,
      eventId: "project-1:1",
      generation: 4,
      kind: "project" as const,
      entityId: "project-1",
      entityVersion: 1,
      payload: snapshot(1).projection.projects[0],
      occurredAt: 1_800_000_000_000,
    }],
  })),
  confirmReconciled: vi.fn(async (_session, cursor) => ({
    phase: "live" as const,
    generation: cursor.generation,
    fromSequence: cursor.sequence,
    cursor: cursor.sequence,
    latestSequence: cursor.sequence,
    isSnapshot: false,
    hasMore: false,
    nextSnapshot: null,
    updates: [],
  })),
  pollNotifications: vi.fn(async () => ({
    notifications: [],
    nextCursor: null,
    hasMore: false,
  })),
  command: vi.fn(async () => ({
    status: "acknowledged" as const,
    acknowledgedAt: 1_800_000_000_100,
  })),
  installRotation: vi.fn(async (session) => ({ ...session, generation: session.generation + 1 })),
  delete: vi.fn(async () => undefined),
  ...overrides,
});

describe("Companion client connection", () => {
  it("accepts only credential-free HTTPS primary-host endpoints", () => {
    expect(normalizeCompanionEndpoint(" https://xiao.local:4318/ ")).toBe(
      "https://xiao.local:4318",
    );
    expect(() => normalizeCompanionEndpoint("http://xiao.local:4318")).toThrow(/requires.*HTTPS/i);
    expect(() => normalizeCompanionEndpoint("https://owner@xiao.local")).toThrow(/without credentials/i);
    expect(() => normalizeCompanionEndpoint("https://xiao.local?secret=value")).toThrow(
      /without credentials/i,
    );
  });

  it("parses the complete out-of-band trust bundle and rejects malformed or expired bundles", () => {
    expect(parseCompanionPairingBundle(pairingCode(), 1_800_000_000_000)).toEqual({
      endpoint: "https://xiao.local:4318",
      serverName: "xiao.local",
      certificatePem,
      certificateFingerprint,
      pairingId: "pairing-once",
      ownerCredential: "owner-once",
      expiresAt: 1_900_000_000_000,
    });
    expect(() => parseCompanionPairingBundle("not-json", 1_800_000_000_000)).toThrow(
      /malformed/i,
    );
    expect(() => parseCompanionPairingBundle(
      pairingCode({ expiresAt: 1_700_000_000_000 }),
      1_800_000_000_000,
    )).toThrow(/expired/i);
    expect(() => parseCompanionPairingBundle(
      pairingCode({ certificatePem: "not a certificate" }),
      1_800_000_000_000,
    )).toThrow(/malformed/i);
  });

  it("returns only separate non-secret references for two logical devices", async () => {
    const client = nativeClient();
    const baseRequest = {
      pairingCode: pairingCode(),
      deviceName: "Operator device",
    };

    const phone = await pairCompanionDevice(
      { ...baseRequest, deviceId: "phone" },
      client,
      1_800_000_000_000,
    );
    const tablet = await pairCompanionDevice(
      {
        ...baseRequest,
        pairingCode: pairingCode({ ownerCredential: "owner-twice" }),
        deviceId: "tablet",
      },
      client,
      1_800_000_000_000,
    );

    expect(phone).not.toHaveProperty("secret");
    expect(tablet).not.toHaveProperty("secret");
    expect(phone).toEqual({
      referenceId: "session-phone",
      endpoint: "https://xiao.local:4318",
      deviceId: "phone",
      sessionId: "session-phone",
      generation: 1,
      certificateFingerprint,
    });
    expect(tablet).toMatchObject({ deviceId: "tablet", sessionId: "session-tablet" });
  });

  it("passes PEM, server name, and fingerprint on the first exchange and refuses a mismatch", async () => {
    const pair = vi.fn(async () => ({
      certificateFingerprint: `sha256:${"cd".repeat(32)}`,
      session: {
        referenceId: "session-phone",
        endpoint: "https://xiao.local:4318",
        deviceId: "phone",
        sessionId: "session-phone",
        generation: 1,
        certificateFingerprint: `sha256:${"cd".repeat(32)}`,
      },
    }));
    const client = nativeClient({
      pair,
    });

    await expect(pairCompanionDevice({
      pairingCode: pairingCode(),
      deviceId: "phone",
      deviceName: "Operator phone",
    }, client, 1_800_000_000_000)).rejects.toThrow(/certificate does not match/i);
    expect(pair).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "https://xiao.local:4318",
      serverName: "xiao.local",
      certificatePem,
      certificateFingerprint,
      ownerCredential: "owner-once",
    }));
    expect(client.delete).toHaveBeenCalledWith({
      referenceId: "session-phone",
      endpoint: "https://xiao.local:4318",
      deviceId: "phone",
      sessionId: "session-phone",
      generation: 1,
      certificateFingerprint: `sha256:${"cd".repeat(32)}`,
    });
  });

  it("reconciles ordered pages, ignores duplicate replay, and confirms before going live", async () => {
    const session: CompanionSessionReference = {
      referenceId: "session-phone",
      endpoint: "https://xiao.local",
      deviceId: "phone",
      sessionId: "session-phone",
      generation: 1,
      certificateFingerprint,
    };
    const poll = vi.fn()
      .mockResolvedValueOnce({
        phase: "reconciling",
        generation: 4,
        fromSequence: 0,
        cursor: 11,
        latestSequence: 12,
        isSnapshot: true,
        updates: [{
          sequence: 11,
          eventId: "project-1:11",
          generation: 4,
          kind: "project",
          entityId: "project-1",
          entityVersion: 11,
          payload: { id: "project-1", name: "Xiao", taskCount: 2, attentionCount: 1 },
          occurredAt: 1_800_000_000_000,
        }],
        hasMore: true,
        nextSnapshot: { baseSequence: 12 },
      })
      .mockResolvedValueOnce({
        phase: "reconciling",
        generation: 4,
        fromSequence: 11,
        cursor: 12,
        latestSequence: 12,
        isSnapshot: true,
        updates: [{
          sequence: 12,
          eventId: "project-1:12",
          generation: 4,
          kind: "project",
          entityId: "project-1",
          entityVersion: 12,
          payload: { id: "project-1", name: "Xiao", taskCount: 2, attentionCount: 1 },
          occurredAt: 1_800_000_001_000,
        }],
        hasMore: false,
        nextSnapshot: null,
      });
    const client = nativeClient({ poll });
    const states: string[] = [];

    const reconciled = await reconcileCompanion(
      initialCompanionState(),
      session,
      client,
      (state) => states.push(`${state.connection}:${state.cursor}`),
    );

    expect(poll.mock.calls.map(([, cursor]) => cursor)).toEqual([
      null,
      { generation: 4, sequence: 11, snapshot: { baseSequence: 12 } },
    ]);
    expect(reconciled).toMatchObject({ connection: "live", stale: false, cursor: 12 });
    expect(reconciled.projection.projects[0]).toMatchObject({ taskCount: 2, attentionCount: 1 });
    expect(states.at(-1)).toBe("live:12");
  });

  it("replaces cached projections when a grant change advances the authorization epoch", async () => {
    const session: CompanionSessionReference = {
      referenceId: "session-phone",
      endpoint: "https://xiao.local",
      deviceId: "phone",
      sessionId: "session-phone",
      generation: 1,
      certificateFingerprint,
    };
    const priorGeneration = 4_294_967_297;
    const nextGeneration = priorGeneration + 1;
    const state: CompanionState = {
      ...initialCompanionState(),
      connection: "live",
      stale: false,
      hostGeneration: priorGeneration,
      cursor: 9,
      projection: {
        ...emptyCompanionProjection(),
        projects: [{ id: "project-1", name: "Xiao", taskCount: 1, attentionCount: 0 }],
        runs: [{
          id: "run-1",
          projectId: "project-1",
          taskId: "task-1",
          status: "running",
          version: 1,
          canStop: true,
          canRetry: false,
          canFollowUp: true,
          safeSummary: "Previously authorized run.",
        }],
      },
    };
    const poll = vi.fn(async () => ({
      phase: "reconciling" as const,
      generation: nextGeneration,
      fromSequence: 0,
      cursor: 1,
      latestSequence: 1,
      isSnapshot: true,
      hasMore: false,
      nextSnapshot: null,
      updates: [{
        sequence: 1,
        eventId: "project-1:filtered",
        generation: nextGeneration,
        kind: "project" as const,
        entityId: "project-1",
        entityVersion: 2,
        payload: { id: "project-1", name: "Xiao", taskCount: 1, attentionCount: 0 },
        occurredAt: 1_800_000_001_000,
      }],
    }));

    const reconciled = await reconcileCompanion(state, session, nativeClient({ poll }));

    expect(reconciled.hostGeneration).toBe(nextGeneration);
    expect(reconciled.projection.runs).toEqual([]);
    expect(poll).toHaveBeenCalledWith(session, {
      generation: priorGeneration,
      sequence: 9,
      snapshot: null,
    });
  });

  it("keeps an action awaiting the host and never announces false success", async () => {
    const session: CompanionSessionReference = {
      referenceId: "session-phone",
      endpoint: "https://xiao.local",
      deviceId: "phone",
      sessionId: "session-phone",
      generation: 1,
      certificateFingerprint,
    };
    let acknowledge: ((value: {
      status: "acknowledged";
      acknowledgedAt: number;
    }) => void) | undefined;
    const commandResult = new Promise<{
      status: "acknowledged";
      acknowledgedAt: number;
    }>((resolve) => {
      acknowledge = resolve;
    });
    const client = nativeClient({ command: vi.fn(() => commandResult) });
    const state = {
      ...initialCompanionState(),
      connection: "live" as const,
      stale: false,
    };
    const command = buildCompanionCommand({
      deviceId: "phone",
      commandId: "command-1",
      idempotencyKey: "phone:command-1",
      auditTimestamp: 1_800_000_000_000,
    }, 2, { runId: "run-1" }, { kind: "stop_run", runId: "run-1" });
    const observed: CompanionState[] = [];

    const pending = executeCompanionCommand(
      state,
      session,
      command,
      client,
      (next) => observed.push(next),
    );
    await vi.waitFor(() => expect(observed).toHaveLength(1));
    expect(observed[0]?.commands["command-1"]).toMatchObject({ state: "awaiting_host" });
    expect(observed[0]?.lastAnnouncement.toLowerCase()).not.toContain("success");

    acknowledge?.({ status: "acknowledged", acknowledgedAt: 1_800_000_000_100 });
    const complete = await pending;
    expect(complete.commands["command-1"]).toMatchObject({ state: "acknowledged" });
  });

  it("reports an unknown durable effect when transport fails before host acknowledgement", async () => {
    const session: CompanionSessionReference = {
      referenceId: "session-phone",
      endpoint: "https://xiao.local",
      deviceId: "phone",
      sessionId: "session-phone",
      generation: 1,
      certificateFingerprint,
    };
    const state = {
      ...initialCompanionState(),
      connection: "live" as const,
      stale: false,
    };
    const command = buildCompanionCommand({
      deviceId: "phone",
      commandId: "command-unknown",
      idempotencyKey: "phone:command-unknown",
      auditTimestamp: 1_800_000_000_000,
    }, 2, { runId: "run-1" }, { kind: "stop_run", runId: "run-1" });
    const observed: CompanionState[] = [];

    await expect(executeCompanionCommand(
      state,
      session,
      command,
      nativeClient({ command: vi.fn(async () => {
        throw new Error("connection closed");
      }) }),
      (next) => observed.push(next),
    )).rejects.toThrow("connection closed");

    expect(observed.at(-1)?.commands["command-unknown"]).toMatchObject({
      state: "rejected",
      error: {
        durableEffect: expect.stringContaining("may have reached"),
        recovery: expect.stringContaining("same idempotency key"),
      },
    });
  });
});
