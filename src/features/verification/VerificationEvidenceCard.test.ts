import { describe, expect, it, vi } from "vitest";

import type { RunSnapshot } from "../../core/models/run";
import type { VerificationAttemptEvidence } from "../../core/models/verification";
import {
  buildVerificationFixPrompt,
  canFixVerificationFailures,
  canRerunVerification,
  createVerificationActionScope,
  loadVerificationArtifact,
  startVerificationFix,
  type ArtifactView,
} from "./VerificationEvidenceCard";

const contractSnapshot = {
  schemaVersion: 1,
  name: "Release checks",
  gates: [],
};

const rerunState = (
  status: RunSnapshot["status"],
  agentOutcome: RunSnapshot["agentOutcome"] = "completed",
  withContract = true,
) => ({
  status,
  agentOutcome,
  acceptanceContractSnapshot: withContract ? contractSnapshot : null,
});

const failedAttempt: VerificationAttemptEvidence = {
  attempt: {
    id: "attempt-1",
    runId: "run-1",
    requestKey: "initial:run-1",
    attemptNumber: 2,
    trigger: "initial",
    contractSnapshot,
    contractSnapshotSha256: "a".repeat(64),
    expectedGateCount: 1,
    status: "failed",
    diagnostic: "Acceptance checks failed.",
    startedAt: 1,
    finishedAt: 2,
    updatedAt: 2,
    version: 1,
  },
  gates: [{
    result: {
      id: "gate-1",
      verificationAttemptId: "attempt-1",
      gateIndex: 0,
      gateType: "command",
      outcome: "failed",
      durationMs: 10,
      exitCode: 1,
      diagnostic: "npm test failed",
      startedAt: 1,
      finishedAt: 2,
    },
    evidence: [{
      evidence: {
        id: "evidence-1",
        runId: "run-1",
        verificationAttemptId: "attempt-1",
        gateResultId: "gate-1",
        evidenceType: "commandOutput",
        summary: { stderr: "expected true to be false" },
        artifactId: null,
        redactionState: "safe",
        createdAt: 2,
      },
      artifact: null,
    }],
  }],
};

describe("verification action scope", () => {
  it("invalidates action settlements when the displayed run changes", () => {
    const scope = createVerificationActionScope("run-a");
    const runAAction = scope.start();

    expect(scope.isCurrent(runAAction)).toBe(true);
    scope.setRunId("run-b");

    expect(scope.isCurrent(runAAction)).toBe(false);
    expect(scope.isCurrent(scope.start())).toBe(true);
  });

  it("invalidates an earlier generation within the same run", () => {
    const scope = createVerificationActionScope("run-a");
    const first = scope.start();
    const second = scope.start();

    expect(scope.isCurrent(first)).toBe(false);
    expect(scope.isCurrent(second)).toBe(true);
  });
});

describe("verification rerun eligibility", () => {
  it("matches the native rerun preconditions", () => {
    expect(canRerunVerification(rerunState("needs_attention"))).toBe(true);
    expect(canRerunVerification(rerunState("interrupted"))).toBe(true);
    expect(canRerunVerification(rerunState("completed"))).toBe(false);
    expect(canRerunVerification(rerunState("needs_attention", "pending"))).toBe(false);
    expect(canRerunVerification(rerunState("interrupted", "interrupted"))).toBe(false);
    expect(canRerunVerification(rerunState("needs_attention", "completed", false))).toBe(false);
  });
});

describe("verification fix loop", () => {
  it("offers fixes only for completed work with a failed acceptance contract", () => {
    const failed = {
      ...rerunState("needs_attention"),
      verificationOutcome: "failed" as const,
    };

    expect(canFixVerificationFailures(failed)).toBe(true);
    expect(canFixVerificationFailures({ ...failed, verificationOutcome: "blocked" })).toBe(false);
    expect(canFixVerificationFailures({ ...failed, status: "interrupted" })).toBe(false);
    expect(canFixVerificationFailures({ ...failed, agentOutcome: "failed" })).toBe(false);
  });

  it("submits the failed gate evidence as a fix request that triggers verification again", async () => {
    const submit = vi.fn().mockResolvedValue(true);

    await startVerificationFix({ id: "run-1" }, failedAttempt, submit);

    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0]).toBe(buildVerificationFixPrompt({ id: "run-1" }, failedAttempt));
    expect(submit.mock.calls[0][0]).toContain("Fix the failures from Xiao verification attempt 2 and verify again.");
    expect(submit.mock.calls[0][0]).toContain("npm test failed");
    expect(submit.mock.calls[0][0]).toContain("expected true to be false");
  });

  it("reports when the fix run could not be started", async () => {
    await expect(startVerificationFix(
      { id: "run-1" },
      failedAttempt,
      vi.fn().mockResolvedValue(false),
    )).rejects.toThrow("Could not start a run to fix the verification failures.");
  });
});

describe("verification artifact loading", () => {
  it("retries errors while suppressing loading and ready duplicates", async () => {
    let view: ArtifactView | undefined;
    let resolveFirst: ((value: unknown) => void) | undefined;
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise<unknown>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockRejectedValueOnce(new Error("artifact unavailable"))
      .mockResolvedValueOnce({ output: "durable evidence" });
    const options = {
      getView: () => view,
      setView: (next: ArtifactView) => {
        view = next;
      },
      read,
    };

    const first = loadVerificationArtifact(options);
    const duplicate = loadVerificationArtifact(options);
    expect(read).toHaveBeenCalledTimes(1);
    resolveFirst?.({ output: "first" });
    await Promise.all([first, duplicate]);
    expect(view).toEqual({ status: "ready", value: { output: "first" } });

    await loadVerificationArtifact(options);
    expect(read).toHaveBeenCalledTimes(1);

    view = { status: "error", message: "stale read error" };
    await loadVerificationArtifact(options);
    expect(read).toHaveBeenCalledTimes(2);
    expect(view).toEqual({ status: "error", message: "artifact unavailable" });

    await loadVerificationArtifact(options);
    expect(read).toHaveBeenCalledTimes(3);
    expect(view).toEqual({ status: "ready", value: { output: "durable evidence" } });
  });
});
