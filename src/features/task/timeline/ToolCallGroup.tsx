import type { ReactNode } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { TimelineEntry } from "../../../core/models/agent";

export function ToolCallGroup({
  children,
  entries,
  expandByDefault,
  index,
  isLive = true,
}: {
  children: ReactNode;
  entries: TimelineEntry[];
  expandByDefault: boolean;
  index: number;
  isLive?: boolean;
}) {
  const active = isLive && entries.some((entry) => entry.status === "active");
  const failed = entries.filter((entry) =>
    entry.status === "error" || entry.status === "warning"
  ).length;
  const firstTitle = entries[0]?.title ?? "Tool calls";
  const sameTool = entries.every((entry) => entry.title === firstTitle);

  return (
    <article
      className={`activity tool-call-group${active ? " is-active" : ""}${failed ? " is-error" : ""}`}
      style={{ "--activity-index": index } as React.CSSProperties}
      aria-busy={active}
    >
      <details open={expandByDefault}>
        <summary>
          <strong className={active ? "is-active" : undefined}>
            {sameTool ? firstTitle : active ? "Using tools" : "Used tools"}
          </strong>
          <span className="tool-call-group__action">
            <span className="tool-call-group__show">
              Show {entries.length} calls{failed ? ` · ${failed} failed` : ""}
            </span>
            <span className="tool-call-group__hide">Hide calls</span>
          </span>
          <XiaoIcon className="tool-call-group__caret" name="caret" size={12} />
        </summary>
        <div className="tool-call-group__items">{children}</div>
      </details>
    </article>
  );
}
