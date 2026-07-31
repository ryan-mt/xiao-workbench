// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompanionSession } from "../../core/models/companion";

const bridge = vi.hoisted(() => ({
  listCompanionSessions: vi.fn(),
  issueCompanionPairingBundle: vi.fn(),
  rotateCompanionSession: vi.fn(),
  revokeCompanionSession: vi.fn(),
  revokeCompanionDevice: vi.fn(),
}));

vi.mock("../../core/bridges/tauri", () => ({
  isTauriHost: () => true,
  nativeBridge: bridge,
}));

import { CompanionHostPage, groupCompanionDevices } from "./CompanionHostPage";

const DEFAULT_GRANT_LABELS = [
  "Read projects",
  "Read tasks",
  "Read runs",
  "Read attention",
  "Read safe timeline",
  "Read verification",
  "Read observatory",
];

const DEFAULT_GRANTS = [
  "read_projects",
  "read_tasks",
  "read_runs",
  "read_attention",
  "read_safe_timeline",
  "read_verification",
  "read_observatory",
];

const pairingBundle = (expiresAt = Date.now() + 60_000) => ({
  endpoint: "https://192.0.2.10:4318",
  serverName: "xiao-companion.local",
  certificatePem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----",
  certificateFingerprint: `sha256:${"ab".repeat(32)}`,
  pairingId: "pairing-1",
  ownerCredential: "owner-once",
  expiresAt,
});

const session = (
  sessionId: string,
  generation: number,
  revokedAt: number | null,
): CompanionSession => ({
  sessionId,
  deviceId: "device-1",
  deviceName: "Operator phone",
  grants: ["read_projects", "read_tasks"],
  generation,
  createdAt: 100,
  lastSeenAt: 200 + generation,
  rotatedAt: generation > 1 ? 150 : null,
  revokedAt,
});

beforeEach(() => {
  vi.clearAllMocks();
  bridge.listCompanionSessions.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Companion primary-host projection", () => {
  it("groups sessions under one inspectable device without exposing credentials", () => {
    const [device] = groupCompanionDevices([
      session("session-a", 1, 300),
      session("session-b", 2, null),
    ]);

    expect(device).toMatchObject({
      id: "device-1",
      name: "Operator phone",
      version: 2,
      grants: ["Read Projects", "Read Tasks"],
      revokedAt: null,
    });
    expect(device.sessions.map(({ id, version, revokedAt }) => ({ id, version, revokedAt })))
      .toEqual([
        { id: "session-a", version: 1, revokedAt: 300_000 },
        { id: "session-b", version: 2, revokedAt: null },
      ]);
    expect(JSON.stringify(device)).not.toContain("secret");
  });

  it("uses safe defaults, passes explicit opt-ins, freezes ready grants, and resets on dismiss", async () => {
    const bundle = pairingBundle();
    bridge.issueCompanionPairingBundle.mockResolvedValue(bundle);
    render(createElement(CompanionHostPage));
    await act(async () => {
      await Promise.resolve();
    });

    for (const label of DEFAULT_GRANT_LABELS) {
      expect((screen.getByRole("checkbox", { name: label }) as HTMLInputElement).checked).toBe(true);
    }
    expect((screen.getByRole("checkbox", {
      name: "Read conversation (opt-in)",
    }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Stop runs" }) as HTMLInputElement).checked)
      .toBe(false);

    fireEvent.click(screen.getByRole("checkbox", { name: "Read conversation (opt-in)" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Stop runs" }));
    fireEvent.click(screen.getByRole("button", { name: "Create pairing bundle" }));

    expect(bridge.issueCompanionPairingBundle).toHaveBeenCalledWith(300, [
      ...DEFAULT_GRANTS,
      "read_conversation",
      "stop_run",
    ]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Single-use pairing bundle")).toBeTruthy();
    expect((screen.getByRole("group", { name: "Pairing grants" }) as HTMLFieldSetElement).disabled)
      .toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect((screen.getByRole("group", { name: "Pairing grants" }) as HTMLFieldSetElement).disabled)
      .toBe(false);
    for (const label of DEFAULT_GRANT_LABELS) {
      expect((screen.getByRole("checkbox", { name: label }) as HTMLInputElement).checked).toBe(true);
    }
    expect((screen.getByRole("checkbox", {
      name: "Read conversation (opt-in)",
    }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Stop runs" }) as HTMLInputElement).checked)
      .toBe(false);
  });

  it("resets pairing grants to safe defaults when a ready bundle expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    bridge.issueCompanionPairingBundle.mockResolvedValue(pairingBundle(Date.now() + 1_000));
    render(createElement(CompanionHostPage));
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "Stop runs" }));
    fireEvent.click(screen.getByRole("button", { name: "Create pairing bundle" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Single-use pairing bundle")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByText(/pairing bundle expired/i)).toBeTruthy();
    expect((screen.getByRole("group", { name: "Pairing grants" }) as HTMLFieldSetElement).disabled)
      .toBe(false);
    for (const label of DEFAULT_GRANT_LABELS) {
      expect((screen.getByRole("checkbox", { name: label }) as HTMLInputElement).checked).toBe(true);
    }
    expect((screen.getByRole("checkbox", { name: "Stop runs" }) as HTMLInputElement).checked)
      .toBe(false);
  });
});
