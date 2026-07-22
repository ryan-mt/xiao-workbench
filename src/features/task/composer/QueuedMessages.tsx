import { useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentFollowUp } from "../../../core/models/agent";

type QueuedMessagesProps = {
  followUps: AgentFollowUp[];
  sendingFollowUpId: string | null;
  failedFollowUpId: string | null;
  canSteer: boolean;
  onEdit: (followUpId: string, prompt: string) => void;
  onRemove: (followUpId: string) => void;
  onRetry: () => void;
  onSendNow: (followUpId: string) => Promise<void>;
};

export function QueuedMessages({
  followUps,
  sendingFollowUpId,
  failedFollowUpId,
  canSteer,
  onEdit,
  onRemove,
  onRetry,
  onSendNow,
}: QueuedMessagesProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingPrompt, setEditingPrompt] = useState("");

  if (followUps.length === 0) return null;

  return (
    <section className="composer-queue" aria-label={`${followUps.length} queued messages`}>
      <header className="composer-queue__header">
        <span><XiaoIcon name="taskQueue" size={13} /> Queued</span>
        <small>{followUps.length}</small>
      </header>
      <ol className="composer-queue__list">
        {followUps.map((followUp, index) => {
          const sending = sendingFollowUpId === followUp.id;
          const failed = failedFollowUpId === followUp.id;
          const editing = editingId === followUp.id;
          return (
            <li className={failed ? "is-error" : sending ? "is-sending" : undefined} key={followUp.id}>
              <span className="composer-queue__order">{index + 1}</span>
              {editing ? (
                <form
                  className="composer-queue__editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const nextPrompt = editingPrompt.trim();
                    if (!nextPrompt) return;
                    onEdit(followUp.id, nextPrompt);
                    setEditingId(null);
                  }}
                >
                  <textarea
                    aria-label={`Edit queued message ${index + 1}`}
                    autoFocus
                    rows={2}
                    value={editingPrompt}
                    onChange={(event) => setEditingPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditingId(null);
                    }}
                  />
                  <span>
                    <button type="button" onClick={() => setEditingId(null)}>Cancel</button>
                    <button type="submit" disabled={!editingPrompt.trim()}>Save</button>
                  </span>
                </form>
              ) : (
                <div className="composer-queue__message">
                  <strong>{followUp.prompt}</strong>
                  <small>
                    {sending
                      ? "Sending now"
                      : failed
                        ? "Could not send"
                        : index === 0
                          ? "Sends after the current response"
                          : "Waiting behind the previous message"}
                    {followUp.attachments.length
                      ? ` · ${followUp.attachments.length} attachment${followUp.attachments.length === 1 ? "" : "s"}`
                      : ""}
                  </small>
                </div>
              )}
              {!editing ? (
                <details className="composer-queue__menu">
                  <summary aria-label={`Actions for queued message ${index + 1}`}>
                    <XiaoIcon name="more" size={15} />
                  </summary>
                  <div>
                    {failed ? (
                      <button type="button" onClick={onRetry}>
                        <XiaoIcon name="refresh" size={13} /> Retry
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => {
                        setEditingId(followUp.id);
                        setEditingPrompt(followUp.prompt);
                      }}
                    >
                      <XiaoIcon name="edit" size={13} /> Edit
                    </button>
                    <button
                      className="is-danger"
                      type="button"
                      disabled={sending}
                      onClick={() => onRemove(followUp.id)}
                    >
                      <XiaoIcon name="close" size={13} /> Delete
                    </button>
                    {canSteer && !failed ? (
                      <button type="button" disabled={sending} onClick={() => void onSendNow(followUp.id)}>
                        <XiaoIcon name="send" size={13} /> Send now
                      </button>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
