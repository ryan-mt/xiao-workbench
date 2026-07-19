import type { ReactNode } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { TimelineEntry } from "../../../core/models/agent";

type ExecutionGroupProps = {
  entries: TimelineEntry[];
  index: number;
  expandByDefault: boolean;
  children: ReactNode;
};

export function ExecutionGroup({
  entries,
  index,
  expandByDefault,
  children,
}: ExecutionGroupProps) {
  const active = entries.some((entry) => entry.status === "active");
  const failed = entries.some((entry) => entry.status === "error");
  const withOutput = entries.filter((entry) => Boolean(entry.body?.trim())).length;
  const detail = [
    `${entries.length} command${entries.length === 1 ? "" : "s"}`,
    withOutput ? `${withOutput} output${withOutput === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <article
      className={`activity execution-group ${active ? "is-active" : ""} ${failed ? "is-error" : ""}`}
      style={{ "--activity-index": index } as React.CSSProperties}
    >
      <details open={active || expandByDefault}>
        <summary>
          <span className="execution-group__mark">
            <XiaoIcon name="command" size={13} />
          </span>
          <strong>{failed ? "Execution needs attention" : active ? "Executing" : "Executed"}</strong>
          <span>{detail}</span>
          <XiaoIcon className="execution-group__caret" name="caret" size={12} />
        </summary>
        <div className="execution-group__items">{children}</div>
      </details>
    </article>
  );
}
