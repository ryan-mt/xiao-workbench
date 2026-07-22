import {
  Fragment,
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
  description: string;
  group: "Current task" | "Workspace" | "System" | "Automation";
  icon: XiaoIconName;
  view: FocusView;
}> = [
  { id: "plan", label: "Task plan", description: "Review steps and progress", group: "Current task", icon: "plan", view: "plan" },
  { id: "changes", label: "Working changes", description: "Inspect the current diff", group: "Current task", icon: "changes", view: "changes" },
  { id: "context", label: "Session context", description: "Review context and usage", group: "Current task", icon: "result", view: "context" },
  { id: "files", label: "Workspace files", description: "Browse and open project files", group: "Workspace", icon: "files", view: "files" },
  { id: "browser", label: "Research browser", description: "Open the embedded browser", group: "Workspace", icon: "browser", view: "browser" },
  { id: "terminal", label: "Workspace terminal", description: "Run commands in this project", group: "Workspace", icon: "terminal", view: "terminal" },
  { id: "extensions", label: "Plugins and skills", description: "Manage installed capabilities", group: "System", icon: "capability", view: "extensions" },
  { id: "runtime", label: "Native runtime", description: "Inspect local runtime services", group: "System", icon: "runtime", view: "runtime" },
  { id: "schedule", label: "Background task", description: "Schedule work for later", group: "Automation", icon: "routine", view: "schedule" },
  { id: "run", label: "Xiao Break", description: "Take a short reset", group: "Automation", icon: "game", view: "run" },
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
            placeholder="Search tasks and commands"
            aria-label="Search tasks and actions"
            aria-controls="command-menu-results"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <button onClick={onClose} aria-label="Close command menu">
            <XiaoIcon name="close" size={16} />
          </button>
        </div>

        <div className="command-menu__context">
          <span><XiaoIcon name="folder" size={16} /></span>
          <div>
            <strong>{workspace.name}</strong>
            <small>{workspace.path}</small>
          </div>
          <em>Workspace</em>
        </div>

        <div className="command-menu__results" id="command-menu-results">
          {filtered.actions.map((action, index) => {
            const previousAction = filtered.actions[index - 1];
            return (
              <Fragment key={action.id}>
                {action.group !== previousAction?.group ? <header>{action.group}</header> : null}
                <button
                  className={activeIndex === index ? "is-active" : undefined}
                  ref={(node) => {
                    resultButtons.current[index] = node;
                  }}
                  onClick={() => onSelectView(action.view)}
                  onFocus={() => setActiveIndex(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className="command-menu__result-icon">
                    <XiaoIcon name={action.icon} size={17} />
                  </span>
                  <span className="command-menu__result-copy">
                    <strong>{action.label}</strong>
                    <small>{action.description}</small>
                  </span>
                  <kbd className="command-menu__result-key">Enter</kbd>
                </button>
              </Fragment>
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
                <span className="command-menu__result-icon">
                  <XiaoIcon name="taskQueue" size={17} />
                </span>
                <span className="command-menu__result-copy">
                  <strong>{task.title}</strong>
                  <small>{task.archived ? "Archived" : task.meta}</small>
                </span>
                <kbd className="command-menu__result-key">Enter</kbd>
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
          <span>{query ? `${resultCount} ${resultCount === 1 ? "result" : "results"}` : `${actions.length} commands`}</span>
          <span><kbd>&uarr;&darr;</kbd> navigate <kbd>Enter</kbd> open <kbd>Esc</kbd> close</span>
        </footer>
      </section>
    </div>
  );
}
