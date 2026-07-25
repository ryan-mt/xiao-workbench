import {
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { CodexThreadSummary, TimelineEntry } from "../../../core/models/agent";
import type { XiaoProjectSummary } from "../../../core/models/xiao";
import { workspaceContainsPath } from "../../agent/history/codexHistory";
import type { WorkbenchTask } from "../../task/task.types";

type InboxFilter = "all" | "active-project";

type InboxItem = {
  key: string;
  kind: "task" | "codex";
  id: string;
  title: string;
  projectName: string;
  projectPath: string;
  createdAt: number;
  updatedAt: number;
  selected: boolean;
  working: boolean;
  waiting: boolean;
  failed: boolean;
  unread: boolean;
  additions: number;
  deletions: number;
  task?: WorkbenchTask;
  thread?: CodexThreadSummary;
};

type SidebarInboxProps = {
  projects: XiaoProjectSummary[];
  activeProjectPath: string;
  tasks: WorkbenchTask[];
  codexThreads: CodexThreadSummary[];
  activeTaskId: string;
  workingTaskIds: string[];
  now: number;
  codexHistoryError: string | null;
  onNewTask: () => void;
  onAddProject: () => void;
  onSelectProject: (path: string) => void;
  onSelectTask: (taskId: string) => void;
  onSelectCodexThread: (thread: CodexThreadSummary) => void;
  onTaskContextMenu: (event: ReactMouseEvent<HTMLElement>, taskId: string) => void;
  onCodexContextMenu: (event: ReactMouseEvent<HTMLElement>, threadId: string) => void;
};

const settledStorageKey = "xiao.sidebar-settled.v1";
const settledPreviewLimit = 14;
const inboxPreviewLimit = 6;
const dayMs = 86_400_000;

const readSettledItems = () => {
  try {
    const value = JSON.parse(window.localStorage.getItem(settledStorageKey) ?? "[]") as unknown;
    return new Set(Array.isArray(value)
      ? value.filter((key): key is string => typeof key === "string")
      : []);
  } catch {
    return new Set<string>();
  }
};

const storeSettledItems = (items: ReadonlySet<string>) => {
  try {
    window.localStorage.setItem(settledStorageKey, JSON.stringify([...items]));
  } catch {
    // Settlement remains active for this session.
  }
};

const projectForPath = (
  projects: XiaoProjectSummary[],
  path: string,
) => projects
  .filter((project) => workspaceContainsPath(project.path, path))
  .sort((left, right) => right.path.length - left.path.length)[0] ?? null;

const diffForTimeline = (timeline: TimelineEntry[]) => {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const files = timeline[index]?.files;
    if (!files?.length) continue;
    return files.reduce(
      (total, file) => ({
        additions: total.additions + Math.max(0, file.additions),
        deletions: total.deletions + Math.max(0, file.deletions),
      }),
      { additions: 0, deletions: 0 },
    );
  }
  return { additions: 0, deletions: 0 };
};

const relativeTime = (timestamp: number, now: number) => {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < dayMs) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < dayMs * 7) return `${Math.floor(elapsed / dayMs)}d`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(timestamp);
};

const monthHeading = (timestamp: number, now: number) => {
  const date = new Date(timestamp);
  const today = new Date(now);
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const elapsedDays = Math.floor((startToday - startDate) / dayMs);
  if (elapsedDays <= 0) return "Today";
  if (elapsedDays === 1) return "Yesterday";
  if (elapsedDays < 7) return "This week";
  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth()
  ) return "Earlier this month";
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  }).format(date);
};

const itemStatus = (item: InboxItem) => {
  if (item.working) return { label: "Working", tone: "working" };
  if (item.waiting) return { label: "Needs input", tone: "waiting" };
  if (item.failed) return { label: "Failed", tone: "failed" };
  if (item.unread) return { label: "Updated", tone: "unread" };
  return null;
};

const ChangePill = ({ additions, deletions }: { additions: number; deletions: number }) => {
  if (!additions && !deletions) return null;
  return (
    <span className="sidebar-inbox__diff" aria-label={`${additions} additions, ${deletions} deletions`}>
      {additions ? <span className="is-addition">+{additions}</span> : null}
      {deletions ? <span className="is-deletion">−{deletions}</span> : null}
    </span>
  );
};

function InboxRow({
  item,
  compact,
  now,
  onOpen,
  onContextMenu,
  onSettle,
}: {
  item: InboxItem;
  compact: boolean;
  now: number;
  onOpen: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onSettle: () => void;
}) {
  const status = itemStatus(item);
  return (
    <article
      className={[
        "sidebar-inbox__row",
        compact ? "is-compact" : "",
        item.selected ? "is-selected" : "",
        item.working ? "is-working" : "",
      ].filter(Boolean).join(" ")}
      style={{ viewTransitionName: `sidebar-${item.key.replace(/[^a-zA-Z0-9_-]/g, "-")}` }}
      onContextMenu={onContextMenu}
    >
      <button
        className="sidebar-inbox__open"
        type="button"
        aria-label={`Open ${item.title}`}
        onClick={onOpen}
      >
        <span className="sidebar-inbox__row-topline">
          <span className="sidebar-inbox__project">
            {item.kind === "task" ? item.projectName : item.projectName || "Codex"}
          </span>
          {status ? (
            <span className={`sidebar-inbox__status is-${status.tone}`}>
              {item.working ? (
                <XiaoIcon name="pending" size={11} />
              ) : (
                <i aria-hidden="true" />
              )}
              {status.label}
            </span>
          ) : (
            <time dateTime={new Date(item.updatedAt).toISOString()}>
              {relativeTime(item.updatedAt, now)}
            </time>
          )}
        </span>
        <strong>{item.title}</strong>
        {!compact ? (
          <span className="sidebar-inbox__row-meta">
            <span>{monthHeading(item.createdAt, now)}</span>
            <ChangePill additions={item.additions} deletions={item.deletions} />
          </span>
        ) : null}
      </button>
      <button
        className="sidebar-inbox__settle"
        type="button"
        aria-label={compact ? `Restore ${item.title} to inbox` : `Settle ${item.title}`}
        onClick={(event) => {
          event.stopPropagation();
          onSettle();
        }}
      >
        <XiaoIcon name={compact ? "undo" : "check"} size={13} />
        {!compact ? <span>Settle</span> : null}
      </button>
    </article>
  );
}

export function SidebarInbox({
  projects,
  activeProjectPath,
  tasks,
  codexThreads,
  activeTaskId,
  workingTaskIds,
  now,
  codexHistoryError,
  onNewTask,
  onAddProject,
  onSelectProject,
  onSelectTask,
  onSelectCodexThread,
  onTaskContextMenu,
  onCodexContextMenu,
}: SidebarInboxProps) {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [settled, setSettled] = useState<ReadonlySet<string>>(readSettledItems);
  const [settledExpanded, setSettledExpanded] = useState(false);
  const [settledShelfOpen, setSettledShelfOpen] = useState(true);
  const [inboxExpanded, setInboxExpanded] = useState(false);
  const [otherExpanded, setOtherExpanded] = useState(false);
  const activeProject = projectForPath(projects, activeProjectPath);
  const working = useMemo(() => new Set(workingTaskIds), [workingTaskIds]);

  const items = useMemo<InboxItem[]>(() => {
    const taskItems = tasks
      .filter((task) => !task.archived && task.origin !== "codex")
      .map((task) => {
        const project = projectForPath(projects, activeProjectPath);
        const diff = diffForTimeline(task.timeline);
        return {
          key: `task:${task.id}`,
          kind: "task" as const,
          id: task.id,
          title: task.title,
          projectName: project?.name ?? "Local",
          projectPath: project?.path ?? activeProjectPath,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          selected: activeTaskId === task.id,
          working: working.has(task.id),
          waiting: false,
          failed: false,
          unread: task.unread,
          additions: diff.additions,
          deletions: diff.deletions,
          task,
        };
      });
    const codexItems = codexThreads
      .filter((thread) => !thread.archived)
      .map((thread) => {
        const project = projectForPath(projects, thread.cwd);
        return {
          key: `codex:${thread.id}`,
          kind: "codex" as const,
          id: thread.id,
          title: thread.title,
          projectName: project?.name ?? "Other Codex chats",
          projectPath: project?.path ?? thread.cwd,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          selected: activeTaskId === `codex:${thread.id}`,
          working: thread.status === "working",
          waiting: thread.status === "waiting",
          failed: thread.status === "failed",
          unread: false,
          additions: thread.additions ?? 0,
          deletions: thread.deletions ?? 0,
          thread,
        };
      });
    return [...taskItems, ...codexItems].sort(
      (left, right) =>
        right.createdAt - left.createdAt ||
        left.key.localeCompare(right.key),
    );
  }, [activeProjectPath, activeTaskId, codexThreads, projects, tasks, working]);

  const visibleItems = items.filter((item) => {
    if (filter === "active-project") {
      return Boolean(activeProject && workspaceContainsPath(activeProject.path, item.projectPath));
    }
    return true;
  });
  const activeItems = visibleItems.filter((item) => !settled.has(item.key));
  const settledItems = visibleItems.filter((item) => settled.has(item.key));
  const otherItems = activeItems.filter((item) => item.projectName === "Other Codex chats");
  const inboxItems = activeItems.filter((item) => item.projectName !== "Other Codex chats");
  const collapsedInboxItems = inboxItems.slice(0, inboxPreviewLimit);
  const selectedHiddenInboxItem = inboxItems
    .slice(inboxPreviewLimit)
    .find((item) => item.selected);
  const shownInboxItems = inboxExpanded
    ? inboxItems
    : selectedHiddenInboxItem
      ? [...collapsedInboxItems.slice(0, inboxPreviewLimit - 1), selectedHiddenInboxItem]
      : collapsedInboxItems;
  const hiddenInboxCount = Math.max(0, inboxItems.length - shownInboxItems.length);
  const shownSettled = settledExpanded ? settledItems : settledItems.slice(0, settledPreviewLimit);

  const toggleSettled = (key: string) => {
    const update = () => {
      setSettled((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        storeSettledItems(next);
        return next;
      });
    };
    const transitionDocument = document as Document & {
      startViewTransition?: (callback: () => void) => { finished: Promise<void> };
    };
    if (transitionDocument.startViewTransition) {
      transitionDocument.startViewTransition(update);
    } else {
      update();
    }
  };

  const openItem = (item: InboxItem) => {
    if (item.task) onSelectTask(item.task.id);
    else if (item.thread) onSelectCodexThread(item.thread);
  };

  const contextItem = (event: ReactMouseEvent<HTMLElement>, item: InboxItem) => {
    if (item.task) onTaskContextMenu(event, item.task.id);
    else if (item.thread) onCodexContextMenu(event, item.thread.id);
  };

  return (
    <div className="sidebar-inbox">
      <div className="sidebar-inbox__toolbar">
        <div>
          <strong>Inbox</strong>
          <small>{inboxItems.length}</small>
        </div>
        <button type="button" onClick={onNewTask}>
          <XiaoIcon name="add" size={13} />
          <span>New task</span>
        </button>
      </div>

      <div className="sidebar-inbox__filters" role="group" aria-label="Filter inbox">
        <button
          type="button"
          className={filter === "all" ? "is-selected" : ""}
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
        >
          All
        </button>
        {activeProject ? (
          <button
            type="button"
            className={filter === "active-project" ? "is-selected" : ""}
            aria-pressed={filter === "active-project"}
            onClick={() => {
              setFilter("active-project");
              onSelectProject(activeProject.path);
            }}
          >
            <XiaoIcon name="folder" size={12} />
            <span>{activeProject.name}</span>
          </button>
        ) : null}
        <button
          className="sidebar-inbox__add-project has-tooltip"
          type="button"
          aria-label="Add project"
          data-tooltip="Add project"
          onClick={onAddProject}
        >
          <XiaoIcon name="add" size={12} />
        </button>
      </div>

      <div className="sidebar-inbox__scroll">
        <section className="sidebar-inbox__section" aria-label="Open threads">
          {shownInboxItems.map((item) => (
            <InboxRow
              key={item.key}
              item={item}
              compact={false}
              now={now}
              onOpen={() => openItem(item)}
              onContextMenu={(event) => contextItem(event, item)}
              onSettle={() => toggleSettled(item.key)}
            />
          ))}
          {inboxItems.length > inboxPreviewLimit ? (
            <button
              className="sidebar-inbox__more"
              type="button"
              aria-expanded={inboxExpanded}
              onClick={() => setInboxExpanded((expanded) => !expanded)}
            >
              <span>{inboxExpanded ? "Show fewer" : `Show ${hiddenInboxCount} more`}</span>
              <XiaoIcon
                className={inboxExpanded ? "is-expanded" : ""}
                name="caret"
                size={11}
              />
            </button>
          ) : null}
          {!inboxItems.length ? (
            <div className="sidebar-inbox__empty">
              <XiaoIcon name="check" size={16} />
              <strong>Inbox clear</strong>
              <span>Start a task or restore one from Settled.</span>
              <button type="button" onClick={onNewTask}>Start new task</button>
            </div>
          ) : null}
        </section>

        {otherItems.length ? (
          <section className="sidebar-inbox__shelf">
            <button
              className="sidebar-inbox__shelf-heading"
              type="button"
              aria-expanded={otherExpanded}
              onClick={() => setOtherExpanded((expanded) => !expanded)}
            >
              <span>
                <XiaoIcon name="branch" size={13} />
                <strong>Other Codex chats</strong>
              </span>
              <span>
                <small>{otherItems.length}</small>
                <XiaoIcon className={otherExpanded ? "is-expanded" : ""} name="caret" size={11} />
              </span>
            </button>
            {otherExpanded ? (
              <div className="sidebar-inbox__shelf-list">
                {otherItems.map((item) => (
                  <InboxRow
                    key={item.key}
                    item={item}
                    compact
                    now={now}
                    onOpen={() => openItem(item)}
                    onContextMenu={(event) => contextItem(event, item)}
                    onSettle={() => toggleSettled(item.key)}
                  />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {settledItems.length ? (
          <section className="sidebar-inbox__shelf is-settled">
            <button
              className="sidebar-inbox__shelf-heading"
              type="button"
              aria-expanded={settledShelfOpen}
              onClick={() => setSettledShelfOpen((open) => !open)}
            >
              <span>
                <XiaoIcon name="check" size={13} />
                <strong>Settled</strong>
              </span>
              <span>
                <small>{settledItems.length}</small>
                <XiaoIcon
                  className={settledShelfOpen ? "is-expanded" : ""}
                  name="caret"
                  size={11}
                />
              </span>
            </button>
            {settledShelfOpen ? (
              <>
                <div className="sidebar-inbox__shelf-list">
                  {shownSettled.map((item) => (
                    <InboxRow
                      key={item.key}
                      item={item}
                      compact
                      now={now}
                      onOpen={() => openItem(item)}
                      onContextMenu={(event) => contextItem(event, item)}
                      onSettle={() => toggleSettled(item.key)}
                    />
                  ))}
                </div>
                {settledItems.length > settledPreviewLimit ? (
                  <button
                    className="sidebar-inbox__more is-settled"
                    type="button"
                    aria-expanded={settledExpanded}
                    onClick={() => setSettledExpanded((expanded) => !expanded)}
                  >
                    <span>
                      {settledExpanded
                        ? "Show fewer"
                        : `Show ${settledItems.length - settledPreviewLimit} more`}
                    </span>
                    <XiaoIcon
                      className={settledExpanded ? "is-expanded" : ""}
                      name="caret"
                      size={11}
                    />
                  </button>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}

        {codexHistoryError ? (
          <div className="sidebar-inbox__error" role="status">{codexHistoryError}</div>
        ) : null}
      </div>
    </div>
  );
}
