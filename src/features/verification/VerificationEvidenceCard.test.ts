import { describe, expect, it, vi } from "vitest";

import type { RunSnapshot } from "../../core/models/run";
import {
  canRerunVerification,
  createVerificationActionScope,
  loadVerificationArtifact,
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
