import { memo, useMemo, useState, type CSSProperties } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import {
  contextUsedPercent,
  normalizeThreadTokenUsage,
  type AgentModelSummary,
  type ThreadTokenUsage,
  type TimelineEntry,
} from "../../../core/models/agent";

type ContextPanelProps = {
  taskTitle: string;
  taskCreatedAt: number;
  timeline: TimelineEntry[];
  threadId: string | null;
  models: AgentModelSummary[];
  selectedModel: string | null;
  usage: ThreadTokenUsage | null;
};

type MessageKind = "all" | "assistant" | "tools" | "user";
type TimelineMessageKind = Exclude<MessageKind, "all">;

const pageSize = 18;
const messageKinds: readonly MessageKind[] = ["all", "user", "assistant", "tools"];
const number = new Intl.NumberFormat();
const time = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const messageKind = (entry: TimelineEntry): TimelineMessageKind => {
  if (entry.kind === "user" || entry.kind === "brief") return "user";
  if (
    entry.kind === "command" ||
    entry.kind === "explore" ||
    entry.kind === "change" ||
    entry.kind === "agent" ||
    entry.kind === "approval"
  ) return "tools";
  return "assistant";
};

const messageLabel = (kind: TimelineMessageKind) => {
  if (kind === "user") return "User";
  if (kind === "tools") return "Tool";
  return "Assistant";
};

export const ContextPanel = memo(function ContextPanel({
  taskTitle,
  taskCreatedAt,
  timeline,
  threadId,
  models,
  selectedModel,
  usage,
}: ContextPanelProps) {
  const [filter, setFilter] = useState<MessageKind>("all");
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const model = useMemo(() => {
    let defaultModel: AgentModelSummary | undefined;
    let selected: AgentModelSummary | undefined;

    for (const item of models) {
      if (item.isDefault) defaultModel = item;
      if (selectedModel && item.model === selectedModel) selected = item;
    }

    return selected ?? defaultModel;
  }, [models, selectedModel]);
  const normalizedUsage = normalizeThreadTokenUsage(usage, model?.contextWindow);
  const contextLimit = normalizedUsage?.modelContextWindow ?? model?.contextWindow ?? null;
  const contextUsage = contextUsedPercent(normalizedUsage, model?.contextWindow);
  const timelineView = useMemo(() => {
    const filtered: TimelineEntry[] = [];
    const counts: Record<TimelineMessageKind, number> = { user: 0, assistant: 0, tools: 0 };
    let lastActivity: number | null = null;

    for (const entry of timeline) {
      const kind = messageKind(entry);
      counts[kind] += 1;
      if (filter === "all" || kind === filter) filtered.push(entry);
      if (entry.createdAt && (lastActivity === null || entry.createdAt > lastActivity)) {
        lastActivity = entry.createdAt;
      }
    }

    return { counts, filtered, lastActivity: lastActivity ?? taskCreatedAt };
  }, [filter, taskCreatedAt, timeline]);
  const visible = useMemo(
    () => timelineView.filtered.slice(Math.max(0, timelineView.filtered.length - visibleCount)),
    [timelineView.filtered, visibleCount],
  );

  const totalUsage = normalizedUsage?.total ?? null;
  const activeTokens = normalizedUsage?.last.totalTokens ?? null;
  const total = totalUsage?.totalTokens ?? 0;
  const cached = Math.min(total, totalUsage?.cachedInputTokens ?? 0);
  const input = Math.min(Math.max(0, total - cached), Math.max(0, (totalUsage?.inputTokens ?? 0) - cached));
  const reasoning = Math.min(Math.max(0, total - cached - input), totalUsage?.reasoningOutputTokens ?? 0);
  const output = Math.min(
    Math.max(0, total - cached - input - reasoning),
    Math.max(0, (totalUsage?.outputTokens ?? 0) - reasoning),
  );
  const other = Math.max(0, total - cached - input - reasoning - output);
  const segments = [
    { id: "input", label: "Input", value: input },
    { id: "cache", label: "Cache", value: cached },
    { id: "output", label: "Output", value: output },
    { id: "reasoning", label: "Reasoning", value: reasoning },
    { id: "other", label: "Other", value: other },
  ].map((segment) => ({
    ...segment,
    percent: Math.round((segment.value / Math.max(1, total)) * 100),
  }));

  return (
    <section className="context-panel">
      <header className="context-panel__hero">
        <div>
          <span>Session context</span>
          <h2>{taskTitle}</h2>
          <p>Live context for this Xiao task, separate from account-wide usage.</p>
        </div>
      </header>

      <section className="context-window" aria-labelledby="context-window-title">
        <header>
          <div>
            <span>Active window</span>
            <h3 id="context-window-title">Context use</h3>
          </div>
          <p className="context-window__percent">
            <strong>{contextUsage === null ? "--" : `${contextUsage}%`}</strong>
            <span>used</span>
          </p>
        </header>
        <div
          className={`context-window__bar${contextUsage === null ? " is-empty" : ""}`}
          role="progressbar"
          aria-label={contextUsage === null ? "Context limit unavailable" : `${contextUsage}% context used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={contextUsage ?? undefined}
          style={{ "--context-ratio": (contextUsage ?? 0) / 100 } as CSSProperties}
        >
          <i />
        </div>
        <div className="context-window__summary">
          <span><strong>{activeTokens === null ? "Not reported" : number.format(activeTokens)}</strong> active tokens</span>
          <span><strong>{contextLimit ? number.format(contextLimit) : "Not reported"}</strong> token limit</span>
        </div>
      </section>

      <dl className="context-facts">
        <div><dt>Messages</dt><dd>{number.format(timeline.length)}</dd></div>
        <div><dt>Model</dt><dd>{model?.displayName ?? selectedModel ?? "Default"}</dd></div>
        <div><dt>Session tokens</dt><dd>{totalUsage ? number.format(totalUsage.totalTokens) : "Not reported"}</dd></div>
        <div><dt>Context limit</dt><dd>{contextLimit ? number.format(contextLimit) : "Not reported"}</dd></div>
        <div><dt>Thread</dt><dd title={threadId ?? undefined}>{threadId ? threadId.slice(0, 12) : "Not started"}</dd></div>
        <div><dt>Last activity</dt><dd>{time.format(timelineView.lastActivity)}</dd></div>
      </dl>

      <section className="context-breakdown" aria-labelledby="context-breakdown-title">
        <header>
          <div><span>Composition</span><h3 id="context-breakdown-title">Session token flow</h3></div>
          <p><strong>{totalUsage ? number.format(total) : "--"}</strong><span> tokens</span></p>
        </header>
        {totalUsage ? (
          <>
            <div className="context-breakdown__bar" aria-hidden="true">
              {segments.filter((segment) => segment.value > 0).map((segment) => (
                <i className={`is-${segment.id}`} key={segment.id} style={{ flexGrow: segment.value }} />
              ))}
            </div>
            <dl className="context-breakdown__legend">
              {segments.map((segment) => (
                <div className={`is-${segment.id}`} key={segment.id}>
                  <dt><i />{segment.label}</dt>
                  <dd><strong>{number.format(segment.value)}</strong><span>{segment.percent}%</span></dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <p className="context-breakdown__empty">Token usage appears after Codex reports the first completed turn.</p>
        )}
      </section>

      <section className="context-messages" aria-labelledby="context-messages-title">
        <header>
          <div>
            <span>Event index</span>
            <h3 id="context-messages-title">Raw messages</h3>
          </div>
          <strong>{number.format(timeline.length)}</strong>
        </header>
        <div className="context-message-filters" role="group" aria-label="Filter raw messages">
          {messageKinds.map((kind) => (
            <button
              className={filter === kind ? "is-active" : undefined}
              key={kind}
              type="button"
              aria-pressed={filter === kind}
              onClick={() => {
                setFilter(kind);
                setVisibleCount(pageSize);
              }}
            >
              {kind === "all" ? "All" : messageLabel(kind)}
              <small>{kind === "all" ? timeline.length : timelineView.counts[kind]}</small>
            </button>
          ))}
        </div>

        {visible.length > 0 ? (
          <div className="context-message-list">
            {visible.map((entry) => {
              const kind = messageKind(entry);
              const details = entry.body ?? entry.command;
              return (
                <details key={entry.id}>
                  <summary>
                    <span className={`context-message-list__role is-${kind}`}>{messageLabel(kind)}</span>
                    <span className="context-message-list__identity">
                      <strong>{entry.title}</strong>
                      <code title={entry.id}>{entry.id}</code>
                    </span>
                    <time>{entry.createdAt ? time.format(entry.createdAt) : "Saved event"}</time>
                    <XiaoIcon name="caret" size={12} />
                  </summary>
                  <div>
                    {details ? <pre>{details}</pre> : null}
                    {entry.files?.length ? (
                      <ul>{entry.files.map((file) => <li key={file.path}>{file.path} <b>+{file.additions}</b> <em>-{file.deletions}</em></li>)}</ul>
                    ) : null}
                    {!details && !entry.files?.length ? <p>No additional payload recorded.</p> : null}
                  </div>
                </details>
              );
            })}
          </div>
        ) : (
          <div className="rail-empty rail-empty--compact">
            <XiaoIcon name="result" size={22} />
            <strong>No {filter === "all" ? "session" : filter} messages</strong>
            <p>Events appear here as Xiao works.</p>
          </div>
        )}

        {timelineView.filtered.length > visibleCount && (
          <button className="context-messages__more" type="button" onClick={() => setVisibleCount((count) => count + pageSize)}>
            Show {Math.min(pageSize, timelineView.filtered.length - visibleCount)} more
            <small>{timelineView.filtered.length - visibleCount} remaining</small>
          </button>
        )}
        {visibleCount > pageSize && (
          <button className="context-messages__collapse" type="button" onClick={() => setVisibleCount(pageSize)}>
            Collapse to latest batch
          </button>
        )}
      </section>
    </section>
  );
});
