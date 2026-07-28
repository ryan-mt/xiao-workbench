import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { APP_DISPLAY_NAME, APP_STAGE } from "../../../core/branding";
import type { AgentAccountSummary } from "../../../core/models/agent";
import type { AttentionHydrationStatus } from "../../agent/hooks/useAgentRuntime";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { ProjectGroup, XiaoProjectSummary } from "../../../core/models/xiao";
import { profileInitials, type LocalUserProfile } from "../../profile/hooks/useLocalProfile";
import type { WorkbenchTask } from "../../task/task.types";
import { projectSidebarTasks, sidebarTaskPresentation } from "../sidebarProjection";
import type { AppPage } from "../shell.types";
import { SidebarStageBackdrop } from "./SidebarStageBackdrop";

type SidebarProps = {
  activePage: AppPage;
  projects: XiaoProjectSummary[];
  hiddenProjects?: XiaoProjectSummary[];
  projectGroups?: ProjectGroup[];
  activeProjectPath: string;
  tasks: WorkbenchTask[];
  activeTaskId: string;
  workspace: WorkspaceSnapshot;
  workingTaskIds: string[];
  account: AgentAccountSummary | null;
  profile: LocalUserProfile;
  canOpenProjects: boolean;
  attentionCount: number;
  attentionHydrationStatus: AttentionHydrationStatus;
  onOpenMenu: () => void;
  onOpenAttention: () => void;
  onOpenCompanion?: () => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenTasks: () => void;
  onAddProject: () => void;
  onCreateProjectGroup?: (name: string) => void;
  onMoveProjectToGroup?: (path: string, groupId: string | null) => void;
  onRenameProjectGroup?: (group: ProjectGroup) => void;
  onMoveProjectGroup?: (group: ProjectGroup, direction: -1 | 1) => void;
  onDeleteProjectGroup?: (group: ProjectGroup) => void;
  onRestoreProject?: (project: XiaoProjectSummary) => void;
  onNewTask: () => void;
  onSelectProject: (path: string) => void;
  onSelectTask: (taskId: string) => void;
  onToggleTaskPinned: (taskId: string) => void;
  onSetTaskArchived: (taskId: string, archived: boolean) => void;
  onRenameTask: (taskId: string, title: string) => void;
  onMarkTaskUnread: (taskId: string, unread: boolean) => void;
  onContinueInNewTask: (taskId: string) => void;
  onToggleProjectPinned: (path: string) => void;
  onOpenProject: (path: string) => void;
  onRenameProject: (path: string, name: string) => void;
  onArchiveProjectTasks: (path: string) => void;
  onRemoveProject: (path: string) => void;
};

type ProjectMenuState = {
  projectPath: string;
  top: number;
  left: number;
  focusFirst: boolean;
};

type RenamingProject = {
  path: string;
  name: string;
};

type TaskMenuState = {
  taskId: string;
  top: number;
  left: number;
  focusFirst: boolean;
};

type RenamingTask = {
  id: string;
  title: string;
};

type ProjectNavigationItem =
  | { kind: "group"; group: ProjectGroup | null }
  | { kind: "project"; project: XiaoProjectSummary };

export const sidebarAttentionTriggerId = "sidebar-attention-trigger";

const projectMenuWidth = 218;
const projectMenuHeight = 214;
const taskMenuHeight = 376;
const sidebarDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

const relativeTime = (timestamp: number, now: number) => {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 172_800_000) return "yesterday";
  return sidebarDateFormatter.format(new Date(timestamp));
};

const stageLabel = APP_STAGE === "production"
  ? null
  : APP_STAGE === "release"
    ? "Release"
    : APP_STAGE === "beta"
      ? "Beta"
      : "Dev";

export function Sidebar({
  activePage,
  projects,
  hiddenProjects = [],
  projectGroups = [],
  activeProjectPath,
  tasks,
  activeTaskId,
  workspace,
  workingTaskIds,
  account,
  profile,
  canOpenProjects,
  attentionCount,
  attentionHydrationStatus,
  onOpenMenu,
  onOpenAttention,
  onOpenCompanion = () => {},
  onOpenProfile,
  onOpenSettings,
  onOpenTasks,
  onAddProject,
  onCreateProjectGroup = () => {},
  onMoveProjectToGroup = () => {},
  onRenameProjectGroup = () => {},
  onMoveProjectGroup = () => {},
  onDeleteProjectGroup = () => {},
  onRestoreProject = () => {},
  onNewTask,
  onSelectProject,
  onSelectTask,
  onToggleTaskPinned,
  onSetTaskArchived,
  onRenameTask,
  onMarkTaskUnread,
  onContinueInNewTask,
  onToggleProjectPinned,
  onOpenProject,
  onRenameProject,
  onArchiveProjectTasks,
  onRemoveProject,
}: SidebarProps) {
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [completedShelfExpanded, setCompletedShelfExpanded] = useState(true);
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null);
  const [renamingProject, setRenamingProject] = useState<RenamingProject | null>(null);
  const [projectGroupDialogOpen, setProjectGroupDialogOpen] = useState(false);
  const [projectGroupName, setProjectGroupName] = useState("");
  const [taskMenu, setTaskMenu] = useState<TaskMenuState | null>(null);
  const [renamingTask, setRenamingTask] = useState<RenamingTask | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const projectPickerRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuTriggerRef = useRef<HTMLElement | null>(null);
  const taskMenuRef = useRef<HTMLDivElement>(null);
  const taskMenuTriggerRef = useRef<HTMLElement | null>(null);
  const { active: activeTasks, completed: completedTasks } = projectSidebarTasks(
    tasks,
    workingTaskIds,
  );
  const visibleTasks = [...activeTasks, ...completedTasks];
  const menuProject = projects.find((project) => project.path === projectMenu?.projectPath);
  const projectGroupPositions = new Map(projectGroups.map((group) => [group.id, group.position]));
  const navigationProjects = [...projects].sort((left, right) => {
    const leftGroup = left.projectGroupId ?? null;
    const rightGroup = right.projectGroupId ?? null;
    if (leftGroup !== rightGroup) {
      if (leftGroup === null) return 1;
      if (rightGroup === null) return -1;
      return (projectGroupPositions.get(leftGroup) ?? Number.MAX_SAFE_INTEGER) -
        (projectGroupPositions.get(rightGroup) ?? Number.MAX_SAFE_INTEGER);
    }
    return (left.projectGroupPosition ?? 0) - (right.projectGroupPosition ?? 0) ||
      Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
      right.updatedAt - left.updatedAt;
  });
  const navigationItems: ProjectNavigationItem[] = [...projectGroups]
    .sort((left, right) => left.position - right.position)
    .flatMap((group) => [
      { kind: "group" as const, group },
      ...navigationProjects
        .filter((project) => project.projectGroupId === group.id)
        .map((project) => ({ kind: "project" as const, project })),
    ]);
  const ungroupedProjects = navigationProjects.filter(
    (project) => !project.projectGroupId || !projectGroupPositions.has(project.projectGroupId),
  );
  if (ungroupedProjects.length) {
    navigationItems.push(
      { kind: "group", group: null },
      ...ungroupedProjects.map((project) => ({ kind: "project" as const, project })),
    );
  }
  const activeProject = projects.find((project) => project.path === activeProjectPath) ?? null;
  const menuTask = tasks.find((task) => task.id === taskMenu?.taskId);
  const workingTasks = new Set(workingTaskIds);
  const projectSwitchLocked = workingTasks.size > 0;
  const initials = profileInitials(profile.name);
  const attentionLabel = attentionHydrationStatus === "ready"
    ? `Attention, ${attentionCount} ${attentionCount === 1 ? "item" : "items"}`
    : `Attention, ${attentionHydrationStatus}, ${attentionCount} available`;

  const closeProjectMenu = (restoreFocus = false) => {
    const trigger = projectMenuTriggerRef.current;
    projectMenuTriggerRef.current = null;
    setProjectMenu(null);
    if (restoreFocus) window.requestAnimationFrame(() => trigger?.focus());
  };

  const closeTaskMenu = (restoreFocus = false) => {
    const trigger = taskMenuTriggerRef.current;
    taskMenuTriggerRef.current = null;
    setTaskMenu(null);
    setCopyError(null);
    if (restoreFocus) window.requestAnimationFrame(() => trigger?.focus());
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    if (!items.length) return;

    event.preventDefault();
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowUp"
            ? activeIndex <= 0
              ? items.length - 1
              : activeIndex - 1
            : activeIndex >= items.length - 1
              ? 0
              : activeIndex + 1;
    items[nextIndex]?.focus();
  };

  const toggleProjectMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    projectPath: string,
  ) => {
    closeTaskMenu();
    const trigger = event.currentTarget;
    const bounds = trigger.getBoundingClientRect();
    const below = bounds.bottom + 6;
    const top =
      below + projectMenuHeight <= window.innerHeight
        ? below
        : Math.max(8, bounds.top - projectMenuHeight - 6);
    const left = Math.max(
      8,
      Math.min(bounds.right - 46, window.innerWidth - projectMenuWidth - 8),
    );

    if (projectMenu?.projectPath === projectPath) {
      closeProjectMenu();
      return;
    }
    projectMenuTriggerRef.current = trigger;
    setProjectMenu({ projectPath, top, left, focusFirst: event.detail === 0 });
  };

  const openProjectContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    projectPath: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    closeTaskMenu();
    projectMenuTriggerRef.current = event.currentTarget;
    setProjectMenu({
      projectPath,
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - projectMenuHeight - 8)),
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - projectMenuWidth - 8)),
      focusFirst: false,
    });
  };

  const openTaskContextMenu = (event: ReactMouseEvent<HTMLElement>, taskId: string) => {
    event.preventDefault();
    event.stopPropagation();
    closeProjectMenu();
    setCopyError(null);
    taskMenuTriggerRef.current = event.currentTarget;
    setTaskMenu({
      taskId,
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - taskMenuHeight - 8)),
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - projectMenuWidth - 8)),
      focusFirst: false,
    });
  };

  const toggleTaskMenu = (event: ReactMouseEvent<HTMLButtonElement>, taskId: string) => {
    closeProjectMenu();
    if (taskMenu?.taskId === taskId) {
      closeTaskMenu();
      return;
    }

    const trigger = event.currentTarget;
    setCopyError(null);
    const bounds = trigger.getBoundingClientRect();
    const below = bounds.bottom + 6;
    const top =
      below + taskMenuHeight <= window.innerHeight
        ? below
        : Math.max(8, bounds.top - taskMenuHeight - 6);
    const left = Math.max(
      8,
      Math.min(bounds.right - 46, window.innerWidth - projectMenuWidth - 8),
    );
    taskMenuTriggerRef.current = trigger;
    setTaskMenu({ taskId, top, left, focusFirst: event.detail === 0 });
  };

  const commitTaskRename = () => {
    if (!renamingTask) return;
    const title = renamingTask.title.trim();
    if (title) onRenameTask(renamingTask.id, title);
    setRenamingTask(null);
  };

  const copyText = async (value: string) => {
    setCopyError(null);
    try {
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
          copied = true;
        } catch {
          // Fall back for WebViews where Clipboard API permission is unavailable.
        }
      }
      if (!copied) {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        try {
          textarea.select();
          copied = document.execCommand("copy");
        } finally {
          textarea.remove();
        }
      }
      if (!copied) throw new Error("Clipboard write failed");
      closeTaskMenu();
    } catch {
      setCopyError("Could not copy to the clipboard. Check Xiao's clipboard permission and retry.");
    }
  };

  const beginProjectRename = (project: XiaoProjectSummary) => {
    closeProjectMenu();
    setRenamingProject({ path: project.path, name: project.name });
  };

  const commitProjectRename = () => {
    if (!renamingProject) return;
    const name = renamingProject.name.trim();
    if (name) onRenameProject(renamingProject.path, name);
    setRenamingProject(null);
  };

  useEffect(() => {
    setProjectPickerOpen(false);
    setCompletedShelfExpanded(true);
  }, [activeProjectPath]);

  useEffect(() => {
    if (!projectPickerOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        projectPickerRef.current?.contains(target) ||
        projectMenuRef.current?.contains(target)
      ) {
        return;
      }
      setProjectPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [projectPickerOpen]);

  useEffect(() => {
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      setNow(Date.now());
      interval = window.setInterval(() => setNow(Date.now()), 60_000);
    }, 60_000 - (Date.now() % 60_000));
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!projectMenu) return;

    const focusFrame = projectMenu.focusFirst
      ? window.requestAnimationFrame(() => {
          projectMenuRef.current
            ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
            ?.focus({ preventScroll: true });
        })
      : null;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        projectMenuRef.current?.contains(target) ||
        projectMenuTriggerRef.current?.contains(target)
      ) {
        return;
      }
      closeProjectMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const trigger = projectMenuTriggerRef.current;
      closeProjectMenu();
      trigger?.focus();
    };
    const closeOnViewportChange = () => closeProjectMenu();

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    document.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      document.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [projectMenu]);

  useEffect(() => {
    if (!taskMenu) return;
    const focusFrame = taskMenu.focusFirst
      ? window.requestAnimationFrame(() => {
          taskMenuRef.current
            ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
            ?.focus({ preventScroll: true });
        })
      : null;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (taskMenuRef.current?.contains(target) || taskMenuTriggerRef.current?.contains(target)) {
        return;
      }
      closeTaskMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTaskMenu(true);
    };
    const closeOnViewportChange = () => closeTaskMenu();
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    document.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      document.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [taskMenu]);

  const renderTaskRow = (task: WorkbenchTask, variant: "card" | "slim") => {
    const selected = activePage === "tasks" && task.id === activeTaskId;
    const taskRunning = workingTasks.has(task.id);
    const taskMenuOpen = taskMenu?.taskId === task.id;
    const presentation = sidebarTaskPresentation(task, taskRunning);
    const stateLabel = taskRunning
      ? ", running"
      : task.unread
        ? ", unread"
        : "";
    return (
      <article
        className={`sidebar-v2-task sidebar-v2-task--${variant} is-${presentation.tone} ${
          task.unread ? "is-unread" : ""
        } ${selected ? "is-selected" : ""} ${taskMenuOpen ? "has-open-menu" : ""}`}
        key={task.id}
        onContextMenu={(event) => openTaskContextMenu(event, task.id)}
      >
        {renamingTask?.id === task.id ? (
          <form
            className="sidebar-v2-task__rename"
            onSubmit={(event) => {
              event.preventDefault();
              commitTaskRename();
            }}
          >
            <input
              autoFocus
              aria-label="Rename task"
              value={renamingTask.title}
              onBlur={commitTaskRename}
              onChange={(event) =>
                setRenamingTask({ id: task.id, title: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                setRenamingTask(null);
              }}
            />
          </form>
        ) : (
          <>
            <button
              className="sidebar-v2-task__select"
              aria-label={`${task.title}${stateLabel}${task.pinned ? ", pinned" : ""}`}
              title={task.title}
              onClick={() => {
                onSelectTask(task.id);
                onOpenTasks();
              }}
            >
              <span className="sidebar-v2-task__state" aria-hidden="true">
                {taskRunning ? (
                  <XiaoIcon className="sidebar-v2-task__spinner" name="pending" size={14} />
                ) : presentation.tone === "completed" ? (
                  <XiaoIcon name="check" size={13} />
                ) : (
                  <i />
                )}
              </span>
              <span className="sidebar-v2-task__copy">
                <span className="sidebar-v2-task__title">
                  <strong>{task.title}</strong>
                  {task.pinned ? <XiaoIcon name="pin" size={11} /> : null}
                </span>
                <span className="sidebar-v2-task__meta">
                  <span>{presentation.status}</span>
                  <i aria-hidden="true">·</i>
                  <time dateTime={new Date(task.updatedAt).toISOString()}>
                    {relativeTime(task.updatedAt, now)}
                  </time>
                </span>
              </span>
            </button>
            <button
              className="sidebar-v2-task__menu"
              type="button"
              aria-label={`Task actions for ${task.title}`}
              aria-haspopup="menu"
              aria-expanded={taskMenuOpen}
              title="Task actions"
              onClick={(event) => toggleTaskMenu(event, task.id)}
            >
              <XiaoIcon name="more" size={15} />
            </button>
          </>
        )}
      </article>
    );
  };

  return (
    <>
      <aside
        className={`sidebar app-sidebar sidebar--${APP_STAGE}`}
        aria-label="Workspace navigation"
      >
        <div className="sidebar__panel">
          <header className="sidebar__header">
            <SidebarStageBackdrop variant={APP_STAGE} />
            <div
              className={`sidebar__brand${APP_STAGE === "production" ? "" : " is-on-stage"}`}
              aria-label={APP_DISPLAY_NAME}
            >
              <strong>XIAO</strong>
              <span>Workbench</span>
            </div>
            {stageLabel ? <span className="sidebar__stage-label">{stageLabel}</span> : null}
          </header>

          <div className="sidebar__primary-nav">
            <button className="sidebar__search" type="button" onClick={onOpenMenu}>
              <XiaoIcon name="search" size={15} />
              <span>Find anything</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button
              className="sidebar-v2__new-task"
              type="button"
              aria-label="New task"
              title="New task"
              onClick={onNewTask}
            >
              <XiaoIcon name="edit" size={15} />
            </button>
          </div>

          <div className="sidebar-v2__scope" ref={projectPickerRef}>
            <div className="sidebar-v2__scope-controls">
              <button
                className="sidebar-v2__scope-trigger"
                type="button"
                aria-label={`Current project: ${activeProject?.name ?? workspace.name}`}
                aria-haspopup="dialog"
                aria-expanded={projectPickerOpen}
                onClick={() => setProjectPickerOpen((open) => !open)}
              >
                <XiaoIcon name="folder" size={15} />
                <span>{activeProject?.name ?? workspace.name}</span>
                <XiaoIcon
                  className={projectPickerOpen ? "is-open" : ""}
                  name="caret"
                  size={13}
                />
              </button>
              <button
                className="sidebar-v2__add-project"
                type="button"
                aria-label="Add project"
                disabled={projectSwitchLocked}
                title={projectSwitchLocked ? "Wait for the active task to finish" : "Add project"}
                onClick={onAddProject}
              >
                <XiaoIcon name="folderOpen" size={15} />
                <XiaoIcon name="add" size={10} />
              </button>
            </div>

            {projectPickerOpen ? (
              <section
                className="sidebar-v2-project-picker"
                role="dialog"
                aria-label="Projects"
              >
                <header>
                  <span>
                    Projects <small>{projects.length}</small>
                  </span>
                  {canOpenProjects ? (
                    <button
                      type="button"
                      aria-label="Create project group"
                      onClick={() => {
                        setProjectPickerOpen(false);
                        setProjectGroupName("");
                        setProjectGroupDialogOpen(true);
                      }}
                    >
                      <XiaoIcon name="add" size={12} />
                      New group
                    </button>
                  ) : null}
                </header>
                <div className="sidebar-v2-project-picker__list">
                  {navigationItems.map((item) => {
                    if (item.kind === "group") {
                      const group = item.group;
                      return (
                        <div
                          className="sidebar-v2-project-group"
                          key={group?.id ?? "ungrouped"}
                        >
                          <span>{group?.name ?? "Ungrouped"}</span>
                          {group ? (
                            <span className="sidebar-v2-project-group__actions">
                              <button
                                type="button"
                                aria-label={`Rename ${group.name}`}
                                title={`Rename ${group.name}`}
                                onClick={() => onRenameProjectGroup(group)}
                              >
                                <XiaoIcon name="edit" size={11} />
                              </button>
                              <button
                                type="button"
                                aria-label={`Move ${group.name} up`}
                                title={`Move ${group.name} up`}
                                disabled={group.position === 0}
                                onClick={() => onMoveProjectGroup(group, -1)}
                              >
                                <XiaoIcon className="is-up" name="down" size={11} />
                              </button>
                              <button
                                type="button"
                                aria-label={`Move ${group.name} down`}
                                title={`Move ${group.name} down`}
                                disabled={group.position >= projectGroups.length - 1}
                                onClick={() => onMoveProjectGroup(group, 1)}
                              >
                                <XiaoIcon name="down" size={11} />
                              </button>
                              <button
                                type="button"
                                aria-label={`Delete ${group.name}`}
                                title={`Delete ${group.name}`}
                                onClick={() => onDeleteProjectGroup(group)}
                              >
                                <XiaoIcon name="close" size={11} />
                              </button>
                            </span>
                          ) : null}
                        </div>
                      );
                    }
                    const project = item.project;
                    const active = project.path === activeProjectPath;
                    const menuOpen = projectMenu?.projectPath === project.path;
                    const renaming = renamingProject?.path === project.path;
                    const running = active && workingTasks.size > 0;
                    const updatedAt = active
                      ? Math.max(project.updatedAt, ...visibleTasks.map((task) => task.updatedAt))
                      : project.updatedAt;
                    const status = running
                      ? "Running"
                      : !active && projectSwitchLocked
                        ? "Locked while task runs"
                        : `Updated ${relativeTime(updatedAt, now)}`;
                    return (
                      <div
                        className={`sidebar-v2-project ${active ? "is-active" : ""} ${
                          menuOpen ? "has-open-menu" : ""
                        }`}
                        key={project.path}
                        onContextMenu={(event) => openProjectContextMenu(event, project.path)}
                      >
                        {renaming ? (
                          <form
                            className="sidebar-v2-project__rename"
                            onSubmit={(event) => {
                              event.preventDefault();
                              commitProjectRename();
                            }}
                          >
                            <XiaoIcon name="folder" size={14} />
                            <input
                              aria-label={`Rename ${project.name}`}
                              autoFocus
                              value={renamingProject.name}
                              onBlur={commitProjectRename}
                              onChange={(event) =>
                                setRenamingProject({
                                  path: project.path,
                                  name: event.target.value,
                                })
                              }
                              onKeyDown={(event) => {
                                if (event.key !== "Escape") return;
                                event.preventDefault();
                                setRenamingProject(null);
                              }}
                            />
                          </form>
                        ) : (
                          <>
                            <button
                              className="sidebar-v2-project__select"
                              type="button"
                              title={project.path}
                              disabled={!active && projectSwitchLocked}
                              onClick={() => {
                                setProjectPickerOpen(false);
                                if (!active) onSelectProject(project.path);
                                else onOpenTasks();
                              }}
                            >
                              <span className="sidebar-v2-project__icon">
                                <XiaoIcon name={active ? "folderOpen" : "folder"} size={14} />
                              </span>
                              <span>
                                <strong>{project.name}</strong>
                                <small className={running ? "is-running" : ""}>{status}</small>
                              </span>
                              {project.pinned ? <XiaoIcon name="pin" size={11} /> : null}
                              {active ? <XiaoIcon name="check" size={13} /> : null}
                            </button>
                            <button
                              className="sidebar-v2-project__menu"
                              type="button"
                              aria-label={`Project actions for ${project.name}`}
                              aria-haspopup="menu"
                              aria-expanded={menuOpen}
                              title="Project actions"
                              onClick={(event) => toggleProjectMenu(event, project.path)}
                            >
                              <XiaoIcon name="more" size={15} />
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
                {hiddenProjects.length ? (
                  <details className="sidebar-v2-project-picker__hidden">
                    <summary>Hidden projects ({hiddenProjects.length})</summary>
                    {hiddenProjects.map((project) => (
                      <button
                        type="button"
                        key={project.path}
                        onClick={() => onRestoreProject(project)}
                      >
                        Restore {project.name}
                      </button>
                    ))}
                  </details>
                ) : null}
              </section>
            ) : null}
          </div>

          <section className="sidebar-v2__tasks" aria-label="Project tasks">
            <header className="sidebar-v2__tasks-heading">
              <span>Tasks</span>
              <small>{visibleTasks.length}</small>
            </header>
            <div className="sidebar-v2__active-list">
              {activeTasks.map((task) => renderTaskRow(task, "card"))}
            </div>
            {completedTasks.length ? (
              <section className="sidebar-v2__completed">
                <button
                  className="sidebar-v2__completed-toggle"
                  type="button"
                  aria-expanded={completedShelfExpanded}
                  onClick={() => setCompletedShelfExpanded((expanded) => !expanded)}
                >
                  <span>Completed</span>
                  {!completedShelfExpanded ? <small>{completedTasks.length}</small> : null}
                  <i aria-hidden="true" />
                  <XiaoIcon
                    className={completedShelfExpanded ? "is-open" : ""}
                    name="down"
                    size={12}
                  />
                </button>
                {completedShelfExpanded ? (
                  <div className="sidebar-v2__completed-list">
                    {completedTasks.map((task) => renderTaskRow(task, "slim"))}
                  </div>
                ) : null}
              </section>
            ) : null}
            {!visibleTasks.length ? (
              <div className="sidebar-v2__empty">
                <span className="sidebar-v2__empty-icon">
                  <XiaoIcon name="taskQueue" size={17} />
                </span>
                <strong>No tasks yet</strong>
                <p>Start a Task in {activeProject?.name ?? workspace.name}.</p>
                <button type="button" onClick={onNewTask}>
                  <XiaoIcon name="add" size={13} />
                  <span>New task</span>
                </button>
              </div>
            ) : null}
          </section>


          <footer className="sidebar__footer">
            <nav className="sidebar__footer-nav" aria-label="Workspace utilities">
              <button
                id={sidebarAttentionTriggerId}
                className={`sidebar__footer-action sidebar__utility-attention ${activePage === "attention" ? "is-active" : ""}`}
                type="button"
                aria-label={attentionLabel}
                aria-current={activePage === "attention" ? "page" : undefined}
                onClick={onOpenAttention}
              >
                <XiaoIcon name="approval" size={16} />
                <span>Attention</span>
                {attentionCount > 0 ? (
                  <span className="sidebar__attention-badge" aria-hidden="true">
                    {attentionCount > 99 ? "99+" : attentionCount}
                  </span>
                ) : null}
              </button>
              <button
                className={`sidebar__footer-action ${activePage === "companion" ? "is-active" : ""}`}
                type="button"
                aria-current={activePage === "companion" ? "page" : undefined}
                onClick={onOpenCompanion}
              >
                <XiaoIcon name="connect" size={16} />
                <span>Companion</span>
              </button>
              <button
                className={`sidebar__footer-action ${activePage === "settings" ? "is-active" : ""}`}
                type="button"
                aria-current={activePage === "settings" ? "page" : undefined}
                onClick={onOpenSettings}
              >
                <XiaoIcon name="settings" size={16} />
                <span>Settings</span>
              </button>
            </nav>
            <button
              className={`sidebar__profile ${activePage === "profile" ? "is-active" : ""}`}
              type="button"
              aria-label={profile.name ? `Open ${profile.name}'s profile` : "Set up profile"}
              aria-current={activePage === "profile" ? "page" : undefined}
              onClick={onOpenProfile}
            >
              <span className="sidebar__profile-avatar">
                {profile.avatarDataUrl ? (
                  <img src={profile.avatarDataUrl} alt="" />
                ) : initials ? (
                  initials
                ) : (
                  <XiaoIcon name="user" size={14} />
                )}
              </span>
              <span className="sidebar__profile-copy">
                <strong>{profile.name || "Set up profile"}</strong>
                <small>{account?.planType ?? "Local workspace"}</small>
              </span>
              <XiaoIcon className="sidebar__profile-chevron" name="caret" size={12} />
            </button>
          </footer>
        </div>
      </aside>

      {projectGroupDialogOpen
        ? createPortal(
            <div className="sidebar-dialog-backdrop">
              <section
                className="sidebar-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="create-project-group-title"
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  setProjectGroupDialogOpen(false);
                }}
              >
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = projectGroupName.trim();
                    if (!name) return;
                    onCreateProjectGroup(name);
                    setProjectGroupDialogOpen(false);
                    setProjectGroupName("");
                  }}
                >
                  <header>
                    <span>Projects</span>
                    <h2 id="create-project-group-title">New project group</h2>
                    <p>Keep related projects together in the sidebar.</p>
                  </header>
                  <label>
                    <span>Group name</span>
                    <input
                      autoFocus
                      value={projectGroupName}
                      placeholder="e.g. Client work"
                      onChange={(event) => setProjectGroupName(event.target.value)}
                    />
                  </label>
                  <footer>
                    <button
                      className="sidebar-dialog__cancel"
                      type="button"
                      onClick={() => setProjectGroupDialogOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      className="sidebar-dialog__submit"
                      type="submit"
                      disabled={!projectGroupName.trim()}
                    >
                      Create group
                    </button>
                  </footer>
                </form>
              </section>
            </div>,
            document.body,
          )
        : null}

      {projectMenu && menuProject
        ? createPortal(
            <div
              className="project-actions-menu"
              ref={projectMenuRef}
              role="menu"
              aria-label={`Actions for ${menuProject.name}`}
              style={{ top: projectMenu.top, left: projectMenu.left }}
              onKeyDown={handleMenuKeyDown}
            >
              <button
                role="menuitem"
                onClick={() => {
                  closeProjectMenu(projectMenu.focusFirst);
                  onToggleProjectPinned(menuProject.path);
                }}
              >
                <XiaoIcon name="pin" size={15} />
                <span>{menuProject.pinned ? "Unpin project" : "Pin project"}</span>
              </button>
              <button
                role="menuitem"
                disabled={!canOpenProjects}
                title={canOpenProjects ? undefined : "Available in the desktop app"}
                onClick={() => {
                  closeProjectMenu(projectMenu.focusFirst);
                  onOpenProject(menuProject.path);
                }}
              >
                <XiaoIcon name="folderOpen" size={15} />
                <span>Open in Explorer</span>
              </button>
              <button role="menuitem" onClick={() => beginProjectRename(menuProject)}>
                <XiaoIcon name="edit" size={15} />
                <span>Rename project</span>
              </button>
              {projectGroups.length ? (
                <label className="project-actions-menu__group">
                  <span>Project Group</span>
                  <select
                    aria-label={`Project Group for ${menuProject.name}`}
                    value={menuProject.projectGroupId ?? ""}
                    onChange={(event) => {
                      onMoveProjectToGroup(menuProject.path, event.target.value || null);
                      closeProjectMenu(projectMenu.focusFirst);
                    }}
                  >
                    <option value="">Ungrouped</option>
                    {projectGroups.map((group) => (
                      <option value={group.id} key={group.id}>{group.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <button
                role="menuitem"
                disabled={menuProject.path === activeProjectPath && workingTasks.size > 0}
                title={
                  menuProject.path === activeProjectPath && workingTasks.size > 0
                    ? "Wait for the active task to finish"
                    : undefined
                }
                onClick={() => {
                  closeProjectMenu(projectMenu.focusFirst);
                  onArchiveProjectTasks(menuProject.path);
                }}
              >
                <XiaoIcon name="archive" size={15} />
                <span>Archive tasks</span>
              </button>
              <button
                className="is-danger"
                role="menuitem"
                disabled={
                  projects.length === 1 ||
                  (menuProject.path === activeProjectPath && projectSwitchLocked)
                }
                title={
                  projects.length === 1
                    ? "Keep at least one project in Xiao"
                    : menuProject.path === activeProjectPath && projectSwitchLocked
                      ? "Wait for the active task to finish"
                      : undefined
                }
                onClick={() => {
                  closeProjectMenu();
                  onRemoveProject(menuProject.path);
                }}
              >
                <XiaoIcon name="close" size={15} />
                <span>Remove</span>
              </button>
            </div>,
            document.body,
          )
        : null}

      {taskMenu && menuTask
        ? createPortal(
            <div
              className="project-actions-menu task-actions-menu"
              ref={taskMenuRef}
              role="menu"
              aria-label={`Actions for ${menuTask.title}`}
              style={{ top: taskMenu.top, left: taskMenu.left }}
              onKeyDown={handleMenuKeyDown}
            >
              <button role="menuitem" onClick={() => {
                closeTaskMenu();
                onToggleTaskPinned(menuTask.id);
              }}>
                <XiaoIcon name="pin" size={15} />
                <span>{menuTask.pinned ? "Unpin task" : "Pin task"}</span>
              </button>
              <button role="menuitem" onClick={() => {
                closeTaskMenu();
                setRenamingTask({ id: menuTask.id, title: menuTask.title });
              }}>
                <XiaoIcon name="edit" size={15} />
                <span>Rename task</span>
              </button>
              <button
                role="menuitem"
                disabled={workingTasks.has(menuTask.id)}
                title={workingTasks.has(menuTask.id) ? "Wait for this task to finish" : undefined}
                onClick={() => {
                  closeTaskMenu();
                  onSetTaskArchived(menuTask.id, true);
                }}
              >
                <XiaoIcon name="archive" size={15} />
                <span>Archive task</span>
              </button>
              <button role="menuitem" onClick={() => {
                closeTaskMenu();
                onMarkTaskUnread(menuTask.id, !menuTask.unread);
              }}>
                <XiaoIcon name="result" size={15} />
                <span>{menuTask.unread ? "Mark as read" : "Mark as unread"}</span>
              </button>

              <i className="context-menu-separator" />

              <button
                role="menuitem"
                disabled={!canOpenProjects}
                onClick={() => {
                  closeTaskMenu();
                  onOpenProject(workspace.path);
                }}
              >
                <XiaoIcon name="folderOpen" size={15} />
                <span>Open in Explorer</span>
              </button>
              <button role="menuitem" onClick={() => void copyText(workspace.path)}>
                <XiaoIcon name="copy" size={15} />
                <span>Copy working directory</span>
              </button>
              <button
                role="menuitem"
                disabled={!menuTask.threadId}
                title={menuTask.threadId ? undefined : "This task has no active Codex session"}
                onClick={() => {
                  if (menuTask.threadId) void copyText(menuTask.threadId);
                }}
              >
                <XiaoIcon name="copy" size={15} />
                <span>Copy session ID</span>
              </button>
              {copyError ? (
                <p className="task-actions-menu__error" role="alert">{copyError}</p>
              ) : null}

              <i className="context-menu-separator" />

              <button role="menuitem" onClick={() => {
                closeTaskMenu();
                onContinueInNewTask(menuTask.id);
              }}>
                <XiaoIcon name="taskQueue" size={15} />
                <span>Continue in new task</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
