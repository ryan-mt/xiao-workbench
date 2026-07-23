import { memo } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentExplorationAction, TimelineEntry } from "../../../core/models/agent";

type ExplorationGroupProps = {
  entries: TimelineEntry[];
  index: number;
  expandByDefault: boolean;
  isLive?: boolean;
};

const countLabel = (count: number, singular: string) =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

const actionLabel = (action: AgentExplorationAction) => {
  if (action.kind === "read") return "Read";
  if (action.kind === "search") return "Searched";
  return "Listed";
};

export const ExplorationGroup = memo(function ExplorationGroup({
  entries,
  index,
  expandByDefault,
  isLive = true,
}: ExplorationGroupProps) {
  const actions = entries.flatMap((entry) =>
    (entry.exploration ?? []).map((action) => ({
      action,
      entryId: entry.id,
      status: entry.status,
    })),
  );
  const reads = actions.filter(({ action }) => action.kind === "read").length;
  const searches = actions.filter(({ action }) => action.kind === "search").length;
  const lists = actions.filter(({ action }) => action.kind === "list").length;
  const active = isLive && entries.some((entry) => entry.status === "active");
  const failed = entries.some((entry) => entry.status === "error");
  const counts = [
    reads ? countLabel(reads, "read") : null,
    searches ? countLabel(searches, "search") : null,
    lists ? countLabel(lists, "list") : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <article
      className={`activity context-tool-group ${active ? "is-active" : ""} ${failed ? "is-error" : ""}`}
      style={{ "--activity-index": index } as React.CSSProperties}
      aria-busy={active}
    >
      <details open={expandByDefault}>
        <summary>
          <span className={`context-tool-group__status${active ? " is-active" : ""}`}>
            {active ? "Gathering context" : "Gathered context"}
          </span>
          <span className="context-tool-group__summary">
            {counts.join(", ") || countLabel(entries.length, "action")}
          </span>
          <XiaoIcon className="context-tool-group__caret" name="caret" size={12} />
        </summary>
        <div className="context-tool-group__items">
          {actions.map(({ action, entryId, status }, actionIndex) => (
            <div
              className={`context-tool-group__item is-${status ?? "idle"}`}
              key={`${entryId}-${actionIndex}-${action.command}`}
              title={action.command}
            >
              <strong className={status === "active" && isLive ? "is-active" : undefined}>
                {actionLabel(action)}
              </strong>
              <span>{action.kind === "search" ? action.query || action.label : action.label}</span>
              {action.path && action.path !== action.label ? <code>{action.path}</code> : null}
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}, (previous, next) =>
  previous.index === next.index &&
  previous.expandByDefault === next.expandByDefault &&
  previous.isLive === next.isLive &&
  previous.entries.length === next.entries.length &&
  previous.entries.every((entry, index) => entry === next.entries[index])
);
