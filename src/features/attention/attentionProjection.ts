import type {
  PendingInputKind,
  PendingInputSnapshot,
  RunSnapshot,
} from "../../core/models/run";
import { runStatusIsActive } from "../agent/hooks/runProjection";
import type { WorkbenchTask } from "../task/task.types";

export type AttentionItem = {
  id: string;
  taskId: string;
  runId: string | null;
  kind: "decision" | "failure" | "verification" | "unread";
  title: string;
  detail: string;
  timestamp: number;
};

type AttentionTask = Pick<
  WorkbenchTask,
  "id" | "title" | "archived" | "unread" | "updatedAt"
>;

const MAX_DETAIL_LENGTH = 160;

const pendingTitles: Record<PendingInputKind, string> = {
  command_approval: "Command approval needed",
  file_approval: "File change approval needed",
  permissions: "Permission request",
  question: "Question from Xiao",
  mcp_elicitation: "MCP input requested",
};

const boundedDetail = (task: AttentionTask, run: RunSnapshot | undefined) => {
  const value = task.title.trim() || run?.prompt.trim() || "Untitled task";
  const normalized = value.replace(/\s+/g, " ");
  return normalized.length <= MAX_DETAIL_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_DETAIL_LENGTH - 1).trimEnd()}…`;
};

const newestRunsByTask = (runs: RunSnapshot[]) => {
  const newest = new Map<string, RunSnapshot>();
  for (const run of runs) {
    const current = newest.get(run.taskId);
    if (
      !current ||
      run.queuedAt > current.queuedAt ||
      (run.queuedAt === current.queuedAt && run.id.localeCompare(current.id) > 0)
    ) {
      newest.set(run.taskId, run);
    }
  }
  return newest;
};

const runAttentionTitle = (run: RunSnapshot) => {
  if (run.verificationOutcome === "failed") return "Verification failed";
  if (run.verificationOutcome === "blocked") return "Verification blocked";
  if (run.status === "failed") return "Run failed";
  if (run.status === "interrupted") return "Run interrupted";
  return "Run needs attention";
};

const itemRank = (item: AttentionItem) => {
  if (item.kind === "decision") return 0;
  if (item.kind === "unread") return 2;
  return 1;
};

export const projectAttentionItems = (
  tasks: AttentionTask[],
  runs: RunSnapshot[],
  pendingInputs: PendingInputSnapshot[],
): AttentionItem[] => {
  const tasksById = new Map(
    tasks.filter((task) => !task.archived).map((task) => [task.id, task]),
  );
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const newestByTask = newestRunsByTask(runs);
  const items: AttentionItem[] = [];
  const tasksWithAttention = new Set<string>();
  const runsWithPending = new Set<string>();

  for (const pending of pendingInputs) {
    if (pending.resolvedAt !== null || pending.invalidatedAt !== null) continue;
    const run = runsById.get(pending.runId);
    if (!run || !runStatusIsActive(run.status)) continue;
    const task = tasksById.get(run.taskId);
    if (!task) continue;
    items.push({
      id: `pending:${pending.id}`,
      taskId: task.id,
      runId: run.id,
      kind: "decision",
      title: pendingTitles[pending.kind],
      detail: boundedDetail(task, run),
      timestamp: pending.openedAt,
    });
    tasksWithAttention.add(task.id);
    runsWithPending.add(run.id);
  }

  for (const [taskId, run] of newestByTask) {
    const task = tasksById.get(taskId);
    if (
      !task ||
      runsWithPending.has(run.id) ||
      !["needs_attention", "failed", "interrupted"].includes(run.status)
    ) continue;
    const verification = run.verificationOutcome === "failed" ||
      run.verificationOutcome === "blocked";
    items.push({
      id: `run:${run.id}`,
      taskId,
      runId: run.id,
      kind: verification ? "verification" : "failure",
      title: runAttentionTitle(run),
      detail: boundedDetail(task, run),
      timestamp: run.finishedAt ?? run.startedAt ?? run.queuedAt,
    });
    tasksWithAttention.add(taskId);
  }

  for (const task of tasksById.values()) {
    if (!task.unread || tasksWithAttention.has(task.id)) continue;
    items.push({
      id: `unread:${task.id}:${task.updatedAt}`,
      taskId: task.id,
      runId: null,
      kind: "unread",
      title: "Unread task",
      detail: boundedDetail(task, newestByTask.get(task.id)),
      timestamp: task.updatedAt,
    });
  }

  return items.sort((left, right) =>
    itemRank(left) - itemRank(right) ||
    right.timestamp - left.timestamp ||
    left.id.localeCompare(right.id)
  );
};
