import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import {
  contextUsedPercent,
  type AgentApprovalPolicy,
  type AgentAttachment,
  type AgentFollowUp,
  type AgentGoal,
  type AgentMcpElicitationRequest,
  type AgentMcpElicitationResponse,
  type AgentMode,
  type AgentModelSummary,
  type AgentPlan,
  type AgentQuestionRequest,
  type AgentRateLimitSnapshot,
  type AgentRuntimeState,
  type AgentSandboxMode,
  type ThreadTokenUsage,
  type TimelineEntry,
} from "../../../core/models/agent";
import type { RunSnapshot } from "../../../core/models/run";
import type { AcceptanceContractDraft } from "../../../core/models/verification";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { XiaoWorkspaceMode } from "../../../core/models/xiao";
import type { FocusView } from "../../focus-rail/focus-rail.types";
import { Composer } from "../composer/Composer";
import { TaskTimeline } from "../timeline/TaskTimeline";
import { TaskHeader } from "./TaskHeader";
import "../styles/task.css";

const useEventCallback = <Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
) => {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback((...args: Args) => callbackRef.current(...args), []);
};

export const activeCollaboratorsFromTimeline = (timeline: TimelineEntry[]) => {
  const latestByThread = new Map(
    timeline.flatMap((entry) => entry.collaborators ?? []).map((collaborator) => [
      collaborator.threadId,
      collaborator,
    ]),
  );
  return [...latestByThread.values()].filter((collaborator) =>
    collaborator.status === "pendingInit" || collaborator.status === "running"
  );
};

const liveOutputFollowThreshold = 72;

type TimelineSelection = {
  text: string;
  left: number;
  top: number;
};

export const distanceFromScrollBottom = ({
  scrollHeight,
  scrollTop,
  clientHeight,
}: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">) =>
  Math.max(0, scrollHeight - scrollTop - clientHeight);

export const shouldFollowLiveOutput = (
  metrics: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
) => distanceFromScrollBottom(metrics) <= liveOutputFollowThreshold;

type TaskWorkspaceProps = {
  taskId: string;
  executionTaskId: string | null;
  taskTitle: string;
  taskArchived: boolean;
  launchMode: boolean;
  taskStateError: string | null;
  taskStateLoading: boolean;
  timeline: TimelineEntry[];
  runtime: AgentRuntimeState;
  rateLimits: AgentRateLimitSnapshot | null;
  latestRun: RunSnapshot | null;
  models: AgentModelSummary[];
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  fastMode: boolean;
  mode: AgentMode;
  approvalPolicy: AgentApprovalPolicy;
  sandboxMode: AgentSandboxMode;
  workspaceMode: XiaoWorkspaceMode;
  environmentBusy: boolean;
  environmentError: string | null;
  goal: AgentGoal | null;
  plan: AgentPlan | null;
  reviewContext: AgentAttachment[];
  questionRequest: AgentQuestionRequest | null;
  mcpElicitationRequest: AgentMcpElicitationRequest | null;
  draftText: string;
  followUps: AgentFollowUp[];
  sendingFollowUpId: string | null;
  failedFollowUpId: string | null;
  attachments: AgentAttachment[];
  canCompact: boolean;
  compacting: boolean;
  hasThread: boolean;
  canUndo: boolean;
  undoing: boolean;
  definitionOfDoneAvailable: boolean;
  definitionOfDone: AcceptanceContractDraft | null;
  definitionOfDoneError: string | null;
  contextUsage: ThreadTokenUsage | null;
  showReasoningSummaries: boolean;
  expandToolOutput: boolean;
  launchBrand: "logo" | "wordmark";
  workspace: WorkspaceSnapshot;
  onSubmit: (prompt: string, attachments: AgentAttachment[]) => Promise<boolean>;
  onSteer: (prompt: string, attachments: AgentAttachment[]) => Promise<boolean>;
  onQueueFollowUp: (prompt: string, attachments: AgentAttachment[]) => Promise<boolean>;
  onEditFollowUp: (followUpId: string, prompt: string) => void;
  onRemoveFollowUp: (followUpId: string) => void;
  onSendFollowUpNow: (followUpId: string) => Promise<void>;
  onRetryFollowUp: () => void;
  onAttachmentsChange: (attachments: AgentAttachment[]) => void;
  onCompact: () => Promise<boolean>;
  onUndo: () => void;
  onDefinitionOfDoneChange: (value: AcceptanceContractDraft | null) => void;
  onForkTask: (entryId: string) => void;
  onRemoveReviewContext: (attachmentId: string) => void;
  onReviewContextSent: (attachments: AgentAttachment[]) => void;
  onDraftChange: (draftText: string) => void;
  onSubmissionStart: () => number;
  onSubmissionSucceeded: (revision: number) => Promise<boolean>;
  onResolveQuestion: (
    requestId: number | string,
    answers: Record<string, string[]>,
  ) => Promise<boolean>;
  onResolveMcpElicitation: (
    requestId: number | string,
    response: AgentMcpElicitationResponse,
  ) => Promise<boolean>;
  onModelChange: (model: string | null) => void;
  onReasoningEffortChange: (effort: string | null) => void;
  onFastModeChange: (fastMode: boolean) => void;
  onModeChange: (mode: AgentMode) => void;
  onApprovalPolicyChange: (policy: AgentApprovalPolicy) => void;
  onSandboxModeChange: (mode: AgentSandboxMode) => void;
  onWorkspaceModeChange: (mode: XiaoWorkspaceMode) => Promise<void>;
  onGoalSet: (objective: string, status?: AgentGoal["status"]) => Promise<boolean>;
  onGoalClear: () => Promise<boolean>;
  onInterrupt: () => Promise<void>;
  onRetryRun: (runId: string) => void;
  onResolveApproval: (
    taskId: string,
    entryId: string,
    requestId: number | string,
    decision: "accept" | "decline",
  ) => Promise<void>;
  onFocusView: (view: FocusView) => void;
  onOpenResource: (target: string) => boolean;
  onToggleArchived: () => void;
};

export function TaskWorkspace({
  taskId,
  executionTaskId,
  taskTitle,
  taskArchived,
  launchMode,
  taskStateError,
  taskStateLoading,
  timeline,
  runtime,
  rateLimits,
  latestRun,
  models,
  selectedModel,
  selectedReasoningEffort,
  fastMode,
  mode,
  approvalPolicy,
  sandboxMode,
  workspaceMode,
  environmentBusy,
  environmentError,
  goal,
  plan,
  reviewContext,
  questionRequest,
  mcpElicitationRequest,
  draftText,
  followUps,
  sendingFollowUpId,
  failedFollowUpId,
  attachments,
  canCompact,
  compacting,
  hasThread,
  canUndo,
  undoing,
  definitionOfDoneAvailable,
  definitionOfDone,
  definitionOfDoneError,
  contextUsage,
  showReasoningSummaries,
  expandToolOutput,
  launchBrand,
  workspace,
  onSubmit,
  onSteer,
  onQueueFollowUp,
  onEditFollowUp,
  onRemoveFollowUp,
  onSendFollowUpNow,
  onRetryFollowUp,
  onAttachmentsChange,
  onCompact,
  onUndo,
  onDefinitionOfDoneChange,
  onForkTask,
  onRemoveReviewContext,
  onReviewContextSent,
  onDraftChange,
  onSubmissionStart,
  onSubmissionSucceeded,
  onResolveQuestion,
  onResolveMcpElicitation,
  onModelChange,
  onReasoningEffortChange,
  onFastModeChange,
  onModeChange,
  onApprovalPolicyChange,
  onSandboxModeChange,
  onWorkspaceModeChange,
  onGoalSet,
  onGoalClear,
  onInterrupt,
  onRetryRun,
  onResolveApproval,
  onFocusView,
  onOpenResource,
  onToggleArchived,
}: TaskWorkspaceProps) {
  const scrollArea = useRef<HTMLDivElement>(null);
  const timelineShell = useRef<HTMLDivElement>(null);
  const followLiveOutput = useRef(true);
  const previousTaskId = useRef(taskId);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [timelineSelection, setTimelineSelection] = useState<TimelineSelection | null>(null);
  const [selectedContext, setSelectedContext] = useState<string | null>(null);
  const taskActionsDisabled =
    environmentBusy || taskStateLoading || Boolean(taskStateError);
  const canFork =
    runtime.phase === "ready" &&
    !taskArchived &&
    !taskStateError &&
    !taskStateLoading &&
    !environmentBusy &&
    !compacting &&
    !undoing &&
    followUps.length === 0;
  const activeModel =
    (selectedModel ? models.find((model) => model.model === selectedModel) : models.find((model) => model.isDefault)) ??
    models.find((model) => model.isDefault);
  const contextPercent = contextUsedPercent(contextUsage, activeModel?.contextWindow);
  const openTimelineResource = useEventCallback(onOpenResource);
  const forkTimelineTask = useEventCallback(onForkTask);
  const resolveTimelineApproval = useEventCallback(onResolveApproval);
  const reviewTimelineChanges = useEventCallback(() => onFocusView("changes"));
  const activeCollaborators = activeCollaboratorsFromTimeline(timeline);

  useEffect(() => {
    setTimelineSelection(null);
    setSelectedContext(null);
  }, [taskId]);

  useEffect(() => {
    if (!timelineSelection) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTimelineSelection(null);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [timelineSelection]);

  const captureTimelineSelection = useCallback(() => {
    window.requestAnimationFrame(() => {
      const root = scrollArea.current;
      const shell = timelineShell.current;
      const selection = window.getSelection();
      if (
        !root ||
        !shell ||
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0 ||
        !selection.anchorNode ||
        !selection.focusNode ||
        !root.contains(selection.anchorNode) ||
        !root.contains(selection.focusNode)
      ) {
        setTimelineSelection(null);
        return;
      }

      const text = selection.toString().trim();
      if (!text) {
        setTimelineSelection(null);
        return;
      }

      const rangeRect = selection.getRangeAt(0).getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const left = Math.min(
        Math.max(rangeRect.left - shellRect.left + rangeRect.width / 2, 72),
        Math.max(72, shellRect.width - 72),
      );
      const top = Math.max(8, rangeRect.top - shellRect.top - 42);
      setTimelineSelection({ text, left, top });
    });
  }, []);

  useLayoutEffect(() => {
    const node = scrollArea.current;
    if (!node) return;
    if (previousTaskId.current !== taskId) {
      previousTaskId.current = taskId;
      followLiveOutput.current = true;
      setShowJumpToLatest(false);
    }
    if (followLiveOutput.current) node.scrollTop = node.scrollHeight;
  }, [taskId, timeline]);

  useLayoutEffect(() => {
    const node = scrollArea.current;
    const content = node?.firstElementChild;
    if (!node || !content || typeof ResizeObserver === "undefined") return;

    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!followLiveOutput.current) return;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        node.scrollTop = node.scrollHeight;
        frame = null;
      });
    });
    observer.observe(node);
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [taskId]);

  const jumpToLatest = useCallback(() => {
    const node = scrollArea.current;
    if (!node) return;
    followLiveOutput.current = true;
    setShowJumpToLatest(false);
    node.scrollTop = node.scrollHeight;
  }, []);

  const composer = (
    <Composer
      key={taskId}
      taskId={taskId}
      executionTaskId={executionTaskId}
      workspacePath={workspace.path}
      runtime={runtime}
      rateLimits={rateLimits}
      models={models}
      selectedModel={selectedModel}
      selectedReasoningEffort={selectedReasoningEffort}
      fastMode={fastMode}
      mode={mode}
      approvalPolicy={approvalPolicy}
      sandboxMode={sandboxMode}
      workspaceMode={workspaceMode}
      isolationAvailable={workspace.execution.isolationAvailable}
      isolationUnavailableReason={workspace.execution.isolationUnavailableReason}
      environmentBusy={environmentBusy}
      environmentError={environmentError}
      managedWorktree={workspace.execution.managedWorktree}
      goal={goal}
      plan={plan}
      collaborators={activeCollaborators}
      reviewContext={reviewContext}
      selectedContext={selectedContext}
      questionRequest={questionRequest}
      mcpElicitationRequest={mcpElicitationRequest}
      draftText={draftText}
      followUps={followUps}
      sendingFollowUpId={sendingFollowUpId}
      failedFollowUpId={failedFollowUpId}
      attachments={attachments}
      canCompact={canCompact}
      compacting={compacting}
      hasThread={hasThread}
      canUndo={canUndo}
      undoing={undoing}
      definitionOfDoneAvailable={definitionOfDoneAvailable}
      definitionOfDone={definitionOfDone}
      autoFocus={launchMode}
      onModelChange={onModelChange}
      onReasoningEffortChange={onReasoningEffortChange}
      onFastModeChange={onFastModeChange}
      onModeChange={onModeChange}
      onApprovalPolicyChange={onApprovalPolicyChange}
      onSandboxModeChange={onSandboxModeChange}
      onWorkspaceModeChange={onWorkspaceModeChange}
      onGoalSet={onGoalSet}
      onGoalClear={onGoalClear}
      onInterrupt={onInterrupt}
      onOpenView={onFocusView}
      onSubmit={onSubmit}
      onSteer={onSteer}
      onQueueFollowUp={onQueueFollowUp}
      onEditFollowUp={onEditFollowUp}
      onRemoveFollowUp={onRemoveFollowUp}
      onSendFollowUpNow={onSendFollowUpNow}
      onRetryFollowUp={onRetryFollowUp}
      onAttachmentsChange={onAttachmentsChange}
      onCompact={onCompact}
      onUndo={onUndo}
      onDefinitionOfDoneChange={onDefinitionOfDoneChange}
      onRemoveReviewContext={onRemoveReviewContext}
      onReviewContextSent={onReviewContextSent}
      onClearSelectedContext={() => setSelectedContext(null)}
      onSelectedContextSent={(submitted) => {
        setSelectedContext((current) => current === submitted ? null : current);
      }}
      onDraftChange={onDraftChange}
      onSubmissionStart={onSubmissionStart}
      onSubmissionSucceeded={onSubmissionSucceeded}
      onResolveQuestion={onResolveQuestion}
      onResolveMcpElicitation={onResolveMcpElicitation}
      disabled={
        taskArchived || taskStateLoading || environmentBusy || Boolean(taskStateError)
      }
      disabledPlaceholder={taskStateLoading ? "Loading task history…" : undefined}
      storageError={taskStateError ?? definitionOfDoneError}
    />
  );

  if (launchMode) {
    const branch = workspace.git?.branch ?? "No Git branch";
    return (
      <section className="task-workspace task-workspace--launch">
        <div className="task-launch">
          <div className="task-launch__inner">
            <header className="task-launch__brand" aria-label="XIAO local agent workspace">
              <span className="task-launch__mark">
                {launchBrand === "logo" ? (
                  <img className="task-launch__logo" src="/xiao-mark.png" alt="" aria-hidden="true" />
                ) : (
                  <span className="task-launch__wordmark" aria-hidden="true">
                    <i>X</i><i>I</i><i>A</i><i className="task-launch__orbit">O</i>
                  </span>
                )}
              </span>
              <span className="task-launch__brand-copy">
                <strong>XIAO</strong>
                <small>Local agent workspace</small>
              </span>
            </header>

            <div className="task-launch__intro">
              <h1>What should we work on?</h1>
              <p>Describe the outcome. Xiao can inspect the code, make changes, and verify the result.</p>
            </div>

            {composer}

            <footer className="task-launch__context" aria-label="Task context">
              <span title={workspace.path}>
                <XiaoIcon name="workspace" size={14} />
                <strong>{workspace.name}</strong>
              </span>
              <i aria-hidden="true">/</i>
              <button type="button" onClick={() => onFocusView("changes")}>
                <XiaoIcon name="branch" size={13} />
                <span>{branch}</span>
              </button>
              <i aria-hidden="true">/</i>
              <span title={definitionOfDone
                ? "This task will run acceptance checks before completion."
                : "No acceptance checks are configured."}
              >
                <XiaoIcon name="check" size={13} />
                <strong>{definitionOfDone
                  ? `${definitionOfDone.gates.length} ${definitionOfDone.gates.length === 1 ? "check" : "checks"}`
                  : "No checks"}</strong>
              </span>
              <span className="task-launch__hint" aria-hidden="true">
                <kbd>Enter</kbd> to send <i>&middot;</i> <kbd>Shift Enter</kbd> for a new line
              </span>
            </footer>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="task-workspace">
      <TaskHeader
        taskId={taskId}
        executionTaskId={executionTaskId}
        taskTitle={taskTitle}
        taskArchived={taskArchived}
        workspace={workspace}
        runtime={runtime}
        latestRun={latestRun}
        contextPercent={contextPercent}
        actionsDisabled={taskActionsDisabled}
        archiveDisabled={taskActionsDisabled}
        canUndo={canUndo}
        undoing={undoing}
        onFocusView={onFocusView}
        onRetryRun={onRetryRun}
        onToggleArchived={onToggleArchived}
        onUndo={onUndo}
      />
      <div className="task-workspace__timeline-shell" ref={timelineShell}>
        <div
          className="task-workspace__scroll"
          ref={scrollArea}
          onPointerUp={captureTimelineSelection}
          onKeyUp={(event) => {
            if (event.shiftKey) captureTimelineSelection();
          }}
          onScroll={(event) => {
            const following = shouldFollowLiveOutput(event.currentTarget);
            followLiveOutput.current = following;
            setShowJumpToLatest(!following);
            setTimelineSelection(null);
          }}
        >
          <TaskTimeline
            taskId={taskId}
            timeline={timeline}
            runtime={runtime}
            latestRun={latestRun}
            showReasoningSummaries={showReasoningSummaries}
            expandToolOutput={expandToolOutput}
            workspacePath={workspace.path}
            onOpenResource={openTimelineResource}
            historyLoading={taskStateLoading}
            canFork={canFork}
            onForkTask={forkTimelineTask}
            onResolveApproval={resolveTimelineApproval}
            onReviewChanges={reviewTimelineChanges}
            onFixVerificationFailures={(prompt) => onSubmit(prompt, [])}
            fixVerificationFailuresDisabled={taskActionsDisabled || taskArchived}
            canUndo={canUndo}
            undoing={undoing}
            onUndo={onUndo}
          />
        </div>
        {timelineSelection ? (
          <div
            className="timeline-selection-toolbar"
            role="toolbar"
            aria-label="Actions for selected text"
            style={{ left: timelineSelection.left, top: timelineSelection.top }}
            onPointerDown={(event) => event.preventDefault()}
          >
            <button
              type="button"
              onClick={() => {
                setSelectedContext(timelineSelection.text);
                setTimelineSelection(null);
                window.getSelection()?.removeAllRanges();
              }}
            >
              <XiaoIcon name="mention" size={13} />
              <span>{hasThread ? "Follow up" : "Ask Xiao"}</span>
            </button>
          </div>
        ) : null}
        {showJumpToLatest ? (
          <button
            className="task-workspace__jump-latest"
            type="button"
            aria-label="Jump to latest message"
            title="Jump to latest message"
            onClick={jumpToLatest}
          >
            <XiaoIcon name="down" size={17} />
          </button>
        ) : null}
      </div>
      {composer}
    </section>
  );
}
