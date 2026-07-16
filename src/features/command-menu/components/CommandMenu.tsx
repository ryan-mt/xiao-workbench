import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { XiaoIcon, type XiaoIconName } from "../../../components/icons/XiaoIcon";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { FocusView } from "../../focus-rail/focus-rail.types";
import type { WorkbenchTask } from "../../task/task.types";
import "../styles/command-menu.css";

type CommandMenuProps = {
  open: boolean;
  tasks: WorkbenchTask[];
  workspace: WorkspaceSnapshot;
  onClose: () => void;
  onSelectTask: (taskId: string) => void;
  onSelectView: (view: FocusView) => void;
};

const actions: Array<{
  id: string;
  label: string;
  hint: string;
  icon: XiaoIconName;
  view: FocusView;
}> = [
  { id: "plan", label: "Open task plan", hint: "Focus", icon: "plan", view: "plan" },
  { id: "files", label: "Browse workspace files", hint: "Focus", icon: "files", view: "files" },
  { id: "browser", label: "Open research browser", hint: "Focus", icon: "browser", view: "browser" },
  { id: "run", label: "Open Xiao Break", hint: "Play", icon: "game", view: "run" },
  { id: "changes", label: "Inspect working changes", hint: "Focus", icon: "changes", view: "changes" },
  { id: "context", label: "Inspect session context", hint: "Focus", icon: "result", view: "context" },
  { id: "extensions", label: "Manage plugins and skills", hint: "Focus", icon: "capability", view: "extensions" },
  { id: "terminal", label: "Open workspace terminal", hint: "Focus", icon: "terminal", view: "terminal" },
  { id: "schedule", label: "Schedule a background task", hint: "Focus", icon: "routine", view: "schedule" },
  { id: "runtime", label: "Open native runtime", hint: "Focus", icon: "runtime", view: "runtime" },
];

export function CommandMenu({
  open,
  tasks,
  workspace,
  onClose,
  onSelectTask,
  onSelectView,
}: CommandMenuProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const resultButtons = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return {
      actions: normalized
        ? actions.filter((action) => action.label.toLowerCase().includes(normalized))
        : actions,
      tasks: normalized
        ? tasks
            .filter(
              (task) =>
                !task.archived &&
                `${task.title} ${task.meta}`.toLowerCase().includes(normalized),
            )
            .slice(0, 6)
        : [],
    };
  }, [query, tasks]);

  const resultCount = filtered.actions.length + filtered.tasks.length;

  useEffect(() => {
    if (!open) return;
    setActiveIndex(resultCount > 0 ? 0 : -1);
    resultButtons.current = resultButtons.current.slice(0, resultCount);
  }, [open, query, resultCount]);

  const moveActiveResult = (direction: 1 | -1) => {
    if (!resultCount) return;
    setActiveIndex((current) => {
      const start = current < 0 ? (direction === 1 ? -1 : 0) : current;
      const next = (start + direction + resultCount) % resultCount;
      requestAnimationFrame(() => resultButtons.current[next]?.scrollIntoView({ block: "nearest" }));
      return next;
    });
  };

  const selectActiveResult = () => {
    if (activeIndex < 0) return;
    const action = filtered.actions[activeIndex];
    if (action) {
      onSelectView(action.view);
      return;
    }
    const task = filtered.tasks[activeIndex - filtered.actions.length];
    if (task) onSelectTask(task.id);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveResult(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      selectActiveResult();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="command-menu-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="command-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-menu__search">
          <XiaoIcon name="search" size={19} />
          <input
            ref={input}
            value={query}
            placeholder="Find a task or action"
            aria-label="Search tasks and actions"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <button onClick={onClose} aria-label="Close command menu">
            <XiaoIcon name="close" size={16} />
          </button>
        </div>

        <div className="command-menu__context">
          <span>{workspace.name.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{workspace.name}</strong>
            <small>{workspace.path}</small>
          </div>
        </div>

        <div className="command-menu__results" id="command-menu-results">
          <header>Jump to</header>
          {filtered.actions.map((action, index) => {
            return (
              <button
                className={activeIndex === index ? "is-active" : undefined}
                key={action.id}
                ref={(node) => {
                  resultButtons.current[index] = node;
                }}
                onClick={() => onSelectView(action.view)}
                onFocus={() => setActiveIndex(index)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span><XiaoIcon name={action.icon} size={17} /></span>
                <strong>{action.label}</strong>
                <small>{action.hint}</small>
                <XiaoIcon name="caret" size={14} />
              </button>
            );
          })}
          {filtered.tasks.length > 0 && <header>Tasks</header>}
          {filtered.tasks.map((task, taskIndex) => {
            const index = filtered.actions.length + taskIndex;
            return (
              <button
                className={activeIndex === index ? "is-active" : undefined}
                key={task.id}
                ref={(node) => {
                  resultButtons.current[index] = node;
                }}
                onClick={() => onSelectTask(task.id)}
                onFocus={() => setActiveIndex(index)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span><XiaoIcon name="taskQueue" size={17} /></span>
                <strong>{task.title}</strong>
                <small>{task.archived ? "Archived" : task.meta}</small>
                <XiaoIcon name="caret" size={14} />
              </button>
            );
          })}
          {filtered.actions.length === 0 && filtered.tasks.length === 0 && (
            <div className="command-menu__empty">
              <strong>No matching action</strong>
              <p>Try a task title, "runtime", or "changes".</p>
            </div>
          )}
        </div>

        <footer>
          <span>{workspace.name}</span>
          <span><kbd>↑↓</kbd> navigate <kbd>Enter</kbd> open <kbd>Esc</kbd> close</span>
        </footer>
      </section>
    </div>
  );
}
