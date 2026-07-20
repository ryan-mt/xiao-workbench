import { describe, expect, it } from "vitest";

import type {
  PendingInputKind,
  PendingInputSnapshot,
  RunSnapshot,
} from "../../core/models/run";
import type { WorkbenchTask } from "../task/task.types";
import { projectAttentionItems } from "./attentionProjection";

type AttentionTask = Pick<
  WorkbenchTask,
  "id" | "title" | "archived" | "unread" | "updatedAt"
>;

const task = (patch: Partial<AttentionTask> = {}): AttentionTask => ({
  id: "task-a",
  title: "Review workspace changes",
  archived: false,
  unread: false,
  updatedAt: 40,
  ...patch,
});

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
  status: "running",
  agentOutcome: "pending",
  verificationOutcome: "not_requested",
  executionEnvironmentId: "environment-a",
  executionRoot: "C:/workspace",
  managedWorktreeId: null,
  prompt: "Review workspace changes",
  model: "gpt-test",
  reasoningEffort: "medium",
  serviceTier: null,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  threadId: "thread-a",
  threadSource: "created",
  cliVersion: "test",
  runtimeGeneration: 1,
  turnId: "turn-a",
  cancelRequested: false,
  queuedAt: 10,
  startedAt: 11,
  finishedAt: null,
  version: 1,
  ...patch,
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

describe("attention projection", () => {
  it("maps all active pending kinds without exposing safe summaries", () => {
    const kinds: PendingInputKind[] = [
      "command_approval",
      "file_approval",
      "permissions",
      "question",
      "mcp_elicitation",
    ];
    const items = projectAttentionItems(
      [task()],
      [run()],
      kinds.map((kind, index) => pendingInput({
        id: `pending-${index}`,
        kind,
        safeSummary: { html: "<strong>unsafe summary</strong>" },
      })),
    );

    expect(items.map((item) => item.title)).toEqual([
      "Command approval needed",
      "File change approval needed",
      "Permission request",
      "Question from Xiao",
      "MCP input requested",
    ]);
    expect(items.every((item) => item.kind === "decision")).toBe(true);
    expect(JSON.stringify(items)).not.toContain("unsafe summary");
  });

  it("excludes settled pending inputs and pending inputs on terminal runs", () => {
    expect(projectAttentionItems([task()], [run()], [
      pendingInput({ id: "resolved", resolvedAt: 30 }),
      pendingInput({ id: "invalidated", invalidatedAt: 31 }),
    ])).toEqual([]);
    expect(projectAttentionItems(
      [task()],
      [run({ status: "completed", agentOutcome: "completed", finishedAt: 30 })],
      [pendingInput()],
    )).toEqual([]);
  });

  it("uses only the newest available run for each task", () => {
    const newestFailure = run({
      id: "new-failure",
      status: "failed",
      agentOutcome: "failed",
      queuedAt: 20,
      finishedAt: 30,
    });
    const items = projectAttentionItems(
      [task()],
      [
        run({ id: "old-failure", status: "failed", agentOutcome: "failed", queuedAt: 10 }),
        newestFailure,
      ],
      [],
    );

    expect(items).toHaveLength(1);
    expect(items[0].runId).toBe(newestFailure.id);
    expect(projectAttentionItems(
      [task()],
      [
        run({ id: "old", status: "failed", agentOutcome: "failed", queuedAt: 10 }),
        run({
          id: "new",
          status: "completed",
          agentOutcome: "completed",
          queuedAt: 20,
          finishedAt: 30,
        }),
      ],
      [],
    )).toEqual([]);
  });

  it.each([
    ["needs_attention", "Run needs attention"],
    ["failed", "Run failed"],
    ["interrupted", "Run interrupted"],
  ] as const)("includes %s runs", (status, title) => {
    const items = projectAttentionItems([task()], [run({ status, finishedAt: 30 })], []);

    expect(items).toMatchObject([{ kind: "failure", title }]);
  });

  it("distinguishes failed and blocked verification", () => {
    const items = projectAttentionItems(
      [task(), task({ id: "task-b", title: "Second task" })],
      [
        run({
          status: "needs_attention",
          verificationOutcome: "failed",
          finishedAt: 30,
        }),
        run({
          id: "run-b",
          taskId: "task-b",
          status: "interrupted",
          agentOutcome: "completed",
          verificationOutcome: "blocked",
          finishedAt: 31,
        }),
      ],
      [],
    );

    expect(items.map(({ kind, title }) => ({ kind, title }))).toEqual([
      { kind: "verification", title: "Verification blocked" },
      { kind: "verification", title: "Verification failed" },
    ]);
  });

  it("suppresses a run duplicate when the same run has a pending decision", () => {
    const terminalSnapshot = run({ status: "needs_attention", finishedAt: 30 });
    const activeReplacement = run({ status: "waiting_for_input" });
    const items = projectAttentionItems(
      [task()],
      [terminalSnapshot, activeReplacement],
      [pendingInput()],
    );

    expect(items).toMatchObject([
      { id: "pending:pending-a", kind: "decision" },
    ]);
  });

  it("adds generic unread only when the task has no decision or failure", () => {
    const unread = task({ unread: true });

    expect(projectAttentionItems([unread], [], [])).toMatchObject([
      { id: "unread:task-a", title: "Unread task", runId: null },
    ]);
    expect(JSON.stringify(projectAttentionItems([unread], [], [])).toLowerCase()).not.toContain(
      "result",
    );
    expect(projectAttentionItems(
      [unread],
      [run({ status: "failed", agentOutcome: "failed", finishedAt: 30 })],
      [],
    )).toHaveLength(1);
    expect(projectAttentionItems([unread], [run()], [pendingInput()])).toHaveLength(1);
  });

  it("ignores archived and missing tasks", () => {
    const items = projectAttentionItems(
      [task({ archived: true, unread: true })],
      [
        run({ status: "failed", agentOutcome: "failed" }),
        run({ id: "run-missing", taskId: "missing", status: "running" }),
      ],
      [pendingInput(), pendingInput({ id: "missing", runId: "run-missing" })],
    );

    expect(items).toEqual([]);
  });

  it("sorts categories, recency, and stable IDs deterministically", () => {
    const items = projectAttentionItems(
      [
        task({ id: "task-a", unread: true }),
        task({ id: "task-b", title: "B", unread: true, updatedAt: 200 }),
        task({ id: "task-c", title: "C", updatedAt: 1 }),
        task({ id: "task-d", title: "D", updatedAt: 1 }),
        task({ id: "task-e", title: "E", unread: true, updatedAt: 300 }),
      ],
      [
        run({ id: "run-a", taskId: "task-a", queuedAt: 1 }),
        run({ id: "run-b", taskId: "task-b", queuedAt: 1 }),
        run({ id: "run-c", taskId: "task-c", status: "failed", finishedAt: 50 }),
        run({ id: "run-d", taskId: "task-d", status: "interrupted", finishedAt: 50 }),
      ],
      [
        pendingInput({ id: "b", runId: "run-b", openedAt: 10 }),
        pendingInput({ id: "a", runId: "run-a", openedAt: 10 }),
      ],
    );

    expect(items.map((item) => item.id)).toEqual([
      "pending:a",
      "pending:b",
      "run:run-c",
      "run:run-d",
      "unread:task-e",
    ]);
  });

  it("normalizes and bounds long detail to 160 characters", () => {
    const items = projectAttentionItems(
      [task({ title: `Long\n task ${"detail ".repeat(40)}`, unread: true })],
      [],
      [],
    );

    expect(items[0].detail.length).toBeLessThanOrEqual(160);
    expect(items[0].detail).not.toContain("\n");
    expect(items[0].detail.endsWith("…")).toBe(true);
  });
});
