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
  const root = useRef<HTMLDivElement>(null);
  const primaryButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const stopping = working && !hasContent;
  const delivery = working ? "queue" : "send";
  const hasDeliveryOptions = working && hasContent;
  const deliver = (nextDelivery: ComposerDelivery) => {
    setMenuOpen(false);
    primaryButton.current?.focus();
    onDeliver(nextDelivery);
  };
  const focusMenuEdge = (edge: "first" | "last") => {
    setMenuOpen(true);
    window.requestAnimationFrame(() => {
      const items = menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      items?.[edge === "first" ? 0 : items.length - 1]?.focus();
    });
  };

  useEffect(() => {
    if (!hasDeliveryOptions) setMenuOpen(false);
  }, [hasDeliveryOptions]);

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", dismiss, true);
    return () => window.removeEventListener("pointerdown", dismiss, true);
  }, [menuOpen]);

  return (
    <div
      ref={root}
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
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
            );
            if (!items.length) return;
            event.preventDefault();
            const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
            const direction = event.key === "ArrowDown" ? 1 : -1;
            const nextIndex = (activeIndex + direction + items.length) % items.length;
            items[nextIndex]?.focus();
          }}
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
              focusMenuEdge("first");
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
          if (
            hasDeliveryOptions
            && (event.key === "ArrowDown" || event.key === "ArrowUp")
          ) {
            event.preventDefault();
            focusMenuEdge(event.key === "ArrowDown" ? "first" : "last");
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
