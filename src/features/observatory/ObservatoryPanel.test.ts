// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunEventRecord, RunSnapshot } from "../../core/models/run";

const bridge = vi.hoisted(() => ({
  listXiaoRuns: vi.fn(async () => []),
  listXiaoPendingInputs: vi.fn(async () => []),
  listXiaoTurnCheckpoints: vi.fn(async () => []),
  loadXiaoRunEvents: vi.fn(async () => ({ events: [], nextSequence: null })),
}));

vi.mock("../../core/bridges/tauri", () => ({
  nativeBridge: bridge,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { loadRunEvents, ObservatoryPanel } from "./ObservatoryPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("loadRunEvents", () => {
  it("keeps the newest 10,000 events when a run exceeds the display cap", async () => {
    const availableEvents: RunEventRecord[] = Array.from({ length: 10_050 }, (_, sequence) => ({
      runId: "run-1",
      sequence,
      timestamp: sequence,
      eventType: "test",
      eventKey: null,
      safePayload: null,
    }));
    const loadPage = vi.fn(async (
      _runId: string,
      afterSequence: number | null = null,
      limit = 200,
    ) => {
      const start = (afterSequence ?? -1) + 1;
      const events = availableEvents.slice(start, start + limit);
      return {
        events,
        nextSequence: events.at(-1)?.sequence ?? null,
      };
    });

    const events = await loadRunEvents("run-1", -1, loadPage);

    expect(events).toHaveLength(10_000);
    expect(events[0]?.sequence).toBe(50);
    expect(events.at(-1)?.sequence).toBe(10_049);
    expect(loadPage).toHaveBeenCalledTimes(51);
  });
});

const observableRun: RunSnapshot = {
  id: "run-attention",
  workspacePath: "C:/projects/xiao",
  taskId: "task-a",
  idempotencyKey: "run-attention",
  parentRunId: null,
  candidateGroupId: null,
  routineOccurrenceId: null,
  acceptanceContractSourceVersionId: null,
  acceptanceContractSnapshot: null,
  acceptanceContractSnapshotSha256: null,
  verificationBaselineState: "notRequired",
  verificationBaselineArtifactId: null,
  verificationBaselineDiagnostic: null,
  latestVerificationAttemptId: null,
  status: "failed",
  agentOutcome: "failed",
  verificationOutcome: "not_requested",
  executionEnvironmentId: "windows",
  executionRoot: "C:/projects/xiao",
  managedWorktreeId: null,
  prompt: "Reproduce the failure",
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  mode: "agent",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  threadId: null,
  threadSource: null,
  cliVersion: null,
  runtimeGeneration: null,
  turnId: null,
  cancelRequested: false,
  queuedAt: 10,
  startedAt: 11,
  finishedAt: 12,
  version: 1,
};

describe("Attention Run deep-link consumption", () => {
  it("reports the exact Run target consumed after selecting it", async () => {
    const onOpenRunConsumed = vi.fn();

    render(createElement(ObservatoryPanel, {
      projectPath: "C:/projects/xiao",
      taskId: "task-a",
      liveRuns: [observableRun],
      livePendingInputs: [],
      openRunId: observableRun.id,
      timeline: [],
      onJumpToTimeline: () => undefined,
      onWorkspaceChange: () => undefined,
      onOpenRunConsumed,
    }));

    await waitFor(() => {
      expect(onOpenRunConsumed).toHaveBeenCalledOnce();
      expect(onOpenRunConsumed).toHaveBeenCalledWith(observableRun.id);
    });
  });
});
