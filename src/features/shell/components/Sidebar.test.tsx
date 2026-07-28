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

const task = (
  id: string,
  updatedAt: number,
  patch: Partial<WorkbenchTask> = {},
): WorkbenchTask => ({
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
  ...patch,
});

type SidebarContent = {
  projects?: XiaoProjectSummary[];
  projectGroups?: ProjectGroup[];
  tasks?: WorkbenchTask[];
  activeTaskId?: string;
  workingTaskIds?: string[];
};

const sidebarElement = (
  attentionCount: number,
  activePage: AppPage = "tasks",
  attentionHydrationStatus: AttentionHydrationStatus = "ready",
  content: SidebarContent = {},
  canOpenProjects = false,
  onCreateProjectGroup: (name: string) => void = noop,
) => (
  <Sidebar
      activePage={activePage}
      projects={content.projects ?? []}
      projectGroups={content.projectGroups ?? []}
      activeProjectPath={workspace.path}
      tasks={content.tasks ?? []}
      activeTaskId={content.activeTaskId ?? ""}
      workspace={workspace}
      workingTaskIds={content.workingTaskIds ?? []}
      account={null}
      profile={{ name: "Xiao User", avatarDataUrl: null }}
      canOpenProjects={canOpenProjects}
      attentionCount={attentionCount}
      attentionHydrationStatus={attentionHydrationStatus}
      onOpenMenu={noop}
      onOpenAttention={noop}
      onOpenProfile={noop}
      onOpenSettings={noop}
      onOpenTasks={noop}
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
    expect(markup).toContain(">Tasks</span>");
    expect(markup).toContain('aria-label="Current project: Xiao"');
    expect(markup).toContain('aria-label="New task"');
    expect(markup).toContain(">Attention</span>");
    expect(markup).toContain(">Settings</span>");
    expect(markup).toContain(">Xiao User</strong>");
  });

  it("offers a new task action for an empty project", () => {
    const markup = renderSidebar(0, "tasks", "ready", { projects: [project] });

    expect(markup).toContain('class="sidebar app-sidebar sidebar--');
    expect(markup).toContain(">No tasks yet</strong>");
    expect(markup).toContain(">New task</span>");
  });

  it("labels project and group creation actions", () => {
    render(sidebarElement(
      0,
      "tasks",
      "ready",
      { projects: [project] },
      true,
    ));
    fireEvent.click(screen.getByRole("button", { name: "Current project: Xiao" }));

    expect(screen.getByRole("button", { name: "Create project group" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add project" })).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: "Current project: Xiao" }));
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
    render(sidebarElement(0, "tasks", "ready", {
      projects: [project],
      projectGroups: [emptyGroup],
    }));
    fireEvent.click(screen.getByRole("button", { name: "Current project: Xiao" }));

    expect(screen.getByText("Empty Group")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename Empty Group" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move Empty Group up" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move Empty Group down" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete Empty Group" })).toBeTruthy();
    expect(screen.getByText("Ungrouped")).toBeTruthy();
  });
});

describe("Sidebar Companion trigger", () => {
  it("exposes Companion as a keyboard-accessible utility page", () => {
    const markup = renderSidebar(0, "companion");

    expect(markup).toContain(">Companion</span>");
    expect(markup).toContain('aria-current="page"');
  });
});

describe("Sidebar V2 task queue", () => {
  it("keeps the active task visible as a selected work card", () => {
    const now = Date.now();
    const activeTask = task("Active task", now);
    const markup = renderSidebar(0, "tasks", "ready", {
      projects: [project],
      tasks: [activeTask, task("Recent task", now - 1)],
      activeTaskId: activeTask.id,
    });

    expect(markup).toContain("Active task");
    expect(markup).toContain("sidebar-v2-task--card");
    expect(markup).toContain("is-selected");
  });

  it("shows the full active queue without time-group disclosures", () => {
    const now = Date.now();
    const tasks = Array.from({ length: 8 }, (_, index) =>
      task(`Recent task ${index + 1}`, now - index),
    );
    const markup = renderSidebar(0, "tasks", "ready", { projects: [project], tasks });

    expect(markup).toContain("Recent task 8");
    expect(markup).not.toContain("task-group__toggle");
    expect(markup).not.toContain(">Recent</span>");
  });

  it("moves completed tasks into a collapsible slim shelf", () => {
    const now = Date.now();
    const completedTask = task("Completed task", now, { stage: "completed" });
    render(sidebarElement(0, "tasks", "ready", {
      projects: [project],
      tasks: [task("Active task", now - 1), completedTask],
      activeTaskId: completedTask.id,
    }));

    const toggle = screen.getByRole("button", { name: "Completed" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Completed task")).toBeTruthy();
    expect(screen.getByText("Completed task").closest(".sidebar-v2-task--slim")).toBeTruthy();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Completed task")).toBeNull();
  });

  it("gives running work the strongest visual status", () => {
    const running = task("Running task", Date.now(), { stage: "ready_for_review" });
    const markup = renderSidebar(0, "tasks", "ready", {
      projects: [project],
      tasks: [running],
      workingTaskIds: [running.id],
    });

    expect(markup).toContain("is-running");
    expect(markup).toContain(">Running</span>");
  });

  it("keeps clipboard failures recoverable instead of rejecting the click handler", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("clipboard denied")),
      },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });

    try {
      render(sidebarElement(0, "tasks", "ready", {
        projects: [project],
        tasks: [task("Copy target", Date.now())],
      }));
      fireEvent.contextMenu(screen.getByText("Copy target").closest("article")!);
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy working directory" }));

      expect((await screen.findByRole("alert")).textContent).toContain(
        "Could not copy to the clipboard",
      );
      expect(screen.getByRole("menu", { name: "Actions for Copy target" })).toBeTruthy();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (execCommandDescriptor) {
        Object.defineProperty(document, "execCommand", execCommandDescriptor);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }
  });
});
