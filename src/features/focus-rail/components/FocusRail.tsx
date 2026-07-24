import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { FileTypeIcon } from "../../../components/icons/FileTypeIcon";
import { XiaoIcon, type XiaoIconName } from "../../../components/icons/XiaoIcon";
import {
  contextUsedPercent,
  type AgentAttachment,
  type AgentModelSummary,
  type AgentPlan,
  type AgentRuntimeState,
  type RuntimeLogEntry,
  type ThreadTokenUsage,
  type TimelineEntry,
} from "../../../core/models/agent";
import type { RoutineSummary } from "../../../core/models/routine";
import type { PendingInputSnapshot, RunSnapshot } from "../../../core/models/run";
import type { ImportHandoffResult } from "../../../core/models/observatory";
import type { FileNode, SystemInfo, WorkspaceSnapshot } from "../../../core/models/workspace";
import type { TaskWorkbenchState } from "../../../core/models/xiao";
import { ObservatoryPanel } from "../../observatory/ObservatoryPanel";
import type { WorkbenchTask } from "../../task/task.types";
import type { FocusResourceRequest, FocusView } from "../focus-rail.types";
import { ChangesPanel } from "./ChangesPanel";
import { ContextPanel } from "./ContextPanel";
import { ExtensionsPanel } from "./ExtensionsPanel";
import { OpenFilePanel } from "./OpenFilePanel";
import { PlanPanel } from "./PlanPanel";
import { RuntimePanel } from "./RuntimePanel";
import { SchedulePanel, type RoutineDraft } from "./SchedulePanel";
import {
  VerificationPanel,
  type SavedAcceptanceContract,
} from "./VerificationPanel";
import "../styles/focus-rail.css";
import { taskPreviewWebviewLabel } from "./taskPreview";

const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((module) => ({ default: module.TerminalPanel })),
);
const BrowserPanel = lazy(() =>
  import("./BrowserPanel").then((module) => ({ default: module.BrowserPanel })),
);
const XiaoRunPanel = lazy(() =>
  import("./XiaoRunPanel").then((module) => ({ default: module.XiaoRunPanel })),
);

type FocusRailProps = {
  activeView: FocusView;
  resourceRequest?: FocusResourceRequest | null;
  onViewChange: (view: FocusView) => void;
  onClose: () => void;
  onOpenBrowser: (url: string) => void;
  onBrowserNavigationStart: () => void;
  workspace: WorkspaceSnapshot;
  system: SystemInfo;
  runtime: AgentRuntimeState;
  task: WorkbenchTask;
  executionTaskId: string | null;
  executionTransitioning: boolean;
  workspaceActionable: boolean;
  timeline: TimelineEntry[];
  models: AgentModelSummary[];
  contextUsage: ThreadTokenUsage | null;
  plan: AgentPlan | null;
  runtimeLogs: RuntimeLogEntry[];
  runs?: RunSnapshot[];
  pendingInputs?: PendingInputSnapshot[];
  onJumpToTimeline?: (entryId: string) => void;
  onImportHandoff?: (bundlePath: string) => Promise<ImportHandoffResult>;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onTaskOutcomeChange?: () => void;
  onLoadDirectory: (path: string) => Promise<FileNode[]>;
  routines: RoutineSummary[];
  routinesLoading: boolean;
  routinesError: string | null;
  routineCreating: boolean;
  routineBusyIds: ReadonlySet<string>;
  routineOpenRunId: string | null;
  observatoryOpenRunId?: string | null;
  nativeRoutinesAvailable: boolean;
  dangerousRoutineAccessDefault: boolean;
  dangerousRoutineIds: ReadonlySet<string>;
  onCreateRoutine: (draft: RoutineDraft) => Promise<void>;
  onUpdateRoutine: (routineId: string, draft: RoutineDraft) => Promise<void>;
  onSetRoutineEnabled: (routineId: string, enabled: boolean) => Promise<void>;
  onRunRoutineNow: (routineId: string) => Promise<void>;
  onDeleteRoutine: (routineId: string) => Promise<void>;
  onClearRoutineError: () => void;
  onTaskAcceptanceContractSaved: (saved: SavedAcceptanceContract) => void;
  reviewContext: AgentAttachment[];
  onStageReviewContext: (attachment: AgentAttachment) => void;
  onRemoveReviewContext: (attachmentId: string) => void;
  obscured: boolean;
  onWorkbenchStateChange: (state: TaskWorkbenchState) => void;
};

const utilityViews: Array<{ id: FocusView; label: string; description: string; icon: XiaoIconName }> = [
  { id: "files", label: "Open file", description: "Read and comment on source", icon: "files" },
  { id: "plan", label: "Plan", description: "Follow live task steps", icon: "plan" },
  { id: "terminal", label: "Terminal", description: "Run workspace commands", icon: "terminal" },
  { id: "browser", label: "Task Preview", description: "Inspect this Task's local outcome", icon: "browser" },
  { id: "run", label: "Xiao Break", description: "Play while Xiao works", icon: "game" },
  { id: "runtime", label: "Runtime", description: "Inspect Codex events", icon: "runtime" },
  { id: "observatory", label: "Observatory", description: "Inspect agents, history, and recovery", icon: "approach" },
  { id: "schedule", label: "Schedule", description: "Queue work for later", icon: "routine" },
  { id: "verification", label: "Acceptance", description: "Define deterministic run gates", icon: "check" },
  { id: "extensions", label: "Tools", description: "Skills, plugins, MCP, and apps", icon: "capability" },
];

const baseViews = new Set<FocusView>(["changes", "context"]);
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const acceptanceUnavailableTitle = "Acceptance is unavailable until this task starts";
const terminalUnavailableTitle = "Terminal is unavailable until this task starts";
const observatoryUnavailableTitle = "Observatory is unavailable until this task starts";

export function FocusRail({
  activeView,
  resourceRequest = null,
  onViewChange,
  onClose,
  onOpenBrowser,
  onBrowserNavigationStart,
  workspace,
  system,
  runtime,
  task,
  executionTaskId,
  executionTransitioning,
  workspaceActionable,
  timeline,
  models,
  contextUsage,
  plan,
  runtimeLogs,
  runs = [],
  pendingInputs = [],
  onJumpToTimeline = () => {},
  onImportHandoff,
  loading,
  error,
  onRefresh,
  onTaskOutcomeChange = () => {},
  onLoadDirectory,
  routines,
  routinesLoading,
  routinesError,
  routineCreating,
  routineBusyIds,
  routineOpenRunId,
  observatoryOpenRunId = null,
  nativeRoutinesAvailable,
  dangerousRoutineAccessDefault,
  dangerousRoutineIds,
  onCreateRoutine,
  onUpdateRoutine,
  onSetRoutineEnabled,
  onRunRoutineNow,
  onDeleteRoutine,
  onClearRoutineError,
  onTaskAcceptanceContractSaved,
  reviewContext,
  onStageReviewContext,
  onRemoveReviewContext,
  obscured,
  onWorkbenchStateChange,
}: FocusRailProps) {
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [terminalOpened, setTerminalOpened] = useState(activeView === "terminal");
  const [browserOpened, setBrowserOpened] = useState(activeView === "browser");
  const [runOpened, setRunOpened] = useState(activeView === "run");
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const activeModel =
    (task.model ? models.find((model) => model.model === task.model) : models.find((model) => model.isDefault)) ??
    models.find((model) => model.isDefault);
  const usagePercent = contextUsedPercent(contextUsage, activeModel?.contextWindow) ?? 0;
  const nativeTaskAvailable = executionTaskId !== null;
  const utility = utilityViews.find((view) => view.id === activeView);
  const utilityLabel = activeView === "files" && activeFile ? basename(activeFile) : utility?.label;
  const previewTabs = task.workbenchState.previewTabs?.length
    ? task.workbenchState.previewTabs
    : [{
        id: "primary",
        target: task.workbenchState.previewTarget ?? "http://127.0.0.1:9/",
      }];
  const activePreviewTabId = previewTabs.some(
    (tab) => tab.id === task.workbenchState.activePreviewTabId,
  )
    ? task.workbenchState.activePreviewTabId!
    : previewTabs[0].id;
  const activePreviewTab = previewTabs.find((tab) => tab.id === activePreviewTabId)!;

  useEffect(() => {
    setActiveFile(task.workbenchState.activeFile ?? null);
  }, [task.id, task.workbenchState.activeFile, workspace.path]);
  useEffect(() => {
    if (resourceRequest?.kind !== "file") return;
    setActiveFile(resourceRequest.path);
    onWorkbenchStateChange({
      ...task.workbenchState,
      activeFile: resourceRequest.path,
    });
  }, [resourceRequest]);
  useEffect(() => {
    if (activeView === "terminal" && nativeTaskAvailable) setTerminalOpened(true);
    if (activeView === "browser") setBrowserOpened(true);
    if (activeView === "run") setRunOpened(true);
  }, [activeView, nativeTaskAvailable]);

  const selectUtility = (view: FocusView) => {
    if ((view === "terminal" || view === "verification" || view === "observatory") && !nativeTaskAvailable) return;
    if (view === "files") {
      setActiveFile(null);
      onWorkbenchStateChange({ ...task.workbenchState, activeFile: null });
    }
    onViewChange(view);
    setToolsMenuOpen(false);
    menu.current?.removeAttribute("open");
  };

  return (
    <aside className="focus-rail" id="review-panel">
      <header className="review-tabs-bar">
        <button
          className="review-tabs-bar__rail"
          type="button"
          aria-label="Hide review sidebar"
          title="Hide review sidebar"
          onClick={onClose}
        >
          <XiaoIcon name={activeView === "run" ? "game" : "sidebar"} size={15} />
        </button>
        <nav className="review-tabs" aria-label="Review tabs">
          {activeView === "run" ? (
            <strong className="review-tabs__run-title">Xiao Break</strong>
          ) : (
            <>
              <button
                className={activeView === "changes" ? "is-active" : undefined}
                type="button"
                onClick={() => onViewChange("changes")}
              >
                <span>Changes</span>
                <small>{workspace.git?.changes.length ?? 0}</small>
              </button>
              <button
                className={activeView === "context" ? "is-active" : undefined}
                type="button"
                onClick={() => onViewChange("context")}
              >
                <i className="review-tabs__context-dot" style={{ "--usage": `${usagePercent}%` } as React.CSSProperties} />
                <span>Context</span>
              </button>
              {!baseViews.has(activeView) && utilityLabel ? (
                <div className="review-tabs__utility is-active">
                  <button type="button" onClick={() => onViewChange(activeView)} title={activeView === "files" ? activeFile ?? "Open file" : utilityLabel}>
                    {activeView === "files" && activeFile ? (
                      <FileTypeIcon path={activeFile} size={14} />
                    ) : (
                      <XiaoIcon name={utility?.icon ?? "file"} size={13} />
                    )}
                    <span>{utilityLabel}</span>
                  </button>
                  <button type="button" aria-label={`Close ${utilityLabel}`} onClick={() => onViewChange("changes")}>
                    <XiaoIcon name="close" size={11} />
                  </button>
                </div>
              ) : null}
              <button
                className="review-tabs__add"
                type="button"
                aria-label="Open file"
                title="Open file"
                onClick={() => selectUtility("files")}
              >
                <XiaoIcon name="add" size={15} />
              </button>
            </>
          )}
        </nav>
        <div className="review-tabs-bar__actions">
          <details className="review-lens-menu" ref={menu} onToggle={(event) => setToolsMenuOpen(event.currentTarget.open)}>
            <summary aria-label="Open workspace tools" title="Workspace tools">
              <XiaoIcon name="folderOpen" size={15} />
              <XiaoIcon name="caret" size={10} />
            </summary>
            <div role="menu" aria-label="Workspace tools">
              <header><span>Workspace tools</span><small>{workspace.name}</small></header>
              {utilityViews.map((view) => {
                const nativeTaskUnavailable =
                  (view.id === "terminal" || view.id === "verification" || view.id === "observatory") && !nativeTaskAvailable;
                const unavailableTitle = view.id === "terminal"
                  ? terminalUnavailableTitle
                  : view.id === "observatory"
                    ? observatoryUnavailableTitle
                    : acceptanceUnavailableTitle;
                return (
                  <button
                    aria-label={nativeTaskUnavailable ? unavailableTitle : undefined}
                    className={activeView === view.id ? "is-active" : undefined}
                    disabled={nativeTaskUnavailable}
                    key={view.id}
                    role="menuitem"
                    title={nativeTaskUnavailable ? unavailableTitle : view.description}
                    onClick={() => selectUtility(view.id)}
                  >
                    <span><XiaoIcon name={view.icon} size={15} /></span>
                    <div><strong>{view.label}</strong><small>{view.description}</small></div>
                    {activeView === view.id ? <XiaoIcon name="check" size={13} /> : null}
                  </button>
                );
              })}
            </div>
          </details>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close review panel">
            <XiaoIcon name="close" size={14} />
          </button>
        </div>
      </header>

      <div className={`focus-panel focus-panel--${activeView}`}>
        {activeView === "changes" && (
          <ChangesPanel
            key={`${workspace.path}\u0000${executionTaskId ?? ""}`}
            workspace={workspace}
            taskId={executionTaskId}
            transitioning={executionTransitioning}
            workspaceActionable={workspaceActionable}
            reviewContext={reviewContext}
            onStageReviewContext={onStageReviewContext}
            onRemoveReviewContext={onRemoveReviewContext}
            onOpenBrowser={onOpenBrowser}
            onRefresh={onRefresh}
            onOutcomeChange={onTaskOutcomeChange}
          />
        )}
        {activeView === "context" && (
          <ContextPanel
            key={task.id}
            taskTitle={task.title}
            taskCreatedAt={task.createdAt}
            timeline={timeline}
            threadId={task.threadId ?? task.threadBinding?.threadId ?? null}
            models={models}
            selectedModel={task.model}
            usage={contextUsage}
          />
        )}
        {activeView === "files" && (
          <OpenFilePanel
            workspace={workspace}
            taskId={executionTaskId}
            loading={loading}
            activeFile={activeFile}
            onActiveFileChange={(activeFile) => {
              setActiveFile(activeFile);
              onWorkbenchStateChange({ ...task.workbenchState, activeFile });
            }}
            onLoadDirectory={onLoadDirectory}
            reviewContext={reviewContext}
            onStageReviewContext={onStageReviewContext}
            onRemoveReviewContext={onRemoveReviewContext}
          />
        )}
        {activeView === "plan" && <PlanPanel runtime={runtime} plan={plan} />}
        {activeView === "extensions" && (
          <ExtensionsPanel workspace={workspace} taskId={executionTaskId} runtime={runtime} />
        )}
        {activeView === "terminal" && executionTaskId === null && (
          <div className="rail-empty"><XiaoIcon name="terminal" size={22} /><strong>Start this task first</strong><p>The terminal will return here after Xiao creates the native task.</p></div>
        )}
        {executionTaskId !== null && (terminalOpened || activeView === "terminal") && (
          <div className="focus-terminal-slot" hidden={activeView !== "terminal"}>
            <Suspense fallback={<div className="terminal-loading"><XiaoIcon name="pending" size={15} /> Starting terminal</div>}>
              <TerminalPanel
                key={task.id}
                active={activeView === "terminal"}
                workspace={workspace}
                taskId={executionTaskId}
                system={system}
                transitioning={executionTransitioning}
                initialSessionIds={task.workbenchState.terminalSessionIds}
                initialActiveSessionId={task.workbenchState.activeTerminalSessionId}
                initialSessionNames={task.workbenchState.terminalSessionNames}
                onSessionStateChange={({ sessionIds, activeSessionId }) => {
                  onWorkbenchStateChange({
                    ...task.workbenchState,
                    terminalSessionIds: sessionIds,
                    activeTerminalSessionId: activeSessionId,
                  });
                }}
                onSessionNamesChange={(terminalSessionNames) => {
                  onWorkbenchStateChange({
                    ...task.workbenchState,
                    terminalSessionNames,
                  });
                }}
              />
            </Suspense>
          </div>
        )}
        {(browserOpened || activeView === "browser") && (
          <div className="focus-browser-slot" hidden={activeView !== "browser"}>
            <Suspense fallback={<div className="browser-loading"><XiaoIcon name="pending" size={15} /> Starting browser</div>}>
              <nav className="task-preview-tabs" aria-label="Task Preview tabs">
                {previewTabs.map((tab, index) => (
                  <span key={tab.id}>
                    <button
                      type="button"
                      aria-current={tab.id === activePreviewTabId ? "page" : undefined}
                      onClick={() => onWorkbenchStateChange({
                        ...task.workbenchState,
                        previewTabs,
                        activePreviewTabId: tab.id,
                        previewTarget: tab.target,
                      })}
                    >
                      Preview {index + 1}
                    </button>
                    {previewTabs.length > 1 ? (
                      <button
                        type="button"
                        aria-label={`Close Preview ${index + 1}`}
                        onClick={() => {
                          const nextTabs = previewTabs.filter((item) => item.id !== tab.id);
                          const next = tab.id === activePreviewTabId ? nextTabs[0] : activePreviewTab;
                          onWorkbenchStateChange({
                            ...task.workbenchState,
                            previewTabs: nextTabs,
                            activePreviewTabId: next.id,
                            previewTarget: next.target,
                          });
                        }}
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                ))}
                <button
                  type="button"
                  aria-label="New Task Preview tab"
                  onClick={() => {
                    const tab = { id: crypto.randomUUID(), target: "http://127.0.0.1:9/" };
                    onWorkbenchStateChange({
                      ...task.workbenchState,
                      previewTabs: [...previewTabs, tab],
                      activePreviewTabId: tab.id,
                      previewTarget: tab.target,
                    });
                  }}
                >
                  +
                </button>
              </nav>
              <BrowserPanel
                key={`${task.id}:${activePreviewTabId}`}
                active={activeView === "browser" && !toolsMenuOpen && !obscured}
                ariaLabel="Task Preview"
                taskPreviewOnly
                taskId={task.id}
                projectPath={workspace.path}
                webviewLabel={taskPreviewWebviewLabel(workspace.path, task.id, activePreviewTabId)}
                homeLabel="Task outcome"
                homeUrl={activePreviewTab.target}
                placeholder={{
                  title: "No Task outcome yet",
                  description: "Start a local server or open a generated HTML file from this Task.",
                  meta: "Task-scoped preview · no general browsing",
                }}
                navigationRequest={resourceRequest?.kind === "browser" ? resourceRequest : null}
                onNavigationStart={onBrowserNavigationStart}
                onTargetChange={(previewTarget) => {
                  onWorkbenchStateChange({
                    ...task.workbenchState,
                    previewTabs: previewTabs.map((tab) => tab.id === activePreviewTabId
                      ? { ...tab, target: previewTarget }
                      : tab),
                    activePreviewTabId,
                    previewTarget,
                  });
                }}
                initialZoom={task.workbenchState.previewZoom ?? 1}
                initialViewport={task.workbenchState.previewViewport}
                initialConsole={task.workbenchState.previewConsole?.[activePreviewTabId]}
                onConsoleChange={(messages) => {
                  onWorkbenchStateChange({
                    ...task.workbenchState,
                    previewTabs,
                    activePreviewTabId,
                    previewConsole: {
                      ...task.workbenchState.previewConsole,
                      [activePreviewTabId]: messages,
                    },
                  });
                }}
                onViewportChange={(previewViewport) => {
                  onWorkbenchStateChange({
                    ...task.workbenchState,
                    previewTabs,
                    activePreviewTabId,
                    previewViewport,
                  });
                }}
                onZoomChange={(previewZoom) => {
                  onWorkbenchStateChange({
                    ...task.workbenchState,
                    previewZoom,
                  });
                }}
                onAnnotate={({ target, viewport, selector, coordinates, zoom, note, screenshotReference }) => {
                  onStageReviewContext({
                    id: crypto.randomUUID(),
                    name: "Task Preview annotation",
                    path: target,
                    url: target,
                    kind: "review",
                    comment: note,
                    preview: JSON.stringify({
                      taskId: task.id,
                      tabId: activePreviewTabId,
                      target,
                      viewport,
                      selector,
                      coordinates,
                      zoom,
                      screenshotReference,
                    }),
                  });
                }}
              />
            </Suspense>
          </div>
        )}
        {(runOpened || activeView === "run") && (
          <div className="focus-run-slot" hidden={activeView !== "run"}>
            <Suspense fallback={<div className="run-loading"><XiaoIcon name="pending" size={15} /> Opening game</div>}>
              <XiaoRunPanel
                runtime={runtime}
                plan={plan}
                interactive={activeView === "run" && !toolsMenuOpen && !obscured}
              />
            </Suspense>
          </div>
        )}
        {activeView === "schedule" && (
          <SchedulePanel
            projectPath={workspace.path}
            routines={routines}
            loading={routinesLoading}
            error={routinesError}
            creating={routineCreating}
            busyIds={routineBusyIds}
            nativeAvailable={nativeRoutinesAvailable}
            dangerousAccessDefault={dangerousRoutineAccessDefault}
            dangerousRoutineIds={dangerousRoutineIds}
            openRunId={routineOpenRunId}
            onCreate={onCreateRoutine}
            onUpdate={onUpdateRoutine}
            onSetEnabled={onSetRoutineEnabled}
            onRunNow={onRunRoutineNow}
            onDelete={onDeleteRoutine}
            onClearError={onClearRoutineError}
          />
        )}
        {activeView === "verification" && executionTaskId === null && (
          <div className="rail-empty"><XiaoIcon name="check" size={22} /><strong>Acceptance unavailable</strong><p>Start this task before defining deterministic run gates.</p></div>
        )}
        {activeView === "verification" && executionTaskId !== null && (
          <VerificationPanel
            key={`${workspace.path}\u0000${executionTaskId}`}
            projectPath={workspace.path}
            taskId={executionTaskId}
            contract={task.acceptanceContract}
            onSaved={onTaskAcceptanceContractSaved}
          />
        )}
        {activeView === "observatory" && executionTaskId === null && (
          <div className="rail-empty"><XiaoIcon name="approach" size={22} /><strong>Observatory unavailable</strong><p>Start this task before inspecting runs and recovery history.</p></div>
        )}
        {activeView === "observatory" && executionTaskId !== null && (
          <ObservatoryPanel
            key={`${workspace.path}\u0000${executionTaskId}`}
            projectPath={workspace.path}
            taskId={executionTaskId}
            liveRuns={runs}
            livePendingInputs={pendingInputs}
            openRunId={observatoryOpenRunId}
            timeline={timeline}
            onJumpToTimeline={onJumpToTimeline}
            onWorkspaceChange={onRefresh}
            onImportHandoff={onImportHandoff}
          />
        )}
        {activeView === "runtime" && (
          <RuntimePanel runtime={runtime} logs={runtimeLogs} system={system} error={error} onRefresh={onRefresh} />
        )}
      </div>
    </aside>
  );
}
