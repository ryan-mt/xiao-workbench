import { useMemo, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { CopyButton } from "./MarkdownBody";

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const exactFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

const relativeTime = (timestamp: number, now = Date.now()) => {
  const seconds = Math.round((timestamp - now) / 1_000);
  if (Math.abs(seconds) < 60) return relativeFormatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeFormatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormatter.format(hours, "hour");
  return relativeFormatter.format(Math.round(hours / 24), "day");
};

export function MessageActions({
  text,
  createdAt,
  editable = false,
  onEdit,
  copyLabel = "Copy message",
}: {
  text: string;
  createdAt?: number;
  editable?: boolean;
  onEdit?: (text: string) => void;
  copyLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const timestamp = useMemo(
    () => createdAt ? {
      relative: relativeTime(createdAt),
      exact: exactFormatter.format(createdAt),
    } : null,
    [createdAt],
  );

  if (editing) {
    return (
      <div className="message-edit">
        <textarea value={draft} autoFocus onChange={(event) => setDraft(event.target.value)} />
        <span>
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          <button
            className="is-primary"
            type="button"
            disabled={!draft.trim()}
            onClick={() => {
              onEdit?.(draft.trim());
              setEditing(false);
            }}
          >
            Use in composer
          </button>
        </span>
      </div>
    );
  }

  return (
    <footer className="message-actions">
      <CopyButton text={text} label={copyLabel} />
      {editable && onEdit ? (
        <button type="button" title="Edit this prompt in the composer" onClick={() => setEditing(true)}>
          <XiaoIcon name="mutation" size={12} />
          <span>Edit</span>
        </button>
      ) : null}
      {timestamp ? <time dateTime={new Date(createdAt!).toISOString()} title={timestamp.exact}>{timestamp.relative}</time> : null}
    </footer>
  );
}
