import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { XiaoProjectSummary } from "../../../core/models/xiao";
import type { AttentionHydrationStatus } from "../../agent/hooks/useAgentRuntime";
import type { WorkbenchTask } from "../../task/task.types";
import type { AppPage } from "../shell.types";
import { Sidebar, sidebarAttentionTriggerId } from "./Sidebar";

const workspace: WorkspaceSnapshot = {
  name: "Xiao",
  path: "C:/workspace/xiao",
  execution: {
    projectPath: "C:/workspace/xiao",
    executionRoot: "C:/workspace/xiao",
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
  git: null,
};

const noop = () => undefined;

const project: XiaoProjectSummary = {
  name: workspace.name,
  path: workspace.path,
  updatedAt: Date.now(),
};

const task = (id: string, updatedAt: number): WorkbenchTask => ({
  id,
  title: id,
  meta: "Now",
  group: "Recent",
  archived: false,
  pinned: false,
  unread: false,
  createdAt: updatedAt,
  updatedAt,
  stage: "draft",
  stageVersion: 0,
  codexProfileId: null,
  workbenchState: {},
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
});

type SidebarContent = {
  projects?: XiaoProjectSummary[];
  tasks?: WorkbenchTask[];
  activeTaskId?: string;
};

const renderSidebar = (
  attentionCount: number,
  activePage: AppPage = "tasks",
  attentionHydrationStatus: AttentionHydrationStatus = "ready",
  content: SidebarContent = {},
) =>
  renderToStaticMarkup(
    <Sidebar
      activePage={activePage}
      projects={content.projects ?? []}
      activeProjectPath={workspace.path}
      tasks={content.tasks ?? []}
      activeTaskId={content.activeTaskId ?? ""}
      workspace={workspace}
      workingTaskIds={[]}
      account={null}
      profile={{ name: "Xiao User", avatarDataUrl: null }}
      canOpenProjects={false}
      attentionCount={attentionCount}
      attentionHydrationStatus={attentionHydrationStatus}
      onOpenMenu={noop}
      onOpenAttention={noop}
      onOpenProfile={noop}
      onOpenSettings={noop}
      onOpenTasks={noop}
      onAddProject={noop}
      onNewTask={noop}
      onSelectProject={noop}
      onSelectTask={noop}
      onToggleTaskPinned={noop}
      onSetTaskArchived={noop}
      onRenameTask={noop}
      onMarkTaskUnread={noop}
      onContinueInNewTask={noop}
      onToggleProjectPinned={noop}
      onOpenProject={noop}
      onRenameProject={noop}
      onArchiveProjectTasks={noop}
      onRemoveProject={noop}
    />,
  );

describe("Sidebar attention trigger", () => {
  it("keeps a labeled trigger without a zero badge", () => {
    const markup = renderSidebar(0);

    expect(markup).toContain(`id="${sidebarAttentionTriggerId}"`);
    expect(markup).toContain('aria-label="Attention, 0 items"');
    expect(markup).not.toContain("sidebar__attention-badge");
  });

  it("labels a loading count as available without showing a zero badge", () => {
    const markup = renderSidebar(0, "tasks", "loading");

    expect(markup).toContain('aria-label="Attention, loading, 0 available"');
    expect(markup).not.toContain("sidebar__attention-badge");
  });

  it("labels a partial positive count as available while retaining its badge", () => {
    const markup = renderSidebar(7, "tasks", "partial");

    expect(markup).toContain('aria-label="Attention, partial, 7 available"');
    expect(markup).toContain('class="sidebar__attention-badge"');
    expect(markup).toContain(">7</span>");
  });

  it("shows a normal positive count with a full accessible label", () => {
    const markup = renderSidebar(7);

    expect(markup).toContain('aria-label="Attention, 7 items"');
    expect(markup).toContain('class="sidebar__attention-badge"');
    expect(markup).toContain(">7</span>");
  });

  it("uses singular accessible wording", () => {
    expect(renderSidebar(1)).toContain('aria-label="Attention, 1 item"');
  });

  it("bounds large visual badges while preserving the full accessible count", () => {
    const markup = renderSidebar(120);

    expect(markup).toContain('aria-label="Attention, 120 items"');
    expect(markup).toContain(">99+</span>");
  });

  it("marks the attention page active and current", () => {
    const markup = renderSidebar(4, "attention");

    expect(markup).toMatch(
      /id="sidebar-attention-trigger"[^>]*class="sidebar__footer-action sidebar__utility-attention is-active"[^>]*aria-current="page"/,
    );
  });

  it("renders a content-first workspace index without the old task rail", () => {
    const markup = renderSidebar(0);

    expect(markup).not.toContain('class="sidebar__rail"');
    expect(markup).not.toContain('class="sidebar__new-task"');
    expect(markup).toContain(">Find anything</span>");
    expect(markup).toContain(">Projects</span>");
    expect(markup).not.toContain(">Tasks</span>");
    expect(markup).toContain(">Attention</span>");
    expect(markup).toContain(">Settings</span>");
    expect(markup).toContain(">Xiao User</strong>");
  });

  it("offers a new task action for an empty project", () => {
    const markup = renderSidebar(0, "tasks", "ready", { projects: [project] });

    expect(markup).toContain('class="sidebar app-sidebar"');
    expect(markup).toContain(">No tasks yet</span>");
    expect(markup).toContain(">New task</span>");
  });
});

describe("Sidebar task group disclosure", () => {
  it("keeps the active task in its recent time group", () => {
    const now = Date.now();
    const activeTask = task("Active task", now);
    const markup = renderSidebar(0, "tasks", "ready", {
      projects: [project],
      tasks: [activeTask, task("Recent task", now - 1)],
      activeTaskId: activeTask.id,
    });

    expect(markup).not.toContain(">Active</span>");
    expect(markup).toContain(">Recent</span><small>2</small>");
    expect(markup).toContain('class="task-list__item is-selected"');
  });

  it("shows all tasks without a disclosure at the six-task limit", () => {
    const now = Date.now();
    const tasks = Array.from({ length: 6 }, (_, index) =>
      task(`Recent task ${index + 1}`, now - index),
    );
    const markup = renderSidebar(0, "tasks", "ready", { projects: [project], tasks });

    expect(markup).toContain("Recent task 6");
    expect(markup).not.toContain("task-group__toggle");
  });

  it("collapses task groups after six tasks and reports the hidden count", () => {
    const now = Date.now();
    const tasks = Array.from({ length: 8 }, (_, index) =>
      task(`Recent task ${index + 1}`, now - index),
    );
    const markup = renderSidebar(0, "tasks", "ready", { projects: [project], tasks });

    expect(markup).toContain("Recent task 6");
    expect(markup).not.toContain("Recent task 7");
    expect(markup).not.toContain("Recent task 8");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(">Show more</span><small>+2</small>");
  });

  it("keeps an active task visible when it falls beyond a collapsed group's limit", () => {
    const now = Date.now();
    const tasks = Array.from({ length: 7 }, (_, index) =>
      task(`Recent task ${index + 1}`, now - index),
    );
    const activeTask = tasks[6]!;
    const markup = renderSidebar(0, "tasks", "ready", {
      projects: [project],
      tasks,
      activeTaskId: activeTask.id,
    });

    expect(markup).toContain(activeTask.title);
    expect(markup).toContain('class="task-list__item is-selected"');
    expect(markup).toContain(">Show more</span><small>+1</small>");
  });
});
