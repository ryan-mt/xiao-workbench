import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceSnapshot } from "../../../core/models/workspace";

const bridge = vi.hoisted(() => ({
  mutateGit: vi.fn(),
  getGitWorktrees: vi.fn(),
  publishGitBranch: vi.fn(),
  getGitPullRequest: vi.fn(),
  createGitDraftPullRequest: vi.fn(),
  getGitPullRequestChecks: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useEffect: () => undefined,
    useMemo: <T,>(factory: () => T) => factory(),
    useState: <T,>(initial: T | (() => T)) => [
      typeof initial === "function" ? (initial as () => T)() : initial,
      vi.fn(),
    ],
  };
});

vi.mock("../../../core/bridges/tauri", () => ({
  nativeBridge: {
    mutateGit: bridge.mutateGit,
    getGitWorktrees: bridge.getGitWorktrees,
    publishGitBranch: bridge.publishGitBranch,
    getGitPullRequest: bridge.getGitPullRequest,
    createGitDraftPullRequest: bridge.createGitDraftPullRequest,
    getGitPullRequestChecks: bridge.getGitPullRequestChecks,
  },
}));

import { ChangesPanel } from "./ChangesPanel";

const workspace = (projectPath: string, taskId: string, changedPath: string): WorkspaceSnapshot => ({
  name: taskId,
  path: `${projectPath}/${taskId}`,
  execution: {
    projectPath,
    executionRoot: `${projectPath}/${taskId}`,
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
    branch: "main",
    repositoryRoot: projectPath,
    workspaceScoped: true,
    added: 0,
    modified: 1,
    deleted: 0,
    untracked: 0,
    clean: false,
    changesTruncated: false,
    changes: [{
      path: changedPath,
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "+changed",
      patchTruncated: false,
    }],
  },
});

const textContent = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  const children = (node as ReactElement<{ children?: ReactNode }>).props.children;
  return Array.isArray(children) ? children.map(textContent).join("") : textContent(children);
};

const findButton = (node: ReactNode, label: string): ReactElement<{ disabled?: boolean; onClick?: () => void }> | null => {
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const element = node as ReactElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }>;
  if (element.type === "button" && textContent(element) === label) return element;
  const children = element.props.children;
  const items = Array.isArray(children) ? children : [children];
  for (const child of items) {
    const match = findButton(child, label);
    if (match) return match;
  }
  return null;
};

describe("ChangesPanel workspace identity guard", () => {
  beforeEach(() => {
    bridge.mutateGit.mockReset().mockResolvedValue("staged");
    bridge.getGitWorktrees.mockReset().mockResolvedValue([]);
    bridge.publishGitBranch.mockReset();
    bridge.getGitPullRequest.mockReset();
    bridge.createGitDraftPullRequest.mockReset();
    bridge.getGitPullRequestChecks.mockReset();
  });

  it("does not send task B with task A paths while the loaded snapshot is stale", () => {
    const taskAWorkspace = workspace("C:/project-a", "task-a", "src/task-a.ts");
    const onRefresh = vi.fn();
    const panel = ChangesPanel({
      workspace: taskAWorkspace,
      taskId: "task-b",
      transitioning: false,
      workspaceActionable: false,
      onRefresh,
    });
    const stage = findButton(panel, "Stage");
    const refresh = findButton(panel, "");

    expect(stage?.props.disabled).toBe(true);
    stage?.props.onClick?.();
    refresh?.props.onClick?.();
    expect(bridge.mutateGit).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("re-enables mutations with task B data after its snapshot resolves", async () => {
    const taskBWorkspace = workspace("C:/project-a", "task-b", "src/task-b.ts");
    const onRefresh = vi.fn();
    const panel = ChangesPanel({
      workspace: taskBWorkspace,
      taskId: "task-b",
      transitioning: false,
      workspaceActionable: true,
      onRefresh,
    });
    const stage = findButton(panel, "Stage");

    expect(stage?.props.disabled).toBe(false);
    stage?.props.onClick?.();
    await vi.waitFor(() => {
      expect(bridge.mutateGit).toHaveBeenCalledWith(
        "C:/project-a/task-b",
        "task-b",
        "stage",
        ["src/task-b.ts"],
        undefined,
      );
    });
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("keeps Ship draft PR disabled until a commit message is present", () => {
    const panel = ChangesPanel({
      workspace: workspace("C:/project-a", "task-b", "src/task-b.ts"),
      taskId: "task-b",
      transitioning: false,
      workspaceActionable: true,
      onRefresh: vi.fn(),
    });

    expect(findButton(panel, "Ship draft PR")?.props.disabled).toBe(true);
  });
});
