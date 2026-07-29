import { useEffect, useMemo, useState } from "react";

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
  onFork,
  copyLabel = "Copy message",
}: {
  text: string;
  createdAt?: number;
  editable?: boolean;
  onEdit?: (text: string) => void;
  onFork?: () => void;
  copyLabel?: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (typeof createdAt !== "number") return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [createdAt]);
  const timestamp = useMemo(
    () => typeof createdAt === "number" ? {
      relative: relativeTime(createdAt, now),
      exact: exactFormatter.format(createdAt),
    } : null,
    [createdAt, now],
  );

  return (
    <footer className="message-actions">
      <CopyButton text={text} label={copyLabel} />
      {onFork ? (
        <button type="button" title="Fork from here" onClick={onFork}>
          <XiaoIcon name="branch" size={12} />
          <span>Fork</span>
        </button>
      ) : null}
      {editable && onEdit ? (
        <button type="button" title="Edit this prompt in the composer" onClick={() => onEdit(text)}>
          <XiaoIcon name="mutation" size={12} />
          <span>Edit</span>
        </button>
      ) : null}
      {timestamp ? <time dateTime={new Date(createdAt!).toISOString()} title={timestamp.exact}>{timestamp.relative}</time> : null}
    </footer>
  );
}

export function InlineMessageEditor({
  text,
  onCancel,
  onSubmit,
}: {
  text: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(text);
  return (
    <form
      className="message-edit"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim()) onSubmit(draft.trim());
      }}
    >
      <textarea
        value={draft}
        autoFocus
        aria-label="Edit prompt"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      />
      <span>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="is-primary" type="submit" disabled={!draft.trim()}>
          Use in composer
        </button>
      </span>
    </form>
  );
}
