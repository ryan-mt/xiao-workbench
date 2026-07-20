import { describe, expect, it } from "vitest";

import type {
  PendingInputSnapshot,
  RunProtocolEnvelope,
  RunSnapshot,
  RunUpdateEnvelope,
} from "../../../core/models/run";
import {
  acceptRunProtocol,
  activePendingInputIdsForRestore,
  activeRunForTask,
  emptyRunProjection,
  latestRunForTask,
  mergeListedPendingInputs,
  mergeListedRunSnapshots,
  projectRunSnapshots,
  projectRunUpdate,
  reconcileListedPendingInputs,
  reconcileListedRunSnapshots,
  runSnapshotBaselineForIds,
  runsForTask,
  shouldRestorePendingInput,
} from "./runProjection";

const run = (patch: Partial<RunSnapshot> = {}): RunSnapshot => ({
  id: "run-a",
  workspacePath: "C:/workspace",
  taskId: "task-a",
  idempotencyKey: "key-a",
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
  status: "queued",
  agentOutcome: "pending",
  verificationOutcome: "not_requested",
  executionEnvironmentId: "environment-a",
  executionRoot: "C:/workspace",
  managedWorktreeId: null,
  prompt: "Do work",
  model: "gpt-test",
  reasoningEffort: "medium",
  serviceTier: null,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  threadId: null,
  threadSource: null,
  cliVersion: null,
  runtimeGeneration: null,
  turnId: null,
  cancelRequested: false,
  queuedAt: 10,
  startedAt: null,
  finishedAt: null,
  version: 0,
  ...patch,
});

const update = (
  snapshot: RunSnapshot,
  sequence: number | null = null,
): RunUpdateEnvelope => ({
  snapshot,
  event: sequence == null ? null : {
    runId: snapshot.id,
    sequence,
    timestamp: 20,
    eventType: "run.updated",
    eventKey: `event-${sequence}`,
    safePayload: {},
  },
  pendingInput: null,
});

const protocol = (patch: Partial<RunProtocolEnvelope> = {}): RunProtocolEnvelope => ({
  runId: "run-a",
  taskId: "task-a",
  executionEnvironmentId: "environment-a",
  runtimeGeneration: 2,
  threadId: "thread-a",
  turnId: "turn-a",
  itemId: "item-a",
  sequence: 4,
  message: { method: "item/completed", params: {} },
  turnDiff: null,
  pendingInput: null,
  ...patch,
});

const pendingInput = (
  patch: Partial<PendingInputSnapshot> = {},
): PendingInputSnapshot => ({
  id: "pending-a",
  runId: "run-a",
  runtimeGeneration: 2,
  requestId: "1",
  threadId: "thread-a",
  turnId: "turn-a",
  itemId: "item-a",
  kind: "question",
  safeSummary: {},
  openedAt: 20,
  resolvedAt: null,
  invalidatedAt: null,
  ...patch,
});

describe("native run projection", () => {
  it("keeps the newest snapshot when updates arrive out of order", () => {
    const newest = run({
      status: "running",
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      version: 3,
    });
    const projection = projectRunUpdate(
      projectRunUpdate(emptyRunProjection(), update(newest, 3)),
      update(run({ status: "preparing", version: 1 }), 1),
    );

    expect(latestRunForTask(projection, "task-a")).toEqual(newest);
  });

  it("clears unresolved baseline pending inputs omitted by an authoritative list", () => {
    const beforeRequest = mergeListedPendingInputs(emptyRunProjection(), [pendingInput()]);

    const reconciled = reconcileListedPendingInputs(
      beforeRequest,
      [],
      beforeRequest.pendingInputsById,
    );

    expect(reconciled.pendingInputsById).toEqual({});
  });

  it("preserves a new pending input received after the list request starts", () => {
    const beforeRequest = mergeListedPendingInputs(emptyRunProjection(), [
      pendingInput({ id: "baseline" }),
    ]);
    const afterLiveInput = mergeListedPendingInputs(beforeRequest, [
      pendingInput({ id: "live", requestId: "2" }),
    ]);

    const reconciled = reconcileListedPendingInputs(
      afterLiveInput,
      [],
      beforeRequest.pendingInputsById,
    );

    expect(reconciled.pendingInputsById).toEqual({
      live: afterLiveInput.pendingInputsById.live,
    });
  });

  it("preserves an active replacement received after the list request starts", () => {
    const beforeRequest = mergeListedPendingInputs(emptyRunProjection(), [pendingInput()]);
    const replacement = pendingInput({ requestId: "replacement" });
    const afterReplacement = mergeListedPendingInputs(beforeRequest, [replacement]);

    const reconciled = reconcileListedPendingInputs(
      afterReplacement,
      [],
      beforeRequest.pendingInputsById,
    );

    expect(reconciled.pendingInputsById[replacement.id]).toBe(replacement);
  });

  it("does not let a stale list replace a same-ID active live replacement", () => {
    const beforeRequest = mergeListedPendingInputs(emptyRunProjection(), [pendingInput()]);
    const replacement = pendingInput({ requestId: "replacement" });
    const afterReplacement = mergeListedPendingInputs(beforeRequest, [replacement]);

    const reconciled = reconcileListedPendingInputs(
      afterReplacement,
      [pendingInput()],
      beforeRequest.pendingInputsById,
    );

    expect(reconciled).toBe(afterReplacement);
    expect(reconciled.pendingInputsById[replacement.id]).toBe(replacement);
  });

  it("merges a listed row when its same-ID baseline is unchanged", () => {
    const beforeRequest = mergeListedPendingInputs(emptyRunProjection(), [pendingInput()]);
    const listed = pendingInput({ requestId: "listed" });

    const reconciled = reconcileListedPendingInputs(
      beforeRequest,
      [listed],
      beforeRequest.pendingInputsById,
    );

    expect(reconciled.pendingInputsById[listed.id]).toBe(listed);
  });

  it("preserves a settled replacement received after the list request starts", () => {
    const beforeRequest = mergeListedPendingInputs(emptyRunProjection(), [pendingInput()]);
    const settled = pendingInput({ resolvedAt: 30 });
    const afterSettlement = mergeListedPendingInputs(beforeRequest, [settled]);

    const reconciled = reconcileListedPendingInputs(
      afterSettlement,
      [],
      beforeRequest.pendingInputsById,
    );

    expect(reconciled.pendingInputsById).toEqual({ "pending-a": settled });
  });

  it("does not let a stale active list replace a live settled pending input", () => {
    const beforeRequest = mergeListedPendingInputs(emptyRunProjection(), [pendingInput()]);
    const settled = pendingInput({ invalidatedAt: 31 });
    const afterSettlement = mergeListedPendingInputs(beforeRequest, [settled]);

    const reconciled = reconcileListedPendingInputs(
      afterSettlement,
      [pendingInput()],
      beforeRequest.pendingInputsById,
    );

    expect(reconciled).toBe(afterSettlement);
    expect(reconciled.pendingInputsById[settled.id]).toBe(settled);
  });

  it("reconciles only baseline pending inputs without disturbing unrelated state", () => {
    const projection = projectRunSnapshots(emptyRunProjection(), [run({
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      version: 2,
    })]);
    const withSequence = acceptRunProtocol(projection, protocol({ sequence: 4 })).projection;
    const beforeRequest = mergeListedPendingInputs(withSequence, [
      pendingInput({ id: "baseline" }),
    ]);
    const unrelated = pendingInput({ id: "unrelated", requestId: "2" });
    const current = mergeListedPendingInputs(beforeRequest, [unrelated]);

    const reconciled = reconcileListedPendingInputs(
      current,
      [],
      beforeRequest.pendingInputsById,
    );

    expect(reconciled.pendingInputsById).toEqual({ unrelated });
    expect(reconciled.runsById).toBe(current.runsById);
    expect(reconciled.runIdsByTask).toBe(current.runIdsByTask);
    expect(reconciled.appliedProtocolSequencesByRun).toBe(
      current.appliedProtocolSequencesByRun,
    );
  });

  it("does not let a delayed run list overwrite a newer live update", () => {
    const staleListSnapshot = run({
      status: "running",
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      version: 2,
    });
    const terminalLiveSnapshot = run({
      status: "completed",
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      finishedAt: 30,
      version: 3,
    });
    const afterLiveUpdate = projectRunUpdate(
      emptyRunProjection(),
      update(terminalLiveSnapshot, 3),
    );

    const restored = mergeListedRunSnapshots(afterLiveUpdate, [staleListSnapshot]);

    expect(latestRunForTask(restored, "task-a")).toEqual(terminalLiveSnapshot);
  });

  it("fully removes a baseline run omitted by an authoritative list", () => {
    const baselineRun = run({
      status: "running",
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      version: 2,
    });
    const withRun = projectRunSnapshots(emptyRunProjection(), [baselineRun]);
    const beforeRequest = acceptRunProtocol(withRun, protocol({ sequence: 4 })).projection;

    const reconciled = reconcileListedRunSnapshots(
      beforeRequest,
      [],
      beforeRequest.runsById,
    );

    expect(reconciled.runsById).toEqual({});
    expect(reconciled.runIdsByTask).toEqual({});
    expect(reconciled.appliedProtocolSequencesByRun).toEqual({});
  });

  it("prunes only runs with prior workspace-list provenance", () => {
    const priorListed = run({ id: "prior-listed", idempotencyKey: "prior-listed" });
    const restoreOnly = run({
      id: "restore-only",
      idempotencyKey: "restore-only",
      queuedAt: 9,
    });
    const projection = projectRunSnapshots(emptyRunProjection(), [
      priorListed,
      restoreOnly,
    ]);
    let trackedIds = new Set([priorListed.id, "no-longer-projected"]);
    const baseline = runSnapshotBaselineForIds(projection, trackedIds);

    expect(baseline).toEqual({ [priorListed.id]: priorListed });

    const nextListed = run({
      id: "next-listed",
      idempotencyKey: "next-listed",
      queuedAt: 8,
    });
    const reconciled = reconcileListedRunSnapshots(
      projection,
      [nextListed],
      baseline,
    );
    trackedIds = new Set([nextListed.id]);

    expect(reconciled.runsById).toEqual({
      [restoreOnly.id]: restoreOnly,
      [nextListed.id]: nextListed,
    });
    expect(runSnapshotBaselineForIds(reconciled, trackedIds)).toEqual({
      [nextListed.id]: nextListed,
    });
  });

  it("retains and merges an unchanged baseline run returned by the list", () => {
    const baselineRun = run({ version: 2 });
    const beforeRequest = projectRunSnapshots(emptyRunProjection(), [baselineRun]);
    const listedRun = { ...baselineRun };

    const reconciled = reconcileListedRunSnapshots(
      beforeRequest,
      [listedRun],
      beforeRequest.runsById,
    );

    expect(reconciled.runsById[listedRun.id]).toBe(listedRun);
    expect(reconciled.runIdsByTask[listedRun.taskId]).toEqual([listedRun.id]);
  });

  it("preserves a same-ID live replacement from an equal or stale list", () => {
    const baselineRun = run({ runtimeGeneration: 1, version: 1 });
    const beforeRequest = projectRunSnapshots(emptyRunProjection(), [baselineRun]);
    const replacement = run({
      status: "running",
      runtimeGeneration: 2,
      version: 2,
    });
    const afterReplacement = projectRunUpdate(beforeRequest, update(replacement));

    for (const listedRun of [
      run({ runtimeGeneration: 1, version: 1 }),
      run({ runtimeGeneration: 2, version: 2 }),
    ]) {
      const reconciled = reconcileListedRunSnapshots(
        afterReplacement,
        [listedRun],
        beforeRequest.runsById,
      );

      expect(reconciled.runsById[replacement.id]).toBe(replacement);
      expect(reconciled.runIdsByTask[replacement.taskId]).toEqual([replacement.id]);
    }
  });

  it("lets a fresher same-ID list replace a live request-time replacement", () => {
    const baselineRun = run({ runtimeGeneration: 1, version: 1 });
    const beforeRequest = projectRunSnapshots(emptyRunProjection(), [baselineRun]);
    const liveReplacement = run({
      status: "running",
      runtimeGeneration: 2,
      version: 2,
    });
    const afterReplacement = projectRunUpdate(beforeRequest, update(liveReplacement));
    const listedReplacement = run({
      status: "completed",
      agentOutcome: "completed",
      runtimeGeneration: 3,
      finishedAt: 30,
      version: 2,
    });

    const reconciled = reconcileListedRunSnapshots(
      afterReplacement,
      [listedReplacement],
      beforeRequest.runsById,
    );

    expect(reconciled.runsById[listedReplacement.id]).toBe(listedReplacement);
  });

  it("preserves a run added after an authoritative list request starts", () => {
    const baselineRun = run({ id: "baseline", idempotencyKey: "baseline" });
    const beforeRequest = projectRunSnapshots(emptyRunProjection(), [baselineRun]);
    const liveRun = run({
      id: "live",
      taskId: "task-b",
      idempotencyKey: "live",
      queuedAt: 20,
    });
    const afterLiveRun = projectRunSnapshots(beforeRequest, [liveRun]);

    const reconciled = reconcileListedRunSnapshots(
      afterLiveRun,
      [baselineRun],
      beforeRequest.runsById,
    );

    expect(reconciled.runsById[liveRun.id]).toBe(liveRun);
    expect(reconciled.runIdsByTask[liveRun.taskId]).toEqual([liveRun.id]);
  });

  it("removes only omitted baseline run state and preserves unrelated indexes", () => {
    const omitted = run({ id: "omitted", idempotencyKey: "omitted" });
    const retained = run({
      id: "retained",
      idempotencyKey: "retained",
      queuedAt: 9,
    });
    const unrelated = run({
      id: "unrelated",
      taskId: "task-b",
      idempotencyKey: "unrelated",
      queuedAt: 8,
    });
    const beforeRequest = projectRunSnapshots(emptyRunProjection(), [
      omitted,
      retained,
      unrelated,
    ]);
    const pendingInputsById = {
      "pending-b": pendingInput({ id: "pending-b", runId: unrelated.id }),
    };
    const current = {
      ...beforeRequest,
      pendingInputsById,
      appliedProtocolSequencesByRun: {
        omitted: [1],
        retained: [2],
        unrelated: [3],
      },
    };

    const reconciled = reconcileListedRunSnapshots(
      current,
      [retained, unrelated],
      beforeRequest.runsById,
    );

    expect(reconciled.runsById).toEqual({ retained, unrelated });
    expect(reconciled.runIdsByTask).toEqual({
      "task-a": [retained.id],
      "task-b": [unrelated.id],
    });
    expect(reconciled.appliedProtocolSequencesByRun).toEqual({
      retained: [2],
      unrelated: [3],
    });
    expect(reconciled.pendingInputsById).toBe(pendingInputsById);
  });

  it("deduplicates persisted protocol sequences but accepts out-of-order uniques", () => {
    const running = run({
      status: "running",
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      version: 2,
    });
    let projection = projectRunSnapshots(emptyRunProjection(), [running]);
    const later = acceptRunProtocol(projection, protocol({ sequence: 8 }));
    expect(later.accepted).toBe(true);
    projection = later.projection;

    const earlier = acceptRunProtocol(projection, protocol({ sequence: 4 }));
    expect(earlier.accepted).toBe(true);
    projection = earlier.projection;

    const duplicate = acceptRunProtocol(projection, protocol({ sequence: 8 }));
    expect(duplicate.accepted).toBe(false);
    expect(projection.appliedProtocolSequencesByRun["run-a"]).toEqual([4, 8]);
  });

  it("continues rejecting old duplicate sequences after a long run", () => {
    const running = run({
      status: "running",
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      version: 2,
    });
    let projection = projectRunSnapshots(emptyRunProjection(), [running]);
    for (let sequence = 1; sequence <= 401; sequence += 1) {
      const accepted = acceptRunProtocol(projection, protocol({ sequence }));
      expect(accepted.accepted).toBe(true);
      projection = accepted.projection;
    }

    expect(acceptRunProtocol(projection, protocol({ sequence: 1 })).accepted).toBe(false);
  });

  it("never reopens a settled pending input from stale updates or restore data", () => {
    const running = run({
      status: "running",
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      version: 3,
    });
    const settled = pendingInput({ resolvedAt: 30 });
    let projection = projectRunUpdate(emptyRunProjection(), {
      ...update(running, 3),
      pendingInput: settled,
    });
    projection = projectRunUpdate(projection, {
      ...update(run({ status: "waiting_for_input", version: 2 }), 2),
      pendingInput: pendingInput(),
    });

    expect(projection.pendingInputsById[settled.id]).toEqual(settled);
    expect(shouldRestorePendingInput(projection, pendingInput())).toBe(false);
  });

  it("merges live pending inputs into restore while excluding settled list rows", () => {
    const settled = pendingInput({ id: "settled", resolvedAt: 30 });
    const live = pendingInput({ id: "live", requestId: "2" });
    let projection = projectRunUpdate(emptyRunProjection(), {
      ...update(run({ version: 3 }), 3),
      pendingInput: settled,
    });
    projection = projectRunUpdate(projection, {
      ...update(run({ version: 3 }), 4),
      pendingInput: live,
    });

    const ids = activePendingInputIdsForRestore(projection, [
      pendingInput({ id: "settled" }),
      pendingInput({ id: "listed", requestId: "3" }),
    ]);

    expect([...ids].sort()).toEqual(["listed", "live"]);
  });

  it("rejects stale generation, task, thread and turn envelopes", () => {
    const projection = projectRunSnapshots(emptyRunProjection(), [run({
      status: "running",
      runtimeGeneration: 3,
      threadId: "thread-new",
      turnId: "turn-new",
      version: 3,
    })]);

    expect(acceptRunProtocol(projection, protocol()).accepted).toBe(false);
    expect(acceptRunProtocol(projection, protocol({
      runtimeGeneration: 3,
      threadId: "thread-new",
      turnId: "turn-old",
    })).accepted).toBe(false);
    expect(acceptRunProtocol(projection, protocol({
      runtimeGeneration: 3,
      threadId: "thread-other",
      turnId: "turn-new",
    })).accepted).toBe(false);
    expect(acceptRunProtocol(projection, protocol({
      taskId: "task-other",
      runtimeGeneration: 3,
      threadId: "thread-new",
      turnId: "turn-new",
    })).accepted).toBe(false);
  });

  it("keeps the executing run ahead of newer follow-ups and selects the oldest queued run", () => {
    const withRunning = projectRunSnapshots(emptyRunProjection(), [
      run({ id: "running", idempotencyKey: "running", queuedAt: 1, status: "running" }),
      run({ id: "follow-up", idempotencyKey: "follow-up", queuedAt: 2 }),
    ]);
    expect(activeRunForTask(withRunning, "task-a")?.id).toBe("running");

    const queued = projectRunSnapshots(emptyRunProjection(), [
      run({ id: "first", idempotencyKey: "first", queuedAt: 1 }),
      run({ id: "second", idempotencyKey: "second", queuedAt: 2 }),
    ]);
    expect(activeRunForTask(queued, "task-a")?.id).toBe("first");
  });

  it("projects concurrent tasks independently and serializes each task by recency", () => {
    const projection = projectRunSnapshots(emptyRunProjection(), [
      run({ id: "a-old", idempotencyKey: "a-old", queuedAt: 1 }),
      run({ id: "a-new", idempotencyKey: "a-new", queuedAt: 3, status: "running" }),
      run({
        id: "b",
        taskId: "task-b",
        idempotencyKey: "b",
        queuedAt: 2,
        status: "waiting_for_input",
      }),
    ]);

    expect(runsForTask(projection, "task-a").map((item) => item.id)).toEqual(["a-new", "a-old"]);
    expect(activeRunForTask(projection, "task-a")?.id).toBe("a-new");
    expect(activeRunForTask(projection, "task-b")?.id).toBe("b");
  });
});
