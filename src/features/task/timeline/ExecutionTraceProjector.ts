import type { TimelineEntry } from "../../../core/models/agent";

export type ExecutionTrace = {
  id: string;
  title: string | null;
  thoughtTitled: boolean;
  entries: TimelineEntry[];
};

export class ExecutionTraceProjector {
  constructor(private readonly entries: TimelineEntry[]) {}

  project(): ExecutionTrace[] {
    // Thoughts are rendered as separate ThinkingBlocks — never as tool-group titles.
    const entries = this.entries.filter((entry) => entry.kind !== "thought");
    if (!entries.length) return [];
    const isWebSearch = (entry: TimelineEntry) =>
      entry.meta === "Browser tool" || entry.meta === "Web search";
    const isToolEntry = (entry: TimelineEntry) =>
      entry.kind === "command" && Boolean(
        entry.meta === "Plugin tool" ||
        entry.meta?.startsWith("Dynamic tool") ||
        entry.meta === "Codex tool" ||
        entry.meta === "Image tool" ||
        isWebSearch(entry) ||
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
      isWebSearch(entry) ||
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
      title: summary || "Execution details",
      thoughtTitled: false,
      entries,
    }];
  }
}

export const projectExecutionTraces = (entries: TimelineEntry[], _live = false) =>
  new ExecutionTraceProjector(entries).project();
