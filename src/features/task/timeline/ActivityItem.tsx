import { memo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { XiaoIcon, type XiaoIconName } from "../../../components/icons/XiaoIcon";
import { isTauriHost } from "../../../core/bridges/tauri";
import { visiblePromptFromSelectedContext, type TimelineEntry } from "../../../core/models/agent";
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
  isLive?: boolean;
};

const isEnvironmentBlockedCommand = (entry: TimelineEntry): boolean => {
  if (entry.kind !== "command" || entry.status !== "error") return false;
  return /spawn\s+(?:eperm|eacces)/.test(entry.body?.toLowerCase() ?? "");
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
  isLive,
  onOpenResource,
}: {
  entry: TimelineEntry;
  index: number;
  isLive: boolean;
  onOpenResource: (target: string) => boolean;
}) {
  const active = isLive && entry.status === "active";

  return (
    <article
      className={`activity activity--reasoning activity--${entry.status ?? "idle"}`}
      style={{ "--activity-index": index } as React.CSSProperties}
      aria-busy={active}
    >
      {entry.body ? (
        <MarkdownBody
          content={entry.body}
          streaming={active}
          onOpenResource={onOpenResource}
        />
      ) : null}
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
  isLive = true,
}: ActivityItemProps) {
  const waitingForApproval = entry.kind === "approval" && entry.status === "warning";
  const userMessage = entry.kind === "brief" || entry.kind === "user";
  const assistantMessage = entry.kind === "result" && entry.title === "Agent response";
  const contextCompaction = entry.kind === "result" && entry.meta === "Context";
  const browserTool = entry.kind === "result" && entry.meta?.toLowerCase() === "browser tool";

  if (entry.kind === "thought" && entry.status !== "active" && !entry.body?.trim()) return null;

  if (entry.kind === "thought" && !showReasoningSummaries) {
    if (entry.status !== "active" || !isLive) return null;
    const heading = reasoningHeading(entry.body);
    return (
      <article
        className="activity activity--thinking-projection"
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <strong className="is-active">Thinking</strong>
        {heading && <span>{heading}</span>}
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
          <div className="activity__user-bubble">
            {visiblePromptFromSelectedContext(entry.body ?? entry.title)}
          </div>
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
                className={entry.status === "active" && isLive ? "spin" : undefined}
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
    const streaming = entry.status === "active" && isLive;
    return (
      <article
        className="activity activity--assistant-message"
        style={{ "--activity-index": index } as React.CSSProperties}
        aria-busy={streaming}
      >
        <div className="activity__assistant-message">
          {entry.body && <MarkdownBody content={entry.body} streaming={streaming} onOpenResource={onOpenResource} />}
          {entry.body && !streaming ? (
            <footer className="activity__assistant-meta">
              <CopyButton text={entry.body} label="Copy response" />
              <span>{entry.meta && entry.meta !== "Streaming" ? entry.meta : "Xiao"}</span>
            </footer>
          ) : null}
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

  if (browserTool) {
    const query = entry.title.replace(/^Searched:\s*/i, "").trim();
    return (
      <article
        className={`activity activity--command activity--${entry.status ?? "success"}`}
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <div className="activity__tool-disclosure activity__tool-disclosure--static">
          <div className="activity__tool-summary-row">
            <span className="activity__tool-summary">
              <strong>Web search</strong>
              {query && query !== "Web search" ? <span title={query}>{query}</span> : null}
            </span>
          </div>
        </div>
      </article>
    );
  }

  if (contextCompaction) {
    const active = entry.status === "active" && isLive;
    const label = active
      ? "Compacting session"
      : entry.status === "active"
        ? "Session compaction stopped"
      : entry.status === "error" || entry.status === "warning"
        ? "Session compaction failed"
        : "Session compacted";
    return (
      <article
        className={`activity activity--context-compaction activity--${entry.status ?? "idle"}`}
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <div className="context-compaction" role="status" aria-live="polite" aria-busy={active}>
          <span className="context-compaction__line" aria-hidden="true" />
          <strong className={active ? "is-active" : undefined}>{label}</strong>
          <span className="context-compaction__line" aria-hidden="true" />
        </div>
      </article>
    );
  }

  if (entry.kind === "thought") {
    return (
      <ReasoningActivity
        entry={entry}
        index={index}
        isLive={isLive}
        onOpenResource={onOpenResource}
      />
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
              {entry.status === "active" && isLive
                ? "Working"
                : entry.status === "active"
                  ? "Stopped"
                  : entry.status === "error"
                    ? "Needs attention"
                    : "Done"}
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
    const active = entry.status === "active" && isLive;
    const toolTitle = environmentBlocked
      ? "Shell blocked"
      : entry.status === "error"
        ? "Shell failed"
        : entry.command
          ? "Shell"
          : entry.title;
    const terminalText = entry.command
      ? `$ ${entry.command}${entry.body ? `\n\n${entry.body}` : ""}`
      : entry.body ?? "";
    const summary = (
      <>
        <span className="activity__tool-summary">
          <strong className={active ? "is-active" : undefined}>{toolTitle}</strong>
          {entry.command ? <span title={toolDetail}>{toolDetail}</span> : null}
          {attemptCount > 1 && (
            <small className="activity__tool-attempts">{attemptCount} attempts</small>
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
              {terminalText && (
                <div className="activity__terminal">
                  <span className="activity__terminal-copy"><CopyButton text={terminalText} /></span>
                  <pre tabIndex={0} aria-label="Shell output"><code>{terminalText}</code></pre>
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
    const verb = entry.status === "error" ? "Edit failed" : "Edit";
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
            const directory = file.path.split(/[\\/]/).slice(0, -1).join("/");
            const firstChangedLine = lines.find((line) => line.kind === "add" || line.kind === "delete");
            const lineNumber = firstChangedLine?.newLine ?? firstChangedLine?.oldLine;
            return (
              <details key={file.path} open={expandToolOutput}>
                <summary>
                  <span className="patch-activity__title">
                    <strong className={`patch-activity__verb${entry.status === "active" && isLive ? " is-active" : ""}`}>
                      {verb}
                    </strong>
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
                      {directory ? <small>{directory}</small> : null}
                      {lineNumber ? <small>line {lineNumber}</small> : null}
                    </span>
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
          {entry.status === "active" && isLive && <i className="activity__pulse" />}
          {entry.body && (
            <span className="activity__header-action">
              <CopyButton text={entry.body} />
            </span>
          )}
        </header>
        <h2>{entry.title}</h2>
        {entry.body && (
          <MarkdownBody
            content={entry.body}
            streaming={entry.status === "active" && isLive}
            onOpenResource={onOpenResource}
          />
        )}
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
