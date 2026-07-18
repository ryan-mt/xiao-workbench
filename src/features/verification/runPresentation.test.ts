import { describe, expect, it } from "vitest";

import type { RunSnapshot } from "../../core/models/run";
import { runPresentation } from "./runPresentation";

const run = (
  status: RunSnapshot["status"],
  verificationOutcome: RunSnapshot["verificationOutcome"],
): Pick<RunSnapshot, "status" | "agentOutcome" | "verificationOutcome"> => ({
  status,
  agentOutcome: "completed",
  verificationOutcome,
});

describe("runPresentation", () => {
  it("labels only a completed passing run as Verified", () => {
    expect(runPresentation(run("completed", "passed")).label).toBe("Verified");
    expect(runPresentation(run("completed", "not_requested")).label).toBe("Done");
    expect(runPresentation(run("completed", "pending")).label).toBe("Done");
    expect(runPresentation(run("verifying", "passed")).label).toBe("Verifying");
  });

  it("distinguishes failed and blocked verification while preserving work", () => {
    expect(runPresentation(run("needs_attention", "failed"))).toMatchObject({
      label: "Verification failed",
      kind: "attention",
    });
    expect(runPresentation(run("needs_attention", "blocked"))).toMatchObject({
      label: "Verification blocked",
      kind: "attention",
    });
  });

  it("presents interrupted verification as blocked attention without relabeling agent interruption", () => {
    expect(runPresentation(run("interrupted", "blocked"))).toEqual({
      label: "Verification blocked",
      description: "Agent work is preserved, but verification was interrupted. Rerun verification to finish checking the saved acceptance gates.",
      kind: "attention",
    });
    expect(runPresentation({
      ...run("interrupted", "not_requested"),
      agentOutcome: "interrupted",
    })).toEqual({
      label: "Interrupted",
      description: "The run was interrupted and can be resumed or retried.",
      kind: "interrupted",
    });
  });
});
