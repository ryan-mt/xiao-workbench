import { describe, expect, it } from "vitest";

import type { PendingInputSnapshot, RunEventRecord, RunSnapshot } from "../../core/models/run";
import { projectObservatory } from "./observatoryProjection";

const run = (): RunSnapshot => ({
  id: "run-1",
  workspacePath: "C:/workspace",
  taskId: "task-1",
  idempotencyKey: "key",
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
  status: "running",
  agentOutcome: "pending",
  verificationOutcome: "not_requested",
  executionEnvironmentId: "environment",
  executionRoot: "C:/workspace",
  managedWorktreeId: null,
  prompt: "Build it",
  model: "gpt-root",
  reasoningEffort: "high",
  serviceTier: null,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  threadId: "root",
  threadSource: "xiao",
  cliVersion: "1",
  runtimeGeneration: 1,
  turnId: "turn",
  cancelRequested: false,
  queuedAt: 1,
  startedAt: 2,
  finishedAt: null,
  version: 1,
});

const event = (sequence: number, item: Record<string, unknown>): RunEventRecord => ({
  runId: "run-1",
  sequence,
  timestamp: 10 + sequence,
  eventType: "agent.item/completed",
  eventKey: String(sequence),
  safePayload: {
    method: "item/completed",
    params: { threadId: "root", turnId: "turn", item },
  },
});

describe("Agent Observatory projection", () => {
  it("builds nested parent and child nodes from normalized collaboration events", () => {
    const snapshot = projectObservatory(run(), [
      event(1, {
        type: "collabAgentToolCall",
        id: "spawn-a",
        tool: "spawnAgent",
        senderThreadId: "root",
        receiverThreadIds: ["child-a"],
        prompt: "Investigate",
        model: "gpt-child",
        agentsStates: { "child-a": { status: "running" } },
      }),
      event(2, {
        type: "collabAgentToolCall",
        id: "spawn-b",
        tool: "spawnAgent",
        senderThreadId: "child-a",
        receiverThreadIds: ["child-b"],
        prompt: "Check tests",
        agentsStates: { "child-b": { status: "completed", message: "Tests pass" } },
      }),
    ], []);

    expect(snapshot.nodes.map((node) => [node.threadId, node.parentThreadId, node.depth])).toEqual([
      ["root", null, 0],
      ["child-a", "root", 1],
      ["child-b", "child-a", 2],
    ]);
    expect(snapshot.nodes[2]).toMatchObject({ status: "completed", latestAction: "Tests pass" });
  });

  it("keeps missing optional ids safe and attaches pending input to its owner", () => {
    const pending: PendingInputSnapshot = {
      id: "pending",
      runId: "run-1",
      runtimeGeneration: 1,
      requestId: "1",
      threadId: "child-missing",
      turnId: "turn",
      itemId: "approval-item",
      kind: "command_approval",
      safeSummary: {},
      openedAt: 99,
      resolvedAt: null,
      invalidatedAt: null,
    };
    const snapshot = projectObservatory(run(), [event(1, {
      type: "collabAgentToolCall",
      id: "wait",
      tool: "wait",
      agentsStates: {},
    })], [pending]);

    expect(snapshot.nodes.find((node) => node.threadId === "child-missing")).toMatchObject({
      status: "waiting",
      pendingInputIds: ["pending"],
    });
    expect(snapshot.activities[0]).toMatchObject({ category: "approvals", status: "warning" });
  });

  it("surfaces failure, close, and token usage states without raw protocol output", () => {
    const tokenEvent: RunEventRecord = {
      runId: "run-1",
      sequence: 1,
      timestamp: 11,
      eventType: "agent.thread/tokenUsage/updated",
      eventKey: null,
      safePayload: {
        method: "thread/tokenUsage/updated",
        params: { threadId: "root", tokenUsage: { total: { totalTokens: 42 } } },
      },
    };
    const snapshot = projectObservatory(run(), [tokenEvent, event(2, {
      type: "collabAgentToolCall",
      id: "close",
      tool: "closeAgent",
      senderThreadId: "root",
      receiverThreadIds: ["child"],
      agentsStates: { child: { status: "errored", message: "Failed safely" } },
    })], []);

    expect(snapshot.nodes.find((node) => node.threadId === "root")?.totalTokens).toBe(42);
    expect(snapshot.nodes.find((node) => node.threadId === "child")).toMatchObject({
      status: "failed",
      latestAction: "Failed safely",
    });
  });

  it("tracks wait, resume, and close transitions from persisted collaboration events", () => {
    const spawned = event(1, {
      type: "collabAgentToolCall",
      id: "spawn",
      tool: "spawnAgent",
      senderThreadId: "root",
      receiverThreadIds: ["child"],
      agentsStates: { child: { status: "running" } },
    });
    const waiting = event(2, {
      type: "collabAgentToolCall",
      id: "wait",
      tool: "wait",
      senderThreadId: "root",
      receiverThreadIds: ["child"],
      agentsStates: { child: { status: "interrupted", message: "Paused" } },
    });
    const resumed = event(3, {
      type: "collabAgentToolCall",
      id: "resume",
      tool: "resumeAgent",
      senderThreadId: "root",
      receiverThreadIds: ["child"],
      agentsStates: { child: { status: "running", message: "Continuing" } },
    });
    const closed = event(4, {
      type: "collabAgentToolCall",
      id: "close",
      tool: "closeAgent",
      senderThreadId: "root",
      receiverThreadIds: ["child"],
      agentsStates: { child: { status: "shutdown", message: "Closed" } },
    });

    expect(projectObservatory(run(), [spawned, waiting], []).nodes.at(-1)?.status).toBe("interrupted");
    expect(projectObservatory(run(), [spawned, waiting, resumed], []).nodes.at(-1)).toMatchObject({
      status: "running",
      latestAction: "Continuing",
      finishedAt: null,
    });
    const snapshot = projectObservatory(run(), [spawned, waiting, resumed, closed], []);
    expect(snapshot.nodes.at(-1)).toMatchObject({ status: "shutdown", latestAction: "Closed" });
    expect(snapshot.activities.map((activity) => activity.title)).toEqual([
      "Close Agent",
      "Resume Agent",
      "Wait",
      "Spawn Agent",
    ]);
  });
});
