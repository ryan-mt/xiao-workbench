import type { ReactNode } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { TimelineEntry } from "../../../core/models/agent";
import {
  compactCommandAttempts,
  isEnvironmentBlockedCommand,
} from "./commandPresentation";

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
  const attempts = compactCommandAttempts(entries);
  const presentedEntries = attempts.map((attempt) => attempt.entry);
  const active = presentedEntries.some((entry) => entry.status === "active");
  const failedEntries = presentedEntries.filter((entry) => entry.status === "error");
  const failed = !active && failedEntries.some((entry) => !isEnvironmentBlockedCommand(entry));
  const blocked = !active && !failed && failedEntries.some(isEnvironmentBlockedCommand);
  const retries = entries.length - attempts.length;
  const withOutput = entries.filter((entry) => Boolean(entry.body?.trim())).length;
  const detail = [
    `${attempts.length} command${attempts.length === 1 ? "" : "s"}`,
    retries ? `${retries} retr${retries === 1 ? "y" : "ies"}` : null,
    withOutput ? `${withOutput} output${withOutput === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <article
      className={`activity execution-group ${active ? "is-active" : ""} ${failed ? "is-error" : ""} ${blocked ? "is-warning" : ""}`}
      style={{ "--activity-index": index } as React.CSSProperties}
    >
      <details open={expandByDefault}>
        <summary>
          <span className="execution-group__mark">
            <XiaoIcon name="command" size={13} />
          </span>
          <strong>{active ? "Executing" : failed ? "Executed with errors" : blocked ? "Environment blocked" : "Executed"}</strong>
          <span>{detail}</span>
          <XiaoIcon className="execution-group__caret" name="caret" size={12} />
        </summary>
        <div className="execution-group__items">{children}</div>
      </details>
    </article>
  );
}
