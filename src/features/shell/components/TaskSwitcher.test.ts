import { describe, expect, it } from "vitest";

import type { WorkbenchTask } from "../../task/task.types";
import { orderTaskSwitcherTasks } from "./TaskSwitcher";

const task = (id: string, patch: Partial<WorkbenchTask> = {}): WorkbenchTask => ({
  id,
  title: id,
  meta: "Now",
  group: "Recent",
  archived: false,
  pinned: false,
  unread: false,
  createdAt: 1,
  updatedAt: 1,
  draftText: "",
  followUps: [],
  model: null,
  reasoningEffort: null,
  threadId: null,
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
  timelineEntryCount: 0,
  plan: null,
  executionEnvironmentId: null,
  workspaceMode: "local",
  managedWorktreeId: null,
  ...patch,
});

describe("task switcher ordering", () => {
  it("prioritizes running, pinned, unread, then recent tasks", () => {
    const ordered = orderTaskSwitcherTasks([
      task("recent", { updatedAt: 50 }),
      task("unread", { unread: true, updatedAt: 10 }),
      task("pinned", { pinned: true, updatedAt: 5 }),
      task("running", { updatedAt: 1 }),
      task("archived", { archived: true, updatedAt: 100 }),
    ], ["running"]);

    expect(ordered.map((item) => item.id)).toEqual([
      "running",
      "pinned",
      "unread",
      "recent",
    ]);
  });
});
