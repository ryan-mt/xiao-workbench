import { useEffect, useMemo, useRef, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { keyboardEventMatchesBinding } from "../../command-menu/commandBindings";
import type { WorkbenchTask } from "../../task/task.types";

type TaskSwitcherProps = {
  tasks: WorkbenchTask[];
  activeTaskId: string | null;
  workingTaskIds: string[];
  cycleBinding: string;
  onSelect: (taskId: string) => void;
  onClose: () => void;
};

const taskTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

const relativeTaskTime = (timestamp: number) => {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 172_800_000) return "yesterday";
  return taskTimeFormatter.format(timestamp);
};

export const orderTaskSwitcherTasks = (
  tasks: WorkbenchTask[],
  workingTaskIds: readonly string[],
) => {
  const working = new Set(workingTaskIds);
  return tasks
    .filter((task) => !task.archived)
    .sort(
      (left, right) =>
        Number(working.has(right.id)) - Number(working.has(left.id)) ||
        Number(right.pinned) - Number(left.pinned) ||
        Number(right.unread) - Number(left.unread) ||
        right.updatedAt - left.updatedAt,
    );
};

export const resolveTaskSwitcherSelection = (
  tasks: readonly WorkbenchTask[],
  highlightedTaskId: string | null,
  activeTaskId: string | null,
) => {
  if (highlightedTaskId && tasks.some((task) => task.id === highlightedTaskId)) {
    return highlightedTaskId;
  }
  if (activeTaskId && tasks.some((task) => task.id === activeTaskId)) return activeTaskId;
  return tasks[0]?.id ?? null;
};

type TaskSwitcherKeyboardEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

export const taskSwitcherCycleDirection = (
  event: TaskSwitcherKeyboardEvent,
  cycleBinding: string,
): -1 | 1 | null => {
  if (event.key === "ArrowUp") return -1;
  if (event.key === "ArrowDown") return 1;
  if (keyboardEventMatchesBinding(event, cycleBinding)) return 1;
  return keyboardEventMatchesBinding(event, cycleBinding, true) ? -1 : null;
};

export function TaskSwitcher({
  tasks,
  activeTaskId,
  workingTaskIds,
  cycleBinding,
  onSelect,
  onClose,
}: TaskSwitcherProps) {
  const [query, setQuery] = useState("");
  const orderedTasks = useMemo(
    () => orderTaskSwitcherTasks(tasks, workingTaskIds),
    [tasks, workingTaskIds],
  );
  const visibleTasks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return orderedTasks;
    return orderedTasks.filter((task) =>
      [task.title, task.meta, task.model ?? ""]
        .some((value) => value.toLocaleLowerCase().includes(normalized)),
    );
  }, [orderedTasks, query]);
  const initialTaskId = resolveTaskSwitcherSelection(visibleTasks, null, activeTaskId);
  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(initialTaskId);
  const selectedTaskId = resolveTaskSwitcherSelection(
    visibleTasks,
    highlightedTaskId,
    activeTaskId,
  );
  const activeIndex = visibleTasks.findIndex((task) => task.id === selectedTaskId);
  const listRef = useRef<HTMLDivElement>(null);
  const working = new Set(workingTaskIds);

  useEffect(() => {
    setHighlightedTaskId(selectedTaskId);
  }, [selectedTaskId]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-task-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const cycleDirection = taskSwitcherCycleDirection(event, cycleBinding);
      if (cycleDirection !== null) {
        if (!visibleTasks.length) return;
        event.preventDefault();
        const currentIndex = Math.max(
          0,
          visibleTasks.findIndex((task) => task.id === selectedTaskId),
        );
        const nextIndex =
          (currentIndex + cycleDirection + visibleTasks.length) % visibleTasks.length;
        setHighlightedTaskId(visibleTasks[nextIndex].id);
        return;
      }
      if (event.key === "Enter") {
        const task = visibleTasks.find((task) => task.id === selectedTaskId);
        if (!task) return;
        event.preventDefault();
        onSelect(task.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycleBinding, onClose, onSelect, selectedTaskId, visibleTasks]);

  return (
    <div
      className="task-switcher-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="task-switcher" role="dialog" aria-modal="true" aria-label="Switch tasks">
        <header className="task-switcher__search">
          <XiaoIcon name="search" size={16} />
          <input
            autoFocus
            value={query}
            aria-label="Search tasks"
            placeholder="Switch tasks"
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>{cycleBinding.split("+").join(" ")}</kbd>
        </header>

        <div className="task-switcher__list" ref={listRef} role="listbox" aria-label="Tasks">
          {visibleTasks.map((task, index) => {
            const taskWorking = working.has(task.id);
            const active = task.id === selectedTaskId;
            const selected = task.id === activeTaskId;
            const state = taskWorking ? "Running" : task.unread ? "Unread" : relativeTaskTime(task.updatedAt);
            return (
              <button
                className={`${active ? "is-active" : ""} ${selected ? "is-selected" : ""}`}
                data-task-index={index}
                type="button"
                role="option"
                aria-selected={active}
                key={task.id}
                onMouseEnter={() => setHighlightedTaskId(task.id)}
                onClick={() => onSelect(task.id)}
              >
                <span className="task-switcher__mark" aria-hidden="true">
                  <XiaoIcon
                    name={taskWorking ? "pending" : task.unread ? "result" : "workspace"}
                    size={14}
                  />
                </span>
                <span className="task-switcher__copy">
                  <strong>{task.title}</strong>
                  <small>
                    {state}
                    {task.model ? ` · ${task.model}` : ""}
                  </small>
                </span>
                <span className="task-switcher__flags">
                  {task.pinned ? <XiaoIcon name="pin" size={11} /> : null}
                  {selected ? <small>Open</small> : null}
                </span>
              </button>
            );
          })}
          {!visibleTasks.length ? (
            <div className="task-switcher__empty">
              <XiaoIcon name="search" size={18} />
              <strong>No matching tasks</strong>
              <small>Try a task title or model name.</small>
            </div>
          ) : null}
        </div>

        <footer className="task-switcher__footer">
          <span><kbd>↑↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Open <kbd>Esc</kbd> Close</span>
        </footer>
      </section>
    </div>
  );
}
