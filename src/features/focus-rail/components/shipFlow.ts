import type {
  GitCheckSummary,
  GitPullRequestSummary,
  GitPushResult,
} from "../../../core/models/workspace";

export type ShipStepId = "commit" | "push" | "pr" | "ci";
export type ShipStepStatus = "idle" | "running" | "complete" | "pending" | "warning" | "error";

export type ShipStepState = {
  id: ShipStepId;
  label: string;
  status: ShipStepStatus;
  detail: string;
};

export const initialShipSteps = (): ShipStepState[] => [
  { id: "commit", label: "Commit", status: "idle", detail: "Staged changes only" },
  { id: "push", label: "Push", status: "idle", detail: "No force push" },
  { id: "pr", label: "Draft PR", status: "idle", detail: "Reuse an open PR when present" },
  { id: "ci", label: "CI", status: "idle", detail: "Read check status once" },
];

export const updateShipStep = (
  steps: ShipStepState[],
  id: ShipStepId,
  status: ShipStepStatus,
  detail?: string,
) => steps.map((step) => step.id === id
  ? { ...step, status, detail: detail ?? step.detail }
  : step);

export type ShipCheckPresentation = {
  status: Extract<ShipStepStatus, "complete" | "pending" | "warning">;
  detail: string;
};

export const summarizeShipChecks = (checks: GitCheckSummary[]): ShipCheckPresentation => {
  if (!checks.length) return { status: "pending", detail: "No checks reported yet" };

  const failed = checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel").length;
  if (failed) {
    return {
      status: "warning",
      detail: `${failed} ${failed === 1 ? "check needs" : "checks need"} attention`,
    };
  }

  const pending = checks.filter((check) => check.bucket === "pending").length;
  if (pending) {
    return {
      status: "pending",
      detail: `${pending} ${pending === 1 ? "check is" : "checks are"} running`,
    };
  }

  return {
    status: "complete",
    detail: `${checks.length} ${checks.length === 1 ? "check passed" : "checks passed"}`,
  };
};

export type ShipFlowOperations = {
  commit: () => Promise<string>;
  push: () => Promise<GitPushResult>;
  findPullRequest: () => Promise<GitPullRequestSummary | null>;
  createDraftPullRequest: () => Promise<GitPullRequestSummary>;
  readChecks: (pullRequest: GitPullRequestSummary) => Promise<GitCheckSummary[]>;
};

export type ShipFlowCallbacks = {
  onStep: (
    id: ShipStepId,
    status: ShipStepStatus,
    detail?: string,
  ) => void;
  onPullRequest?: (pullRequest: GitPullRequestSummary) => void;
  onChecks?: (checks: GitCheckSummary[]) => void;
};

export type ShipFlowResult = {
  pullRequest: GitPullRequestSummary;
  checks: GitCheckSummary[];
};

export type ShipFlowResume = {
  commitOutput?: string | null;
};

const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

export const executeShipFlow = async (
  operations: ShipFlowOperations,
  callbacks: ShipFlowCallbacks,
  resume: ShipFlowResume = {},
): Promise<ShipFlowResult> => {
  let activeStep: ShipStepId = "commit";
  try {
    if (resume.commitOutput) {
      callbacks.onStep("commit", "complete", resume.commitOutput.trim() || "Commit already created");
    } else {
      callbacks.onStep("commit", "running", "Creating commit");
      const commitOutput = await operations.commit();
      callbacks.onStep("commit", "complete", commitOutput.trim() || "Committed staged changes");
    }

    activeStep = "push";
    callbacks.onStep("push", "running", "Publishing current branch");
    const push = await operations.push();
    callbacks.onStep("push", "complete", `Pushed ${push.branch} to ${push.upstream}`);

    activeStep = "pr";
    callbacks.onStep("pr", "running", "Looking for an open pull request");
    let pullRequest = await operations.findPullRequest();
    const existing = Boolean(pullRequest);
    if (!pullRequest) pullRequest = await operations.createDraftPullRequest();
    callbacks.onPullRequest?.(pullRequest);
    callbacks.onStep(
      "pr",
      "complete",
      `${existing ? "Using" : "Created"} ${pullRequest.isDraft ? "draft " : ""}PR #${pullRequest.number}`,
    );

    activeStep = "ci";
    callbacks.onStep("ci", "running", "Reading GitHub checks");
    const checks = await operations.readChecks(pullRequest);
    callbacks.onChecks?.(checks);
    const summary = summarizeShipChecks(checks);
    callbacks.onStep("ci", summary.status, summary.detail);

    return { pullRequest, checks };
  } catch (reason) {
    callbacks.onStep(activeStep, "error", errorMessage(reason));
    throw reason;
  }
};
