import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";

export function MessageImage({
  source,
  name,
  className,
  local = false,
}: {
  source: string;
  name: string;
  className?: string;
  local?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setFailed(false);
  }, [source]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    closeRef.current?.focus();
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      triggerRef.current?.focus();
    };
  }, [open]);

  if (failed) {
    return (
      <span className="message-image__fallback" role="img" aria-label={`${name}: image unavailable`}>
        <XiaoIcon name="file" size={14} />
        <span>{name}</span>
      </span>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        className={`message-image${className ? ` ${className}` : ""}`}
        type="button"
        title={`Open ${name}`}
        onClick={() => setOpen(true)}
      >
        <img
          src={source}
          alt={name}
          data-local-image={local ? "true" : undefined}
          decoding="async"
          loading="lazy"
          onError={() => setFailed(true)}
        />
        <span className="message-image__zoom"><XiaoIcon name="search" size={13} /></span>
      </button>
      {open ? createPortal(
        <div className="message-lightbox" role="dialog" aria-modal="true" aria-label={name}>
          <button
            className="message-lightbox__backdrop"
            type="button"
            tabIndex={-1}
            aria-label="Close image preview"
            onClick={() => setOpen(false)}
          />
          <figure>
            <img src={source} alt={name} />
            <figcaption>{name}</figcaption>
          </figure>
          <button
            ref={closeRef}
            className="message-lightbox__close"
            type="button"
            title="Close image preview"
            onClick={() => setOpen(false)}
          >
            <XiaoIcon name="close" size={18} />
          </button>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
