// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { ProjectGroup, XiaoProjectSummary } from "../../../core/models/xiao";
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
  projectGroups?: ProjectGroup[];
  tasks?: WorkbenchTask[];
  activeTaskId?: string;
  activeProjectPath?: string;
};

const sidebarElement = (
  attentionCount: number,
  activePage: AppPage = "tasks",
  attentionHydrationStatus: AttentionHydrationStatus = "ready",
  content: SidebarContent = {},
  canOpenProjects = false,
  onCreateProjectGroup: (name: string) => void = noop,
  onOpenTasks: () => void = noop,
) => (
  <Sidebar
      activePage={activePage}
      projects={content.projects ?? []}
      projectGroups={content.projectGroups ?? []}
      activeProjectPath={content.activeProjectPath ?? workspace.path}
      tasks={content.tasks ?? []}
      activeTaskId={content.activeTaskId ?? ""}
      workspace={workspace}
      workingTaskIds={[]}
      account={null}
      profile={{ name: "Xiao User", avatarDataUrl: null }}
      canOpenProjects={canOpenProjects}
      attentionCount={attentionCount}
      attentionHydrationStatus={attentionHydrationStatus}
      onOpenMenu={noop}
      onOpenAttention={noop}
      onOpenProfile={noop}
      onOpenSettings={noop}
      onOpenTasks={onOpenTasks}
      onAddProject={noop}
      onCreateProjectGroup={onCreateProjectGroup}
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
  />
);

const renderSidebar = (
  attentionCount: number,
  activePage: AppPage = "tasks",
  attentionHydrationStatus: AttentionHydrationStatus = "ready",
  content: SidebarContent = {},
  canOpenProjects = false,
) => renderToStaticMarkup(
  sidebarElement(attentionCount, activePage, attentionHydrationStatus, content, canOpenProjects),
);

afterEach(cleanup);

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

  it("keeps production branding free of non-production stage styling", () => {
    const markup = renderSidebar(0);

    expect(markup).toContain('class="sidebar__brand"');
    expect(markup).not.toContain('class="sidebar__brand is-on-stage"');
  });

  it("offers a new task action for an empty project", () => {
    const markup = renderSidebar(0, "tasks", "ready", { projects: [project] });

    expect(markup).toContain('class="sidebar app-sidebar"');
    expect(markup).toContain(">No tasks yet</span>");
    expect(markup).toContain(">New task</span>");
  });

  it("returns to Tasks when the active project is clicked", () => {
    const onOpenTasks = vi.fn();
    render(sidebarElement(
      0,
      "settings",
      "ready",
      { projects: [project] },
      false,
      noop,
      onOpenTasks,
    ));

    const projectButton = document.querySelector<HTMLButtonElement>(".sidebar-project__select");
    expect(projectButton).not.toBeNull();
    fireEvent.click(projectButton!);
    expect(onOpenTasks).toHaveBeenCalledOnce();
  });

  it("expands the containing project when the active workspace is nested beneath it", () => {
    const nestedTask = task("Nested workspace task", Date.now());
    render(sidebarElement(0, "tasks", "ready", {
      projects: [project],
      tasks: [nestedTask],
      activeTaskId: nestedTask.id,
      activeProjectPath: `${project.path}/.xiao/worktrees/pr-12`,
    }));

    const projectButton = document.querySelector<HTMLButtonElement>(".sidebar-project__select");
    expect(projectButton?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: nestedTask.title })).not.toBeNull();

    fireEvent.click(projectButton!);
    expect(projectButton?.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: nestedTask.title })).toBeNull();
  });

  it("labels project and group creation actions", () => {
    const markup = renderSidebar(0, "tasks", "ready", { projects: [project] }, true);

    expect(markup).toContain('aria-label="Create project group"');
    expect(markup).toContain(">Group</span>");
    expect(markup).toContain('aria-label="Add project"');
    expect(markup).toContain(">Add</span>");
  });

  it("creates project groups through an in-app dialog", () => {
    const onCreateProjectGroup = vi.fn();
    render(sidebarElement(
      0,
      "tasks",
      "ready",
      { projects: [project] },
      true,
      onCreateProjectGroup,
    ));

    fireEvent.click(screen.getByRole("button", { name: "Create project group" }));
    const dialog = screen.getByRole("dialog", { name: "New project group" });
    fireEvent.change(screen.getByLabelText("Group name"), { target: { value: "Client work" } });
    fireEvent.click(screen.getByRole("button", { name: "Create group" }));

    expect(onCreateProjectGroup).toHaveBeenCalledWith("Client work");
    expect(dialog.isConnected).toBe(false);
  });

  it("keeps empty project groups visible and manageable", () => {
    const emptyGroup: ProjectGroup = {
      id: "empty",
      name: "Empty Group",
      position: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const markup = renderSidebar(0, "tasks", "ready", {
      projects: [project],
      projectGroups: [emptyGroup],
    });

    expect(markup).toContain(">Empty Group</span>");
    expect(markup).toContain('aria-label="Rename Empty Group"');
    expect(markup).toContain('aria-label="Move Empty Group up"');
    expect(markup).toContain('aria-label="Move Empty Group down"');
    expect(markup).toContain('aria-label="Delete Empty Group"');
    expect(markup).toContain(">Ungrouped</span>");
  });
});

describe("Sidebar Companion trigger", () => {
  it("exposes Companion as a keyboard-accessible utility page", () => {
    const markup = renderSidebar(0, "companion");

    expect(markup).toContain(">Companion</span>");
    expect(markup).toContain('aria-current="page"');
  });
});

describe("Sidebar task group disclosure", () => {
  it("keeps task order stable when activity timestamps change", () => {
    const now = Date.now();
    const olderTask = { ...task("Created first", now), createdAt: now - 2_000 };
    const newerTask = {
      ...task("Created second", now - 1_000),
      createdAt: now - 1_000,
      updatedAt: now - 2_000,
    };
    const markup = renderSidebar(0, "tasks", "ready", {
      projects: [project],
      tasks: [olderTask, newerTask],
    });

    expect(markup.indexOf("Created second")).toBeLessThan(markup.indexOf("Created first"));
  });

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
