import { useEffect, useId, useRef, useState } from "react";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const primaryButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const stopping = working && !hasContent;
  const delivery = working ? "queue" : "send";
  const hasDeliveryOptions = working && hasContent;
  const deliver = (nextDelivery: ComposerDelivery) => {
    setMenuOpen(false);
    onDeliver(nextDelivery);
  };

  useEffect(() => {
    if (!hasDeliveryOptions) setMenuOpen(false);
  }, [hasDeliveryOptions]);

  return (
    <div
      className={`composer-primary-action ${stopping ? "is-stop" : "is-send"} ${
        hasDeliveryOptions ? "has-delivery-options" : ""
      } ${menuOpen ? "is-menu-open" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !menuOpen) return;
        event.preventDefault();
        event.stopPropagation();
        primaryButton.current?.focus();
        setMenuOpen(false);
      }}
    >
      {hasDeliveryOptions ? (
        <div
          ref={menu}
          className="composer-primary-action__menu"
          id={menuId}
          role="menu"
          aria-label="Message delivery"
          hidden={!menuOpen}
        >
          <button type="button" role="menuitem" disabled={!canSubmit} onClick={() => deliver("queue")}>
            <span>Queue</span><kbd>Enter</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canSubmit || !canSteer}
            onClick={() => deliver("steer")}
          >
            <span>Steer</span><kbd>Ctrl ↵</kbd>
          </button>
        </div>
      ) : null}
      <button
        ref={primaryButton}
        className="composer-primary-action__button"
        type="button"
        aria-label={stopping
          ? "Stop current turn"
          : hasDeliveryOptions
            ? "Choose message delivery"
            : "Send task"}
        aria-keyshortcuts={stopping ? "Escape" : working ? "Enter Control+Enter" : "Enter"}
        aria-haspopup={hasDeliveryOptions ? "menu" : undefined}
        aria-expanded={hasDeliveryOptions ? menuOpen : undefined}
        aria-controls={hasDeliveryOptions ? menuId : undefined}
        title={stopping
          ? "Stop current turn (Esc)"
          : working
            ? "Queue follow-up · choose Steer from delivery options"
            : "Send task"}
        disabled={stopping ? false : !canSubmit}
        onClick={(event) => {
          if (stopping) {
            onInterrupt();
          } else if (hasDeliveryOptions) {
            const nextOpen = !menuOpen;
            setMenuOpen(nextOpen);
            if (nextOpen && event.detail === 0) {
              window.requestAnimationFrame(() =>
                menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
              );
            }
          } else {
            deliver(delivery);
          }
        }}
        onKeyDown={(event) => {
          if (stopping && event.key === "Escape") {
            event.preventDefault();
            onInterrupt();
            return;
          }
          if (
            hasDeliveryOptions
            && canSubmit
            && canSteer
            && event.key === "Enter"
            && (event.ctrlKey || event.metaKey)
          ) {
            event.preventDefault();
            deliver("steer");
            return;
          }
          if (hasDeliveryOptions && event.key === "ArrowDown") {
            event.preventDefault();
            setMenuOpen(true);
            window.requestAnimationFrame(() =>
              menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
            );
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
