// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompanionProjectionUpdate } from "./companionClient";

const client = vi.hoisted(() => ({
  pair: vi.fn(),
  poll: vi.fn(),
  confirmReconciled: vi.fn(),
  pollNotifications: vi.fn(),
  command: vi.fn(),
  installRotation: vi.fn(),
  delete: vi.fn(),
}));
const bridge = vi.hoisted(() => ({
  listCompanionSessions: vi.fn(),
  issueCompanionPairingBundle: vi.fn(),
  rotateCompanionSession: vi.fn(),
  revokeCompanionSession: vi.fn(),
  revokeCompanionDevice: vi.fn(),
}));

vi.mock("./nativeCompanionClient", () => ({
  nativeCompanionClient: client,
}));

vi.mock("../../core/bridges/tauri", () => ({
  isTauriHost: () => true,
  nativeBridge: bridge,
}));

import { CompanionPage } from "./CompanionPage";

const fingerprint = `sha256:${"ab".repeat(32)}`;
const session = {
  referenceId: "session-device-1",
  sessionId: "session-device-1",
  deviceId: "device-1",
  generation: 1,
  endpoint: "https://192.0.2.10:4318",
  certificateFingerprint: fingerprint,
};

const updates: CompanionProjectionUpdate[] = [
  {
    sequence: 1,
    eventId: "project-1",
    generation: 65_535,
    kind: "project",
    entityId: "project-1",
    entityVersion: 1,
    payload: { id: "project-1", name: "Xiao", taskCount: 2, attentionCount: 0 },
    occurredAt: 1_900_000_000_000,
  },
  {
    sequence: 2,
    eventId: "task-1",
    generation: 65_535,
    kind: "task",
    entityId: "project-1/task-1",
    entityVersion: 4,
    payload: {
      id: "task-1",
      projectId: "project-1",
      title: "Release Companion",
      stage: "in_progress",
      version: 4,
      currentRunId: "run-1",
      outcomeAcceptancePermitted: true,
    },
    occurredAt: 1_900_000_001_000,
  },
  {
    sequence: 3,
    eventId: "run-1",
    generation: 65_535,
    kind: "run",
    entityId: "run-1",
    entityVersion: 5,
    payload: {
      id: "run-1",
      projectId: "project-1",
      taskId: "task-1",
      status: "waiting_for_input",
      version: 5,
      canStop: true,
      canRetry: false,
      canFollowUp: true,
      safeSummary: "Waiting for approval.",
    },
    occurredAt: 1_900_000_002_000,
  },
  {
    sequence: 4,
    eventId: "task-2",
    generation: 65_535,
    kind: "task",
    entityId: "project-1/task-2",
    entityVersion: 3,
    payload: {
      id: "task-2",
      projectId: "project-1",
      title: "Retry release check",
      stage: "in_progress",
      version: 3,
      currentRunId: "run-2",
      outcomeAcceptancePermitted: false,
    },
    occurredAt: 1_900_000_003_000,
  },
  {
    sequence: 5,
    eventId: "run-2",
    generation: 65_535,
    kind: "run",
    entityId: "run-2",
    entityVersion: 6,
    payload: {
      id: "run-2",
      projectId: "project-1",
      taskId: "task-2",
      status: "failed",
      version: 6,
      canStop: false,
      canRetry: true,
      canFollowUp: false,
      safeSummary: "Release check failed.",
    },
    occurredAt: 1_900_000_004_000,
  },
  {
    sequence: 6,
    eventId: "pending-1",
    generation: 65_535,
    kind: "pending_input",
    entityId: "pending-1",
    entityVersion: 2,
    payload: {
      id: "pending-1",
      runId: "run-1",
      version: 2,
      kind: "approval",
      safePrompt: "Allow the bounded command?",
      options: [{ id: "allow_once", label: "Allow once" }],
    },
    occurredAt: 1_900_000_005_000,
  },
];

const page = {
  phase: "reconciling" as const,
  generation: 65_535,
  fromSequence: 0,
  cursor: 6,
  latestSequence: 6,
  isSnapshot: true,
  hasMore: false,
  nextSnapshot: null,
  updates,
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: vi.fn()
      .mockReturnValueOnce("device-1")
      .mockReturnValueOnce("command-stop")
      .mockReturnValueOnce("command-retry")
      .mockReturnValueOnce("command-follow-up")
      .mockReturnValueOnce("command-accept")
      .mockReturnValue("command-approval"),
  });
  bridge.listCompanionSessions.mockResolvedValue([
    {
      sessionId: "phone-session",
      deviceId: "phone",
      deviceName: "Operator phone",
      grants: ["read_tasks", "stop_run"],
      generation: 1,
      createdAt: 1_900_000_000,
      lastSeenAt: 1_900_000_010,
      rotatedAt: null,
      revokedAt: null,
    },
    {
      sessionId: "tablet-session",
      deviceId: "tablet",
      deviceName: "Operator tablet",
      grants: ["read_tasks"],
      generation: 1,
      createdAt: 1_900_000_001,
      lastSeenAt: 1_900_000_011,
      rotatedAt: null,
      revokedAt: null,
    },
  ]);
  bridge.revokeCompanionDevice.mockResolvedValue(undefined);
  client.pair.mockResolvedValue({ session, certificateFingerprint: fingerprint });
  client.poll.mockImplementation(async (_session, cursor) => cursor
    ? {
      ...page,
      fromSequence: cursor.sequence,
      cursor: cursor.sequence,
      isSnapshot: false,
      updates: [],
    }
    : page);
  client.confirmReconciled.mockImplementation(async (_session, cursor) => ({
    phase: "live",
    generation: cursor.generation,
    fromSequence: cursor.sequence,
    cursor: cursor.sequence,
    latestSequence: cursor.sequence,
    isSnapshot: false,
    hasMore: false,
    nextSnapshot: null,
    updates: [],
  }));
  client.pollNotifications.mockResolvedValue({
    notifications: [],
    nextCursor: null,
    hasMore: false,
  });
  client.command.mockResolvedValue({
    status: "acknowledged",
    acknowledgedAt: 1_900_000_004_000,
  });
  client.delete.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("Companion application journey", () => {
  it("keeps two-device revocation under primary-host authority", async () => {
    render(<CompanionPage />);

    await screen.findByText("Operator phone");
    expect(screen.getByText("Operator tablet")).toBeTruthy();
    expect(screen.getByText("Primary-host administration. Owner pairing credentials are short-lived and single-use."))
      .toBeTruthy();

    const revokeButtons = screen.getAllByRole("button", { name: "Revoke device" });
    fireEvent.click(revokeButtons[0]);
    await waitFor(() => expect(bridge.revokeCompanionDevice).toHaveBeenCalledWith("phone"));
    expect(client.command).not.toHaveBeenCalled();
  });

  it("clears an expired pairing bundle instead of rendering its credential", async () => {
    const bundle = {
      endpoint: "https://192.0.2.10:4318",
      serverName: "xiao-companion.local",
      certificatePem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----",
      certificateFingerprint: fingerprint,
      pairingId: "pairing-expired",
      ownerCredential: "owner-expired",
      expiresAt: Date.now() - 1,
    };
    bridge.issueCompanionPairingBundle.mockResolvedValue(bundle);
    render(<CompanionPage />);
    await screen.findByText("Operator phone");

    fireEvent.click(screen.getByRole("button", { name: "Create pairing bundle" }));

    expect(await screen.findByText(/pairing bundle expired/i)).toBeTruthy();
    expect(screen.queryByDisplayValue(JSON.stringify(bundle))).toBeNull();
  });

  it("conceals a rotated credential until the operator reveals it", async () => {
    const credential = {
      sessionId: "phone-session",
      deviceId: "phone",
      generation: 2,
      secret: "rotated-secret",
    };
    bridge.rotateCompanionSession.mockResolvedValue({ credential });
    render(<CompanionPage />);
    await screen.findByText("Operator phone");

    fireEvent.click(screen.getAllByRole("button", { name: "Rotate" })[0]);

    expect(await screen.findByText("Rotation credential — transfer it once")).toBeTruthy();
    expect(screen.queryByDisplayValue(JSON.stringify(credential))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal rotation credential" }));
    expect(screen.getByDisplayValue(JSON.stringify(credential))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Rotation credential — transfer it once")).toBeNull();
  });

  it("keeps the native credential reference when keyring deletion is not acknowledged", async () => {
    localStorage.setItem("xiao.companion.session.v1", JSON.stringify(session));
    client.delete.mockRejectedValueOnce(new Error("keyring unavailable"));
    render(<CompanionPage />);
    fireEvent.click(screen.getByRole("button", { name: "Connected device" }));
    await screen.findByText("Live");

    fireEvent.click(screen.getByRole("button", { name: "Forget this host" }));
    await screen.findByText(/credential may still remain in the native keyring/i);

    expect(localStorage.getItem("xiao.companion.session.v1")).not.toBeNull();
    expect(screen.getByText(`Paired with ${session.endpoint}`)).toBeTruthy();
  });

  it("starts notification polling from a fresh cursor after pairing a different host", async () => {
    const firstCursor = {
      createdAt: 1_900_000_010,
      attentionId: "attention-host-a",
    };
    const secondSession = {
      ...session,
      referenceId: "session-device-2",
      sessionId: "session-device-2",
      endpoint: "https://192.0.2.20:4318",
    };
    localStorage.setItem("xiao.companion.session.v1", JSON.stringify(session));
    client.pollNotifications
      .mockResolvedValueOnce({
        notifications: [],
        nextCursor: firstCursor,
        hasMore: false,
      })
      .mockResolvedValue({
        notifications: [],
        nextCursor: null,
        hasMore: false,
      });

    render(<CompanionPage />);
    fireEvent.click(screen.getByRole("button", { name: "Connected device" }));
    await waitFor(() => {
      expect(client.pollNotifications).toHaveBeenCalledWith(session, null);
    });

    fireEvent.click(screen.getByRole("button", { name: "Forget this host" }));
    await screen.findByRole("heading", { name: "Pair with a primary host" });

    client.pair.mockResolvedValueOnce({
      session: secondSession,
      certificateFingerprint: fingerprint,
    });
    fireEvent.change(screen.getByLabelText("Primary host pairing bundle"), {
      target: {
        value: JSON.stringify({
          endpoint: secondSession.endpoint,
          serverName: "xiao-companion.local",
          certificatePem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n",
          certificateFingerprint: fingerprint,
          pairingId: "pairing-2",
          ownerCredential: "owner-twice",
          expiresAt: 2_000_000_000_000,
        }),
      },
    });
    fireEvent.change(screen.getByLabelText("Device name"), {
      target: { value: "Operator tablet" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair device" }));

    await screen.findByText(`Paired with ${secondSession.endpoint}`);
    await waitFor(() => {
      expect(client.pollNotifications).toHaveBeenCalledWith(secondSession, null);
    });
  });

  it("reports a second action while the first still awaits the primary host", async () => {
    localStorage.setItem("xiao.companion.session.v1", JSON.stringify(session));
    client.command.mockImplementationOnce(() => new Promise(() => undefined));

    render(<CompanionPage />);
    fireEvent.click(screen.getByRole("button", { name: "Connected device" }));
    await screen.findByText("Live");

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByText(
      "Another Companion action is still awaiting the primary host. Wait for it to finish before trying again.",
    );
    expect(client.command).toHaveBeenCalledTimes(1);
  });

  it("pairs, reconciles, performs only bounded actions, and recovers stale state", async () => {
    render(<CompanionPage />);
    fireEvent.click(screen.getByRole("button", { name: "Connected device" }));
    fireEvent.change(screen.getByLabelText("Primary host pairing bundle"), {
      target: {
        value: JSON.stringify({
          endpoint: session.endpoint,
          serverName: "xiao-companion.local",
          certificatePem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----",
          certificateFingerprint: fingerprint,
          pairingId: "pairing-1",
          ownerCredential: "owner-once",
          expiresAt: 2_000_000_000_000,
        }),
      },
    });
    fireEvent.change(screen.getByLabelText("Device name"), {
      target: { value: "Operator phone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair device" }));

    await screen.findByRole("heading", { name: "Xiao Companion" });
    await screen.findByText("Live");
    expect(screen.getByText("Release Companion")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        action: { kind: "stop_run", runId: "run-1" },
        expectedEntityVersion: 5,
      }),
    ));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        action: { kind: "retry_run", runId: "run-2" },
        expectedEntityVersion: 6,
      }),
    ));
    fireEvent.change(screen.getByLabelText("Bounded follow-up"), {
      target: { value: "Run the focused release check." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        action: {
          kind: "follow_up",
          runId: "run-1",
          message: "Run the focused release check.",
        },
        expectedEntityVersion: 5,
      }),
    ));
    fireEvent.click(screen.getByRole("button", { name: "Accept outcome" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        action: { kind: "accept_outcome", taskId: "task-1" },
        expectedEntityVersion: 4,
      }),
    ));
    expect(screen.queryByRole("button", { name: /terminal|files|settings|publish/i })).toBeNull();

    client.poll.mockRejectedValueOnce(new Error("host disconnected"));
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        action: {
          kind: "resolve_pending_input",
          pendingInputId: "pending-1",
          inputKind: "approval",
          optionId: "allow_once",
        },
        expectedEntityVersion: 2,
      }),
    ));
    await screen.findByText("Cached data is stale");
    expect((screen.getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled)
      .toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await screen.findByText("Live");
    expect(client.confirmReconciled).toHaveBeenCalled();
  });
});
