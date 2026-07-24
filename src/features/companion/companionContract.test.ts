import { describe, expect, it } from "vitest";

import {
  authorizedCompanionNotificationDeepLink,
  buildCompanionCommand,
  companionReducer,
  emptyCompanionProjection,
  initialCompanionState,
  isPrivacyBoundedNotification,
  type CompanionSnapshot,
} from "./companionContract";

const snapshot = (cursor: number): CompanionSnapshot => ({
  hostGeneration: 2,
  cursor,
  capturedAt: 1_800_000_000_000 + cursor,
  projection: {
    ...emptyCompanionProjection(),
    projects: [{ id: "project-1", name: "Xiao", taskCount: 1, attentionCount: 0 }],
  },
});

describe("companionReducer", () => {
  it("stays stale through snapshot reconciliation and becomes live only at the reconciled cursor", () => {
    const connected = companionReducer(initialCompanionState(), { type: "connected" });
    const hydrated = companionReducer(connected, {
      type: "snapshot_received",
      snapshot: snapshot(10),
    });
    const wrongCursor = companionReducer(hydrated, {
      type: "reconciliation_completed",
      cursor: 9,
    });
    const live = companionReducer(wrongCursor, {
      type: "reconciliation_completed",
      cursor: 10,
    });

    expect(connected).toMatchObject({ connection: "reconciling", stale: true });
    expect(hydrated).toMatchObject({ connection: "reconciling", stale: true, cursor: 10 });
    expect(wrongCursor).toBe(hydrated);
    expect(live).toMatchObject({ connection: "live", stale: false, cursor: 10 });
  });

  it("applies ordered increments and ignores duplicate replay", () => {
    const hydrated = companionReducer(initialCompanionState(), {
      type: "snapshot_received",
      snapshot: snapshot(10),
    });
    const increment = {
      type: "increment_received" as const,
      update: {
        hostGeneration: 2,
        cursor: 11,
        capturedAt: 1_800_000_000_011,
        projection: {
          projects: [{ id: "project-1", name: "Xiao", taskCount: 2, attentionCount: 1 }],
        },
      },
    };
    const updated = companionReducer(hydrated, increment);
    const duplicate = companionReducer(updated, increment);

    expect(updated.cursor).toBe(11);
    expect(updated.projection.projects[0]).toMatchObject({ taskCount: 2, attentionCount: 1 });
    expect(duplicate).toBe(updated);
  });

  it("keeps only the latest 200 safe timeline summaries", () => {
    const hydrated = companionReducer(initialCompanionState(), {
      type: "snapshot_received",
      snapshot: snapshot(10),
    });
    const timeline = Array.from({ length: 250 }, (_, index) => ({
      id: `run-1:${index + 1}`,
      taskId: "task-1",
      runId: "run-1",
      occurredAt: 1_800_000_000_000 + index,
      kind: "agent.progress",
      safeSummary: `Progress ${index + 1}`,
    }));
    const updated = companionReducer(hydrated, {
      type: "increment_received",
      update: {
        hostGeneration: 2,
        cursor: 11,
        capturedAt: 1_800_000_000_250,
        projection: { timeline },
      },
    });

    expect(updated.projection.timeline).toHaveLength(200);
    expect(updated.projection.timeline[0]?.id).toBe("run-1:51");
    expect(updated.projection.timeline.at(-1)?.id).toBe("run-1:250");
  });

  it("accepts an authenticated cursor jump when filtered grants hide intervening updates", () => {
    const live = {
      ...initialCompanionState(),
      connection: "live" as const,
      stale: false,
      hostGeneration: 2,
      cursor: 10,
    };
    const next = companionReducer(live, {
      type: "increment_received",
      update: {
        hostGeneration: 2,
        cursor: 12,
        capturedAt: 1_800_000_000_012,
        projection: { projects: [] },
      },
    });

    expect(next).toMatchObject({
      connection: "live",
      stale: false,
      cursor: 12,
    });
  });

  it("marks cached state stale immediately on disconnect", () => {
    const disconnected = companionReducer({
      ...initialCompanionState(),
      connection: "live",
      stale: false,
      hostGeneration: 2,
      cursor: 3,
      projection: snapshot(3).projection,
    }, { type: "disconnected" });

    expect(disconnected).toMatchObject({
      connection: "disconnected",
      stale: true,
      cursor: 3,
    });
    expect(disconnected.projection.projects).toHaveLength(1);
  });

  it("rejects late host generations and requires a snapshot for a newer generation", () => {
    const hydrated = companionReducer(initialCompanionState(), {
      type: "snapshot_received",
      snapshot: snapshot(10),
    });
    const late = companionReducer(hydrated, {
      type: "increment_received",
      update: {
        hostGeneration: 1,
        cursor: 11,
        capturedAt: 1_800_000_000_011,
        projection: { projects: [] },
      },
    });
    const newer = companionReducer(hydrated, {
      type: "increment_received",
      update: {
        hostGeneration: 3,
        cursor: 1,
        capturedAt: 1_800_000_000_012,
        projection: { projects: [] },
      },
    });

    expect(late).toBe(hydrated);
    expect(newer).toMatchObject({
      connection: "reconciling",
      stale: true,
      hostGeneration: 2,
      cursor: 10,
    });
    expect(newer.lastAnnouncement).toContain("fresh snapshot");
  });

  it("does not report command success before host acknowledgement", () => {
    const command = buildCompanionCommand(
      {
        deviceId: "device-1",
        commandId: "command-1",
        idempotencyKey: "device-1:command-1",
        auditTimestamp: 1_800_000_000_000,
      },
      4,
      { projectId: "project-1", taskId: "task-1", runId: "run-1" },
      { kind: "stop_run", runId: "run-1" },
    );
    const sent = companionReducer(initialCompanionState(), {
      type: "command_sent",
      command,
    });
    const acknowledged = companionReducer(sent, {
      type: "command_acknowledged",
      commandId: command.commandId,
      acknowledgedAt: 1_800_000_000_010,
    });

    expect(sent.commands[command.commandId]).toMatchObject({ state: "awaiting_host" });
    expect(sent.lastAnnouncement).toContain("Waiting for the primary host");
    expect(sent.lastAnnouncement.toLowerCase()).not.toContain("success");
    expect(acknowledged.commands[command.commandId]).toMatchObject({
      state: "acknowledged",
      acknowledgedAt: 1_800_000_000_010,
    });
    expect(acknowledged.lastAnnouncement).toContain("acknowledged");
  });

  it("reports a rejected command with scope, durable effect, and safe recovery", () => {
    const command = buildCompanionCommand(
      {
        deviceId: "device-1",
        commandId: "command-1",
        idempotencyKey: "device-1:command-1",
        auditTimestamp: 1_800_000_000_000,
      },
      2,
      { attentionId: "attention-1" },
      { kind: "acknowledge_attention", attentionId: "attention-1" },
    );
    const sent = companionReducer(initialCompanionState(), { type: "command_sent", command });
    const rejected = companionReducer(sent, {
      type: "command_rejected",
      commandId: command.commandId,
      rejectedAt: 1_800_000_000_010,
      error: {
        scope: "Attention item attention-1",
        durableEffect: "No acknowledgement was recorded.",
        recovery: "Refresh the item and try again.",
      },
    });

    expect(rejected.lastAnnouncement).toBe(
      "Attention item attention-1: No acknowledgement was recorded. Refresh the item and try again.",
    );
  });
});

describe("Companion client contract", () => {
  it("includes every host authorization and audit field in a command envelope", () => {
    const command = buildCompanionCommand(
      {
        deviceId: "device-1",
        commandId: "command-1",
        idempotencyKey: "idempotency-1",
        auditTimestamp: 1_800_000_000_000,
      },
      7,
      { projectId: "project-1", taskId: "task-1" },
      { kind: "accept_outcome", taskId: "task-1" },
    );

    expect(command).toEqual({
      deviceId: "device-1",
      commandId: "command-1",
      idempotencyKey: "idempotency-1",
      expectedEntityVersion: 7,
      targetScope: { projectId: "project-1", taskId: "task-1" },
      auditTimestamp: 1_800_000_000_000,
      action: { kind: "accept_outcome", taskId: "task-1" },
    });
  });

  it("only accepts notifications that deep-link to the same canonical Attention item", () => {
    const notification = {
      attentionId: "attention-1",
      safeTitle: "Approval needed",
      grantVersion: 3,
      deepLink: { kind: "attention", attentionId: "attention-1" },
    } as const;
    expect(isPrivacyBoundedNotification(notification)).toBe(true);
    expect(authorizedCompanionNotificationDeepLink(notification, 3, true)).toEqual(
      { kind: "attention", attentionId: "attention-1" },
    );
    expect(authorizedCompanionNotificationDeepLink(notification, 4, true)).toBeNull();
    expect(authorizedCompanionNotificationDeepLink(notification, 3, false)).toBeNull();
    expect(isPrivacyBoundedNotification({
      attentionId: "attention-1",
      safeTitle: "Approval needed",
      grantVersion: 3,
      deepLink: { kind: "attention", attentionId: "attention-2" },
    })).toBe(false);
  });
});
