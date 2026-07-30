import { memo, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { XiaoIcon, type XiaoIconName } from "../../../components/icons/XiaoIcon";
import { isTauriHost } from "../../../core/bridges/tauri";
import {
  replaceVisiblePromptInSelectedContext,
  visiblePromptFromSelectedContext,
  type AgentAttachment,
  type TimelineEntry,
} from "../../../core/models/agent";
import { CopyButton, MarkdownBody } from "./MarkdownBody";
import { InlineMessageEditor, MessageActions } from "./MessageActions";
import { MessageImage } from "./MessageImage";
import { ThinkingBlock } from "./ThinkingBlock";

const agentProgressDots = Array.from({ length: 25 }, (_, index) => ({
  index,
  x: 1.5 + (index % 5) * 3,
  y: 1.5 + Math.floor(index / 5) * 3,
  delay: ((index % 5) + Math.floor(index / 5)) * 70,
}));

function AgentProgressIndicator() {
  return (
    <svg
      className="agent-progress-indicator"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      {agentProgressDots.map((dot) => (
        <rect
          key={dot.index}
          x={dot.x}
          y={dot.y}
          width="2"
          height="2"
          style={{ animationDelay: `${dot.delay}ms` }}
        />
      ))}
    </svg>
  );
}

const formatCommandDuration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${seconds}s`;
};

function CommandExecutionTitle({
  active,
  startedAt,
  durationMs,
  fallback,
}: {
  active: boolean;
  startedAt?: number;
  durationMs?: number;
  fallback: string;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (active) {
    return <>Running command for {formatCommandDuration(Math.max(0, now - (startedAt ?? now)))}</>;
  }
  if (typeof durationMs === "number" && durationMs > 0 && fallback === "Ran command") {
    return <>Ran command in {formatCommandDuration(durationMs)}</>;
  }
  return <>{fallback}</>;
}

const directImageSource = (value: string | undefined) => {
  const source = value?.trim();
  if (!source) return null;
  return /^data:image\//i.test(source) || /^https?:\/\//i.test(source) ? source : null;
};

export function TimelineImages({
  attachments,
}: {
  attachments: TimelineEntry["attachments"];
}) {
  const images = attachments?.flatMap((attachment) => {
    if (attachment.kind !== "image") return [];
    const source = directImageSource(attachment.url) ?? (
      attachment.path &&
      !attachment.path.startsWith("clipboard:") &&
      isTauriHost()
        ? convertFileSrc(attachment.path)
        : null
    );
    return source ? [{ attachment, source }] : [];
  }) ?? [];
  if (!images.length) return null;
  return (
    <div className="activity__image-attachments" aria-label="Image output">
      {images.map(({ attachment, source }) => (
        <MessageImage
          key={attachment.id ?? attachment.path}
          name={attachment.name}
          source={source}
        />
      ))}
    </div>
  );
}

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
  onEditUserMessage?: (text: string, attachments: AgentAttachment[]) => void;
  showMessageActions?: boolean;
  attemptCount?: number;
  recovered?: boolean;
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
  onEditUserMessage,
  showMessageActions = true,
  attemptCount = 1,
  recovered = false,
  isLive = true,
}: ActivityItemProps) {
  const [editingPrompt, setEditingPrompt] = useState(false);
  const waitingForApproval = entry.kind === "approval" && entry.status === "warning";
  const userMessage = entry.kind === "brief" || entry.kind === "user";
  const assistantMessage = entry.kind === "result" && entry.title === "Agent response";
  const contextCompaction = entry.kind === "result" && entry.meta === "Context";
  const browserTool = (
    entry.kind === "result" ||
    entry.kind === "command"
  ) && ["browser tool", "web search"].includes(entry.meta?.toLowerCase() ?? "");

  if (entry.kind === "thought" && entry.status !== "active" && !entry.body?.trim()) return null;

  if (entry.kind === "thought" && !showReasoningSummaries) {
    if (entry.status !== "active" || !isLive) return null;
    return (
      <article
        className="activity activity--reasoning"
        style={{ "--activity-index": index } as React.CSSProperties}
        aria-busy
      >
        <ThinkingBlock
          entry={entry}
          live
          showBody={false}
          onOpenResource={onOpenResource}
        />
      </article>
    );
  }

  if (userMessage) {
    const visiblePrompt = visiblePromptFromSelectedContext(entry.body ?? entry.title);
    const reviewComments = entry.attachments?.filter((attachment) => attachment.kind === "review") ?? [];
    const sentAttachments = entry.attachments?.filter((attachment) => attachment.kind !== "review") ?? [];
    return (
      <article
        className="activity activity--user-message"
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <div className="activity__user-message-content">
          {editingPrompt && onEditUserMessage ? (
            <InlineMessageEditor
              text={visiblePrompt}
              onCancel={() => setEditingPrompt(false)}
              onSubmit={(text) => {
                onEditUserMessage(
                  replaceVisiblePromptInSelectedContext(entry.body ?? entry.title, text),
                  sentAttachments,
                );
                setEditingPrompt(false);
              }}
            />
          ) : (entry.body ?? entry.title).trim() ? (
            <div className="activity__user-bubble">
              {visiblePrompt}
            </div>
          ) : null}
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
                      <MessageImage
                        source={imageSource}
                        name={attachment.name}
                        className="is-user-attachment"
                      />
                    ) : (
                      <XiaoIcon name={attachment.kind === "directory" ? "folder" : "file"} size={14} />
                    )}
                    {!imageSource ? <span>{attachment.name}</span> : null}
                  </span>
                );
              })}
            </div>
          )}
          {entry.kind === "user" && entry.meta && entry.meta !== "You" ? (
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
          {!editingPrompt ? (
            <MessageActions
              text={visiblePrompt}
              createdAt={entry.createdAt}
              editable
              onEdit={onEditUserMessage ? () => setEditingPrompt(true) : undefined}
              onFork={entry.kind === "user" && canFork ? () => onForkTask(entry.id) : undefined}
              copyLabel="Copy prompt"
            />
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
          <TimelineImages attachments={entry.attachments} />
          {entry.body && !streaming && showMessageActions ? (
            <MessageActions text={entry.body} createdAt={entry.createdAt} copyLabel="Copy response" />
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
    const hasDetails = Boolean(entry.body);
    const summary = (
      <>
        <span className="activity__tool-icon" aria-hidden="true">
          <XiaoIcon name="browser" size={13} />
        </span>
        <span className="activity__tool-summary">
          <strong>Web search</strong>
          {query && query !== "Web search" ? <span className="activity__web-query" title={query}>{query}</span> : null}
          {hasDetails ? (
            <span className="activity__tool-caret">
              <XiaoIcon name="caret" size={13} />
            </span>
          ) : null}
        </span>
      </>
    );
    return (
      <article
        className={`activity activity--command activity--${entry.status ?? "success"}`}
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        {hasDetails ? (
          <details className="activity__tool-disclosure" open={expandToolOutput}>
            <summary>{summary}</summary>
            <div className="activity__tool-details">
              <div className="activity__terminal">
                <span className="activity__terminal-copy"><CopyButton text={entry.body!} /></span>
                <pre tabIndex={0} aria-label="Search results"><code>{entry.body}</code></pre>
              </div>
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
      <article
        className={`activity activity--reasoning activity--${entry.status ?? "idle"}`}
        style={{ "--activity-index": index } as React.CSSProperties}
        aria-busy={isLive && entry.status === "active"}
      >
        <ThinkingBlock
          entry={entry}
          live={isLive}
          showBody={showReasoningSummaries}
          onOpenResource={onOpenResource}
        />
      </article>
    );
  }

  if (entry.kind === "agent") {
    const collaborators = entry.collaborators ?? [];
    const active = entry.status === "active" && isLive;
    const stateLabel = entry.status === "error"
      ? "Needs attention"
      : entry.status === "warning"
        ? "Warning"
        : entry.status === "active" && !isLive
          ? "Stopped"
          : null;
    return (
      <article
        className={`activity activity--agent activity--${entry.status ?? "idle"}`}
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <div className="agent-activity">
          <header>
            <span className="agent-activity__icon">
              {active ? <AgentProgressIndicator /> : <XiaoIcon name="cpu" size={14} />}
            </span>
            <span className="agent-activity__heading">
              <strong>{entry.title}</strong>
              {entry.meta && <small>{entry.meta}</small>}
            </span>
            {stateLabel && (
              <span className={`agent-activity__state is-${entry.status ?? "idle"}`}>
                {stateLabel}
              </span>
            )}
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
    const noSearchMatches = entry.title === "Search found no matches";
    const toolDetail = (entry.command ?? entry.title).replace(/\s+/g, " ").trim();
    const hasDetails = Boolean(entry.command || entry.body);
    const active = entry.status === "active" && isLive;
    const integration = Boolean(
      entry.meta === "Plugin tool" ||
      entry.meta === "Dynamic tool" ||
      entry.meta === "Codex tool" ||
      entry.meta === "Image tool" ||
      entry.meta?.startsWith("Skill"),
    );
    const codexTool = entry.meta === "Codex tool";
    const imageTool = entry.meta === "Image tool";
    const webSearch = entry.meta === "Web search";
    const skillName = entry.meta?.startsWith("Skill")
      ? entry.meta.split(" · ").slice(1).filter(Boolean).join(" · ")
      : "";
    const toolTitle = recovered
      ? "Shell retry"
      : environmentBlocked
        ? "Shell blocked"
        : entry.status === "error"
          ? "Shell failed"
          : noSearchMatches
            ? "No matches"
            : integration
              ? active
                ? `Using ${skillName || entry.title}`
                : `Used ${skillName || entry.title}`
              : entry.command
                ? active ? "Running command" : "Ran command"
                : entry.title;
    const terminalText = entry.command
      ? `$ ${entry.command}${entry.body ? `\n\n${entry.body}` : ""}`
      : entry.body ?? "";
    const summary = (
      <>
        <span className="activity__tool-icon" aria-hidden="true">
          {codexTool && !active ? (
            <img className="activity__codex-icon" src="/codex-mark.png" alt="" />
          ) : (
            <XiaoIcon
              className={active ? "spin" : undefined}
              name={active
                ? "pending"
                : imageTool
                  ? "files"
                  : webSearch
                    ? "browser"
                    : integration
                      ? "capability"
                      : "command"}
              size={13}
            />
          )}
        </span>
        <span className="activity__tool-summary">
          <strong className={active ? "is-active" : undefined}>
            {entry.command && !integration ? (
              <CommandExecutionTitle
                active={active}
                startedAt={entry.createdAt}
                durationMs={entry.durationMs}
                fallback={toolTitle}
              />
            ) : toolTitle}
          </strong>
          {entry.command ? <span title={toolDetail}>{toolDetail}</span> : null}
          {attemptCount > 1 && (
            <small className="activity__tool-attempts">{attemptCount} attempts</small>
          )}
          {recovered && (
            <small className="activity__tool-recovered">recovered</small>
          )}
          {hasDetails && (
            <span className="activity__tool-caret">
              <XiaoIcon name="caret" size={13} />
            </span>
          )}
        </span>
      </>
    );

    return (
      <article
        className={`activity activity--command activity--${environmentBlocked || recovered ? "warning" : entry.status ?? "idle"}`}
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
                  {!active && entry.status === "success" ? (
                    <span className="activity__terminal-success">
                      <XiaoIcon name="check" size={11} />
                      Completed{typeof entry.exitCode === "number" ? ` · exit ${entry.exitCode}` : ""}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          </details>
        ) : (
          <div className="activity__tool-disclosure activity__tool-disclosure--static">
            <div className="activity__tool-summary-row">{summary}</div>
          </div>
        )}
        {entry.attachments?.some((attachment) => attachment.kind === "image") ? (
          <div className="activity__viewed-images">
            <span className="activity__viewed-images-label">
              <XiaoIcon name="files" size={13} />
              Viewed {entry.attachments.filter((attachment) => attachment.kind === "image").length === 1
                ? "an image"
                : `${entry.attachments.filter((attachment) => attachment.kind === "image").length} images`}
            </span>
            <TimelineImages attachments={entry.attachments} />
          </div>
        ) : null}
      </article>
    );
  }

  if (entry.kind === "change" && entry.files?.length) {
    return (
      <article
        className={`activity activity--patch activity--${entry.status ?? "idle"}`}
        style={{ "--activity-index": index } as React.CSSProperties}
      >
        <div className="patch-activity__files">
          {entry.files.map((file) => {
            const created = /---\s+(?:\/dev\/null|NUL)/i.test(file.patch ?? "");
            const deleted = /\+\+\+\s+(?:\/dev\/null|NUL)/i.test(file.patch ?? "");
            const verb = entry.status === "error"
              ? "Edit failed"
              : created
                ? "Created"
                : deleted
                  ? "Deleted"
                  : "Edited";
            const absolutePath = /^[A-Za-z]:[\\/]/.test(file.path)
              ? file.path
              : `${workspacePath.replace(/[\\/]+$/, "")}\\${file.path.replace(/\//g, "\\")}`;
            const normalizedWorkspace = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
            const normalizedPath = file.path.replace(/\\/g, "/");
            const displayPath = normalizedPath.toLowerCase().startsWith(`${normalizedWorkspace.toLowerCase()}/`)
              ? normalizedPath.slice(normalizedWorkspace.length + 1)
              : normalizedPath;
            const displayName = displayPath.split("/").filter(Boolean).at(-1) ?? displayPath;
            return (
              <div className={`patch-activity__row is-${created ? "created" : deleted ? "deleted" : "edited"}`} key={file.path}>
                <span className="activity__tool-icon" aria-hidden="true">
                  <XiaoIcon name={created ? "mutation" : deleted ? "trash" : "edit"} size={13} />
                  {created || deleted ? <i className="patch-activity__operation-dot" /> : null}
                </span>
                <strong className={`patch-activity__verb${entry.status === "active" && isLive ? " is-active" : ""}`}>
                  {verb}
                </strong>
                <button
                  className="patch-activity__path"
                  type="button"
                  title={`Open ${absolutePath}`}
                  onClick={() => onOpenResource(absolutePath)}
                >
                  {displayName}
                </button>
                <span className="patch-activity__stats">
                  <b>+{file.additions}</b>
                  <em>-{file.deletions}</em>
                </span>
              </div>
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
