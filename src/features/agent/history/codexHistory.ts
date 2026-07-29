import { nativeBridge } from "../../../core/bridges/tauri";
import type {
  AgentAttachment,
  AgentPlan,
  CodexThreadSummary,
  CodexRolloutCommand,
  TimelineEntry,
} from "../../../core/models/agent";
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
  path?: unknown;
};

type ThreadListResponse = {
  data?: unknown;
  nextCursor?: unknown;
};

const sourceKinds = ["cli", "vscode", "appServer"];
type AgentContext = { projectPath: string; taskId: string | null };
const snapshotKey = "xiao.codex-thread-snapshot.v2";
const codexRolloutPath = (value: unknown, threadId: string) => {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\\/g, "/");
  return normalized.endsWith(`-${threadId}.jsonl`) ? value : undefined;
};

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
  const rolloutPath = codexRolloutPath(thread.path, thread.id);
  return {
    id: thread.id,
    title: titleForThread(thread.name, thread.preview),
    preview: typeof thread.preview === "string" ? thread.preview : "",
    cwd: thread.cwd,
    ...(rolloutPath ? { rolloutPath } : {}),
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

export const userEntryFromItem = (
  item: Record<string, unknown>,
  createdAt: number,
  turnId: string,
): TimelineEntry | null => {
  if (!Array.isArray(item.content)) return null;
  const rawTitle = item.content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n\n")
    .trim();
  const requestMarker = /(?:^|\n)#{1,3}\s*My request for Codex:\s*\n/i;
  const requestMatch = requestMarker.exec(rawTitle);
  const title = requestMatch
    ? rawTitle.slice(requestMatch.index + requestMatch[0].length).trim()
    : rawTitle;
  const attachments = item.content.flatMap((part, index): AgentAttachment[] => {
    if (!part || typeof part !== "object") return [];
    const value = part as Record<string, unknown>;
    const type = value.type;
    const rawPath = type === "localImage" && typeof value.path === "string"
      ? value.path.trim()
      : null;
    const rawUrl = type === "image" && typeof value.url === "string"
      ? value.url.trim()
      : null;
    if (!rawPath && !rawUrl) return [];
    let path = rawPath ?? rawUrl ?? "";
    if (/^file:\/\//i.test(path)) {
      try {
        path = decodeURIComponent(new URL(path).pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
      } catch {
        // Keep the original URL if a legacy record is malformed.
      }
    }
    const local = Boolean(rawPath || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\"));
    const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? `Image ${index + 1}`;
    return [{
      id: `${typeof item.id === "string" ? item.id : turnId}-image-${index + 1}`,
      name,
      path,
      kind: "image",
      ...(local ? {} : { url: rawUrl ?? path }),
    }];
  });
  if (!title && !attachments.length) return null;
  return {
    id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
    kind: "user",
    title,
    attachments: attachments.length ? attachments : undefined,
    createdAt,
    status: "success",
    turnId,
  };
};

export const readCodexThreadTimeline = async (
  threadId: string,
  context: AgentContext,
  rolloutPath?: string,
): Promise<TimelineEntry[]> => {
  const rolloutCommandsPromise = nativeBridge
    .readCodexRolloutCommands(threadId, rolloutPath)
    .catch((reason): CodexRolloutCommand[] => {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes("Could not find the local Codex rollout for this task.")) {
        return [];
      }
      throw reason;
    });
  const turnsNewestFirst: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response: ThreadListResponse = await nativeBridge.agentRequest<ThreadListResponse>(
      "thread/turns/list",
      {
        threadId,
        cursor,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      },
      context,
    );
    if (Array.isArray(response.data)) turnsNewestFirst.push(...response.data);
    const next: string | null =
      typeof response.nextCursor === "string" ? response.nextCursor : null;
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  } while (cursor);
  const rolloutCommands = await rolloutCommandsPromise;
  const turns = turnsNewestFirst.reverse();
  const rolloutMarkersByTurn = new Map<string, CodexRolloutCommand[]>();
  for (const activity of rolloutCommands) {
    if (activity.activityKind !== "timelineMarker" || !activity.turnId) continue;
    const markers = rolloutMarkersByTurn.get(activity.turnId) ?? [];
    markers.push(activity);
    rolloutMarkersByTurn.set(activity.turnId, markers);
  }
  const commandsByTurn = new Map<string, CodexRolloutCommand[]>();
  const commandsByTurnIndex = new Map<number, CodexRolloutCommand[]>();
  const latestRolloutTurnIndex = rolloutCommands.reduce(
    (latest, command) =>
      typeof command.turnIndex === "number" && Number.isFinite(command.turnIndex)
        ? Math.max(latest, command.turnIndex)
        : latest,
    -1,
  );
  const rolloutTurnOffset = Math.max(0, latestRolloutTurnIndex + 1 - turns.length);
  const turnWindows = turns.flatMap((rawTurn, index) => {
    if (!rawTurn || typeof rawTurn !== "object") return [];
    const turn = rawTurn as Record<string, unknown>;
    if (typeof turn.id !== "string") return [];
    const startedAt = firstTimestamp(
      turn,
      ["startedAt", "started_at", "createdAt", "created_at"],
    );
    const completedAt = firstTimestamp(
      turn,
      ["completedAt", "completed_at", "updatedAt", "updated_at"],
    );
    const nextTurn = turns[index + 1];
    const nextStartedAt = nextTurn && typeof nextTurn === "object"
      ? firstTimestamp(
        nextTurn as Record<string, unknown>,
        ["startedAt", "started_at", "createdAt", "created_at"],
      )
      : null;
    return startedAt === null
      ? []
      : [{ id: turn.id, startedAt, completedAt, nextStartedAt }];
  });
  for (const command of rolloutCommands) {
    if (command.activityKind === "timelineMarker") continue;
    const commandAt = timestampMilliseconds(command.createdAt);
    const inferredTurn = commandAt === null ? null : [...turnWindows]
      .reverse()
      .find((turn) => turn.startedAt <= commandAt && (
        turn.nextStartedAt === null || commandAt < turn.nextStartedAt
      ));
    const owningTurnId = command.turnId ?? inferredTurn?.id;
    if (owningTurnId) {
      const current = commandsByTurn.get(owningTurnId) ?? [];
      current.push(command);
      commandsByTurn.set(owningTurnId, current);
      continue;
    }
    if (typeof command.turnIndex === "number") {
      const localTurnIndex = command.turnIndex - rolloutTurnOffset;
      if (localTurnIndex >= 0 && localTurnIndex < turns.length) {
        const current = commandsByTurnIndex.get(localTurnIndex) ?? [];
        current.push(command);
        commandsByTurnIndex.set(localTurnIndex, current);
      }
    }
  }
  return turns.flatMap((rawTurn, rawTurnIndex) => {
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
    const markers = rolloutMarkersByTurn.get(turnId) ?? [];
    const exactMarkerTimes = new Map(markers.flatMap((marker) => {
      const createdAt = timestampMilliseconds(marker.createdAt);
      return createdAt === null ? [] : [[marker.id, createdAt] as const];
    }));
    const markerQueues = new Map<string, CodexRolloutCommand[]>();
    for (const marker of markers) {
      if (!marker.label) continue;
      const queue = markerQueues.get(marker.label) ?? [];
      queue.push(marker);
      markerQueues.set(marker.label, queue);
    }
    const takeMarkerTime = (label: string) => {
      const marker = markerQueues.get(label)?.shift();
      return marker ? timestampMilliseconds(marker.createdAt) : null;
    };
    const takeReasoningTime = (summaryParts: number) => {
      const queue = markerQueues.get("reasoning");
      if (!queue?.length) return null;
      let consumed = 0;
      let createdAt: number | null = null;
      while (queue.length && consumed < Math.max(1, summaryParts)) {
        const marker = queue.shift()!;
        createdAt ??= timestampMilliseconds(marker.createdAt);
        consumed += Math.max(1, marker.markerSpan ?? 1);
      }
      return createdAt;
    };
    const rolloutTimestampForItem = (item: Record<string, unknown>) => {
      const exact = typeof item.id === "string" ? exactMarkerTimes.get(item.id) : undefined;
      if (exact !== undefined) return exact;
      if (item.type === "userMessage") return takeMarkerTime("user");
      if (item.type === "agentMessage" && typeof item.phase === "string") {
        return takeMarkerTime(item.phase);
      }
      if (item.type === "reasoning") {
        const summaryParts = Array.isArray(item.summary) ? item.summary.length : 0;
        return takeReasoningTime(summaryParts);
      }
      return null;
    };
    const mapped = items.flatMap((rawItem) => {
      if (!rawItem || typeof rawItem !== "object") return [];
      const item = rawItem as Record<string, unknown>;
      const explicitItemTimestamp = firstTimestamp(
        item,
        ["createdAt", "created_at", "timestamp", "updatedAt", "updated_at"],
      );
      const rolloutItemTimestamp = rolloutTimestampForItem(item);
      const itemCreatedAt = explicitItemTimestamp ?? rolloutItemTimestamp ?? (
        item.type === "agentMessage" && item.phase !== "commentary" && completedAt
          ? completedAt
          : createdAt
      );
      if (item.type === "userMessage") {
        const entry = userEntryFromItem(item, itemCreatedAt, turnId);
        return entry ? [{ ...entry, ...(turnDurationMs !== null ? { turnDurationMs } : {}) }] : [];
      }
      const entry = timelineEntryFromItem(item);
      return entry ? [{
        ...entry,
        createdAt: itemCreatedAt,
        turnId,
        ...(turnDurationMs !== null ? { turnDurationMs } : {}),
      }] : [];
    });
    const existingCommands = new Set(mapped.flatMap((entry) =>
      entry.kind === "command" && entry.command ? [entry.command] : []
    ));
    const recoveredCommands: TimelineEntry[] = [
      ...(commandsByTurn.get(turnId) ?? []),
      ...(commandsByTurnIndex.get(rawTurnIndex) ?? []),
    ]
      .filter((command) =>
        command.activityKind !== "command" || !existingCommands.has(command.command)
      )
      .map((command) => {
        const shell = command.activityKind === "command";
        const imageView = command.activityKind === "imageView";
        const completed = imageView ||
          command.output !== null && command.output !== undefined ||
          command.durationMs !== null && command.durationMs !== undefined;
        const meta = command.activityKind === "webSearch"
          ? "Web search"
          : command.activityKind === "skill"
            ? `Skill · ${command.label ?? "Codex skill"}`
            : command.activityKind === "integration"
              ? "Plugin tool"
              : command.activityKind === "tool"
                ? command.label === "Read chat terminal" ? "Codex tool" : "Dynamic tool"
                : imageView
                  ? "Image tool"
                : "Workspace";
        const imageName = imageView
          ? command.command.split(/[\\/]/).filter(Boolean).at(-1) ?? "Viewed image"
          : null;
        return {
          id: `rollout-command:${command.id}`,
          kind: "command" as const,
          title: shell
            ? completed ? "Ran command" : "Running command"
            : command.label ?? command.command,
          command: shell ? command.command : undefined,
          body: command.output ?? undefined,
          meta,
          attachments: imageView ? [{
            id: `rollout-image:${command.id}`,
            name: imageName!,
            path: command.command,
            kind: "image" as const,
          }] : undefined,
          createdAt: timestampMilliseconds(command.createdAt) ?? createdAt,
          durationMs: command.durationMs ?? undefined,
          exitCode: command.exitCode ?? undefined,
          status: !completed
            ? "active" as const
            : command.exitCode !== undefined && command.exitCode !== null && command.exitCode !== 0
              ? "error" as const
              : "success" as const,
          turnId,
          ...(turnDurationMs !== null ? { turnDurationMs } : {}),
        };
      });
    return [...mapped, ...recoveredCommands].sort(
      (left, right) => (left.createdAt ?? createdAt) - (right.createdAt ?? createdAt),
    );
  });
};

export const codexPlanFromTimeline = (timeline: TimelineEntry[]): AgentPlan | null => {
  const plan = [...timeline].reverse().find((entry) =>
    entry.kind === "thought" && entry.meta === "Plan" && entry.body?.trim()
  );
  if (!plan?.body) return null;
  const steps = plan.body.split(/\r?\n/).flatMap((line) => {
    const match = line.match(
      /^\s*(?:[-*]|\d+[.)])\s+(?:\[([ xX>~!-])\]\s*)?(.+?)\s*$/,
    );
    if (!match?.[2]) return [];
    const marker = match[1]?.toLowerCase();
    const status = marker === "x"
      ? "completed" as const
      : marker === ">" || marker === "~" || marker === "!"
        ? "inProgress" as const
        : "pending" as const;
    return [{ step: match[2].trim(), status }];
  });
  return steps.length ? { explanation: null, steps } : null;
};

const latestCodexTurn = (timeline: TimelineEntry[]) => {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index].kind === "user" || timeline[index].kind === "brief") {
      return timeline.slice(index + 1);
    }
  }
  return [] as TimelineEntry[];
};

export const codexTimelineHasFinalResponse = (timeline: TimelineEntry[]) =>
  latestCodexTurn(timeline).some((entry) =>
    entry.kind === "result" &&
    entry.title === "Agent response" &&
    entry.meta !== "Commentary" &&
    entry.status !== "active"
  );

export const codexTimelineIsWorking = (timeline: TimelineEntry[]) => {
  const latestTurn = latestCodexTurn(timeline);
  return latestTurn.length > 0 &&
    !codexTimelineHasFinalResponse(timeline) &&
    latestTurn.some((entry) => entry.status === "active");
};

const sameJsonValue = (left: unknown, right: unknown) =>
  left === right || JSON.stringify(left) === JSON.stringify(right);

export const sameCodexTimeline = (
  left: readonly TimelineEntry[],
  right: readonly TimelineEntry[],
) => left.length === right.length && left.every((entry, index) => {
  const candidate = right[index];
  return Boolean(candidate) &&
    entry.id === candidate.id &&
    entry.kind === candidate.kind &&
    entry.title === candidate.title &&
    entry.createdAt === candidate.createdAt &&
    entry.body === candidate.body &&
    entry.meta === candidate.meta &&
    entry.status === candidate.status &&
    entry.command === candidate.command &&
    entry.requestId === candidate.requestId &&
    entry.pendingInputId === candidate.pendingInputId &&
    entry.runId === candidate.runId &&
    entry.turnId === candidate.turnId &&
    entry.turnDurationMs === candidate.turnDurationMs &&
    entry.durationMs === candidate.durationMs &&
    entry.exitCode === candidate.exitCode &&
    entry.turnDiff === candidate.turnDiff &&
    sameJsonValue(entry.files, candidate.files) &&
    sameJsonValue(entry.attachments, candidate.attachments) &&
    sameJsonValue(entry.exploration, candidate.exploration) &&
    sameJsonValue(entry.collaborators, candidate.collaborators);
});

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
