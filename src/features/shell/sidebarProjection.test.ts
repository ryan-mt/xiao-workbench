import { describe, expect, it } from "vitest";

import type { WorkbenchTask } from "../task/task.types";
import {
  activeSidebarProject,
  projectSidebarTasks,
  sidebarTaskPresentation,
} from "./sidebarProjection";

const task = (
  id: string,
  stage: WorkbenchTask["stage"],
  updatedAt: number,
  patch: Partial<WorkbenchTask> = {},
): WorkbenchTask => ({
  id,
  title: id,
  meta: "",
  group: "Recent",
  archived: false,
  pinned: false,
  unread: false,
  createdAt: updatedAt,
  updatedAt,
  stage,
  stageVersion: 0,
  codexProfileId: null,
  workbenchState: {},
  draftText: "",
  followUps: [],
  model: null,
  reasoningEffort: null,
  threadId: stage === "draft" ? null : `thread-${id}`,
  threadBinding: null,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  goal: null,
  acceptanceContract: null,
  timeline: [],
  timelineLoaded: true,
  timelineComplete: true,
  timelineStart: 0,
  timelineEntryCount: stage === "draft" ? 0 : 1,
  plan: null,
  executionEnvironmentId: null,
  workspaceMode: "local",
  managedWorktreeId: null,
  ...patch,
});

describe("projectSidebarTasks", () => {
  it("keeps active work task-first and moves completed work to the slim shelf", () => {
    const result = projectSidebarTasks([
      task("draft", "draft", 50),
      task("completed", "completed", 100),
      task("review", "ready_for_review", 30),
      task("running", "in_progress", 10),
    ], ["running"]);

    expect(result.active.map((item) => item.id)).toEqual(["running", "review", "draft"]);
    expect(result.completed.map((item) => item.id)).toEqual(["completed"]);
  });

  it("keeps pinned work ahead of recency within the same status", () => {
    const result = projectSidebarTasks([
      task("newer", "in_progress", 100),
      task("pinned", "in_progress", 10, { pinned: true }),
    ], []);

    expect(result.active.map((item) => item.id)).toEqual(["pinned", "newer"]);
  });

  it("excludes archived work from both shelves", () => {
    const result = projectSidebarTasks([
      task("archived", "completed", 100, { archived: true }),
    ], []);

    expect(result).toEqual({ active: [], completed: [] });
  });
});

describe("activeSidebarProject", () => {
  it("chooses the exact or most-specific project for a nested workspace", () => {
    const parent = { name: "Parent", path: "C:/work", updatedAt: 1 };
    const nested = { name: "Nested", path: "C:/work/nested", updatedAt: 1 };

    expect(activeSidebarProject([parent, nested], nested.path)).toBe(nested);
    expect(activeSidebarProject(
      [parent, nested],
      "C:/work/nested/.xiao/worktrees/review",
    )).toBe(nested);
  });
});

describe("sidebarTaskPresentation", () => {
  it("lets live execution outrank the durable Task stage", () => {
    expect(sidebarTaskPresentation(task("review", "ready_for_review", 1), true))
      .toEqual({ status: "Running", tone: "running" });
  });

  it.each([
    ["draft", "Draft", "draft"],
    ["in_progress", "In progress", "progress"],
    ["ready_for_review", "Ready for review", "review"],
    ["published", "Published", "published"],
    ["completed", "Completed", "completed"],
  ] as const)("maps %s to a Xiao-native status", (stage, status, tone) => {
    expect(sidebarTaskPresentation(task(stage, stage, 1), false))
      .toEqual({ status, tone });
  });
});
