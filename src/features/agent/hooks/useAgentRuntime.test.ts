import { describe, expect, it, vi } from "vitest";

import type { AgentPlan, AgentQuestionRequest, TimelineEntry } from "../../../core/models/agent";
import type { RunEventRecord, RunSnapshot } from "../../../core/models/run";
import {
  advanceAgentRuntimeWorkspaceScope,
  agentRuntimeEnvelopeMatches,
  agentQuestionRequestMatches,
  agentRuntimeApprovalRequestKey,
  agentRuntimeTaskScopeMatches,
  agentRuntimeTaskWorkspaceScopeMatches,
  agentRuntimeWorkspaceScopeMatches,
  clearResolvedAgentQuestionRequest,
  completedAgentPlan,
  handleAgentApprovalRequest,
  loadAllXiaoRunEvents,
  normalizeFileChangeDiff,
  restoredRunProtocolEnvelope,
  settleAutoTitleAfterUndo,
  type AgentRuntimeTaskScope,
  type AgentRuntimeWorkspaceScope,
} from "./useAgentRuntime";
import { latestUndoableTurn } from "./agentProtocol";
import {
  emptyRunProjection,
  latestRunForTask,
  projectRunSnapshots,
  type RunProjection,
} from "./runProjection";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
};

describe("completedAgentPlan", () => {
  it("settles every published step without mutating the live plan", () => {
    const plan: AgentPlan = {
      explanation: "Ship it",
      steps: [
        { step: "Build", status: "inProgress" },
        { step: "Verify", status: "pending" },
      ],
    };

    expect(completedAgentPlan(plan)).toEqual({
      explanation: "Ship it",
      steps: [
        { step: "Build", status: "completed" },
        { step: "Verify", status: "completed" },
      ],
    });
    expect(plan.steps.map((step) => step.status)).toEqual(["inProgress", "pending"]);
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
