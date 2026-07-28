import { nativeBridge } from "../../../core/bridges/tauri";
import type { CodexThreadSummary, TimelineEntry } from "../../../core/models/agent";
import { timelineEntryFromItem } from "../hooks/useAgentRuntime";

type RawThread = {
  id?: unknown;
  name?: unknown;
  preview?: unknown;
  cwd?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  recencyAt?: unknown;
  status?: unknown;
};

type ThreadListResponse = {
  data?: unknown;
  nextCursor?: unknown;
};

const sourceKinds = ["cli", "vscode", "appServer"];
type AgentContext = { projectPath: string; taskId: string | null };
const snapshotKey = "xiao.codex-thread-snapshot.v2";

const timestampMilliseconds = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1_000_000_000_000 ? value : value * 1_000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const firstTimestamp = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const parsed = timestampMilliseconds(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
};

const threadStatus = (
  value: unknown,
): CodexThreadSummary["status"] => {
  const raw = typeof value === "string"
    ? value
    : value && typeof value === "object"
      ? String(
          (value as Record<string, unknown>).type ??
          (value as Record<string, unknown>).status ??
          "",
        )
      : "";
  const normalized = raw.toLocaleLowerCase();
  if (/(active|working|running|inprogress)/.test(normalized)) return "working";
  if (/(waiting|approval|input|blocked)/.test(normalized)) return "waiting";
  if (/(failed|error|cancelled|interrupted)/.test(normalized)) return "failed";
  return "ready";
};

const titleForThread = (name: unknown, preview: unknown) => {
  const explicit = typeof name === "string" ? name.trim() : "";
  if (explicit) return explicit;
  const firstLine = typeof preview === "string" ? preview.trim().split(/\r?\n/, 1)[0] : "";
  if (!firstLine) return "Untitled Codex chat";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69).trimEnd()}…` : firstLine;
};

export const codexThreadActivityAt = (
  createdAt: number,
  updatedAt: unknown,
  recencyAt: unknown,
) =>
  typeof updatedAt === "number"
    ? updatedAt * 1_000
    : typeof recencyAt === "number"
      ? recencyAt * 1_000
      : createdAt;

const summaryFromThread = (
  value: unknown,
  archived: boolean,
): CodexThreadSummary | null => {
  if (!value || typeof value !== "object") return null;
  const thread = value as RawThread;
  if (typeof thread.id !== "string" || typeof thread.cwd !== "string") return null;
  const createdAt =
    typeof thread.createdAt === "number" ? thread.createdAt * 1_000 : Date.now();
  const updatedAt = codexThreadActivityAt(
    createdAt,
    thread.updatedAt,
    thread.recencyAt,
  );
  return {
    id: thread.id,
    title: titleForThread(thread.name, thread.preview),
    preview: typeof thread.preview === "string" ? thread.preview : "",
    cwd: thread.cwd,
    createdAt,
    updatedAt,
    archived,
    status: threadStatus(thread.status),
  };
};

export const readCodexThreadSnapshot = (): CodexThreadSummary[] => {
  try {
    const value = JSON.parse(window.localStorage.getItem(snapshotKey) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((thread): thread is CodexThreadSummary => Boolean(
      thread &&
      typeof thread === "object" &&
      typeof (thread as CodexThreadSummary).id === "string" &&
      typeof (thread as CodexThreadSummary).cwd === "string" &&
      typeof (thread as CodexThreadSummary).title === "string",
    ));
  } catch {
    return [];
  }
};

export const writeCodexThreadSnapshot = (threads: CodexThreadSummary[]) => {
  try {
    window.localStorage.setItem(snapshotKey, JSON.stringify(threads));
  } catch {
    // The live result remains usable when private storage is unavailable.
  }
};

const listPage = (archived: boolean, cursor: string | null, context: AgentContext) =>
  nativeBridge.agentRequest<ThreadListResponse>("thread/list", {
    archived,
    cursor,
    limit: 100,
    sortKey: "recency_at",
    sortDirection: "desc",
    sourceKinds,
  }, context);

export const listCodexThreads = async (
  context: AgentContext,
  includeArchived = true,
): Promise<CodexThreadSummary[]> => {
  const threads: CodexThreadSummary[] = [];
  for (const archived of includeArchived ? [false, true] : [false]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const response = await listPage(archived, cursor, context);
      const rows = Array.isArray(response.data) ? response.data : [];
      for (const row of rows) {
        const summary = summaryFromThread(row, archived);
        if (summary) threads.push(summary);
      }
      const next = typeof response.nextCursor === "string" ? response.nextCursor : null;
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    } while (cursor);
  }
  return [...new Map(threads.map((thread) => [thread.id, thread])).values()]
    .sort((left, right) => right.updatedAt - left.updatedAt);
};

export const readCodexThreadChangeSummary = async (
  threadId: string,
  context: AgentContext,
) => {
  const response = await nativeBridge.agentRequest<{ data?: unknown }>(
    "thread/turns/list",
    {
      threadId,
      cursor: null,
      // The newest turn is often only a follow-up or status update. A small
      // tail finds the latest real edit without loading the conversation.
      limit: 6,
      sortDirection: "desc",
      itemsView: "full",
    },
    context,
  );
  const turns = Array.isArray(response.data) ? response.data : [];
  for (const rawTurn of turns) {
    if (!rawTurn || typeof rawTurn !== "object") continue;
    const turn = rawTurn as Record<string, unknown>;
    const items = Array.isArray(turn.items) ? turn.items : [];
    let additions = 0;
    let deletions = 0;
    let changed = false;
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const item = rawItem as Record<string, unknown>;
      if (item.type !== "fileChange" || !Array.isArray(item.changes)) continue;
      for (const rawChange of item.changes) {
        if (!rawChange || typeof rawChange !== "object") continue;
        const change = rawChange as Record<string, unknown>;
        if (typeof change.path !== "string") continue;
        changed = true;
        const diff = typeof change.diff === "string" ? change.diff : "";
        for (const line of diff.replace(/\r\n?/g, "\n").split("\n")) {
          if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
          if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
        }
      }
    }
    if (changed) return { additions, deletions };
  }
  return { additions: 0, deletions: 0 };
};

const userEntry = (
  item: Record<string, unknown>,
  createdAt: number,
  turnId: string,
): TimelineEntry | null => {
  if (!Array.isArray(item.content)) return null;
  const title = item.content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n\n")
    .trim();
  if (!title) return null;
  return {
    id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
    kind: "user",
    title,
    createdAt,
    status: "success",
    turnId,
  };
};

export const readCodexThreadTimeline = async (
  threadId: string,
  context: AgentContext,
): Promise<TimelineEntry[]> => {
  const response = await nativeBridge.agentRequest<{ data?: unknown }>(
    "thread/turns/list",
    {
      threadId,
      cursor: null,
      limit: 100,
      sortDirection: "desc",
      itemsView: "full",
    },
    context,
  );
  const turns = Array.isArray(response.data) ? [...response.data].reverse() : [];
  return turns.flatMap((rawTurn) => {
    if (!rawTurn || typeof rawTurn !== "object") return [];
    const turn = rawTurn as Record<string, unknown>;
    const turnId = typeof turn.id === "string" ? turn.id : crypto.randomUUID();
    const createdAt = firstTimestamp(
      turn,
      ["startedAt", "started_at", "createdAt", "created_at"],
    ) ?? Date.now();
    const completedAt = firstTimestamp(
      turn,
      ["completedAt", "completed_at", "updatedAt", "updated_at"],
    );
    const turnDurationMs =
      typeof turn.durationMs === "number" && Number.isFinite(turn.durationMs)
        ? Math.max(0, turn.durationMs)
        : null;
    const items = Array.isArray(turn.items) ? turn.items : [];
    return items.flatMap((rawItem) => {
      if (!rawItem || typeof rawItem !== "object") return [];
      const item = rawItem as Record<string, unknown>;
      if (item.type === "userMessage") {
        const entry = userEntry(item, createdAt, turnId);
        return entry ? [{ ...entry, ...(turnDurationMs !== null ? { turnDurationMs } : {}) }] : [];
      }
      const entry = timelineEntryFromItem(item);
      const explicitItemTimestamp = firstTimestamp(
        item,
        ["createdAt", "created_at", "timestamp", "updatedAt", "updated_at"],
      );
      const itemCreatedAt = explicitItemTimestamp ?? (
        item.type === "agentMessage" && item.phase !== "commentary" && completedAt
          ? completedAt
          : createdAt
      );
      return entry ? [{
        ...entry,
        createdAt: itemCreatedAt,
        turnId,
        ...(turnDurationMs !== null ? { turnDurationMs } : {}),
      }] : [];
    });
  });
};

export const sameWorkspacePath = (left: string, right: string) =>
  left.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLocaleLowerCase() ===
  right.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLocaleLowerCase();

export const workspaceContainsPath = (workspace: string, candidate: string) => {
  const parent = workspace.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLocaleLowerCase();
  const child = candidate.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLocaleLowerCase();
  return child === parent || child.startsWith(`${parent}/`);
};

export const isLegacyCodexImportPath = (path: string) =>
  /\/documents\/codex\/\d{4}-\d{2}-\d{2}\//i.test(
    path.replace(/[\\/]+/g, "/"),
  );
