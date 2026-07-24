import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompanionCommand } from "./companionContract";
import type { CompanionSessionReference } from "./companionClient";

const bridge = vi.hoisted(() => ({
  pairRemoteCompanion: vi.fn(),
  pollRemoteCompanion: vi.fn(),
  confirmRemoteCompanion: vi.fn(),
  pollRemoteCompanionNotifications: vi.fn(),
  executeRemoteCompanionCommand: vi.fn(),
  installRemoteCompanionRotation: vi.fn(),
  forgetRemoteCompanion: vi.fn(),
}));

vi.mock("../../core/bridges/tauri", () => ({
  nativeBridge: bridge,
}));

import { nativeCompanionClient } from "./nativeCompanionClient";

const session: CompanionSessionReference = {
  referenceId: "session-1",
  sessionId: "session-1",
  deviceId: "device-1",
  generation: 3,
  endpoint: "https://192.0.2.10:4318",
  certificateFingerprint: `sha256:${"ab".repeat(32)}`,
};

const command = (action: CompanionCommand["action"]): CompanionCommand => ({
  deviceId: session.deviceId,
  commandId: "command-1",
  idempotencyKey: "device-1:command-1",
  expectedEntityVersion: 7,
  targetScope: {
    projectId: "project-1",
    taskId: "task-1",
    runId: "run-1",
    pendingInputId: "input-1",
  },
  auditTimestamp: 1_800_000_000_123,
  action,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("native Companion boundary", () => {
  it("sends the complete pin bundle once and returns only a non-secret reference", async () => {
    bridge.pairRemoteCompanion.mockResolvedValue(session);
    const result = await nativeCompanionClient.pair({
      endpoint: session.endpoint,
      serverName: "xiao-companion.local",
      certificatePem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----",
      certificateFingerprint: session.certificateFingerprint,
      pairingId: "pairing-1",
      ownerCredential: "owner-once",
      expiresAt: 1_900_000_000_000,
      deviceId: session.deviceId,
      deviceName: "Operator phone",
    });

    const pairingCode = JSON.parse(bridge.pairRemoteCompanion.mock.calls[0]?.[0] as string);
    expect(pairingCode).toMatchObject({
      endpoint: session.endpoint,
      serverName: "xiao-companion.local",
      pairingId: "pairing-1",
      ownerCredential: "owner-once",
    });
    expect(result.session).toEqual(session);
    expect(result.session).not.toHaveProperty("secret");
  });

  it("maps pending input kind, identity, scope, version, and millisecond audit time", async () => {
    bridge.executeRemoteCompanionCommand.mockResolvedValue({
      commandId: "command-1",
      state: "succeeded",
      acknowledgement: {
        acknowledgementId: "host:command-1",
        resultingVersion: 8,
        acknowledgedAt: 1_800_000_000_124,
        detail: { durableEffect: "runtime_outbox" },
      },
      refusalCode: null,
      message: null,
    });

    await nativeCompanionClient.command(session, command({
      kind: "resolve_pending_input",
      pendingInputId: "input-1",
      inputKind: "question",
      optionId: "answer-1",
    }));

    expect(bridge.executeRemoteCompanionCommand).toHaveBeenCalledWith(
      session.referenceId,
      expect.objectContaining({
        sessionId: session.sessionId,
        sessionGeneration: 3,
        deviceId: session.deviceId,
        commandId: "command-1",
        idempotencyKey: "device-1:command-1",
        expectedVersion: 7,
        auditTimestamp: 1_800_000_000_123,
        capability: "resolve_question",
        target: {
          kind: "pending_input",
          id: "input-1",
          projectId: "project-1",
        },
        payload: { optionId: "answer-1" },
      }),
    );
  });

  it("reports success only when the native host returns a durable acknowledgement", async () => {
    bridge.executeRemoteCompanionCommand
      .mockResolvedValueOnce({
        commandId: "command-1",
        state: "pending_host_acknowledgement",
        acknowledgement: null,
        refusalCode: null,
        message: "The host has not acknowledged this command.",
      })
      .mockResolvedValueOnce({
        commandId: "command-1",
        state: "succeeded",
        acknowledgement: {
          acknowledgementId: "host:command-1",
          resultingVersion: 8,
          acknowledgedAt: 1_800_000_000_124,
          detail: { durableEffect: "runtime_outbox" },
        },
        refusalCode: null,
        message: null,
      });

    await expect(nativeCompanionClient.command(
      session,
      command({ kind: "stop_run", runId: "run-1" }),
    )).resolves.toEqual({
      status: "acknowledged",
      acknowledgedAt: 1_800_000_000_124,
    });
    expect(bridge.executeRemoteCompanionCommand).toHaveBeenCalledTimes(2);
  });

  it("installs a rotation through the native keyring boundary", async () => {
    const rotated = { ...session, generation: 4 };
    bridge.installRemoteCompanionRotation.mockResolvedValue(rotated);

    await expect(
      nativeCompanionClient.installRotation(session, "{\"generation\":4}"),
    ).resolves.toEqual(rotated);
    expect(bridge.installRemoteCompanionRotation).toHaveBeenCalledWith(
      session.referenceId,
      "{\"generation\":4}",
    );
  });
});
