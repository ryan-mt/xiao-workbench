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
  constructor(
    private readonly entries: TimelineEntry[],
    private readonly live = false,
  ) {}

  project(): ExecutionTrace[] {
    const traceMarkers = this.entries.filter((entry) => entry.kind === "thought");
    const entries = this.entries.filter((entry) => entry.kind !== "thought");
    if (!entries.length) return [];
    const latestMarker = traceMarkers.at(-1);
    const hasCommands = entries.some((entry) => entry.kind === "command");
    const hasChanges = entries.some((entry) => entry.kind === "change");
    const hasOtherTools = entries.some((entry) =>
      entry.kind === "explore" ||
      entry.kind === "approval" ||
      entry.kind === "agent"
    );
    const summary = hasChanges
      ? ["Edited files", hasCommands ? "ran commands" : "", hasOtherTools ? "used tools" : ""]
          .filter(Boolean).join(", ")
      : hasCommands
        ? ["Ran commands", hasOtherTools ? "used tools" : ""].filter(Boolean).join(", ")
        : hasOtherTools ? "Used tools" : "";
    return [{
      id: `execution-${entries[0].id}`,
      title: this.live && latestMarker
        ? traceTitle(latestMarker)
        : summary || "Execution details",
      thoughtTitled: Boolean(this.live && latestMarker),
      entries,
    }];
  }
}

export const projectExecutionTraces = (entries: TimelineEntry[], live = false) =>
  new ExecutionTraceProjector(entries, live).project();
