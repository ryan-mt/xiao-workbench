import { describe, expect, it, vi } from "vitest";

import type {
  GitCheckSummary,
  GitPullRequestSummary,
  GitPushResult,
} from "../../../core/models/workspace";
import {
  executeShipFlow,
  initialShipSteps,
  summarizeShipChecks,
  updateShipStep,
  type ShipStepId,
  type ShipStepStatus,
} from "./shipFlow";

const push: GitPushResult = {
  branch: "feature/ship-flow",
  remote: "origin",
  upstream: "origin/feature/ship-flow",
  output: "pushed",
};

const pullRequest: GitPullRequestSummary = {
  number: 42,
  url: "https://github.com/example/xiao/pull/42",
  title: "Ship flow",
  isDraft: true,
  state: "OPEN",
  baseRefName: "dev",
  headRefName: "feature/ship-flow",
};

const check = (bucket: string, name = bucket): GitCheckSummary => ({
  name,
  state: bucket.toUpperCase(),
  bucket,
  link: "https://github.com/example/xiao/actions",
  workflow: "CI",
});

describe("ship flow", () => {
  it("commits, pushes, creates a draft PR, then reads CI in order", async () => {
    const order: string[] = [];
    const steps: Array<[ShipStepId, ShipStepStatus, string | undefined]> = [];
    const operations = {
      commit: vi.fn(async () => { order.push("commit"); return "committed"; }),
      push: vi.fn(async () => { order.push("push"); return push; }),
      findPullRequest: vi.fn(async () => { order.push("find-pr"); return null; }),
      createDraftPullRequest: vi.fn(async () => { order.push("create-pr"); return pullRequest; }),
      readChecks: vi.fn(async () => { order.push("checks"); return [check("pending")]; }),
    };

    const result = await executeShipFlow(operations, {
      onStep: (id, status, detail) => steps.push([id, status, detail]),
    });

    expect(order).toEqual(["commit", "push", "find-pr", "create-pr", "checks"]);
    expect(result.pullRequest).toEqual(pullRequest);
    expect(steps.at(-1)).toEqual(["ci", "pending", "1 check is running"]);
  });

  it("reuses an existing pull request instead of creating another", async () => {
    const createDraftPullRequest = vi.fn(async () => pullRequest);

    await executeShipFlow({
      commit: async () => "committed",
      push: async () => push,
      findPullRequest: async () => pullRequest,
      createDraftPullRequest,
      readChecks: async () => [check("pass")],
    }, { onStep: vi.fn() });

    expect(createDraftPullRequest).not.toHaveBeenCalled();
  });

  it("resumes at push when the commit was already created", async () => {
    const commit = vi.fn(async () => "unexpected commit");

    await executeShipFlow({
      commit,
      push: async () => push,
      findPullRequest: async () => pullRequest,
      createDraftPullRequest: async () => pullRequest,
      readChecks: async () => [check("pass")],
    }, { onStep: vi.fn() }, { commitOutput: "existing commit" });

    expect(commit).not.toHaveBeenCalled();
  });

  it("stops at the failing step and preserves the failure detail", async () => {
    const steps: Array<[ShipStepId, ShipStepStatus, string | undefined]> = [];
    const findPullRequest = vi.fn(async () => pullRequest);

    await expect(executeShipFlow({
      commit: async () => "committed",
      push: async () => { throw new Error("No origin remote is configured."); },
      findPullRequest,
      createDraftPullRequest: async () => pullRequest,
      readChecks: async () => [],
    }, {
      onStep: (id, status, detail) => steps.push([id, status, detail]),
    })).rejects.toThrow("No origin remote");

    expect(findPullRequest).not.toHaveBeenCalled();
    expect(steps.at(-1)).toEqual(["push", "error", "No origin remote is configured."]);
  });
});

describe("ship CI presentation", () => {
  it("distinguishes empty, pending, failed, and passing checks", () => {
    expect(summarizeShipChecks([])).toEqual({ status: "pending", detail: "No checks reported yet" });
    expect(summarizeShipChecks([check("pending")]).status).toBe("pending");
    expect(summarizeShipChecks([check("pass"), check("fail")])).toEqual({
      status: "warning",
      detail: "1 check needs attention",
    });
    expect(summarizeShipChecks([check("pass"), check("skipping")])).toEqual({
      status: "complete",
      detail: "2 checks passed",
    });
  });

  it("updates one step without disturbing the others", () => {
    const steps = updateShipStep(initialShipSteps(), "push", "running", "Publishing");

    expect(steps.find((step) => step.id === "push")).toMatchObject({
      status: "running",
      detail: "Publishing",
    });
    expect(steps.find((step) => step.id === "commit")?.status).toBe("idle");
  });
});
