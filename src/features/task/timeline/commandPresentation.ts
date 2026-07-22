import type { TimelineEntry } from "../../../core/models/agent";

export type CommandAttemptGroup = {
  entry: TimelineEntry;
  entryIds: string[];
  attempts: number;
};

const commandKey = (entry: TimelineEntry) => {
  let command = entry.command?.replace(/\s+/g, " ").trim();
  if (!command) return null;
  if (/\bcargo\s+fmt\b/.test(command)) {
    command = command.replace(/\s+--check(?=\s|["']|$)/g, "").replace(/\s+/g, " ").trim();
  }
  return `${entry.meta ?? ""}\u0000${command}`;
};

export const compactCommandAttempts = (entries: TimelineEntry[]): CommandAttemptGroup[] => {
  const grouped = new Map<string, TimelineEntry[]>();
  const order: string[] = [];

  for (const entry of entries) {
    const key = commandKey(entry) ?? `\u0000${entry.id}`;
    const attempts = grouped.get(key);
    if (attempts) {
      attempts.push(entry);
    } else {
      grouped.set(key, [entry]);
      order.push(key);
    }
  }

  return order.map((key) => {
    const attempts = grouped.get(key)!;
    let active: TimelineEntry | undefined;
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      if (attempts[index].status === "active") {
        active = attempts[index];
        break;
      }
    }
    return {
      entry: active ?? attempts.at(-1)!,
      entryIds: attempts.map((entry) => entry.id),
      attempts: attempts.length,
    };
  });
};

export const isEnvironmentBlockedCommand = (entry: TimelineEntry): boolean => {
  if (entry.kind !== "command" || entry.status !== "error") return false;
  const output = entry.body?.toLowerCase() ?? "";
  if (!output) return false;
  return /spawn\s+(?:eperm|eacces)/.test(output);
};
