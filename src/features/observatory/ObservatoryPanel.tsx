import { useEffect, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";

import { XiaoIcon } from "../../components/icons/XiaoIcon";
import type { TimelineEntry } from "../../core/models/agent";
import type {
  ImportHandoffResult,
  ObservatoryActivityCategory,
  TurnCheckpointSummary,
} from "../../core/models/observatory";
import type { PendingInputSnapshot, RunEventRecord, RunSnapshot } from "../../core/models/run";
import { nativeBridge } from "../../core/bridges/tauri";
import { projectObservatory } from "./observatoryProjection";

type ObservatoryPanelProps = {
  projectPath: string;
  taskId: string;
  liveRuns: RunSnapshot[];
  livePendingInputs: PendingInputSnapshot[];
  timeline: TimelineEntry[];
  onJumpToTimeline: (entryId: string) => void;
  onWorkspaceChange: () => void;
  onImportHandoff?: (bundlePath: string) => Promise<ImportHandoffResult>;
};

type ObservatoryView = "agents" | "history" | "restore" | "handoff";

const MAX_OBSERVATORY_EVENTS = 10_000;

const categories: Array<{ id: ObservatoryActivityCategory; label: string }> = [
  { id: "status", label: "Status" },
  { id: "tools", label: "Tools" },
  { id: "approvals", label: "Approvals" },
  { id: "changes", label: "Changes" },
  { id: "verification", label: "Verification" },
];

const statusLabel = (status: string) => status.replace(/_/g, " ");

const shortId = (value: string) => value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;

const elapsed = (startedAt: number, finishedAt: number | null) => {
  const seconds = Math.max(0, Math.floor(((finishedAt ?? Date.now()) - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const eventTime = (timestamp: number) => new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
}).format(timestamp);

const checkpointTime = (timestamp: number) => new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
}).format(timestamp);

const patchSize = (bytes: number) => {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
};

const mergeRuns = (listed: RunSnapshot[], live: RunSnapshot[]) => {
  const byId = new Map(listed.map((run) => [run.id, run]));
  for (const run of live) {
    const current = byId.get(run.id);
    if (!current || run.version >= current.version) byId.set(run.id, run);
  }
  return [...byId.values()].sort(
    (left, right) => right.queuedAt - left.queuedAt || right.id.localeCompare(left.id),
  );
};

const workspaceRelativePath = (root: string, path: string) => {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRoot = normalize(root);
  const normalizedPath = normalize(path);
  const rootPrefix = `${normalizedRoot.toLowerCase()}/`;
  const lowerPath = normalizedPath.toLowerCase();
  const relative = lowerPath.startsWith(rootPrefix)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
  if (!relative || /^(?:[a-z]:|\/|clipboard:)/i.test(relative)) return null;
  if (relative.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return relative;
};

const loadRunEvents = async (runId: string, initialAfterSequence = -1) => {
  const events: RunEventRecord[] = [];
  let afterSequence = initialAfterSequence;
  while (true) {
    const page = await nativeBridge.loadXiaoRunEvents(runId, afterSequence, 200);
    events.push(...page.events);
    if (events.length >= MAX_OBSERVATORY_EVENTS) return events.slice(0, MAX_OBSERVATORY_EVENTS);
    if (page.events.length < 200 || page.nextSequence === null) return events;
    if (page.nextSequence <= afterSequence) throw new Error("Run event history did not advance.");
    afterSequence = page.nextSequence;
  }
};

export function ObservatoryPanel({
  projectPath,
  taskId,
  liveRuns,
  livePendingInputs,
  timeline,
  onJumpToTimeline,
  onWorkspaceChange,
  onImportHandoff,
}: ObservatoryPanelProps) {
  const [view, setView] = useState<ObservatoryView>("agents");
  const [listedRuns, setListedRuns] = useState<RunSnapshot[]>([]);
  const [listedPending, setListedPending] = useState<PendingInputSnapshot[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEventRecord[]>([]);
  const [filters, setFilters] = useState<Set<ObservatoryActivityCategory>>(new Set(categories.map((item) => item.id)));
  const [checkpoints, setCheckpoints] = useState<TurnCheckpointSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState<"export" | "import" | null>(null);
  const [handoffMessage, setHandoffMessage] = useState<string | null>(null);
  const [selectedAttachments, setSelectedAttachments] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const runs = useMemo(() => mergeRuns(listedRuns, liveRuns), [listedRuns, liveRuns]);
  const pendingInputs = useMemo(() => {
    const byId = new Map(listedPending.map((pending) => [pending.id, pending]));
    for (const pending of livePendingInputs) byId.set(pending.id, pending);
    return [...byId.values()].filter((pending) => pending.resolvedAt == null && pending.invalidatedAt == null);
  }, [listedPending, livePendingInputs]);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
  const selectedRunVersion = selectedRun?.version ?? -1;
  const selectedPendingCount = pendingInputs.filter((pending) => pending.runId === selectedRun?.id).length;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([
      nativeBridge.listXiaoRuns(projectPath, taskId, 50),
      nativeBridge.listXiaoPendingInputs(projectPath, taskId),
    ]).then(([nextRuns, nextPending]) => {
      if (!active) return;
      setListedRuns(nextRuns);
      setListedPending(nextPending);
      setSelectedRunId((current) => current && nextRuns.some((run) => run.id === current)
        ? current
        : nextRuns[0]?.id ?? null);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [projectPath, taskId]);

  useEffect(() => {
    if (!selectedRun) {
      setEvents([]);
      return;
    }
    let active = true;
    let afterSequence = -1;
    let initialized = false;
    let timer: number | null = null;
    const runIsActive = ["queued", "preparing", "running", "waiting_for_input", "verifying"]
      .includes(selectedRun.status);
    const refreshEvents = async () => {
      try {
        const nextEvents = await loadRunEvents(selectedRun.id, afterSequence);
        if (!active) return;
        if (nextEvents.length) afterSequence = nextEvents.at(-1)!.sequence;
        setEvents((current) => (initialized ? [...current, ...nextEvents] : nextEvents)
          .slice(-MAX_OBSERVATORY_EVENTS));
        initialized = true;
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (active && runIsActive) timer = window.setTimeout(() => void refreshEvents(), 1_000);
      }
    };
    void refreshEvents();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [selectedRun?.id, selectedRun?.status, selectedRunVersion, selectedPendingCount]);

  const loadCheckpoints = () => nativeBridge
    .listXiaoTurnCheckpoints(projectPath, taskId, 100)
    .then(setCheckpoints)
    .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));

  useEffect(() => {
    if (view === "restore") void loadCheckpoints();
  }, [view, projectPath, taskId, selectedRunVersion]);

  const snapshot = useMemo(
    () => selectedRun ? projectObservatory(selectedRun, events, pendingInputs) : null,
    [selectedRun, events, pendingInputs],
  );
  const filteredActivities = snapshot?.activities.filter((activity) => filters.has(activity.category)) ?? [];
  const activeRuns = runs.some((run) => ["queued", "preparing", "running", "waiting_for_input", "verifying"].includes(run.status));
  const activeCheckpoints = checkpoints.filter((checkpoint) => checkpoint.restoredAt === null);
  const handoffAttachments = useMemo(() => {
    const byPath = new Map<string, string>();
    for (const entry of timeline) {
      for (const attachment of entry.attachments ?? []) {
        if (attachment.kind !== "file" && attachment.kind !== "image") continue;
        const path = workspaceRelativePath(projectPath, attachment.path);
        if (path && !byPath.has(path)) byPath.set(path, attachment.name || path);
      }
    }
    return [...byPath].map(([path, name]) => ({ path, name }));
  }, [projectPath, timeline]);

  const toggleFilter = (category: ObservatoryActivityCategory) => setFilters((current) => {
    const next = new Set(current);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    return next;
  });

  const restore = async (checkpoint: TurnCheckpointSummary) => {
    const index = activeCheckpoints.findIndex((item) => item.id === checkpoint.id);
    const turnCount = index < 0 ? 0 : index + 1;
    if (!turnCount || activeRuns) return;
    const confirmed = window.confirm(
      `Restore the workspace to before this turn? Xiao will reverse ${turnCount} ${turnCount === 1 ? "turn" : "turns"} after checking the complete plan.`,
    );
    if (!confirmed) return;
    setRestoringId(checkpoint.id);
    setError(null);
    try {
      await nativeBridge.restoreXiaoTurns(projectPath, taskId, checkpoint.id);
      await loadCheckpoints();
      onWorkspaceChange();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRestoringId(null);
    }
  };

  const toggleAttachment = (path: string) => setSelectedAttachments((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const exportBundle = async () => {
    const destinationPath = await save({
      defaultPath: `${taskId}.xiao-handoff`,
      filters: [{ name: "Xiao handoff", extensions: ["xiao-handoff"] }],
    });
    if (!destinationPath) return;
    setHandoffBusy("export");
    setHandoffMessage(null);
    setError(null);
    try {
      const result = await nativeBridge.exportXiaoHandoff(
        projectPath,
        taskId,
        destinationPath,
        [...selectedAttachments],
      );
      setHandoffMessage(`Exported ${result.entryCount} entries (${patchSize(result.byteLength)}).`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setHandoffBusy(null);
    }
  };

  const importBundle = async () => {
    if (!onImportHandoff) return;
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Xiao handoff", extensions: ["xiao-handoff"] }],
    });
    if (typeof selected !== "string") return;
    setHandoffBusy("import");
    setHandoffMessage(null);
    setError(null);
    try {
      const result = await onImportHandoff(selected);
      setHandoffMessage(result.alreadyImported
        ? "This bundle was already imported; Xiao opened its existing task."
        : "Imported as a new task and read-only run lineage.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setHandoffBusy(null);
    }
  };

  return (
    <section className="rail-section observatory-panel">
      <header className="rail-section__header">
        <div>
          <span>Agent Observatory</span>
          <h2>Runs, agents, and recovery</h2>
        </div>
        {selectedRun ? <small className={`observatory-run-state observatory-run-state--${selectedRun.status}`}>{statusLabel(selectedRun.status)}</small> : null}
      </header>

      <nav className="observatory-tabs" aria-label="Observatory views">
        <button className={view === "agents" ? "is-active" : undefined} onClick={() => setView("agents")}>Agents</button>
        <button className={view === "history" ? "is-active" : undefined} onClick={() => setView("history")}>History</button>
        <button className={view === "restore" ? "is-active" : undefined} onClick={() => setView("restore")}>Restore</button>
        <button className={view === "handoff" ? "is-active" : undefined} onClick={() => setView("handoff")}>Handoff</button>
      </nav>

      {view !== "handoff" && runs.length ? (
        <label className="observatory-run-picker">
          <span>Run</span>
          <select value={selectedRun?.id ?? ""} onChange={(event) => setSelectedRunId(event.target.value)}>
            {runs.map((run, index) => (
              <option key={run.id} value={run.id}>
                {index === 0 ? "Latest" : checkpointTime(run.queuedAt)} · {statusLabel(run.status)} · {shortId(run.id)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {error ? <p className="observatory-error" role="alert">{error}</p> : null}
      {view !== "handoff" && loading && !selectedRun ? <div className="observatory-empty"><XiaoIcon className="is-spinning" name="pending" /> Loading run history</div> : null}
      {view !== "handoff" && !loading && !selectedRun ? <div className="observatory-empty">Start this task to create an observable run.</div> : null}

      {view === "agents" && snapshot ? (
        <div className="observatory-agent-list">
          {snapshot.nodes.map((node, index) => (
            <button
              className="observatory-agent"
              key={node.threadId}
              style={{ "--agent-depth": node.depth } as React.CSSProperties}
              disabled={!node.latestTimelineEntryId}
              onClick={() => node.latestTimelineEntryId && onJumpToTimeline(node.latestTimelineEntryId)}
            >
              <span className={`observatory-agent__state observatory-agent__state--${node.status}`} />
              <span className="observatory-agent__identity">
                <strong>{index === 0 ? "Primary agent" : node.label}</strong>
                <small>{node.model ?? "Model unavailable"}{node.reasoningEffort ? ` · ${node.reasoningEffort}` : ""}</small>
              </span>
              <span className="observatory-agent__facts">
                <strong>{statusLabel(node.status)}</strong>
                <small>{elapsed(node.startedAt, node.finishedAt)}{node.totalTokens != null ? ` · ${node.totalTokens.toLocaleString()} tok` : ""}</small>
              </span>
              {node.latestAction ? <span className="observatory-agent__action">{node.latestAction}</span> : null}
              {node.pendingInputIds.length ? <span className="observatory-agent__pending">{node.pendingInputIds.length} pending</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {view === "history" && snapshot ? (
        <div className="observatory-history">
          <div className="observatory-filters">
            {categories.map((category) => (
              <button
                className={filters.has(category.id) ? "is-active" : undefined}
                key={category.id}
                onClick={() => toggleFilter(category.id)}
              >
                {category.label}
              </button>
            ))}
          </div>
          <ol className="observatory-activity-list">
            {filteredActivities.map((activity) => (
              <li key={activity.id}>
                <span className={`observatory-activity__state observatory-activity__state--${activity.status}`} />
                <div>
                  <strong>{activity.title}</strong>
                  {activity.detail ? <p>{activity.detail}</p> : null}
                  <small>{eventTime(activity.timestamp)} · {activity.category}</small>
                </div>
                {activity.timelineEntryId ? (
                  <button aria-label="Jump to timeline activity" onClick={() => onJumpToTimeline(activity.timelineEntryId!)}>
                    <XiaoIcon name="forward" size={13} />
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          {!filteredActivities.length ? <div className="observatory-empty">No events match these filters.</div> : null}
        </div>
      ) : null}

      {view === "restore" ? (
        <div className="observatory-restore">
          <div className="observatory-restore__notice">
            <XiaoIcon name="secure" size={15} />
            <p><strong>Guarded restore</strong><span>Every reverse patch is preflighted before Xiao changes the workspace. Staged or later edits block restore.</span></p>
          </div>
          {activeRuns ? <p className="observatory-error">Wait for active runs to settle before restoring.</p> : null}
          <ol>
            {checkpoints.map((checkpoint) => {
              const activeIndex = activeCheckpoints.findIndex((item) => item.id === checkpoint.id);
              const restoreCount = activeIndex + 1;
              return (
                <li className={checkpoint.restoredAt ? "is-restored" : undefined} key={checkpoint.id}>
                  <div>
                    <strong>{checkpoint.prompt || "Untitled turn"}</strong>
                    <small>{checkpointTime(checkpoint.createdAt)} · {patchSize(checkpoint.patchBytes)} · {statusLabel(checkpoint.runStatus)}</small>
                  </div>
                  <button
                    className="button button--quiet"
                    disabled={Boolean(checkpoint.restoredAt) || activeRuns || restoringId !== null}
                    onClick={() => void restore(checkpoint)}
                  >
                    {restoringId === checkpoint.id ? "Checking…" : checkpoint.restoredAt ? "Restored" : `Restore ${restoreCount}`}
                  </button>
                </li>
              );
            })}
          </ol>
          {!checkpoints.length ? <div className="observatory-empty">No durable turn checkpoints are available yet.</div> : null}
        </div>
      ) : null}

      {view === "handoff" ? (
        <div className="observatory-handoff">
          <div className="observatory-restore__notice">
            <XiaoIcon name="secure" size={15} />
            <p><strong>Portable context with redaction safeguards</strong><span>Bundles contain task context and lineage, never apply patches on import, and never overwrite an existing task.</span></p>
          </div>
          <section>
            <h3>Export this task</h3>
            <p>Common credential patterns and private paths are redacted. Review free-form text before sharing; selected attachments are included without redaction.</p>
            {handoffAttachments.length ? (
              <div className="observatory-handoff__attachments">
                {handoffAttachments.map((attachment) => (
                  <label key={attachment.path}>
                    <input
                      type="checkbox"
                      checked={selectedAttachments.has(attachment.path)}
                      onChange={() => toggleAttachment(attachment.path)}
                    />
                    <span><strong>{attachment.name}</strong><small>{attachment.path}</small></span>
                  </label>
                ))}
              </div>
            ) : <small>No workspace-relative attachments are available.</small>}
            <button className="button button--primary" disabled={handoffBusy !== null} onClick={() => void exportBundle()}>
              {handoffBusy === "export" ? "Exporting…" : "Export handoff"}
            </button>
          </section>
          <section>
            <h3>Import a handoff</h3>
            <p>Xiao verifies schema, paths, hashes, and size limits, then creates a separate task and completed source run.</p>
            <button className="button button--quiet" disabled={handoffBusy !== null || !onImportHandoff} onClick={() => void importBundle()}>
              {handoffBusy === "import" ? "Importing…" : "Choose bundle"}
            </button>
          </section>
          {handoffMessage ? <p className="observatory-handoff__success" role="status">{handoffMessage}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
