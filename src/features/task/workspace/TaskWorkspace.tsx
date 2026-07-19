import { useLayoutEffect, useRef } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import {
  contextUsedPercent,
  type AgentApprovalPolicy,
  type AgentAttachment,
  type AgentFollowUp,
  type AgentGoal,
  type AgentMode,
  type AgentModelSummary,
  type AgentPlan,
  type AgentQuestionRequest,
  type AgentRuntimeState,
  type AgentSandboxMode,
  type ThreadTokenUsage,
  type TimelineEntry,
} from "../../../core/models/agent";
import type { RunSnapshot } from "../../../core/models/run";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { XiaoWorkspaceMode } from "../../../core/models/xiao";
import type { FocusView } from "../../focus-rail/focus-rail.types";
import { Composer } from "../composer/Composer";
import { TaskTimeline } from "../timeline/TaskTimeline";
import { TaskAcceptanceAction, TaskHeader } from "./TaskHeader";
import "../styles/task.css";

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
  contextUsage: ThreadTokenUsage | null;
  showReasoningSummaries: boolean;
  expandToolOutput: boolean;
  launchBrand: "logo" | "wordmark";
  workspace: WorkspaceSnapshot;
  onSubmit: (prompt: string, attachments: AgentAttachment[]) => Promise<boolean>;
  onQueueFollowUp: (prompt: string, attachments: AgentAttachment[]) => Promise<boolean>;
  onRemoveFollowUp: (followUpId: string) => void;
  onSendFollowUpNow: (followUpId: string) => Promise<void>;
  onRetryFollowUp: () => void;
  onAttachmentsChange: (attachments: AgentAttachment[]) => void;
  onCompact: () => Promise<boolean>;
  onUndo: () => void;
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
  contextUsage,
  showReasoningSummaries,
  expandToolOutput,
  launchBrand,
  workspace,
  onSubmit,
  onQueueFollowUp,
  onRemoveFollowUp,
  onSendFollowUpNow,
  onRetryFollowUp,
  onAttachmentsChange,
  onCompact,
  onUndo,
  onForkTask,
  onRemoveReviewContext,
  onReviewContextSent,
  onDraftChange,
  onSubmissionStart,
  onSubmissionSucceeded,
  onResolveQuestion,
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
  const followLiveOutput = useRef(true);
  const previousWorking = useRef(false);
  const taskWorking = runtime.phase === "working" && runtime.taskId === taskId;
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

  useLayoutEffect(() => {
    const node = scrollArea.current;
    if (!node) return;
    if (taskWorking && !previousWorking.current) {
      followLiveOutput.current = true;
    }
    previousWorking.current = taskWorking;
    if (followLiveOutput.current) node.scrollTop = node.scrollHeight;
  }, [taskId, taskWorking, timeline]);

  const composer = (
    <Composer
      key={taskId}
      taskId={taskId}
      executionTaskId={executionTaskId}
      workspacePath={workspace.path}
      runtime={runtime}
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
      reviewContext={reviewContext}
      questionRequest={questionRequest}
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
      onQueueFollowUp={onQueueFollowUp}
      onRemoveFollowUp={onRemoveFollowUp}
      onSendFollowUpNow={onSendFollowUpNow}
      onRetryFollowUp={onRetryFollowUp}
      onAttachmentsChange={onAttachmentsChange}
      onCompact={onCompact}
      onUndo={onUndo}
      onRemoveReviewContext={onRemoveReviewContext}
      onReviewContextSent={onReviewContextSent}
      onDraftChange={onDraftChange}
      onSubmissionStart={onSubmissionStart}
      onSubmissionSucceeded={onSubmissionSucceeded}
      onResolveQuestion={onResolveQuestion}
      disabled={
        taskArchived || taskStateLoading || environmentBusy || Boolean(taskStateError)
      }
      disabledPlaceholder={taskStateLoading ? "Loading task history…" : undefined}
      storageError={taskStateError}
    />
  );

  if (launchMode) {
    const branch = workspace.git?.branch ?? "No Git branch";
    return (
      <section className="task-workspace task-workspace--launch">
        <div className="task-launch">
          <div className="task-launch__inner">
            <div className="task-launch__brand" aria-label="XIAO">
              {launchBrand === "logo" ? (
                <img className="task-launch__logo" src="/xiao-mark.png" alt="" aria-hidden="true" />
              ) : (
                <span className="task-launch__wordmark" aria-hidden="true">
                  <i>X</i><i>I</i><i>A</i><i className="task-launch__orbit">O</i>
                </span>
              )}
              <small>Local agent workspace</small>
            </div>
            {composer}
            <div className="task-launch__context" aria-label="Task context">
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
              <TaskAcceptanceAction
                executionTaskId={executionTaskId}
                iconSize={13}
                label="Acceptance"
                onOpen={() => onFocusView("verification")}
              />
            </div>
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
        archiveDisabled={environmentBusy || taskStateLoading || Boolean(taskStateError)}
        canUndo={canUndo}
        undoing={undoing}
        onFocusView={onFocusView}
        onRetryRun={onRetryRun}
        onToggleArchived={onToggleArchived}
        onUndo={onUndo}
      />
      <div
        className="task-workspace__scroll"
        ref={scrollArea}
        onScroll={(event) => {
          const node = event.currentTarget;
          followLiveOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
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
          onOpenResource={onOpenResource}
          historyLoading={taskStateLoading}
          canFork={canFork}
          onForkTask={onForkTask}
          onResolveApproval={onResolveApproval}
          onReviewChanges={() => onFocusView("changes")}
        />
      </div>
      {composer}
    </section>
  );
}
