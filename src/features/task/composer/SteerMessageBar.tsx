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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const followUp = followUps[0];
  if (!followUp) return null;

  const sending = sendingFollowUpId === followUp.id;
  const anotherSendInProgress = sendingFollowUpId !== null;
  const failed = failedFollowUpId === followUp.id;
  const prompt = visiblePromptFromSelectedContext(followUp.prompt);
  const submitEdit = () => {
    const nextPrompt = draft.trim();
    if (!nextPrompt) return;
    onEdit(
      followUp.id,
      replaceVisiblePromptInSelectedContext(followUp.prompt, nextPrompt),
    );
    setEditing(false);
  };

  return (
    <section
      className={`steer-message${sending ? " is-sending" : ""}${failed ? " is-error" : ""}`}
      aria-label={`${followUps.length} queued ${followUps.length === 1 ? "message" : "messages"}`}
    >
      <span className="steer-message__icon" aria-hidden="true">
        <XiaoIcon name="enter" size={14} />
      </span>
      {editing ? (
        <form
          className="steer-message__editor"
          onSubmit={(event) => {
            event.preventDefault();
            submitEdit();
          }}
        >
          <input
            aria-label="Edit steer message"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
            }}
          />
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          <button type="submit" disabled={!draft.trim()}>Save</button>
        </form>
      ) : (
        <>
          <span className="steer-message__prompt" title={prompt}>
            {prompt}
            {followUp.attachments.length ? (
              <small>{followUp.attachments.length} attachment{followUp.attachments.length === 1 ? "" : "s"}</small>
            ) : null}
          </span>
          {followUps.length > 1 ? (
            <span className="steer-message__count" title={`${followUps.length - 1} more queued`}>
              +{followUps.length - 1}
            </span>
          ) : null}
          <span className="steer-message__actions">
            <button
              className="steer-message__send"
              type="button"
              disabled={anotherSendInProgress || interactiveRequestOpen || (!canSteer && !failed)}
              title={failed ? "Retry this message" : "Steer the current task with this message"}
              onClick={() => {
                if (failed && !canSteer) onRetry();
                else void onSendNow(followUp.id);
              }}
            >
              <XiaoIcon name="enter" size={13} />
              <span>{failed ? "Retry" : "Steer"}</span>
            </button>
            <button
              type="button"
              disabled={sending}
              title="Delete queued message"
              aria-label="Delete queued message"
              onClick={() => onRemove(followUp.id)}
            >
              <XiaoIcon name="trash" size={14} />
            </button>
            <details className="steer-message__menu">
              <summary title="More queued message actions" aria-label="More queued message actions">
                <XiaoIcon name="more" size={15} />
              </summary>
              <div>
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => {
                    setDraft(prompt);
                    setEditing(true);
                  }}
                >
                  <XiaoIcon name="edit" size={13} /> Edit message
                </button>
                {followUps.slice(1).map((queued, index) => (
                  <span className="steer-message__queued" key={queued.id}>
                    <small>{index + 2}</small>
                    <span title={visiblePromptFromSelectedContext(queued.prompt)}>
                      {visiblePromptFromSelectedContext(queued.prompt)}
                    </span>
                    <button
                      type="button"
                      title={`Delete queued message ${index + 2}`}
                      aria-label={`Delete queued message ${index + 2}`}
                      onClick={() => onRemove(queued.id)}
                    >
                      <XiaoIcon name="trash" size={12} />
                    </button>
                  </span>
                ))}
              </div>
            </details>
          </span>
        </>
      )}
    </section>
  );
}
