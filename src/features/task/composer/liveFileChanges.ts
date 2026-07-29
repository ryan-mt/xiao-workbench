import type { TimelineEntry } from "../../../core/models/agent";

export type LiveFileChangeSummary = {
  fileCount: number;
  additions: number;
  deletions: number;
  stepIndex?: number;
  stepTotal?: number;
};

const isUserEntry = (entry: TimelineEntry) =>
  entry.kind === "user" || entry.kind === "brief";

export class LiveFileChangeProjector {
  constructor(private readonly timeline: readonly TimelineEntry[]) {}

  project(): LiveFileChangeSummary | null {
    let turnStart = -1;
    let activeTurnId: string | null = null;
    for (let index = this.timeline.length - 1; index >= 0; index -= 1) {
      if (isUserEntry(this.timeline[index])) {
        turnStart = index;
        activeTurnId = this.timeline[index].turnId ?? null;
        if (activeTurnId) {
          for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
            if (!isUserEntry(this.timeline[candidate])) continue;
            if (this.timeline[candidate].turnId !== activeTurnId) break;
            turnStart = candidate;
          }
        }
        break;
      }
    }
    if (turnStart < 0) return null;

    const files = new Map<string, { additions: number; deletions: number }>();
    for (const entry of this.timeline.slice(turnStart + 1)) {
      if (entry.kind !== "change" || entry.status === "error") continue;
      for (const file of entry.files ?? []) {
        const current = files.get(file.path) ?? { additions: 0, deletions: 0 };
        files.set(file.path, {
          additions: current.additions + file.additions,
          deletions: current.deletions + file.deletions,
        });
      }
    }
    if (!files.size) return null;

    return [...files.values()].reduce<LiveFileChangeSummary>(
      (summary, file) => ({
        fileCount: summary.fileCount,
        additions: summary.additions + file.additions,
        deletions: summary.deletions + file.deletions,
      }),
      { fileCount: files.size, additions: 0, deletions: 0 },
    );
  }
}

export const projectLiveFileChanges = (timeline: readonly TimelineEntry[]) =>
  new LiveFileChangeProjector(timeline).project();
