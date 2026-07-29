import { useMemo, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { TimelineEntry } from "../../../core/models/agent";

type ChangedFile = NonNullable<TimelineEntry["files"]>[number];
const previewLimit = 3;

export const workspaceRelativePath = (path: string, workspacePath: string) => {
  const normalized = path.replace(/\\/g, "/");
  const root = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized.replace(/^[A-Za-z]:\/+/, "").replace(/^\/+/, "");
};

const absolutePath = (path: string, workspacePath: string) =>
  /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/")
    ? path
    : `${workspacePath.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`;

export function EditedFilesSummary({
  files,
  workspacePath,
  canUndo,
  undoing,
  onUndo,
  onReview,
  onOpenResource,
}: {
  files: ChangedFile[];
  workspacePath: string;
  canUndo: boolean;
  undoing: boolean;
  onUndo?: () => void;
  onReview: () => void;
  onOpenResource: (target: string) => boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const totals = useMemo(() => files.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  ), [files]);
  const visible = expanded ? files : files.slice(0, previewLimit);
  const remaining = Math.max(0, files.length - previewLimit);

  return (
    <section className="edited-files" aria-label={`${files.length} edited files`}>
      <header>
        <span className="edited-files__icon"><XiaoIcon name="changes" size={16} /></span>
        <span className="edited-files__heading">
          <strong>Edited {files.length} {files.length === 1 ? "file" : "files"}</strong>
          <small><b>+{totals.additions}</b> <em>-{totals.deletions}</em></small>
        </span>
        <span className="edited-files__actions">
          {canUndo && onUndo ? (
            <button type="button" disabled={undoing} title="Undo these file changes" onClick={onUndo}>
              {undoing ? "Undoing" : "Undo"} <XiaoIcon className={undoing ? "spin" : undefined} name={undoing ? "pending" : "undo"} size={13} />
            </button>
          ) : null}
          <button className="is-outlined" type="button" title="Review all file changes" onClick={onReview}>
            Review
          </button>
        </span>
      </header>
      <div className="edited-files__list">
        {visible.map((file) => (
          <button
            type="button"
            className="edited-files__file"
            title={`Open ${workspaceRelativePath(file.path, workspacePath)}`}
            key={file.path}
            onClick={() => onOpenResource(absolutePath(file.path, workspacePath))}
          >
            <span>{workspaceRelativePath(file.path, workspacePath)}</span>
            <small><b>+{file.additions}</b> <em>-{file.deletions}</em></small>
          </button>
        ))}
      </div>
      {remaining > 0 ? (
        <button className="edited-files__toggle" type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show fewer files" : `Show ${remaining} more ${remaining === 1 ? "file" : "files"}`}
          <XiaoIcon className={expanded ? "is-expanded" : undefined} name="caret" size={13} />
        </button>
      ) : null}
    </section>
  );
}
