// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunEventRecord, RunSnapshot } from "../../core/models/run";
import type { TurnCheckpointSummary } from "../../core/models/observatory";

const bridge = vi.hoisted(() => ({
  listXiaoRuns: vi.fn(async (): Promise<RunSnapshot[]> => []),
  listXiaoPendingInputs: vi.fn(async () => []),
  listXiaoTurnCheckpoints: vi.fn(async (): Promise<TurnCheckpointSummary[]> => []),
  loadXiaoRunEvents: vi.fn(async (): Promise<{
    events: RunEventRecord[];
    nextSequence: number | null;
  }> => ({ events: [], nextSequence: null })),
}));

vi.mock("../../core/bridges/tauri", () => ({
  nativeBridge: bridge,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { loadRunEvents, ObservatoryPanel } from "./ObservatoryPanel";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

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

  it("keeps the exact live Run selected when stale list hydration finishes later", async () => {
    const listedRuns = deferred<RunSnapshot[]>();
    const newerRun: RunSnapshot = {
      ...observableRun,
      id: "run-newer",
      idempotencyKey: "run-newer",
      status: "completed",
      agentOutcome: "completed",
      queuedAt: 20,
      startedAt: 21,
      finishedAt: 22,
    };
    bridge.listXiaoRuns.mockReturnValueOnce(listedRuns.promise);
    const onOpenRunConsumed = vi.fn();
    const properties = {
      projectPath: "C:/projects/xiao",
      taskId: "task-a",
      liveRuns: [newerRun, observableRun],
      livePendingInputs: [],
      timeline: [],
      onJumpToTimeline: () => undefined,
      onWorkspaceChange: () => undefined,
      onOpenRunConsumed,
    };

    const rendered = render(createElement(ObservatoryPanel, {
      ...properties,
      openRunId: observableRun.id,
    }));
    await waitFor(() => {
      expect(onOpenRunConsumed).toHaveBeenCalledWith(observableRun.id);
      expect(screen.getByRole("button", { name: "Observable run" }).textContent)
        .toContain(observableRun.id);
    });

    rendered.rerender(createElement(ObservatoryPanel, {
      ...properties,
      openRunId: null,
    }));
    listedRuns.resolve([newerRun]);
    await act(async () => {
      await listedRuns.promise;
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Observable run" }).textContent)
        .toContain(observableRun.id);
    });
  });

  it("keeps checkpoints from the newest task load when requests resolve out of order", async () => {
    const firstLoad = deferred<TurnCheckpointSummary[]>();
    const secondLoad = deferred<TurnCheckpointSummary[]>();
    bridge.listXiaoTurnCheckpoints
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise);
    const checkpoint = (id: string, prompt: string): TurnCheckpointSummary => ({
      id,
      runId: observableRun.id,
      turnId: id,
      prompt,
      runStatus: "completed",
      patchBytes: 1,
      beforeFingerprint: "before",
      afterFingerprint: "after",
      createdAt: 1,
      restoredAt: null,
    });
    const properties = {
      liveRuns: [],
      livePendingInputs: [],
      timeline: [],
      onJumpToTimeline: () => undefined,
      onWorkspaceChange: () => undefined,
    };
    const rendered = render(createElement(ObservatoryPanel, {
      ...properties,
      projectPath: "C:/projects/first",
      taskId: "task-first",
    }));

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(bridge.listXiaoTurnCheckpoints).toHaveBeenCalledTimes(1));
    rendered.rerender(createElement(ObservatoryPanel, {
      ...properties,
      projectPath: "C:/projects/second",
      taskId: "task-second",
    }));
    await waitFor(() => expect(bridge.listXiaoTurnCheckpoints).toHaveBeenCalledTimes(2));

    secondLoad.resolve([checkpoint("new", "Newest checkpoint")]);
    await waitFor(() => expect(screen.getByText("Newest checkpoint")).toBeTruthy());
    firstLoad.resolve([checkpoint("old", "Stale checkpoint")]);
    await act(async () => { await firstLoad.promise; });

    expect(screen.queryByText("Stale checkpoint")).toBeNull();
    expect(screen.getByText("Newest checkpoint")).toBeTruthy();
  });

  it("does not show the previous run's events while a newly selected run loads", async () => {
    const firstRun = {
      ...observableRun,
      id: "run-first",
      idempotencyKey: "run-first",
      queuedAt: 20,
    };
    const secondRun = {
      ...observableRun,
      id: "run-second",
      idempotencyKey: "run-second",
      queuedAt: 10,
    };
    const secondEvents = deferred<{ events: RunEventRecord[]; nextSequence: number | null }>();
    bridge.loadXiaoRunEvents
      .mockResolvedValueOnce({
        events: [{
          runId: firstRun.id,
          sequence: 1,
          timestamp: 1,
          eventType: "run.one",
          eventKey: null,
          safePayload: null,
        }],
        nextSequence: null,
      })
      .mockReturnValueOnce(secondEvents.promise);
    const properties = {
      projectPath: "C:/projects/xiao",
      taskId: "task-a",
      liveRuns: [firstRun, secondRun],
      livePendingInputs: [],
      timeline: [],
      onJumpToTimeline: () => undefined,
      onWorkspaceChange: () => undefined,
    };
    const rendered = render(createElement(ObservatoryPanel, {
      ...properties,
      openRunId: firstRun.id,
    }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await waitFor(() => expect(screen.getByText("Run One")).toBeTruthy());

    rendered.rerender(createElement(ObservatoryPanel, {
      ...properties,
      openRunId: secondRun.id,
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Observable run" }).textContent)
      .toContain(secondRun.id));

    expect(screen.queryByText("Run One")).toBeNull();
    expect(screen.getByText("No events match these filters.")).toBeTruthy();
  });
});
