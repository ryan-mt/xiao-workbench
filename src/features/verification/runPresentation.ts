import type { RunSnapshot } from "../../core/models/run";

export type RunPresentationKind =
  | "queued"
  | "working"
  | "waiting"
  | "done"
  | "verified"
  | "attention"
  | "failed"
  | "cancelled"
  | "interrupted";

export type RunPresentation = {
  label: string;
  description: string;
  kind: RunPresentationKind;
};

type PresentableRun = Pick<RunSnapshot, "status" | "agentOutcome" | "verificationOutcome">;

export const runPresentation = (run: PresentableRun): RunPresentation => {
  switch (run.status) {
    case "queued":
      return { label: "Queued", description: "Waiting for an execution slot.", kind: "queued" };
    case "preparing":
      return { label: "Preparing", description: "Resolving the run environment.", kind: "working" };
    case "running":
      return { label: "Working", description: "The agent is working on this task.", kind: "working" };
    case "waiting_for_input":
      return { label: "Waiting for input", description: "The agent needs a decision before continuing.", kind: "waiting" };
    case "verifying":
      return { label: "Verifying", description: "Native acceptance gates are running.", kind: "working" };
    case "completed":
      if (run.verificationOutcome === "passed") {
        return { label: "Verified", description: "Every saved acceptance gate passed.", kind: "verified" };
      }
      return {
        label: "Done",
        description: run.agentOutcome === "completed"
          ? "The agent finished; no passing acceptance attempt is attached."
          : "The run completed without a passing acceptance attempt.",
        kind: "done",
      };
    case "needs_attention":
      if (run.verificationOutcome === "failed") {
        return {
          label: "Verification failed",
          description: "Agent work is preserved, but one or more acceptance gates failed.",
          kind: "attention",
        };
      }
      if (run.verificationOutcome === "blocked") {
        return {
          label: "Verification blocked",
          description: "Agent work is preserved, but verification could not complete.",
          kind: "attention",
        };
      }
      return { label: "Needs attention", description: "The run needs a user decision.", kind: "attention" };
    case "failed":
      return { label: "Failed", description: "The agent run failed before completion.", kind: "failed" };
    case "cancelled":
      return { label: "Cancelled", description: "The run was cancelled.", kind: "cancelled" };
    case "interrupted":
      if (run.agentOutcome === "completed" && run.verificationOutcome === "blocked") {
        return {
          label: "Verification blocked",
          description: "Agent work is preserved, but verification was interrupted. Rerun verification to finish checking the saved acceptance gates.",
          kind: "attention",
        };
      }
      return { label: "Interrupted", description: "The run was interrupted and can be resumed or retried.", kind: "interrupted" };
  }
};
