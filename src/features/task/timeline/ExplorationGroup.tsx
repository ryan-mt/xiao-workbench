import { XiaoIcon, type XiaoIconName } from "../../../components/icons/XiaoIcon";
import type { AgentExplorationAction, TimelineEntry } from "../../../core/models/agent";

type ExplorationGroupProps = {
  entries: TimelineEntry[];
  index: number;
  expandByDefault: boolean;
};

const iconByAction: Record<AgentExplorationAction["kind"], XiaoIconName> = {
  list: "folderOpen",
  read: "file",
  search: "search",
};

const countLabel = (count: number, singular: string) =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

const actionLabel = (action: AgentExplorationAction) => {
  if (action.kind === "read") return "Read";
  if (action.kind === "search") return "Searched";
  return "Listed";
};

export function ExplorationGroup({ entries, index, expandByDefault }: ExplorationGroupProps) {
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
  const active = entries.some((entry) => entry.status === "active");
  const failed = entries.some((entry) => entry.status === "error");
  const counts = [
    reads ? countLabel(reads, "read") : null,
    searches ? countLabel(searches, "search") : null,
    lists ? countLabel(lists, "list") : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <article
      className={`activity exploration-group ${active ? "is-active" : ""} ${failed ? "is-error" : ""}`}
      style={{ "--activity-index": index } as React.CSSProperties}
    >
      <details open={active || expandByDefault}>
        <summary>
          <span className="exploration-group__mark">
            <XiaoIcon name="search" size={13} />
          </span>
          <strong>{active ? "Exploring" : "Explored"}</strong>
          <span>{counts.join(", ") || countLabel(entries.length, "action")}</span>
          {active ? <i className="activity__pulse" /> : null}
          <XiaoIcon className="exploration-group__caret" name="caret" size={12} />
        </summary>
        <div className="exploration-group__items">
          {actions.map(({ action, entryId, status }, actionIndex) => (
            <div
              className={`exploration-group__item is-${status ?? "idle"}`}
              key={`${entryId}-${actionIndex}-${action.command}`}
              title={action.command}
            >
              <span><XiaoIcon name={iconByAction[action.kind]} size={13} /></span>
              <div>
                <strong>{actionLabel(action)}</strong>
                <code>{action.kind === "search" ? action.query || action.label : action.label}</code>
                {action.path && action.path !== action.label ? <small>{action.path}</small> : null}
              </div>
              {status === "active" ? <i className="activity__pulse" /> : null}
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}
