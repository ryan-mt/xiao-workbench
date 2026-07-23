import type {
  PendingInputSnapshot,
  RunProtocolEnvelope,
  RunSnapshot,
  RunStatus,
  RunUpdateEnvelope,
} from "../../../core/models/run";

export type RunProjection = {
  runsById: Record<string, RunSnapshot>;
  runIdsByTask: Record<string, string[]>;
  pendingInputsById: Record<string, PendingInputSnapshot>;
  appliedProtocolSequencesByRun: Record<string, AppliedProtocolSequenceSet>;
};

export type AppliedProtocolSequenceSet = {
  ranges: Array<[start: number, end: number]>;
};

export const MAX_RETAINED_TERMINAL_RUNS = 200;

export const emptyRunProjection = (): RunProjection => ({
  runsById: {},
  runIdsByTask: {},
  pendingInputsById: {},
  appliedProtocolSequencesByRun: {},
});

const compareRuns = (left: RunSnapshot, right: RunSnapshot) =>
  right.queuedAt - left.queuedAt || right.id.localeCompare(left.id);

const addRunToTask = (
  projection: RunProjection,
  snapshot: RunSnapshot,
): Record<string, string[]> => {
  const current = projection.runIdsByTask[snapshot.taskId] ?? [];
  const ids = current.includes(snapshot.id) ? current : [...current, snapshot.id];
  ids.sort((left, right) => compareRuns(
    left === snapshot.id ? snapshot : projection.runsById[left],
    right === snapshot.id ? snapshot : projection.runsById[right],
  ));
  return { ...projection.runIdsByTask, [snapshot.taskId]: ids };
};

const compareSnapshotFreshness = (current: RunSnapshot, next: RunSnapshot) => {
  if (next.version !== current.version) return next.version - current.version;
  const currentGeneration = current.runtimeGeneration ?? -1;
  const nextGeneration = next.runtimeGeneration ?? -1;
  return nextGeneration - currentGeneration;
};

const shouldReplaceSnapshot = (current: RunSnapshot | undefined, next: RunSnapshot) =>
  !current || compareSnapshotFreshness(current, next) >= 0;

const withPendingInput = (
  current: Record<string, PendingInputSnapshot>,
  pending: PendingInputSnapshot | null,
) => {
  if (!pending) return current;
  const existing = current[pending.id];
  const existingSettledAt = existing
    ? Math.max(existing.resolvedAt ?? -1, existing.invalidatedAt ?? -1)
    : -1;
  const nextSettledAt = Math.max(pending.resolvedAt ?? -1, pending.invalidatedAt ?? -1);
  if (existingSettledAt >= 0 && nextSettledAt <= existingSettledAt) return current;
  return { ...current, [pending.id]: pending };
};

export const shouldRestorePendingInput = (
  projection: RunProjection,
  pending: PendingInputSnapshot,
) => {
  const current = projection.pendingInputsById[pending.id];
  return !current || (current.resolvedAt == null && current.invalidatedAt == null);
};

export const activePendingInputIdsForRestore = (
  projection: RunProjection,
  listed: PendingInputSnapshot[],
) => {
  const active = new Set(
    listed
      .filter((pending) => shouldRestorePendingInput(projection, pending))
      .map((pending) => pending.id),
  );
  for (const pending of Object.values(projection.pendingInputsById)) {
    if (pending.resolvedAt == null && pending.invalidatedAt == null) active.add(pending.id);
  }
  return active;
};

const withSequence = (
  current: Record<string, AppliedProtocolSequenceSet>,
  runId: string,
  sequence: number | null | undefined,
) => {
  if (sequence == null) return current;
  const existing = current[runId]?.ranges ?? [];
  let low = 0;
  let high = existing.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (existing[middle][1] < sequence) low = middle + 1;
    else high = middle;
  }
  const candidate = existing[low];
  if (candidate && candidate[0] <= sequence) return current;

  let start = sequence;
  let end = sequence;
  let replaceFrom = low;
  let replaceCount = 0;
  const previous = existing[low - 1];
  if (previous && previous[1] + 1 >= sequence) {
    start = previous[0];
    end = Math.max(end, previous[1]);
    replaceFrom = low - 1;
    replaceCount += 1;
  }
  if (candidate && candidate[0] <= end + 1) {
    end = Math.max(end, candidate[1]);
    replaceCount += 1;
  }
  const ranges = existing.slice();
  ranges.splice(replaceFrom, replaceCount, [start, end]);
  return {
    ...current,
    [runId]: { ranges },
  };
};

const sequenceWasApplied = (
  applied: AppliedProtocolSequenceSet | undefined,
  sequence: number,
) => {
  const ranges = applied?.ranges ?? [];
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle][1] < sequence) low = middle + 1;
    else high = middle;
  }
  return Boolean(ranges[low] && ranges[low][0] <= sequence);
};

export const projectRunSnapshots = (
  projection: RunProjection,
  snapshots: RunSnapshot[],
): RunProjection => snapshots.reduce(
  (current, snapshot) => projectRunUpdate(current, {
    snapshot,
    event: null,
    pendingInput: null,
  }),
  projection,
);

export const mergeListedRunSnapshots = (
  current: RunProjection,
  snapshots: RunSnapshot[],
) => projectRunSnapshots(current, snapshots);

export const runSnapshotBaselineForIds = (
  projection: RunProjection,
  ids: ReadonlySet<string>,
): Readonly<Record<string, RunSnapshot>> => {
  const baseline: Record<string, RunSnapshot> = {};
  for (const id of ids) {
    const snapshot = projection.runsById[id];
    if (snapshot) baseline[id] = snapshot;
  }
  return baseline;
};

export const reconcileListedRunSnapshots = (
  projection: RunProjection,
  listed: RunSnapshot[],
  baseline: Readonly<Record<string, RunSnapshot>>,
): RunProjection => {
  const mergeableListed = listed.filter((snapshot) => {
    const current = projection.runsById[snapshot.id];
    return (
      !current ||
      current === baseline[snapshot.id] ||
      compareSnapshotFreshness(current, snapshot) > 0
    );
  });
  const merged = mergeListedRunSnapshots(projection, mergeableListed);
  const listedIds = new Set(listed.map((snapshot) => snapshot.id));
  let runsById = merged.runsById;
  let runIdsByTask = merged.runIdsByTask;
  let appliedProtocolSequencesByRun = merged.appliedProtocolSequencesByRun;

  for (const baselineRun of Object.values(baseline)) {
    if (
      listedIds.has(baselineRun.id) ||
      runsById[baselineRun.id] !== baselineRun
    ) continue;

    if (runsById === merged.runsById) runsById = { ...runsById };
    delete runsById[baselineRun.id];

    const taskRunIds = runIdsByTask[baselineRun.taskId];
    if (taskRunIds?.includes(baselineRun.id)) {
      if (runIdsByTask === merged.runIdsByTask) runIdsByTask = { ...runIdsByTask };
      const remaining = taskRunIds.filter((id) => id !== baselineRun.id);
      if (remaining.length) runIdsByTask[baselineRun.taskId] = remaining;
      else delete runIdsByTask[baselineRun.taskId];
    }

    if (Object.prototype.hasOwnProperty.call(
      appliedProtocolSequencesByRun,
      baselineRun.id,
    )) {
      if (appliedProtocolSequencesByRun === merged.appliedProtocolSequencesByRun) {
        appliedProtocolSequencesByRun = { ...appliedProtocolSequencesByRun };
      }
      delete appliedProtocolSequencesByRun[baselineRun.id];
    }
  }

  return runsById === merged.runsById
    ? merged
    : { ...merged, runsById, runIdsByTask, appliedProtocolSequencesByRun };
};

export const mergeListedPendingInputs = (
  projection: RunProjection,
  pendingInputs: PendingInputSnapshot[],
): RunProjection => pendingInputs.reduce((current, pendingInput) => {
  const pendingInputsById = withPendingInput(current.pendingInputsById, pendingInput);
  return pendingInputsById === current.pendingInputsById
    ? current
    : { ...current, pendingInputsById };
}, projection);

export const reconcileListedPendingInputs = (
  projection: RunProjection,
  listed: PendingInputSnapshot[],
  baseline: Readonly<Record<string, PendingInputSnapshot>>,
): RunProjection => {
  const mergeableListed = listed.filter((pending) => {
    const baselinePending = baseline[pending.id];
    return !baselinePending || projection.pendingInputsById[pending.id] === baselinePending;
  });
  const merged = mergeListedPendingInputs(projection, mergeableListed);
  const listedIds = new Set(listed.map((pending) => pending.id));
  let pendingInputsById = merged.pendingInputsById;

  for (const pending of Object.values(baseline)) {
    if (
      pending.resolvedAt != null ||
      pending.invalidatedAt != null ||
      listedIds.has(pending.id) ||
      pendingInputsById[pending.id] !== pending
    ) continue;
    if (pendingInputsById === merged.pendingInputsById) {
      pendingInputsById = { ...pendingInputsById };
    }
    delete pendingInputsById[pending.id];
  }

  return pendingInputsById === merged.pendingInputsById
    ? merged
    : { ...merged, pendingInputsById };
};

export const projectRunUpdate = (
  projection: RunProjection,
  update: RunUpdateEnvelope,
): RunProjection => {
  const current = projection.runsById[update.snapshot.id];
  if (!shouldReplaceSnapshot(current, update.snapshot)) {
    return {
      ...projection,
      pendingInputsById: withPendingInput(projection.pendingInputsById, update.pendingInput),
    };
  }
  const runsById = { ...projection.runsById, [update.snapshot.id]: update.snapshot };
  return {
    ...projection,
    runsById,
    runIdsByTask: addRunToTask({ ...projection, runsById }, update.snapshot),
    pendingInputsById: withPendingInput(projection.pendingInputsById, update.pendingInput),
  };
};

export const acceptRunProtocol = (
  projection: RunProjection,
  envelope: RunProtocolEnvelope,
): { projection: RunProjection; accepted: boolean } => {
  const run = projection.runsById[envelope.runId];
  if (
    !run ||
    run.taskId !== envelope.taskId ||
    run.executionEnvironmentId !== envelope.executionEnvironmentId ||
    run.runtimeGeneration !== envelope.runtimeGeneration ||
    (run.threadId != null && run.threadId !== envelope.threadId) ||
    (run.turnId != null && envelope.turnId != null && run.turnId !== envelope.turnId)
  ) {
    return { projection, accepted: false };
  }
  const applied = projection.appliedProtocolSequencesByRun[envelope.runId];
  if (envelope.sequence != null && sequenceWasApplied(applied, envelope.sequence)) {
    return { projection, accepted: false };
  }
  return {
    accepted: true,
    projection: {
      ...projection,
      pendingInputsById: withPendingInput(
        projection.pendingInputsById,
        envelope.pendingInput,
      ),
      appliedProtocolSequencesByRun: withSequence(
        projection.appliedProtocolSequencesByRun,
        envelope.runId,
        envelope.sequence,
      ),
    },
  };
};

export const runsForTask = (projection: RunProjection, taskId: string) =>
  (projection.runIdsByTask[taskId] ?? [])
    .flatMap((id) => projection.runsById[id] ? [projection.runsById[id]] : []);

export const latestRunForTask = (projection: RunProjection, taskId: string) =>
  runsForTask(projection, taskId)[0] ?? null;

export const activeRunForTask = (projection: RunProjection, taskId: string) => {
  const active = runsForTask(projection, taskId).filter((run) => runStatusIsActive(run.status));
  return active.find((run) => run.status !== "queued")
    ?? active.filter((run) => run.status === "queued").at(-1)
    ?? null;
};

export const runStatusIsActive = (status: RunStatus) =>
  status === "queued" ||
  status === "preparing" ||
  status === "running" ||
  status === "waiting_for_input" ||
  status === "verifying";

export const runProjectionUiChanged = (
  current: RunProjection,
  next: RunProjection,
) =>
  current.runsById !== next.runsById ||
  current.runIdsByTask !== next.runIdsByTask ||
  current.pendingInputsById !== next.pendingInputsById;

const runRecency = (snapshot: RunSnapshot) =>
  snapshot.finishedAt ?? snapshot.startedAt ?? snapshot.queuedAt;

export const pruneRunProjection = (
  projection: RunProjection,
  maxTerminalRuns = MAX_RETAINED_TERMINAL_RUNS,
): RunProjection => {
  const runs = Object.values(projection.runsById);
  if (runs.length <= maxTerminalRuns) return projection;

  const activeRuns = runs.filter((snapshot) => runStatusIsActive(snapshot.status));
  const terminalRuns = runs
    .filter((snapshot) => !runStatusIsActive(snapshot.status))
    .sort((left, right) =>
      runRecency(right) - runRecency(left) || right.id.localeCompare(left.id)
    );
  if (terminalRuns.length <= maxTerminalRuns) return projection;

  const retainedIds = new Set([
    ...activeRuns.map((snapshot) => snapshot.id),
    ...terminalRuns.slice(0, Math.max(0, maxTerminalRuns)).map((snapshot) => snapshot.id),
  ]);
  const runsById = Object.fromEntries(
    runs
      .filter((snapshot) => retainedIds.has(snapshot.id))
      .map((snapshot) => [snapshot.id, snapshot]),
  );
  const runIdsByTask = Object.fromEntries(
    Object.entries(projection.runIdsByTask)
      .map(([taskId, ids]) => [taskId, ids.filter((id) => retainedIds.has(id))] as const)
      .filter(([, ids]) => ids.length > 0),
  );
  const pendingInputsById = Object.fromEntries(
    Object.entries(projection.pendingInputsById).filter(([, pending]) =>
      retainedIds.has(pending.runId) ||
      (pending.resolvedAt == null && pending.invalidatedAt == null)
    ),
  );
  const appliedProtocolSequencesByRun = Object.fromEntries(
    Object.entries(projection.appliedProtocolSequencesByRun)
      .filter(([runId]) => retainedIds.has(runId)),
  );

  return {
    runsById,
    runIdsByTask,
    pendingInputsById,
    appliedProtocolSequencesByRun,
  };
};
