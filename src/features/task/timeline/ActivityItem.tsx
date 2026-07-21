import { memo } from "react";

import { XiaoIcon, type XiaoIconName } from "../../../components/icons/XiaoIcon";
import type { TimelineEntry } from "../../../core/models/agent";
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
        <strong>Thinking</strong>
        {heading && <span>{heading}</span>}
        <i className="activity__pulse" />
      </article>
    );
  }

  if (userMessage) {
    const reviewComments = entry.attachments?.filter((attachment) => attachment.kind === "review") ?? [];
    return (
      <article
        className="activity activity--user-message"
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <div className="activity__user-message-content">
          <div className="activity__user-bubble">{entry.body ?? entry.title}</div>
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
    const additions = turnFiles.reduce((sum, file) => sum + file.additions, 0);
    const deletions = turnFiles.reduce((sum, file) => sum + file.deletions, 0);
    return (
      <article
        className="activity activity--assistant-message"
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <div className="activity__assistant-message">
          {entry.body && <MarkdownBody content={entry.body} streaming={entry.status === "active"} onOpenResource={onOpenResource} />}
          {turnFiles.length > 0 && (
            <section className="turn-changes" aria-label={`Edited ${turnFiles.length} ${turnFiles.length === 1 ? "file" : "files"}`}>
              <header className="turn-changes__header">
                <span className="turn-changes__mark"><XiaoIcon name="changes" size={16} /></span>
                <span className="turn-changes__summary">
                  <strong>Edited {turnFiles.length} {turnFiles.length === 1 ? "file" : "files"}</strong>
                  <small><b>+{additions}</b><em>-{deletions}</em></small>
                </span>
                <span className="turn-changes__actions">
                  {canUndo && onUndo ? (
                    <button type="button" disabled={undoing} onClick={onUndo}>
                      {undoing ? "Undoing" : "Undo"}
                      <XiaoIcon name={undoing ? "pending" : "undo"} size={13} />
                    </button>
                  ) : null}
                  <button className="turn-changes__review" type="button" onClick={onReviewChanges}>
                    Review
                  </button>
                </span>
              </header>
              <div className="turn-changes__files">
                {turnFiles.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    title={`Open ${file.path}`}
                    onClick={() => onOpenResource(file.path)}
                  >
                    <span>{file.path}</span>
                    <small><b>+{file.additions}</b><em>-{file.deletions}</em></small>
                  </button>
                ))}
              </div>
            </section>
          )}
          {entry.body && (
            <div className="activity__assistant-actions">
              <CopyButton text={entry.body} />
            </div>
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
        <div className="context-compaction">
          <span className="context-compaction__glyph" aria-hidden="true">
            <i />
            <i />
            <b />
          </span>
          <span className="context-compaction__copy">
            <small>Session context</small>
            <strong>{entry.title}</strong>
          </span>
          {entry.status === "active" ? (
            <i className="activity__pulse" aria-hidden="true" />
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
    const heading = reasoningHeading(entry.body);
    return (
      <article
        className={`activity activity--reasoning activity--${entry.status ?? "idle"}`}
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <details>
          <summary>
            <XiaoIcon name="approach" size={13} />
            <strong>{entry.status === "active" ? "Thinking" : "Thought"}</strong>
            {heading && <span>{heading}</span>}
            {entry.status === "active" ? <i className="activity__pulse" /> : null}
            {entry.body ? <XiaoIcon className="activity__reasoning-caret" name="caret" size={12} /> : null}
          </summary>
          {entry.body && <div><MarkdownBody content={entry.body} streaming={entry.status === "active"} onOpenResource={onOpenResource} /></div>}
        </details>
      </article>
    );
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
    const toolDetail = (entry.command ?? entry.title).replace(/\s+/g, " ").trim();
    const hasDetails = Boolean(entry.command || entry.body);
    const toolAction = entry.command
      ? entry.status === "active"
        ? "Running"
        : entry.status === "error"
          ? "Failed"
          : "Ran"
      : entry.status === "active"
        ? "Using"
        : entry.status === "error"
          ? "Failed"
          : "Used";
    const summary = (
      <>
        <span className="activity__tool-icon">
          <XiaoIcon name="command" size={14} />
        </span>
        <span className="activity__tool-summary">
          <strong>{toolAction}</strong>
          <code title={toolDetail}>{toolDetail}</code>
        </span>
        {entry.status === "active" && <i className="activity__pulse" />}
        {hasDetails && (
          <span className="activity__tool-caret">
            <XiaoIcon name="caret" size={13} />
          </span>
        )}
      </>
    );

    return (
      <article
        className={`activity activity--command activity--${entry.status ?? "idle"}`}
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
    const additions = entry.files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = entry.files.reduce((sum, file) => sum + file.deletions, 0);
    return (
      <article
        className={`activity activity--patch activity--${entry.status ?? "idle"}`}
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <div className="patch-activity__heading">
          <strong>Patch</strong>
          <span>{entry.files.length} {entry.files.length === 1 ? "file" : "files"}</span>
          <small><b>+{additions}</b><em>-{deletions}</em></small>
        </div>
        <div className="patch-activity__files">
          {entry.files.map((file) => {
            const lines = file.patch ? patchLines(file.patch) : [];
            const absolutePath = /^[A-Za-z]:[\\/]/.test(file.path)
              ? file.path
              : `${workspacePath.replace(/[\\/]+$/, "")}\\${file.path.replace(/\//g, "\\")}`;
            const firstChangedLine = lines.find((line) => line.kind === "add" || line.kind === "delete");
            const lineNumber = firstChangedLine?.newLine ?? firstChangedLine?.oldLine;
            return (
              <details key={file.path} open={expandToolOutput}>
                <summary>
                  <span className="patch-activity__file-icon"><XiaoIcon name="mutation" size={14} /></span>
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
                    <strong>{absolutePath}</strong>
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
        <button className="patch-activity__review" type="button" onClick={onReviewChanges}>
          Open review <XiaoIcon name="external" size={12} />
        </button>
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
