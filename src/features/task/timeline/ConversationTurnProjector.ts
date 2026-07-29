import type { TimelineEntry } from "../../../core/models/agent";

export type ConversationTurn = {
  id: string;
  user: TimelineEntry;
  flow: TimelineEntry[];
  commentary: TimelineEntry[];
  work: TimelineEntry[];
  response: TimelineEntry | null;
  files: NonNullable<TimelineEntry["files"]>;
  startIndex: number;
  endIndex: number;
};

export type ConversationProjectionRow =
  | { kind: "turn"; turn: ConversationTurn }
  | { kind: "entry"; entry: TimelineEntry; index: number };

const isUser = (entry: TimelineEntry) => entry.kind === "user" || entry.kind === "brief";
const isResponse = (entry: TimelineEntry) =>
  entry.kind === "result" &&
  entry.title === "Agent response" &&
  entry.meta !== "Commentary";
const isCommentary = (entry: TimelineEntry) =>
  entry.kind === "result" &&
  entry.title === "Agent response" &&
  entry.meta === "Commentary";

const mergeFiles = (entries: TimelineEntry[]) => {
  const files = new Map<string, NonNullable<TimelineEntry["files"]>[number]>();
  for (const entry of entries) {
    if (entry.kind !== "change" || entry.status === "error") continue;
    for (const file of entry.files ?? []) {
      const existing = files.get(file.path);
      files.set(file.path, existing
        ? {
            ...file,
            additions: existing.additions + file.additions,
            deletions: existing.deletions + file.deletions,
          }
        : { ...file });
    }
  }
  return [...files.values()];
};

/**
 * Converts the flat app-server timeline into stable conversation turns.
 * Rendering policy lives here so the canvas cannot accidentally expose
 * reasoning entries or attach execution state to the wrong response.
 */
export class ConversationTurnProjector {
  constructor(private readonly timeline: TimelineEntry[]) {}

  project(): ConversationProjectionRow[] {
    const rows: ConversationProjectionRow[] = [];
    let index = 0;

    while (index < this.timeline.length) {
      const entry = this.timeline[index];
      if (!isUser(entry)) {
        if (entry.kind !== "thought") rows.push({ kind: "entry", entry, index });
        index += 1;
        continue;
      }

      const startIndex = index;
      const user = entry;
      const flow: TimelineEntry[] = [];
      const commentary: TimelineEntry[] = [];
      const work: TimelineEntry[] = [];
      let response: TimelineEntry | null = null;
      index += 1;

      while (index < this.timeline.length) {
        const candidate = this.timeline[index];
        if (isUser(candidate)) {
          const sameBackendTurn = Boolean(
            user.turnId &&
            candidate.turnId &&
            user.turnId === candidate.turnId,
          );
          if (!sameBackendTurn) break;
          flow.push(candidate);
          index += 1;
          continue;
        }
        if (isResponse(candidate)) {
          response = candidate;
        } else if (isCommentary(candidate)) {
          commentary.push(candidate);
          flow.push(candidate);
        } else {
          work.push(candidate);
          flow.push(candidate);
        }
        index += 1;
      }

      rows.push({
        kind: "turn",
        turn: {
          id: user.id,
          user,
          flow,
          commentary,
          work,
          response,
          files: mergeFiles(work),
          startIndex,
          endIndex: index - 1,
        },
      });
    }

    return rows;
  }
}

export const projectConversation = (timeline: TimelineEntry[]) =>
  new ConversationTurnProjector(timeline).project();
