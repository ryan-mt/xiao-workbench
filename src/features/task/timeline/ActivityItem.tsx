import { memo, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { XiaoIcon, type XiaoIconName } from "../../../components/icons/XiaoIcon";
import { isTauriHost } from "../../../core/bridges/tauri";
import type { TimelineEntry } from "../../../core/models/agent";
import { isEnvironmentBlockedCommand } from "./commandPresentation";
import { CopyButton, MarkdownBody } from "./MarkdownBody";

type ActivityItemProps = {
  entry: TimelineEntry;
  index: number;
  showReasoningSummaries: boolean;
  expandToolOutput: boolean;
  workspacePath: string;
  onOpenResource: (target: string) => boolean;
  taskId: string;
  canFork: boolean;
  onForkTask: (entryId: string) => void;
  onResolveApproval: (
    taskId: string,
    entryId: string,
    requestId: number | string,
    decision: "accept" | "decline",
  ) => Promise<void>;
  onReviewChanges: () => void;
  turnFiles?: NonNullable<TimelineEntry["files"]>;
  canUndo?: boolean;
  undoing?: boolean;
  onUndo?: () => void;
  attemptCount?: number;
};

const iconByKind: Record<TimelineEntry["kind"], XiaoIconName> = {
  brief: "brief",
  thought: "approach",
  command: "command",
  explore: "search",
  change: "mutation",
  result: "result",
  approval: "approval",
  user: "user",
  agent: "cpu",
};

const collaboratorStatusLabel: Record<NonNullable<TimelineEntry["collaborators"]>[number]["status"], string> = {
  pendingInit: "Starting",
  running: "Working",
  interrupted: "Interrupted",
  completed: "Completed",
  errored: "Failed",
  shutdown: "Closed",
  notFound: "Not found",
  unknown: "Status unavailable",
};

type PatchLine = {
  kind: "add" | "delete" | "context" | "meta" | "fold";
  text: string;
  oldLine?: number;
  newLine?: number;
};

const patchLines = (patch: string): PatchLine[] => {
  const result: PatchLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let initialized = false;

  for (const line of patch.replace(/\r\n?/g, "\n").split("\n")) {
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      const nextOld = Number(hunk[1]);
      const nextNew = Number(hunk[2]);
      const hidden = initialized
        ? Math.max(0, Math.min(nextOld - oldLine, nextNew - newLine))
        : Math.max(0, Math.min(nextOld - 1, nextNew - 1));
      if (hidden > 0) result.push({ kind: "fold", text: `${hidden} unmodified lines` });
      oldLine = nextOld;
      newLine = nextNew;
      initialized = true;
      result.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }
    if (line.startsWith("+")) {
      result.push({ kind: "add", text: line.slice(1), newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      result.push({ kind: "delete", text: line.slice(1), oldLine });
      oldLine += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      result.push({ kind: "meta", text: line });
      continue;
    }
    result.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }
  return result;
};

const reasoningHeading = (body?: string) =>
  body
    ?.match(/(?:^|\n)\s*(?:#{1,6}\s+|\*\*|__)?([^\n*_]{3,80})/)?.[1]
    ?.trim();

const ReasoningActivity = memo(function ReasoningActivity({
  entry,
  index,
  onOpenResource,
}: {
  entry: TimelineEntry;
  index: number;
  onOpenResource: (target: string) => boolean;
}) {
  const active = entry.status === "active";
  const [open, setOpen] = useState(active);
  const heading = reasoningHeading(entry.body);

  useEffect(() => {
    setOpen(active);
  }, [active, entry.id]);

  return (
    <article
      className={`activity activity--reasoning activity--${entry.status ?? "idle"}`}
      style={{ "--activity-index": index } as React.CSSProperties}
    >
      <details
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <span className="activity__reasoning-mark">
            <XiaoIcon name="approach" size={13} />
          </span>
          <span className="activity__reasoning-summary">
            <strong>{active ? "Thinking" : "Thought process"}</strong>
            {heading && <span>{heading}</span>}
          </span>
          <span className={`activity__reasoning-state is-${active ? "live" : "done"}`}>
            {active ? <i className="activity__pulse" /> : <XiaoIcon name="check" size={11} />}
            {active ? "Live" : "Done"}
          </span>
          {entry.body ? <XiaoIcon className="activity__reasoning-caret" name="caret" size={12} /> : null}
        </summary>
        {entry.body && (
          <div className="activity__reasoning-content">
            <MarkdownBody
              content={entry.body}
              streaming={active}
              onOpenResource={onOpenResource}
            />
          </div>
        )}
      </details>
    </article>
  );
});

export const ActivityItem = memo(function ActivityItem({
  entry,
  index,
  showReasoningSummaries,
  expandToolOutput,
  workspacePath,
  onOpenResource,
  taskId,
  canFork,
  onForkTask,
  onResolveApproval,
  onReviewChanges,
  turnFiles = [],
  canUndo = false,
  undoing = false,
  onUndo,
  attemptCount = 1,
}: ActivityItemProps) {
  const waitingForApproval = entry.kind === "approval" && entry.status === "warning";
  const userMessage = entry.kind === "brief" || entry.kind === "user";
  const assistantMessage = entry.kind === "result" && entry.title === "Agent response";
  const contextCompaction = entry.kind === "result" && entry.meta === "Context";

  if (entry.kind === "thought" && entry.status !== "active" && !entry.body?.trim()) return null;

  if (entry.kind === "thought" && !showReasoningSummaries) {
    if (entry.status !== "active") return null;
    const heading = reasoningHeading(entry.body);
    return (
      <article
        className="activity activity--thinking-projection"
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <XiaoIcon name="approach" size={13} />
        <strong>Working through it</strong>
        {heading && <span>{heading}</span>}
        <i className="activity__pulse" />
      </article>
    );
  }

  if (userMessage) {
    const reviewComments = entry.attachments?.filter((attachment) => attachment.kind === "review") ?? [];
    const sentAttachments = entry.attachments?.filter((attachment) => attachment.kind !== "review") ?? [];
    return (
      <article
        className="activity activity--user-message"
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <div className="activity__user-message-content">
          <div className="activity__user-bubble">{entry.body ?? entry.title}</div>
          {sentAttachments.length > 0 && (
            <div className="activity__user-attachments" aria-label="Sent attachments">
              {sentAttachments.map((attachment) => {
                const imageSource = attachment.kind === "image"
                  ? attachment.url ?? (
                    !attachment.path.startsWith("clipboard:") && isTauriHost()
                      ? convertFileSrc(attachment.path)
                      : ""
                  )
                  : "";
                return (
                  <span
                    className={`activity__user-attachment${imageSource ? " is-image" : ""}`}
                    key={attachment.id ?? attachment.path}
                    title={attachment.path}
                  >
                    {imageSource ? (
                      <img src={imageSource} alt={attachment.name} />
                    ) : (
                      <XiaoIcon name={attachment.kind === "directory" ? "folder" : "file"} size={14} />
                    )}
                    <span>{attachment.name}</span>
                  </span>
                );
              })}
            </div>
          )}
          {entry.kind === "user" && entry.meta ? (
            <span className={`activity__user-state is-${entry.status ?? "idle"}`}>
              <XiaoIcon
                className={entry.status === "active" ? "spin" : undefined}
                name={entry.status === "error" ? "close" : entry.status === "success" ? "check" : "pending"}
                size={11}
              />
              {entry.meta}
            </span>
          ) : null}
          {reviewComments.length > 0 && (
            <div className="activity__review-comments">
              {reviewComments.map((comment) => {
                const start = comment.lineStart;
                const end = comment.lineEnd ?? start;
                return (
                  <article key={comment.id ?? `${comment.path}:${start}:${end}`}>
                    <strong>
                      <XiaoIcon name="file" size={12} />
                      {comment.path}{start ? `:${start}${end !== start ? `-${end}` : ""}` : ""}
                    </strong>
                    <p>{comment.comment}</p>
                  </article>
                );
              })}
            </div>
          )}
          {entry.kind === "user" && canFork ? (
            <div className="activity__user-actions">
              <button
                type="button"
                title="Create a new task from the conversation before this prompt"
                onClick={() => onForkTask(entry.id)}
              >
                <XiaoIcon name="branch" size={12} />
                Fork from here
              </button>
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  if (assistantMessage) {
    const streaming = entry.status === "active";
    return (
      <article
        className="activity activity--assistant-message"
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <div className="activity__assistant-message">
          <header className="activity__assistant-header">
            <span className="activity__assistant-mark"><XiaoIcon name="result" size={13} /></span>
            <strong>{streaming ? "Writing response" : "Response"}</strong>
            {streaming ? <i className="activity__pulse" /> : null}
            {entry.body && !streaming ? (
              <span className="activity__assistant-copy"><CopyButton text={entry.body} /></span>
            ) : null}
          </header>
          {entry.body && <MarkdownBody content={entry.body} streaming={streaming} onOpenResource={onOpenResource} />}
          {turnFiles.length > 0 && (
            <nav className="turn-change-actions" aria-label="Actions for edited files">
              <button type="button" onClick={onReviewChanges}>
                <XiaoIcon name="changes" size={13} /> Review changes
              </button>
              {canUndo && onUndo ? (
                <button type="button" disabled={undoing} onClick={onUndo}>
                  <XiaoIcon className={undoing ? "spin" : undefined} name={undoing ? "pending" : "undo"} size={13} />
                  {undoing ? "Undoing" : "Undo"}
                </button>
              ) : null}
            </nav>
          )}
        </div>
      </article>
    );
  }

  if (contextCompaction) {
    return (
      <article
        className={`activity activity--context-compaction activity--${entry.status ?? "idle"}`}
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <div className="context-compaction" role="status" aria-live="polite">
          <span className="context-compaction__glyph" aria-hidden="true">
            <i />
            <i />
            <b />
          </span>
          <span className="context-compaction__copy">
            <strong>{entry.title}</strong>
            <small>{entry.status === "active" ? "Keeping the useful parts" : "Session context ready"}</small>
          </span>
          <span className="context-compaction__meter" aria-hidden="true"><i /></span>
          {entry.status === "active" ? (
            <span className="context-compaction__working" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          ) : (
            <XiaoIcon
              className={`context-compaction__state context-compaction__state--${entry.status ?? "idle"}`}
              name={entry.status === "success" ? "check" : "close"}
              size={15}
            />
          )}
        </div>
      </article>
    );
  }

  if (entry.kind === "thought") {
    return <ReasoningActivity entry={entry} index={index} onOpenResource={onOpenResource} />;
  }

  if (entry.kind === "agent") {
    const collaborators = entry.collaborators ?? [];
    return (
      <article
        className={`activity activity--agent activity--${entry.status ?? "idle"}`}
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <div className="agent-activity">
          <header>
            <span className="agent-activity__icon"><XiaoIcon name="cpu" size={14} /></span>
            <span className="agent-activity__heading">
              <strong>{entry.title}</strong>
              {entry.meta && <small>{entry.meta}</small>}
            </span>
            <span className={`agent-activity__state is-${entry.status ?? "idle"}`}>
              {entry.status === "active" ? "Working" : entry.status === "error" ? "Needs attention" : "Done"}
            </span>
          </header>
          {collaborators.length > 0 && (
            <ul className="agent-activity__agents">
              {collaborators.map((collaborator, collaboratorIndex) => (
                <li className={`is-${collaborator.status}`} key={collaborator.threadId}>
                  <span className="agent-activity__agent-state" aria-hidden="true">
                    {collaborator.status === "completed" || collaborator.status === "shutdown" ? (
                      <XiaoIcon name="check" size={11} />
                    ) : collaborator.status === "errored" || collaborator.status === "interrupted" || collaborator.status === "notFound" ? (
                      <XiaoIcon name="close" size={11} />
                    ) : (
                      <XiaoIcon name="pending" size={11} />
                    )}
                  </span>
                  <span>
                    <strong>Subagent {collaboratorIndex + 1}</strong>
                    <code title={collaborator.threadId}>{collaborator.threadId.slice(0, 12)}</code>
                    {collaborator.message && <small>{collaborator.message}</small>}
                  </span>
                  <em>{collaboratorStatusLabel[collaborator.status]}</em>
                </li>
              ))}
            </ul>
          )}
          {entry.body && (
            <details className="agent-activity__prompt">
              <summary>Delegated task <XiaoIcon name="caret" size={12} /></summary>
              <p>{entry.body}</p>
            </details>
          )}
        </div>
      </article>
    );
  }

  if (entry.kind === "command") {
    const environmentBlocked = isEnvironmentBlockedCommand(entry);
    const toolDetail = (entry.command ?? entry.title).replace(/\s+/g, " ").trim();
    const hasDetails = Boolean(entry.command || entry.body);
    const toolAction = entry.command
      ? entry.status === "active"
        ? "Running"
        : environmentBlocked
          ? "Blocked"
          : entry.status === "error"
            ? "Failed"
            : "Ran"
      : entry.status === "active"
        ? "Using"
        : environmentBlocked
          ? "Blocked"
          : entry.status === "error"
            ? "Failed"
            : "Used";
    const toolStateLabel = entry.status === "active"
      ? "In progress"
      : environmentBlocked
        ? "Blocked"
        : entry.status === "error"
          ? "Failed"
          : "Completed";
    const summary = (
      <>
        <span className="activity__tool-icon">
          <XiaoIcon name="command" size={14} />
        </span>
        <span className="activity__tool-summary">
          <strong>{toolAction}</strong>
          <code title={toolDetail}>{toolDetail}</code>
          {attemptCount > 1 && (
            <small className="activity__tool-attempts">{attemptCount} attempts</small>
          )}
        </span>
        <span className={`activity__tool-state is-${entry.status ?? "success"}`} aria-label={toolStateLabel} title={toolStateLabel}>
          {entry.status === "active" ? (
            <i className="activity__pulse" />
          ) : (
            <XiaoIcon name={entry.status === "error" ? "close" : "check"} size={11} />
          )}
        </span>
        {hasDetails && (
          <span className="activity__tool-caret">
            <XiaoIcon name="caret" size={13} />
          </span>
        )}
      </>
    );

    return (
      <article
        className={`activity activity--command activity--${environmentBlocked ? "warning" : entry.status ?? "idle"}`}
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        {hasDetails ? (
          <details className="activity__tool-disclosure" open={expandToolOutput}>
            <summary>{summary}</summary>
            <div className="activity__tool-details">
              {entry.meta && <div className="activity__tool-meta">{entry.meta}</div>}
              {entry.command && (
                <div className="command-block">
                  <header>
                    <span>Command</span>
                    <CopyButton text={entry.command} />
                  </header>
                  <pre><code>{entry.command}</code></pre>
                </div>
              )}
              {entry.body && (
                <div className="activity__result">
                  <header>
                    <span>Output</span>
                    <CopyButton text={entry.body} />
                  </header>
                  <pre>{entry.body}</pre>
                </div>
              )}
            </div>
          </details>
        ) : (
          <div className="activity__tool-disclosure activity__tool-disclosure--static">
            <div className="activity__tool-summary-row">{summary}</div>
          </div>
        )}
      </article>
    );
  }

  if (entry.kind === "change" && entry.files?.length) {
    const verb = entry.status === "active" ? "Editing" : entry.status === "error" ? "Edit failed" : "Edit";
    return (
      <article
        className={`activity activity--patch activity--${entry.status ?? "idle"}`}
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <div className="patch-activity__files">
          {entry.files.map((file) => {
            const lines = file.patch ? patchLines(file.patch) : [];
            const absolutePath = /^[A-Za-z]:[\\/]/.test(file.path)
              ? file.path
              : `${workspacePath.replace(/[\\/]+$/, "")}\\${file.path.replace(/\//g, "\\")}`;
            const displayPath = file.path.split(/[\\/]/).filter(Boolean).at(-1) ?? file.path;
            const firstChangedLine = lines.find((line) => line.kind === "add" || line.kind === "delete");
            const lineNumber = firstChangedLine?.newLine ?? firstChangedLine?.oldLine;
            return (
              <details key={file.path} open={expandToolOutput}>
                <summary>
                  <span className="patch-activity__file-icon">
                    <XiaoIcon name="mutation" size={14} />
                    {entry.status === "active" ? <i className="activity__pulse" /> : null}
                  </span>
                  <strong className="patch-activity__verb">{verb}</strong>
                  <span
                    className="patch-activity__path"
                    title={`Open ${absolutePath}`}
                    role="link"
                    tabIndex={0}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenResource(absolutePath);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenResource(absolutePath);
                    }}
                  >
                    <strong>{displayPath}</strong>
                    {lineNumber && <small>line {lineNumber}</small>}
                  </span>
                  <span className="patch-activity__stats"><b>+{file.additions}</b><em>-{file.deletions}</em></span>
                  <XiaoIcon className="patch-activity__caret" name="caret" size={13} />
                </summary>
                <div className="patch-activity__diff">
                  {lines.length ? lines.map((line, lineIndex) => (
                    <div className={`is-${line.kind}`} key={`${lineIndex}-${line.text}`}>
                      {line.kind === "fold" ? (
                        <span className="patch-activity__fold">{line.text}</span>
                      ) : (
                        <>
                          <span>{line.oldLine ?? ""}</span>
                          <span>{line.newLine ?? ""}</span>
                          <i>{line.kind === "add" ? "+" : line.kind === "delete" ? "-" : ""}</i>
                          <code>{line.text || " "}</code>
                        </>
                      )}
                    </div>
                  )) : (
                    <p>No textual patch is available for this file.</p>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </article>
    );
  }

  return (
    <article
      className={`activity activity--${entry.kind} activity--${entry.status ?? "idle"}`}
      style={{ "--activity-index": index } as React.CSSProperties}
    >
      <div className="activity__body">
        <header>
          <span className="activity__kind-icon">
            <XiaoIcon name={iconByKind[entry.kind]} size={14} />
          </span>
          <span>{entry.meta ?? entry.kind}</span>
          {entry.status === "active" && <i className="activity__pulse" />}
          {entry.body && (
            <span className="activity__header-action">
              <CopyButton text={entry.body} />
            </span>
          )}
        </header>
        <h2>{entry.title}</h2>
        {entry.body && <MarkdownBody content={entry.body} streaming={entry.status === "active"} onOpenResource={onOpenResource} />}
        {entry.files && (
          <div className="change-list">
            <header>
              <span><XiaoIcon name="changes" size={16} /> Changed {entry.files.length} files</span>
              <button onClick={onReviewChanges}>
                Review <XiaoIcon name="caret" size={14} />
              </button>
            </header>
            {entry.files.map((file) => (
              <button key={file.path} onClick={onReviewChanges}>
                <span>{file.path}</span>
                <small>
                  <b>+{file.additions}</b>
                  <em>-{file.deletions}</em>
                </small>
              </button>
            ))}
          </div>
        )}
        {waitingForApproval && entry.requestId != null && (
          <div className="approval-actions">
            <button
              className="button button--primary"
              onClick={() => void onResolveApproval(taskId, entry.id, entry.requestId!, "accept")}
            >
              <XiaoIcon name="check" size={15} />
              Allow once
            </button>
            <button
              className="button button--quiet"
              onClick={() => void onResolveApproval(taskId, entry.id, entry.requestId!, "decline")}
            >
              <XiaoIcon name="decline" size={15} />
              Decline
            </button>
          </div>
        )}
      </div>
    </article>
  );
});
