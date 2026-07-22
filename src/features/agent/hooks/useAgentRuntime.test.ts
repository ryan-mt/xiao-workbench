import { describe, expect, it, vi } from "vitest";

import type {
  AgentQuestionRequest,
  AgentRuntimeState,
  TimelineEntry,
} from "../../../core/models/agent";
import type {
  PendingInputSnapshot,
  RunEventRecord,
  RunSnapshot,
} from "../../../core/models/run";
import {
  accountRateLimitsRefreshIntervalMs,
  advanceAgentRuntimeWorkspaceScope,
  agentMessageRequiresWorkspaceRefresh,
  agentRuntimeEnvelopeMatches,
  attentionHydrationStatusFromSettlements,
  agentQuestionRequestMatches,
  agentRuntimeApprovalRequestKey,
  agentRuntimeTaskScopeMatches,
  agentRuntimeTaskWorkspaceScopeMatches,
  agentRuntimeWorkspaceScopeMatches,
  clearResolvedAgentQuestionRequest,
  handleAgentApprovalRequest,
  listenerRecoveryPendingAfterConnect,
  loadAllXiaoRunEvents,
  fileChangeTimelineEntry,
  normalizeFileChangeDiff,
  projectFileChangePatchUpdate,
  projectAgentRateLimitsUpdate,
  reconcileFetchedAgentRateLimits,
  projectTimelineRunSnapshot,
  projectTimelineRunStatus,
  resetPendingInputReplayForTaskRestore,
  restoredRunProtocolEnvelope,
  runtimeAfterListenerAttachSuccess,
  runtimeForPublishedActiveRun,
  settleAutoTitleAfterUndo,
  shouldClearAgentPlan,
  type AgentRuntimeTaskScope,
  type AgentRuntimeWorkspaceScope,
  type AttentionHydrationStatus,
} from "./useAgentRuntime";
import { latestUndoableTurn } from "./agentProtocol";
import {
  emptyRunProjection,
  latestRunForTask,
  mergeListedPendingInputs,
  mergeListedRunSnapshots,
  projectRunSnapshots,
  reconcileListedPendingInputs,
  reconcileListedRunSnapshots,
  runSnapshotBaselineForIds,
  type RunProjection,
} from "./runProjection";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
};

describe("shouldClearAgentPlan", () => {
  it("clears immediately only after a successful turn", () => {
    expect(shouldClearAgentPlan("completed")).toBe(true);
    expect(shouldClearAgentPlan("failed")).toBe(false);
    expect(shouldClearAgentPlan("interrupted")).toBe(false);
  });
});

describe("Codex rate-limit updates", () => {
  it("refreshes the account snapshot every 30 seconds", () => {
    expect(accountRateLimitsRefreshIntervalMs).toBe(30_000);
  });

  it("lets a fetched snapshot replace stale percentages while preserving sparse metadata", () => {
    const current = {
      limitId: "codex",
      limitName: "Codex",
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 24, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
    };
    const fetched = {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 12, windowDurationMins: null, resetsAt: null },
      secondary: { usedPercent: 22, windowDurationMins: null, resetsAt: null },
    };

    expect(reconcileFetchedAgentRateLimits(current, fetched)).toEqual({
      ...current,
      primary: { ...current.primary, usedPercent: 12 },
      secondary: { ...current.secondary, usedPercent: 22 },
    });
  });

  it("applies the pushed percentages immediately and preserves sparse window metadata", () => {
    const current = {
      limitId: "codex",
      limitName: "Codex",
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
    };

    expect(projectAgentRateLimitsUpdate(current, {
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 14, windowDurationMins: null, resetsAt: null },
          secondary: { usedPercent: 23, windowDurationMins: null, resetsAt: null },
        },
      },
    })).toEqual({
      ...current,
      primary: { ...current.primary, usedPercent: 14 },
      secondary: { ...current.secondary, usedPercent: 23 },
    });
  });

  it("ignores a pushed bucket that is not the Codex quota", () => {
    const current = {
      limitId: "codex",
      limitName: "Codex",
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: null },
    };

    expect(projectAgentRateLimitsUpdate(current, {
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "another-limit",
          primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: null },
        },
      },
    })).toBe(current);
  });
});

describe("normalizeFileChangeDiff", () => {
  it("projects raw new-file content as additions with usable line numbers", () => {
    expect(normalizeFileChangeDiff("<html>\n\n</html>\n", "add")).toEqual({
      additions: 3,
      deletions: 0,
      patch: "@@ -0,0 +1,3 @@\n+<html>\n+\n+</html>",
    });
  });

  it("projects raw deleted-file content as deletions", () => {
    expect(normalizeFileChangeDiff("one\ntwo\n", "delete")).toEqual({
      additions: 0,
      deletions: 2,
      patch: "@@ -1,2 +0,0 @@\n-one\n-two",
    });
  });

  it("preserves unified update diffs and counts their changed lines", () => {
    const patch = "@@ -1 +1 @@\n-old\n+new";
    expect(normalizeFileChangeDiff(patch, "update")).toEqual({
      additions: 1,
      deletions: 1,
      patch,
    });
  });
});

describe("streaming file changes", () => {
  const changes = [{
    path: "src/App.tsx",
    kind: { type: "update" },
    diff: "@@ -1 +1 @@\n-old\n+new",
  }];

  it("projects an in-progress file change as an active editing entry", () => {
    expect(fileChangeTimelineEntry({
      type: "fileChange",
      id: "patch-1",
      status: "inProgress",
      changes,
    })).toMatchObject({
      id: "patch-1",
      kind: "change",
      title: "Editing 1 file",
      meta: "Streaming workspace changes",
      status: "active",
      files: [{
        path: "src/App.tsx",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new",
      }],
    });
  });

  it("updates the same timeline entry when a streamed patch changes", () => {
    const initial = projectFileChangePatchUpdate([], "patch-1", changes);
    const updated = projectFileChangePatchUpdate(initial, "patch-1", [{
      ...changes[0],
      diff: "@@ -1 +1,2 @@\n-old\n+new\n+line",
    }]);

    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      id: "patch-1",
      status: "active",
      files: [{ additions: 2, deletions: 1 }],
    });
  });

  it.each(["add", "update", "delete"])(
    "refreshes the workspace when a streamed %s reaches disk",
    (kind) => {
      expect(agentMessageRequiresWorkspaceRefresh({
        method: "item/fileChange/patchUpdated",
        params: {
          itemId: "patch-1",
          changes: [{ path: "src/App.tsx", kind: { type: kind }, diff: "changed" }],
        },
      })).toBe(true);
    },
  );

  it("refreshes once more when a file change or turn completes", () => {
    expect(agentMessageRequiresWorkspaceRefresh({
      method: "item/completed",
      params: { item: { type: "fileChange", id: "patch-1" } },
    })).toBe(true);
    expect(agentMessageRequiresWorkspaceRefresh({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed" } },
    })).toBe(true);
    expect(agentMessageRequiresWorkspaceRefresh({
      method: "item/commandExecution/outputDelta",
      params: { delta: "reading only" },
    })).toBe(false);
  });
});

describe("projectTimelineRunStatus", () => {
  const queuedUser: TimelineEntry = {
    id: "request-1",
    kind: "user",
    title: "Fix the app",
    runId: "run-1",
    meta: "Queued",
    status: "active",
  };

  it("marks a queued user message as delivered when its turn starts", () => {
    expect(projectTimelineRunStatus([queuedUser], {
      runId: "run-1",
      turnId: "turn-1",
      status: "active",
    })).toEqual([{
      ...queuedUser,
      turnId: "turn-1",
      meta: "You",
    }]);
  });

  it("marks a queued image message as delivered when its run starts", () => {
    const queuedImage = {
      ...queuedUser,
      runId: undefined,
      attachments: [{
        id: "attachment-1",
        kind: "image" as const,
        name: "image.png",
        path: "clipboard:image-1",
      }],
    };

    expect(projectTimelineRunSnapshot([queuedImage], {
      id: "run-1",
      idempotencyKey: "request-1",
      status: "running",
      turnId: "turn-1",
    })).toEqual([{
      ...queuedImage,
      turnId: "turn-1",
      meta: "You",
    }]);
  });

  it("settles terminal messages by idempotency key even before runId attachment", () => {
    const withoutRunId = { ...queuedUser, runId: undefined };

    expect(projectTimelineRunStatus([withoutRunId], {
      entryId: "request-1",
      runId: "run-1",
      turnId: "turn-1",
      turnDiff: "diff --git a/file b/file",
      status: "success",
    })).toEqual([{
      ...withoutRunId,
      turnId: "turn-1",
      turnDiff: "diff --git a/file b/file",
      meta: "You",
      status: "success",
    }]);
  });

  it("does not settle an unrelated queued message", () => {
    expect(projectTimelineRunStatus([queuedUser], {
      entryId: "request-2",
      runId: "run-2",
      turnId: "turn-2",
      status: "error",
    })).toEqual([queuedUser]);
  });

  it("does not regress a delivered message when a late active snapshot arrives", () => {
    const delivered = { ...queuedUser, meta: "You", status: "success" as const };

    expect(projectTimelineRunStatus([delivered], {
      entryId: "request-1",
      runId: "run-1",
      status: "active",
    })).toEqual([delivered]);
  });
});

const pendingInput = (
  patch: Partial<PendingInputSnapshot> = {},
): PendingInputSnapshot => ({
  id: "pending-a",
  runId: "run-a",
  runtimeGeneration: 1,
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

const run = (workspacePath: string, patch: Partial<RunSnapshot> = {}): RunSnapshot => ({
  id: `run-${workspacePath.at(-1)?.toLowerCase()}`,
  workspacePath,
  taskId: "shared",
  idempotencyKey: `key-${workspacePath.at(-1)?.toLowerCase()}`,
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
  executionEnvironmentId: `environment-${workspacePath.at(-1)?.toLowerCase()}`,
  executionRoot: workspacePath,
  managedWorktreeId: null,
  prompt: `Work in ${workspacePath}`,
  model: "gpt-test",
  reasoningEffort: "medium",
  serviceTier: null,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  threadId: `thread-${workspacePath.at(-1)?.toLowerCase()}`,
  threadSource: "created",
  cliVersion: "test",
  runtimeGeneration: 1,
  turnId: `turn-${workspacePath.at(-1)?.toLowerCase()}`,
  cancelRequested: false,
  queuedAt: 10,
  startedAt: 11,
  finishedAt: 12,
  version: 1,
  ...patch,
});

describe("agent runtime workspace scope", () => {
  it("restores every durable run event in sequence across pages", async () => {
    const events = Array.from({ length: 450 }, (_, sequence): RunEventRecord => ({
      runId: "run-a",
      sequence,
      timestamp: sequence,
      eventType: "agent.fake",
      eventKey: `event-${sequence}`,
      safePayload: { sequence },
    }));
    const cursors: number[] = [];

    const restored = await loadAllXiaoRunEvents(
      "run-a",
      async (runId, afterSequence, limit) => {
        expect(runId).toBe("run-a");
        expect(limit).toBe(200);
        cursors.push(afterSequence ?? -2);
        const pageEvents = events
          .filter((event) => event.sequence > (afterSequence ?? -1))
          .slice(0, limit);
        return {
          events: pageEvents,
          nextSequence: pageEvents.at(-1)?.sequence ?? null,
        };
      },
    );

    expect(cursors).toEqual([-1, 199, 399]);
    expect(restored.map((event) => event.sequence)).toEqual(
      Array.from({ length: 450 }, (_, sequence) => sequence),
    );
  });

  it("restores a durable turn diff as undo metadata", () => {
    const turnDiff = "diff --git a/file.txt b/file.txt\n+restored\n";
    const snapshot = run("C:/A", {
      id: "run-a",
      taskId: "task-a",
      status: "completed",
      agentOutcome: "completed",
      turnId: "turn-a",
    });
    const envelope = restoredRunProtocolEnvelope(snapshot, {
      runId: snapshot.id,
      sequence: 9,
      timestamp: 10,
      eventType: "run.completed",
      eventKey: "completion",
      safePayload: {
        protocol: {
          method: "turn/completed",
          params: { turn: { id: "turn-a", status: "completed" } },
        },
        turnDiff,
      },
    });

    expect(envelope?.turnDiff).toBe(turnDiff);
    const restoredUser: TimelineEntry = {
      id: snapshot.idempotencyKey,
      kind: "user",
      title: snapshot.prompt,
      turnId: envelope?.turnId ?? undefined,
      turnDiff: envelope?.turnDiff ?? undefined,
    };
    expect(latestUndoableTurn([restoredUser])?.turnDiff).toBe(turnDiff);
  });

  it("rejects runtime events from other environments and stale generations", () => {
    expect(
      agentRuntimeEnvelopeMatches("environment-a", null, {
        environmentId: "environment-b",
        generation: 1,
      }),
    ).toBe(false);
    expect(
      agentRuntimeEnvelopeMatches("environment-a", 2, {
        environmentId: "environment-a",
        generation: 1,
      }),
    ).toBe(false);
    expect(
      agentRuntimeEnvelopeMatches("environment-a", 2, {
        environmentId: "environment-a",
        generation: 2,
      }),
    ).toBe(true);
  });

  it("keeps its generation while switching tasks in one workspace", () => {
    const scope: AgentRuntimeWorkspaceScope = { workspacePath: "C:/A", generation: 4 };

    expect(advanceAgentRuntimeWorkspaceScope(scope, "C:/A")).toBe(scope);
    expect(agentRuntimeWorkspaceScopeMatches(scope, "C:/A", 4)).toBe(true);
  });

  it("returns false for task A completion after task B becomes active", () => {
    const workspaceScope: AgentRuntimeWorkspaceScope = {
      workspacePath: "C:/A",
      generation: 4,
    };
    const taskScope: AgentRuntimeTaskScope = { ...workspaceScope, taskId: "task-a" };

    expect(agentRuntimeTaskScopeMatches(workspaceScope, "task-b", taskScope)).toBe(false);
  });

  it("keeps task A settlements out of task B singleton state in one workspace", async () => {
    const workspaceScope: AgentRuntimeWorkspaceScope = {
      workspacePath: "C:/A",
      generation: 4,
    };
    const taskScope: AgentRuntimeTaskScope = { ...workspaceScope, taskId: "task-a" };
    const settlement = deferred<string>();
    let activeTaskId = "task-a";
    let settledTaskId: string | null = null;
    let runtimeError: string | null = null;
    const completed = settlement.promise.then((error) => {
      if (agentRuntimeTaskWorkspaceScopeMatches(workspaceScope, taskScope)) {
        settledTaskId = taskScope.taskId;
      }
      if (agentRuntimeTaskScopeMatches(workspaceScope, activeTaskId, taskScope)) {
        runtimeError = error;
      }
    });

    activeTaskId = "task-b";
    settlement.resolve("Task A failed");
    await completed;

    expect(agentRuntimeTaskWorkspaceScopeMatches(workspaceScope, taskScope)).toBe(true);
    expect(agentRuntimeTaskScopeMatches(workspaceScope, activeTaskId, taskScope)).toBe(false);
    expect(settledTaskId).toBe("task-a");
    expect(runtimeError).toBeNull();
  });

  it("drops first-turn automatic title eligibility but preserves later-turn eligibility", () => {
    const autoTitled = new Set(["task-a", "task-b"]);

    settleAutoTitleAfterUndo(autoTitled, "task-a", true);
    settleAutoTitleAfterUndo(autoTitled, "task-b", false);

    expect(autoTitled.has("task-a")).toBe(false);
    expect(autoTitled.has("task-b")).toBe(true);
  });

  it("scopes automatic approval keys by workspace generation, task, and pending input", () => {
    const first: AgentRuntimeTaskScope = {
      workspacePath: "C:/A",
      generation: 2,
      taskId: "task-a",
    };

    expect(agentRuntimeApprovalRequestKey(first, "input-1")).not.toBe(
      agentRuntimeApprovalRequestKey({ ...first, taskId: "task-b" }, "input-1"),
    );
    expect(agentRuntimeApprovalRequestKey(first, "input-1")).not.toBe(
      agentRuntimeApprovalRequestKey({ ...first, generation: 3 }, "input-1"),
    );
    expect(agentRuntimeApprovalRequestKey(first, "input-1")).not.toBe(
      agentRuntimeApprovalRequestKey(first, "input-2"),
    );
  });

  it("resolves one late approval after the local policy changes to Never ask", async () => {
    let timeline: TimelineEntry[] = [];
    const nativeResolution = vi.fn(async (pendingInputId: string) => pendingInputId);
    const declineWithoutPrompt = vi.fn(async (
      _taskId: string,
      _requestId: number | string,
      _approvalKind: TimelineEntry["approvalKind"],
      entryId: string,
    ) => {
      const approval = timeline.find((entry) => entry.id === entryId);
      await nativeResolution(approval?.pendingInputId ?? "");
      return true;
    });
    const approval = {
      id: "approval-input-late",
      kind: "approval" as const,
      title: "Command permission requested",
      requestId: 7,
      pendingInputId: "input-late",
      approvalKind: "action" as const,
      meta: "Waiting for your decision",
      status: "warning" as const,
    };
    const updateTimeline = (
      _taskId: string,
      update: (current: typeof timeline) => typeof timeline,
    ) => { timeline = update(timeline); };

    await handleAgentApprovalRequest(
      "task-a",
      "never",
      approval,
      updateTimeline,
      declineWithoutPrompt,
    );

    expect(timeline).toEqual([approval]);
    expect(declineWithoutPrompt).toHaveBeenCalledOnce();
    expect(declineWithoutPrompt).toHaveBeenCalledWith(
      "task-a",
      7,
      "action",
      "approval-input-late",
    );
    expect(nativeResolution).toHaveBeenCalledOnce();
    expect(nativeResolution).toHaveBeenCalledWith("input-late");
  });

  it("matches resolved questions only across task, run, pending input, and request ID", () => {
    const question = (
      patch: Partial<Pick<
        AgentQuestionRequest,
        "pendingInputId" | "requestId" | "runId" | "taskId"
      >> = {},
    ): AgentQuestionRequest => ({
      requestId: 7,
      pendingInputId: "input-a",
      runId: "run-a",
      taskId: "task-a",
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "item-a",
      questions: [],
      autoResolutionMs: null,
      receivedAt: 1,
      ...patch,
    });
    const resolved = question();

    expect(agentQuestionRequestMatches(question(), resolved)).toBe(true);
    expect(agentQuestionRequestMatches(question({ taskId: "task-b" }), resolved)).toBe(false);
    expect(agentQuestionRequestMatches(question({ pendingInputId: "input-b" }), resolved)).toBe(false);
    expect(agentQuestionRequestMatches(question({ requestId: 8 }), resolved)).toBe(false);
    expect(agentQuestionRequestMatches(question({ runId: "replacement-run" }), resolved)).toBe(false);
  });

  it("keeps a replacement question when a prior run reuses its request ID", () => {
    const replacement: AgentQuestionRequest = {
      requestId: 7,
      pendingInputId: "replacement-input",
      runId: "replacement-run",
      taskId: "task-a",
      threadId: "thread-a",
      turnId: "replacement-turn",
      itemId: "replacement-item",
      questions: [],
      autoResolutionMs: null,
      receivedAt: 2,
    };
    const staleResolution = {
      requestId: 7,
      pendingInputId: "prior-input",
      runId: "prior-run",
      taskId: "task-a",
    };

    const stateAfterResolution = clearResolvedAgentQuestionRequest(
      replacement,
      staleResolution,
    );
    const refAfterResolution = clearResolvedAgentQuestionRequest(
      replacement,
      staleResolution,
    );

    expect(stateAfterResolution).toBe(replacement);
    expect(refAfterResolution).toBe(replacement);
    expect(clearResolvedAgentQuestionRequest(replacement, replacement)).toBeNull();
  });

  const runtimeState = (
    phase: AgentRuntimeState["phase"],
    error: string | null,
  ): AgentRuntimeState => ({
    phase,
    taskId: null,
    threadId: null,
    turnId: null,
    turnStartedAt: null,
    error,
    eventsSeen: 4,
  });

  it("moves the exact listener-owned error runtime to reconnectable offline", () => {
    const listenerOwnedError = runtimeState("error", "listener failed");

    expect(runtimeAfterListenerAttachSuccess(
      listenerOwnedError,
      listenerOwnedError,
    )).toEqual({
      ...listenerOwnedError,
      phase: "offline",
      error: null,
    });
  });

  it("preserves an equal-message runtime not owned by listener registration", () => {
    const listenerOwnedError = runtimeState("error", "listener failed");
    const replacement = runtimeState("error", "listener failed");

    expect(runtimeAfterListenerAttachSuccess(replacement, listenerOwnedError)).toBe(
      replacement,
    );
  });

  it("preserves reconnectable error and offline runtimes during listener recovery", () => {
    const activeRun = run("C:/A", {
      status: "running",
      agentOutcome: "pending",
      finishedAt: null,
    });
    const errorRuntime = runtimeState("error", "listener failed");
    const offlineRuntime = runtimeState("offline", null);

    expect(runtimeForPublishedActiveRun(errorRuntime, activeRun, true)).toBe(errorRuntime);
    expect(runtimeForPublishedActiveRun(offlineRuntime, activeRun, true)).toBe(offlineRuntime);
  });

  it("publishes the normal active lifecycle when listener recovery is not pending", () => {
    const activeRun = run("C:/A", {
      status: "running",
      agentOutcome: "pending",
      finishedAt: null,
    });
    const current = runtimeState("error", "prior failure");

    expect(runtimeForPublishedActiveRun(current, activeRun, false)).toMatchObject({
      phase: "working",
      taskId: activeRun.taskId,
      threadId: activeRun.threadId,
      turnId: activeRun.turnId,
      error: null,
    });
  });

  it("clears listener recovery only after a successful connect", () => {
    expect(listenerRecoveryPendingAfterConnect(true, true)).toBe(false);
    expect(listenerRecoveryPendingAfterConnect(true, false)).toBe(true);
    expect(listenerRecoveryPendingAfterConnect(false, true)).toBe(false);
  });

  it("keeps a deferred replay publication from cancelling listener recovery", async () => {
    const activeRun = run("C:/A", {
      status: "running",
      agentOutcome: "pending",
      finishedAt: null,
    });
    const replay = deferred<RunSnapshot>();
    const listenerOwnedError = runtimeState("error", "listener failed");
    let current = listenerOwnedError;
    let recoveryPending = true;
    const publication = replay.promise.then((replayedRun) => {
      current = runtimeForPublishedActiveRun(current, replayedRun, recoveryPending);
    });

    current = runtimeAfterListenerAttachSuccess(current, listenerOwnedError);
    replay.resolve(activeRun);
    await publication;

    expect(current.phase).toBe("offline");
    expect(current.error).toBeNull();

    recoveryPending = listenerRecoveryPendingAfterConnect(recoveryPending, true);
    current = runtimeForPublishedActiveRun(current, activeRun, recoveryPending);
    expect(current.phase).toBe("working");
  });

  it("resets pending-input replay state on each A to B to A task activation", () => {
    const replayed = new Set<string>();

    resetPendingInputReplayForTaskRestore(replayed);
    expect(replayed.has("pending-a")).toBe(false);
    replayed.add("pending-a");
    expect(replayed.has("pending-a")).toBe(true);

    resetPendingInputReplayForTaskRestore(replayed);
    replayed.add("pending-b");

    resetPendingInputReplayForTaskRestore(replayed);
    expect(replayed.has("pending-a")).toBe(false);
    replayed.add("pending-a");
    expect(replayed.has("pending-a")).toBe(true);
  });

  it("reports ready only when listeners and both bounded lists succeed", async () => {
    const fulfilled = await Promise.allSettled([
      Promise.resolve("runs"),
      Promise.resolve("pending"),
    ]);
    const runsFailed = await Promise.allSettled([
      Promise.reject(new Error("runs unavailable")),
      Promise.resolve("pending"),
    ]);
    const pendingFailed = await Promise.allSettled([
      Promise.resolve("runs"),
      Promise.reject(new Error("pending unavailable")),
    ]);

    expect(attentionHydrationStatusFromSettlements(fulfilled)).toBe("ready");
    expect(attentionHydrationStatusFromSettlements(runsFailed)).toBe("partial");
    expect(attentionHydrationStatusFromSettlements(pendingFailed)).toBe("partial");
    expect(attentionHydrationStatusFromSettlements(fulfilled, false)).toBe("partial");
  });

  it("publishes each successful hydration list without waiting for the other", async () => {
    let projection = emptyRunProjection();
    let status: AttentionHydrationStatus = "loading";
    const runsList = deferred<RunSnapshot[]>();
    const pendingList = deferred<PendingInputSnapshot[]>();
    const runsBaseline = runSnapshotBaselineForIds(projection, new Set());
    const pendingBaseline = projection.pendingInputsById;
    const runsPublication = runsList.promise.then((runs) => {
      projection = reconcileListedRunSnapshots(projection, runs, runsBaseline);
    });
    const pendingPublication = pendingList.promise.then((pendingInputs) => {
      projection = reconcileListedPendingInputs(
        projection,
        pendingInputs,
        pendingBaseline,
      );
    });
    const hydration = Promise.allSettled([runsPublication, pendingPublication]).then(
      (settlements) => {
        status = attentionHydrationStatusFromSettlements(settlements);
      },
    );
    const listedRun = run("C:/A", {
      status: "running",
      agentOutcome: "pending",
      finishedAt: null,
    });

    runsList.resolve([listedRun]);
    await runsPublication;

    expect(latestRunForTask(projection, "shared")).toEqual(listedRun);
    expect(projection.pendingInputsById).toEqual({});
    expect(status).toBe("loading");

    const listedPending = pendingInput({ runId: listedRun.id });
    pendingList.resolve([listedPending]);
    await hydration;

    expect(projection.pendingInputsById[listedPending.id]).toEqual(listedPending);
    expect(status).toBe("ready");
  });

  it("drops independent hydration publications after the workspace changes", async () => {
    let scope: AgentRuntimeWorkspaceScope = { workspacePath: "C:/A", generation: 0 };
    const captured = scope;
    let projection = emptyRunProjection();
    let status: AttentionHydrationStatus = "loading";
    const runsList = deferred<RunSnapshot[]>();
    const pendingList = deferred<PendingInputSnapshot[]>();
    const runsBaseline = runSnapshotBaselineForIds(projection, new Set());
    const listIsCurrent = () => agentRuntimeWorkspaceScopeMatches(
      scope,
      "C:/A",
      captured.generation,
    );
    const runsPublication = runsList.promise.then((runs) => {
      if (listIsCurrent()) {
        projection = reconcileListedRunSnapshots(projection, runs, runsBaseline);
      }
    });
    const pendingPublication = pendingList.promise.then((pendingInputs) => {
      if (listIsCurrent()) {
        projection = reconcileListedPendingInputs(projection, pendingInputs, {});
      }
    });
    const hydration = Promise.allSettled([runsPublication, pendingPublication]).then(
      (settlements) => {
        if (listIsCurrent()) {
          status = attentionHydrationStatusFromSettlements(settlements);
        }
      },
    );

    scope = advanceAgentRuntimeWorkspaceScope(scope, "C:/B");
    runsList.resolve([run("C:/A")]);
    pendingList.resolve([pendingInput()]);
    await hydration;

    expect(projection).toEqual(emptyRunProjection());
    expect(status).toBe("loading");
  });

  it("reconciles a late pending list against its request baseline", async () => {
    const beforeRequest = mergeListedPendingInputs(emptyRunProjection(), [pendingInput()]);
    let projection = beforeRequest;
    const pendingList = deferred<PendingInputSnapshot[]>();
    const publication = pendingList.promise.then((pendingInputs) => {
      projection = reconcileListedPendingInputs(
        projection,
        pendingInputs,
        beforeRequest.pendingInputsById,
      );
    });
    const settled = pendingInput({ resolvedAt: 30 });

    projection = mergeListedPendingInputs(projection, [settled]);
    pendingList.resolve([pendingInput()]);
    await publication;

    expect(projection.pendingInputsById[settled.id]).toBe(settled);
  });

  it("keeps projected and lifecycle data intact across a failed retry", async () => {
    const currentRun = run("C:/A", { version: 3 });
    const settled = pendingInput({ resolvedAt: 30 });
    let projection = mergeListedPendingInputs(
      mergeListedRunSnapshots(emptyRunProjection(), [currentRun]),
      [settled],
    );
    const finishedRunIds = new Set([currentRun.id]);
    const replayedPendingInputs = new Set([settled.id]);
    const sessions = new Map([[currentRun.taskId, currentRun.threadId!]]);
    const lifecycle = { phase: "ready", error: "existing runtime error" };
    let status: AttentionHydrationStatus = "loading";
    const runsBaseline = runSnapshotBaselineForIds(
      projection,
      new Set([currentRun.id]),
    );
    const pendingBaseline = projection.pendingInputsById;
    const runsList = deferred<RunSnapshot[]>();
    const pendingList = deferred<PendingInputSnapshot[]>();
    const runsPublication = runsList.promise.then((runs) => {
      projection = reconcileListedRunSnapshots(projection, runs, runsBaseline);
    });
    const pendingPublication = pendingList.promise.then((pendingInputs) => {
      projection = reconcileListedPendingInputs(
        projection,
        pendingInputs,
        pendingBaseline,
      );
    });
    const retry = Promise.allSettled([runsPublication, pendingPublication]).then(
      (settlements) => {
        status = attentionHydrationStatusFromSettlements(settlements);
      },
    );

    runsList.resolve([run("C:/A", { version: 2 })]);
    pendingList.reject(new Error("pending unavailable"));
    await retry;

    expect(latestRunForTask(projection, "shared")).toEqual(currentRun);
    expect(projection.pendingInputsById[settled.id]).toBe(settled);
    expect(finishedRunIds).toEqual(new Set([currentRun.id]));
    expect(replayedPendingInputs).toEqual(new Set([settled.id]));
    expect(sessions).toEqual(new Map([[currentRun.taskId, currentRun.threadId]]));
    expect(lifecycle).toEqual({ phase: "ready", error: "existing runtime error" });
    expect(status).toBe("partial");
  });

  it("fails closed across deferred A/shared listeners and lists before exposing B/shared", async () => {
    let scope: AgentRuntimeWorkspaceScope = { workspacePath: "C:/A", generation: 0 };
    let projection: RunProjection = projectRunSnapshots(emptyRunProjection(), [run("C:/A")]);
    let sessions = new Map<string, string>([["shared", "thread-a"]]);
    const retryTargets = () => latestRunForTask(projection, "shared")?.id ?? null;
    const visible = (workspacePath: string) => {
      const current = scope.workspacePath === workspacePath;
      return {
        latestRun: current ? latestRunForTask(projection, "shared") : null,
        sessionId: current ? sessions.get("shared") ?? null : null,
        retryRunId: current ? retryTargets() : null,
      };
    };
    const settle = (
      captured: AgentRuntimeWorkspaceScope,
      workspacePath: string,
      runs: RunSnapshot[],
    ) => {
      if (!agentRuntimeWorkspaceScopeMatches(
        scope,
        workspacePath,
        captured.generation,
      )) return;
      const scopedRuns = runs.filter((item) => item.workspacePath === workspacePath);
      projection = projectRunSnapshots(projection, scopedRuns);
      for (const item of scopedRuns) {
        if (item.threadId) sessions.set(item.taskId, item.threadId);
      }
    };

    const aScope = scope;
    const staleAList = deferred<RunSnapshot[]>();
    const bList = deferred<RunSnapshot[]>();
    const staleASettlement = staleAList.promise.then((runs) => settle(aScope, "C:/A", runs));

    scope = advanceAgentRuntimeWorkspaceScope(scope, "C:/B");
    projection = emptyRunProjection();
    sessions = new Map();
    const bScope = scope;
    const bSettlement = bList.promise.then((runs) => settle(bScope, "C:/B", runs));

    expect(visible("C:/B")).toEqual({ latestRun: null, sessionId: null, retryRunId: null });

    staleAList.resolve([run("C:/A", { version: 2 })]);
    await staleASettlement;
    settle(aScope, "C:/A", [run("C:/A", { id: "stale-listener-run", version: 3 })]);

    expect(visible("C:/B")).toEqual({ latestRun: null, sessionId: null, retryRunId: null });

    const bRun = run("C:/B", { status: "running", agentOutcome: "pending", finishedAt: null });
    bList.resolve([bRun]);
    await bSettlement;

    expect(visible("C:/B")).toEqual({
      latestRun: bRun,
      sessionId: "thread-b",
      retryRunId: "run-b",
    });
  });
});
