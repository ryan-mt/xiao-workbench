import { useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { TimelineEntry } from "../../../core/models/agent";
import { MarkdownBody } from "./MarkdownBody";
import { formatThoughtDuration, reasoningSummary } from "./reasoningSummary";

export function ThinkingBlock({
  entry,
  live,
  showBody,
  onOpenResource,
}: {
  entry: TimelineEntry;
  live: boolean;
  showBody: boolean;
  onOpenResource: (target: string) => boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = live && entry.status === "active";
  const { title, body } = reasoningSummary(entry.body ?? "");
  const durationLabel =
    !active && typeof entry.durationMs === "number" && entry.durationMs >= 0
      ? formatThoughtDuration(entry.durationMs)
      : null;
  const canExpand = showBody && Boolean(body.trim());
  const open = canExpand && expanded;

  const label = (
    <>
      <strong className={active ? "is-active" : undefined}>
        {active ? "Thinking" : "Thought"}
      </strong>
      {title ? <span className="thinking-block__topic">{title}</span> : null}
      {durationLabel ? (
        <span className="thinking-block__duration">· {durationLabel}</span>
      ) : null}
      {canExpand ? (
        <XiaoIcon className="thinking-block__caret" name="caret" size={12} />
      ) : null}
    </>
  );

  return (
    <div
      className={`thinking-block${active ? " is-live" : ""}${open ? " is-open" : ""}`}
      id={`timeline-entry-${entry.id}`}
    >
      {canExpand ? (
        <button
          className="thinking-block__header"
          type="button"
          aria-expanded={open}
          onClick={() => setExpanded((value) => !value)}
        >
          {label}
        </button>
      ) : (
        <div className="thinking-block__header" role="status">
          {label}
        </div>
      )}
      {open ? (
        <div className="thinking-block__body">
          <MarkdownBody
            content={body}
            streaming={active}
            onOpenResource={onOpenResource}
          />
        </div>
      ) : null}
    </div>
  );
}
