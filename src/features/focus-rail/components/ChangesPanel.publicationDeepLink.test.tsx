// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicationRecord } from "../../../core/models/xiao";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";

const bridge = vi.hoisted(() => ({
  getGitBranches: vi.fn(async () => []),
  getGitWorktrees: vi.fn(async () => []),
  listXiaoTaskPublications: vi.fn(async () => [] as PublicationRecord[]),
}));

vi.mock("../../../core/bridges/tauri", () => ({
  nativeBridge: new Proxy(bridge, {
    get: (target, property: keyof typeof bridge) =>
      target[property] ?? vi.fn(async () => undefined),
  }),
}));

import { ChangesPanel, publicationForAttentionTarget } from "./ChangesPanel";

const workspace: WorkspaceSnapshot = {
  name: "Xiao",
  path: "C:/projects/xiao",
  execution: {
    projectPath: "C:/projects/xiao",
    executionRoot: "C:/projects/xiao",
    environment: {
      id: "windows",
      kind: "windows",
      label: "Windows",
      availability: "available",
    },
    workspaceMode: "local",
    managedWorktree: null,
    isolationAvailable: true,
    isolationUnavailableReason: null,
  },
  files: [],
  git: {
    branch: "feature/current",
    repositoryRoot: "C:/projects/xiao",
    workspaceScoped: true,
    added: 0,
    modified: 0,
    deleted: 0,
    untracked: 0,
    clean: true,
    changesTruncated: false,
    changes: [],
  },
};

const publication = (
  id: string,
  sourceRunId: string,
  status: PublicationRecord["status"],
  pullRequestNumber: number,
): PublicationRecord => ({
  id,
  projectPath: workspace.path,
  taskId: "task-a",
  sourceRunId,
  kind: "pull_request",
  status,
  branch: "feature/current",
  remote: null,
  url: `https://github.com/example/xiao/pull/${pullRequestNumber}`,
  pullRequestNumber,
  checkState: status === "superseded" ? "failing" : "passing",
  createdAt: pullRequestNumber,
  updatedAt: pullRequestNumber,
});

afterEach(cleanup);

describe("publication Attention deep link", () => {
  beforeEach(() => {
    bridge.getGitBranches.mockClear();
    bridge.getGitWorktrees.mockClear();
    bridge.listXiaoTaskPublications.mockReset();
  });

  it("selects and consumes the exact durable publication for an older Run", async () => {
    const current = publication("publication-current", "run-current", "active", 43);
    const superseded = publication("publication-superseded", "run-older", "superseded", 42);
    bridge.listXiaoTaskPublications.mockResolvedValue([current, superseded]);
    const onOpenRunConsumed = vi.fn();

    const rendered = render(
      <ChangesPanel
        workspace={workspace}
        taskId="task-a"
        transitioning={false}
        workspaceActionable
        reviewContext={[]}
        onStageReviewContext={() => undefined}
        onRemoveReviewContext={() => undefined}
        onOpenBrowser={() => undefined}
        onRefresh={() => undefined}
        openPublicationTarget={{
          runId: "run-older",
          sourceOccurrenceKey:
            "workspace:7:publication:publication-superseded:superseded:failing:42",
        }}
        onOpenRunConsumed={onOpenRunConsumed}
      />,
    );

    const publicationRegion = await screen.findByRole("region", {
      name: "Attention publication",
    });
    expect(publicationRegion.textContent).toContain("PR #42");
    expect(publicationRegion.textContent).toContain("Superseded");
    expect(screen.queryByText("PR #43")).toBeNull();
    await waitFor(() => {
      expect(onOpenRunConsumed).toHaveBeenCalledOnce();
      expect(onOpenRunConsumed).toHaveBeenCalledWith("run-older");
    });

    rendered.rerender(
      <ChangesPanel
        workspace={workspace}
        taskId="task-a"
        transitioning={false}
        workspaceActionable
        reviewContext={[]}
        onStageReviewContext={() => undefined}
        onRemoveReviewContext={() => undefined}
        onOpenBrowser={() => undefined}
        onRefresh={() => undefined}
        openPublicationTarget={null}
        onOpenRunConsumed={onOpenRunConsumed}
      />,
    );

    expect(screen.getByRole("region", { name: "Attention publication" }).textContent)
      .toContain("PR #42");
    expect(onOpenRunConsumed).toHaveBeenCalledOnce();

    rendered.rerender(
      <ChangesPanel
        workspace={{ ...workspace, path: "C:/projects/other" }}
        taskId="task-b"
        transitioning={false}
        workspaceActionable
        reviewContext={[]}
        onStageReviewContext={() => undefined}
        onRemoveReviewContext={() => undefined}
        onOpenBrowser={() => undefined}
        onRefresh={() => undefined}
        openPublicationTarget={null}
        onOpenRunConsumed={onOpenRunConsumed}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Attention publication" })).toBeNull();
    });
  });

  it("does not substitute another publication from the same Run", () => {
    const available = publication("publication-available", "run-older", "active", 43);

    expect(publicationForAttentionTarget([available], {
      runId: "run-older",
      sourceOccurrenceKey:
        "workspace:7:publication:publication-missing:superseded:failing:42",
    })).toBeNull();
  });
});
