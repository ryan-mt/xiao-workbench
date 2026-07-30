import { useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import {
  replaceVisiblePromptInSelectedContext,
  visiblePromptFromSelectedContext,
  type AgentFollowUp,
} from "../../../core/models/agent";

export function SteerMessageBar({
  followUps,
  sendingFollowUpId,
  failedFollowUpId,
  canSteer,
  interactiveRequestOpen,
  onEdit,
  onRemove,
  onRetry,
  onSendNow,
}: {
  followUps: AgentFollowUp[];
  sendingFollowUpId: string | null;
  failedFollowUpId: string | null;
  canSteer: boolean;
  interactiveRequestOpen: boolean;
  onEdit: (followUpId: string, prompt: string) => void;
  onRemove: (followUpId: string) => void;
  onRetry: () => void;
  onSendNow: (followUpId: string) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  if (!followUps.length) return null;

  const anotherSendInProgress = sendingFollowUpId !== null;
  const submitEdit = (followUp: AgentFollowUp) => {
    const nextPrompt = draft.trim();
    if (!nextPrompt) return;
    onEdit(
      followUp.id,
      replaceVisiblePromptInSelectedContext(followUp.prompt, nextPrompt),
    );
    setEditingId(null);
    setDraft("");
  };

  return (
    <section
      className="steer-message"
      aria-label={`${followUps.length} queued ${followUps.length === 1 ? "message" : "messages"}`}
    >
      <header className="steer-message__header">
        <span className="steer-message__icon" aria-hidden="true">
          <XiaoIcon name="enter" size={14} />
        </span>
        <strong>Queued</strong>
        <small>{followUps.length}</small>
      </header>
      <ol className="steer-message__list">
        {followUps.map((followUp, index) => {
          const sending = sendingFollowUpId === followUp.id;
          const failed = failedFollowUpId === followUp.id;
          const prompt = visiblePromptFromSelectedContext(followUp.prompt);
          const editing = editingId === followUp.id;
          const isNext = index === 0;

          return (
            <li
              key={followUp.id}
              className={[
                "steer-message__item",
                isNext ? "is-next" : "",
                sending ? "is-sending" : "",
                failed ? "is-error" : "",
              ].filter(Boolean).join(" ")}
            >
              <span className="steer-message__order" aria-hidden="true">{index + 1}</span>
              {editing ? (
                <form
                  className="steer-message__editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitEdit(followUp);
                  }}
                >
                  <input
                    aria-label={`Edit queued message ${index + 1}`}
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setEditingId(null);
                        setDraft("");
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(null);
                      setDraft("");
                    }}
                  >
                    Cancel
                  </button>
                  <button type="submit" disabled={!draft.trim()}>Save</button>
                </form>
              ) : (
                <>
                  <div className="steer-message__body">
                    <span className="steer-message__prompt" title={prompt}>
                      {prompt}
                    </span>
                    {followUp.attachments.length ? (
                      <small>
                        {followUp.attachments.length} attachment
                        {followUp.attachments.length === 1 ? "" : "s"}
                      </small>
                    ) : null}
                    {failed ? <small className="steer-message__status">Failed</small> : null}
                    {sending ? <small className="steer-message__status">Sending…</small> : null}
                    {isNext && !failed && !sending ? (
                      <small className="steer-message__status">Next</small>
                    ) : null}
                  </div>
                  <span className="steer-message__actions">
                    {isNext ? (
                      <button
                        className="steer-message__send"
                        type="button"
                        disabled={
                          anotherSendInProgress
                          || interactiveRequestOpen
                          || (!canSteer && !failed)
                        }
                        title={
                          failed
                            ? "Retry this message"
                            : "Steer the current task with this message"
                        }
                        onClick={() => {
                          if (failed && !canSteer) onRetry();
                          else void onSendNow(followUp.id);
                        }}
                      >
                        <XiaoIcon name="enter" size={13} />
                        <span>{failed ? "Retry" : "Steer"}</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={sending}
                      title={`Edit queued message ${index + 1}`}
                      aria-label={`Edit queued message ${index + 1}`}
                      onClick={() => {
                        setEditingId(followUp.id);
                        setDraft(prompt);
                      }}
                    >
                      <XiaoIcon name="edit" size={13} />
                    </button>
                    <button
                      type="button"
                      disabled={sending}
                      title={`Delete queued message ${index + 1}`}
                      aria-label={`Delete queued message ${index + 1}`}
                      onClick={() => onRemove(followUp.id)}
                    >
                      <XiaoIcon name="trash" size={14} />
                    </button>
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
