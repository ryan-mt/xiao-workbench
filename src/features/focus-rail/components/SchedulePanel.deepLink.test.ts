// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoutineSummary } from "../../../core/models/routine";
import type { RunSnapshot } from "../../../core/models/run";

vi.mock("./AcceptanceContractEditor", () => ({
  AcceptanceContractEditor: () => null,
  contractDraftFromVersion: () => null,
}));

vi.mock("../../verification/VerificationEvidenceCard", () => ({
  VerificationEvidenceCard: () => null,
}));

import { SchedulePanel } from "./SchedulePanel";

const run: RunSnapshot = {
  id: "run-attention",
  workspacePath: "C:/projects/xiao",
  taskId: "task-a",
  idempotencyKey: "run-attention",
  parentRunId: null,
  candidateGroupId: null,
  routineOccurrenceId: "occurrence-a",
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
  prompt: "Run the scheduled task",
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

const routine: RoutineSummary = {
  id: "routine-a",
  workspacePath: "C:/projects/xiao",
  taskId: "task-a",
  title: "Scheduled review",
  prompt: "Review the outcome",
  acceptanceContract: null,
  scheduleKind: "daily",
  timezone: "UTC",
  scheduledFor: null,
  dailyTime: "09:00",
  missedRunPolicy: "run_once",
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  mode: "agent",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  executionEnvironmentId: "windows",
  executionRoot: "C:/projects/xiao",
  managedWorktreeId: null,
  workspaceMode: "local",
  enabled: true,
  nextRunAt: null,
  lastRunAt: 12,
  lastError: null,
  isolationWarning: null,
  lastStatus: "failed",
  history: [{
    id: "occurrence-a",
    scheduledFor: 10,
    triggerKind: "automatic",
    status: "dispatched",
    run,
  }],
  version: 1,
  createdAt: 1,
  updatedAt: 12,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Attention schedule deep-link consumption", () => {
  it("consumes the exact Run once, after expanding and scrolling to it", async () => {
    const events: string[] = [];
    const scrollIntoView = vi.fn(() => events.push("scroll"));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    function Harness() {
      const [openRunId, setOpenRunId] = useState<string | null>(run.id);
      return createElement(SchedulePanel, {
        projectPath: "C:/projects/xiao",
        routines: [routine],
        loading: false,
        error: null,
        creating: false,
        busyIds: new Set<string>(),
        nativeAvailable: true,
        dangerousAccessDefault: false,
        dangerousRoutineIds: new Set<string>(),
        openRunId,
        onOpenRunConsumed: (runId) => {
          events.push(`consume:${runId}`);
          setOpenRunId(null);
        },
        onCreate: async () => undefined,
        onUpdate: async () => undefined,
        onSetEnabled: async () => undefined,
        onRunNow: async () => undefined,
        onDelete: async () => undefined,
        onClearError: () => undefined,
      });
    }

    render(createElement(Harness));

    await waitFor(() => {
      expect(events).toEqual(["scroll", `consume:${run.id}`]);
      expect(scrollIntoView).toHaveBeenCalledOnce();
    });
  });
});
