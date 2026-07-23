import type { ReactNode } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { TimelineEntry } from "../../../core/models/agent";

const commandToolName = (command: string) => {
  const payload = /(?:^|\s)(?:-Command|\/c)\s+(?:"|')?(.+)$/i.exec(command)?.[1] ?? command;
  return payload
    .match(/^\s*(?:&\s*)?["']?([^\s"';&|]+)/)?.[1]
    ?.split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
    .toLowerCase() ?? "shell";
};

const toolIdentity = (entry: TimelineEntry) =>
  entry.command
    ? `shell:${commandToolName(entry.command)}`
    : `${entry.meta ?? "tool"}:${entry.title}`.toLowerCase();

export const toolCallRecovery = (entries: TimelineEntry[]) => {
  const recoveredIds = new Set<string>();
  let unresolvedCount = 0;

  entries.forEach((entry, index) => {
    if (entry.status !== "error" && entry.status !== "warning") return;
    const identity = toolIdentity(entry);
    const recovered = entries
      .slice(index + 1)
      .some((candidate) =>
        candidate.status === "success" && toolIdentity(candidate) === identity
      );
    if (recovered) recoveredIds.add(entry.id);
    else unresolvedCount += 1;
  });

  return {
    recoveredIds,
    recoveredCount: recoveredIds.size,
    unresolvedCount,
  };
};

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
  const recovery = toolCallRecovery(entries);
  const failed = recovery.unresolvedCount;
  const recovered = recovery.recoveredCount;
  const firstTitle = entries[0]?.title ?? "Tool calls";
  const sameTool = entries.every((entry) => entry.title === firstTitle);
  const statusSummary = failed
    ? ` · ${failed} failed${recovered ? ` · ${recovered} recovered` : ""}`
    : recovered
      ? ` · ${recovered} recovered`
      : "";

  return (
    <article
      className={`activity tool-call-group${active ? " is-active" : ""}${failed ? " is-error" : ""}${recovered && !failed ? " is-recovered" : ""}`}
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
              Show {entries.length} calls{statusSummary}
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
