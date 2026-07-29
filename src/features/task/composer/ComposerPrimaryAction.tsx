import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { ComposerDelivery } from "./Composer";

type ComposerPrimaryActionProps = {
  working: boolean;
  hasContent: boolean;
  canSubmit: boolean;
  canSteer: boolean;
  onDeliver: (delivery: ComposerDelivery) => void;
  onInterrupt: () => void;
};

export function ComposerPrimaryAction({
  working,
  hasContent,
  canSubmit,
  canSteer,
  onDeliver,
  onInterrupt,
}: ComposerPrimaryActionProps) {
  const stopping = working && !hasContent;
  const delivery = working ? "queue" : "send";

  return (
    <div className={`composer-primary-action ${stopping ? "is-stop" : "is-send"} ${
      working && hasContent ? "has-delivery-options" : ""
    }`}>
      {working && hasContent ? (
        <div className="composer-primary-action__menu" role="menu" aria-label="Message delivery">
          <button type="button" role="menuitem" disabled={!canSubmit} onClick={() => onDeliver("queue")}>
            <span>Queue</span><kbd>Enter</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canSubmit || !canSteer}
            onClick={() => onDeliver("steer")}
          >
            <span>Steer</span><kbd>Ctrl ↵</kbd>
          </button>
        </div>
      ) : null}
      <button
        className="composer-primary-action__button"
        type="button"
        aria-label={stopping ? "Stop current turn" : working ? "Queue follow-up" : "Send task"}
        aria-keyshortcuts={stopping ? "Escape" : working ? "Enter Control+Enter" : "Enter"}
        title={stopping ? "Stop current turn (Esc)" : working ? "Queue follow-up · hover for Steer" : "Send task"}
        disabled={stopping ? false : !canSubmit}
        onClick={() => stopping ? onInterrupt() : onDeliver(delivery)}
        onKeyDown={(event) => {
          if (stopping && event.key === "Escape") {
            event.preventDefault();
            onInterrupt();
          }
        }}
      >
        <span className="composer-primary-action__glyph" aria-hidden="true">
          {stopping ? <i /> : <XiaoIcon name="send" size={15} strokeWidth={2.2} />}
        </span>
      </button>
    </div>
  );
}
