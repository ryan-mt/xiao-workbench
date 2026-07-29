import type { TimelineEntry } from "../../../core/models/agent";

export type ExecutionTrace = {
  id: string;
  title: string | null;
  thoughtTitled: boolean;
  entries: TimelineEntry[];
};

const traceTitle = (entry: TimelineEntry) =>
  entry.body
    ?.split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+|^\s*[-*]\s+|\*\*|__/g, "").trim())
    .find(Boolean) ?? entry.title;

export class ExecutionTraceProjector {
  constructor(private readonly entries: TimelineEntry[]) {}

  project(): ExecutionTrace[] {
    const traceMarkers = this.entries.filter((entry) => entry.kind === "thought");
    const entries = this.entries.filter((entry) => entry.kind !== "thought");
    if (!entries.length) return [];
    const latestMarker = traceMarkers.at(-1);
    const isToolEntry = (entry: TimelineEntry) =>
      entry.kind === "command" && Boolean(
        entry.meta === "Plugin tool" ||
        entry.meta === "Dynamic tool" ||
        entry.meta === "Codex tool" ||
        entry.meta?.startsWith("Skill"),
      );
    const shellCommands = entries.filter((entry) =>
      entry.kind === "command" && !isToolEntry(entry)
    );
    const changes = entries.filter((entry) => entry.kind === "change");
    const otherTools = entries.filter((entry) =>
      entry.kind === "explore" ||
      entry.kind === "approval" ||
      entry.kind === "agent" ||
      isToolEntry(entry)
    );
    const actions = [
      changes.length
        ? changes.length === 1 && (shellCommands.length || otherTools.length)
          ? "Edited a file"
          : "Edited files"
        : "",
      shellCommands.length
        ? shellCommands.length === 1
          ? changes.length ? "ran a command" : "Ran a command"
          : changes.length ? "ran commands" : "Ran commands"
        : "",
      ...otherTools.map((entry) => entry.title.toLocaleLowerCase()),
    ].filter(Boolean);
    const summary = actions.join(", ");
    return [{
      id: `execution-${entries[0].id}`,
      title: latestMarker
        ? traceTitle(latestMarker)
        : summary || "Execution details",
      thoughtTitled: Boolean(latestMarker),
      entries,
    }];
  }
}

export const projectExecutionTraces = (entries: TimelineEntry[], _live = false) =>
  new ExecutionTraceProjector(entries).project();
