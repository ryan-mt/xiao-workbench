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
};

type ThreadListResponse = {
  data?: unknown;
  nextCursor?: unknown;
};

const sourceKinds = ["cli", "vscode", "appServer"];

const titleForThread = (name: unknown, preview: unknown) => {
  const explicit = typeof name === "string" ? name.trim() : "";
  if (explicit) return explicit;
  const firstLine = typeof preview === "string" ? preview.trim().split(/\r?\n/, 1)[0] : "";
  if (!firstLine) return "Untitled Codex chat";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69).trimEnd()}…` : firstLine;
};

const summaryFromThread = (
  value: unknown,
  archived: boolean,
): CodexThreadSummary | null => {
  if (!value || typeof value !== "object") return null;
  const thread = value as RawThread;
  if (typeof thread.id !== "string" || typeof thread.cwd !== "string") return null;
  const createdAt =
    typeof thread.createdAt === "number" ? thread.createdAt * 1_000 : Date.now();
  const updatedAt =
    typeof thread.recencyAt === "number"
      ? thread.recencyAt * 1_000
      : typeof thread.updatedAt === "number"
        ? thread.updatedAt * 1_000
        : createdAt;
  return {
    id: thread.id,
    title: titleForThread(thread.name, thread.preview),
    preview: typeof thread.preview === "string" ? thread.preview : "",
    cwd: thread.cwd,
    createdAt,
    updatedAt,
    archived,
  };
};

const listPage = (archived: boolean, cursor: string | null) =>
  nativeBridge.agentRequest<ThreadListResponse>("thread/list", {
    archived,
    cursor,
    limit: 100,
    sortKey: "recency_at",
    sortDirection: "desc",
    sourceKinds,
  });

export const listCodexThreads = async (): Promise<CodexThreadSummary[]> => {
  const threads: CodexThreadSummary[] = [];
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const response = await listPage(archived, cursor);
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
    meta: "You",
    status: "success",
    turnId,
  };
};

export const readCodexThreadTimeline = async (
  threadId: string,
): Promise<TimelineEntry[]> => {
  const response = await nativeBridge.agentRequest<{ thread?: unknown }>("thread/read", {
    threadId,
    includeTurns: true,
  });
  const root =
    response.thread && typeof response.thread === "object"
      ? response.thread as Record<string, unknown>
      : response as unknown as Record<string, unknown>;
  const turns = Array.isArray(root.turns) ? root.turns : [];
  return turns.flatMap((rawTurn) => {
    if (!rawTurn || typeof rawTurn !== "object") return [];
    const turn = rawTurn as Record<string, unknown>;
    const turnId = typeof turn.id === "string" ? turn.id : crypto.randomUUID();
    const createdAt =
      typeof turn.startedAt === "number" ? turn.startedAt * 1_000 : Date.now();
    const items = Array.isArray(turn.items) ? turn.items : [];
    return items.flatMap((rawItem) => {
      if (!rawItem || typeof rawItem !== "object") return [];
      const item = rawItem as Record<string, unknown>;
      if (item.type === "userMessage") {
        const entry = userEntry(item, createdAt, turnId);
        return entry ? [entry] : [];
      }
      const entry = timelineEntryFromItem(item);
      return entry ? [{ ...entry, createdAt, turnId }] : [];
    });
  });
};

export const sameWorkspacePath = (left: string, right: string) =>
  left.replace(/[\\/]+$/, "").toLocaleLowerCase() ===
  right.replace(/[\\/]+$/, "").toLocaleLowerCase();
