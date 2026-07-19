import type { TimelineEntry } from "../../../core/models/agent";

export type LiveTimelineDelta =
  | {
      kind: "assistant";
      entryId: string;
      delta: string;
      settleThinkingEntryId?: string;
    }
  | {
      kind: "reasoning";
      entryId: string;
      delta: string;
      replace: boolean;
    }
  | {
      kind: "command-output";
      entryId: string;
      delta: string;
    };

const settleThinking = (timeline: TimelineEntry[], entryId: string) => {
  const index = timeline.findIndex((entry) => entry.id === entryId);
  if (index < 0) return timeline;
  const entry = timeline[index];
  const next = [...timeline];
  if (!entry.body?.trim()) {
    next.splice(index, 1);
  } else {
    next[index] = {
      ...entry,
      title: "Reasoning complete",
      meta: "Xiao",
      status: "success",
    };
  }
  return next;
};

export const appendLiveTimelineDelta = (
  queue: LiveTimelineDelta[],
  delta: LiveTimelineDelta,
) => {
  const previous = queue.at(-1);
  if (!previous || previous.kind !== delta.kind || previous.entryId !== delta.entryId) {
    queue.push(delta);
    return;
  }

  if (delta.kind === "assistant" && previous.kind === "assistant") {
    previous.delta += delta.delta;
    previous.settleThinkingEntryId ??= delta.settleThinkingEntryId;
    return;
  }
  if (delta.kind === "command-output" && previous.kind === "command-output") {
    previous.delta += delta.delta;
    return;
  }
  if (delta.kind === "reasoning" && previous.kind === "reasoning") {
    if (delta.replace) {
      previous.delta = delta.delta;
      previous.replace = true;
    } else {
      previous.delta += delta.delta;
    }
  }
};

export const applyLiveTimelineDeltas = (
  timeline: TimelineEntry[],
  deltas: readonly LiveTimelineDelta[],
  createdAt = Date.now(),
) => {
  let next = timeline;

  for (const delta of deltas) {
    if (delta.kind === "assistant") {
      if (delta.settleThinkingEntryId) {
        next = settleThinking(next, delta.settleThinkingEntryId);
      }
      const index = next.findIndex((entry) => entry.id === delta.entryId);
      if (index < 0) {
        next = [
          ...next,
          {
            id: delta.entryId,
            kind: "result",
            title: "Agent response",
            createdAt,
            body: delta.delta,
            meta: "Streaming",
            status: "active",
          },
        ];
      } else {
        const updated = [...next];
        updated[index] = {
          ...updated[index],
          body: `${updated[index].body ?? ""}${delta.delta}`,
        };
        next = updated;
      }
      continue;
    }

    if (delta.kind === "reasoning") {
      const index = next.findIndex((entry) => entry.id === delta.entryId);
      if (index < 0) {
        next = [
          ...next,
          {
            id: delta.entryId,
            kind: "thought",
            title: "Thinking",
            createdAt,
            body: delta.delta,
            meta: "Live reasoning",
            status: "active",
          },
        ];
      } else {
        const updated = [...next];
        const entry = updated[index];
        updated[index] = {
          ...entry,
          title: "Thinking",
          body: delta.replace ? delta.delta : `${entry.body ?? ""}${delta.delta}`,
          meta: "Live reasoning",
          status: "active",
        };
        next = updated;
      }
      continue;
    }

    const index = next.findIndex((entry) => entry.id === delta.entryId);
    if (index >= 0) {
      const updated = [...next];
      const entry = updated[index];
      updated[index] = {
        ...entry,
        body: `${entry.body ?? ""}${delta.delta}`.slice(-8_000),
      };
      next = updated;
    }
  }

  return next;
};

const COMPLETED_TEXT_BYTE_LIMIT = 16 * 1024;

const matchesBackendTruncation = (streamedBody: string, completedBody: string) => {
  if (!completedBody.endsWith("…")) return false;

  const bytes = new TextEncoder().encode(streamedBody);
  if (bytes.length <= COMPLETED_TEXT_BYTE_LIMIT) return false;

  let end = COMPLETED_TEXT_BYTE_LIMIT;
  while ((bytes[end] & 0xc0) === 0x80) end -= 1;
  const prefix = new TextDecoder().decode(bytes.subarray(0, end));
  return completedBody === `${prefix}…`;
};

export const reconcileCompletedStreamBody = (
  streamedBody: string | undefined,
  completedBody: string | undefined,
) => {
  if (
    streamedBody !== undefined &&
    completedBody !== undefined &&
    matchesBackendTruncation(streamedBody, completedBody)
  ) {
    return streamedBody;
  }
  return completedBody ?? streamedBody;
};
