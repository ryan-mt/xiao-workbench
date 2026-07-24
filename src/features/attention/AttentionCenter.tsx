import { useEffect, useRef } from "react";

import { XiaoIcon } from "../../components/icons/XiaoIcon";
import type { AttentionItem } from "../../core/models/xiao";
import type { AttentionHydrationStatus } from "./useAttentionCenter";
import "./attention.css";

type AttentionCenterProps = {
  items: AttentionItem[];
  hydrationStatus: AttentionHydrationStatus;
  onRetry: () => void;
  onOpenItem: (item: AttentionItem) => void;
  onAcknowledge: (itemId: string) => void;
  onClose: () => void;
};

const attentionTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const boundedDetail = (detail: string) => {
  const normalized = detail.replace(/\s+/g, " ").trim();
  return normalized.length <= 160
    ? normalized
    : `${normalized.slice(0, 159).trimEnd()}…`;
};

const kindLabel = (kind: AttentionItem["kind"]) => {
  if (kind === "decision") return "Decision";
  if (kind === "verification") return "Verification";
  if (kind === "failure") return "Failure";
  if (kind === "review") return "Review";
  if (kind === "publication") return "Publication";
  if (kind === "routine") return "Routine";
  return "Unread";
};

export const retryAttentionWithStableFocus = (
  heading: Pick<HTMLElement, "focus"> | null,
  onRetry: () => void,
) => {
  heading?.focus();
  onRetry();
};

export function AttentionCenter({
  items,
  hydrationStatus,
  onRetry,
  onOpenItem,
  onAcknowledge,
  onClose,
}: AttentionCenterProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const hydrationNotice = hydrationStatus === "loading"
    ? "Checking every Project for attention items…"
    : hydrationStatus === "partial"
      ? "Some attention data is unavailable. Available items are shown."
      : hydrationStatus === "stale"
        ? "Attention data is stale. Last known items are shown."
      : null;
  const countUnit = hydrationStatus === "live"
    ? items.length === 1 ? "item" : "items"
    : "available";
  const countAnnouncement = hydrationStatus === "live"
    ? `${items.length} ${countUnit}`
    : `${items.length} available, ${hydrationStatus} attention data`;
  const handleRetry = () => retryAttentionWithStableFocus(headingRef.current, onRetry);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section className="attention-center" aria-labelledby="attention-heading">
      <header className="attention-center__header">
        <div>
          <span>Workspace</span>
          <h1 id="attention-heading" ref={headingRef} tabIndex={-1}>Attention</h1>
          <p>Decisions, recent run issues, and unread task activity.</p>
        </div>
        <p
          className="attention-center__count"
          role="status"
          aria-label={countAnnouncement}
          aria-live="polite"
        >
          <strong>{items.length}</strong>
          <span>{countUnit}</span>
        </p>
        <button
          className="attention-center__close"
          type="button"
          aria-label="Close attention center"
          title="Close"
          onClick={onClose}
        >
          <XiaoIcon name="close" size={15} />
        </button>
      </header>

      <div className="attention-center__body">
        {items.length ? (
          <>
            {hydrationNotice ? (
              <div className={`attention-center__notice is-${hydrationStatus}`} role="status">
                <span>{hydrationNotice}</span>
                {hydrationStatus === "partial" || hydrationStatus === "stale" ? (
                  <button className="attention-center__retry" type="button" onClick={handleRetry}>
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}
            <ol className="attention-center__list" aria-label="Workspace attention items">
              {items.map((item) => {
                const detail = boundedDetail(item.safeSummary);
                return (
                  <li className={`attention-center__item is-${item.kind}`} key={item.id}>
                    <span className="attention-center__kind">{kindLabel(item.kind)}</span>
                    <div className="attention-center__copy">
                      <h2>{item.title}</h2>
                      <p>{item.projectName} · {detail}</p>
                      {item.runId ? <small>Run {item.runId}</small> : null}
                      <time dateTime={new Date(item.createdAt).toISOString()}>
                        {attentionTime.format(item.createdAt)}
                      </time>
                    </div>
                    <div className="attention-center__actions">
                      <button
                        className="attention-center__open"
                        type="button"
                        aria-label={`Open task: ${detail}`}
                        onClick={() => onOpenItem(item)}
                      >
                        <span>Open task</span>
                        <XiaoIcon name="forward" size={14} />
                      </button>
                      <button
                        className="attention-center__dismiss"
                        type="button"
                        aria-label={`Acknowledge: ${detail}`}
                        title="Acknowledge"
                        onClick={() => onAcknowledge(item.id)}
                      >
                        <XiaoIcon name="close" size={14} />
                        <span>Acknowledge</span>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </>
        ) : hydrationStatus === "loading" ? (
          <div className="attention-center__empty is-loading" role="status">
            <span><XiaoIcon name="pending" size={18} /></span>
            <h2>Loading attention</h2>
            <p>Checking active and recent runs, requests, and unread tasks.</p>
          </div>
        ) : hydrationStatus === "partial" ? (
          <div className="attention-center__empty is-partial" role="status">
            <span><XiaoIcon name="approval" size={18} /></span>
            <h2>Some attention data is unavailable</h2>
            <p>Some attention data could not load. Try again to check for more.</p>
            <button className="attention-center__retry" type="button" onClick={handleRetry}>
              Retry
            </button>
          </div>
        ) : hydrationStatus === "stale" ? (
          <div className="attention-center__empty is-partial" role="status">
            <span><XiaoIcon name="approval" size={18} /></span>
            <h2>Attention data is stale</h2>
            <p>Reconnect to the primary host before assuming no work needs attention.</p>
            <button className="attention-center__retry" type="button" onClick={handleRetry}>
              Retry
            </button>
          </div>
        ) : hydrationStatus === "unavailable" ? (
          <div className="attention-center__empty is-partial" role="alert">
            <span><XiaoIcon name="close" size={18} /></span>
            <h2>Attention Center unavailable</h2>
            <p>The primary host could not provide a cross-Project view.</p>
            <button className="attention-center__retry" type="button" onClick={handleRetry}>
              Retry
            </button>
          </div>
        ) : (
          <div className="attention-center__empty is-live" role="status">
            <span><XiaoIcon name="check" size={18} /></span>
            <h2>Nothing needs attention</h2>
            <p>New decisions, recent run issues, and unread tasks will appear here.</p>
          </div>
        )}
      </div>
    </section>
  );
}
