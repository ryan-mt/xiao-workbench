"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";

import { navItems, site } from "@/lib/site";

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const desktop = window.matchMedia("(min-width: 880px)");
    const onDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    desktop.addEventListener("change", onDesktop);
    return () => {
      window.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onDesktop);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  return (
    <header className="top">
      <div className="frame top-inner">
        <a href="#top" className="mark" onClick={() => setOpen(false)}>
          <Image
            src="/xiao-mark.png"
            alt=""
            width={24}
            height={24}
            className="size-6 shrink-0"
            priority
          />
          <span className="truncate">{site.shortName}</span>
        </a>

        <nav className="nav" aria-label="Primary">
          {navItems.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>

        <div className="top-actions">
          <a
            href={site.releasesUrl}
            className="btn hidden sm:inline-flex"
            target="_blank"
            rel="noopener noreferrer"
          >
            Download
          </a>
          <button
            ref={toggleRef}
            type="button"
            className="menu"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((value) => !value)}
          >
            <span aria-hidden className="relative block size-3.5">
              <span
                className={`absolute left-0 top-[3px] h-[1.5px] w-3.5 bg-current transition ${
                  open ? "translate-y-[4.5px] rotate-45" : ""
                }`}
              />
              <span
                className={`absolute left-0 top-[10px] h-[1.5px] w-3.5 bg-current transition ${
                  open ? "-translate-y-[2.5px] -rotate-45" : ""
                }`}
              />
            </span>
          </button>
        </div>
      </div>

      {open ? (
        <div id={panelId} className="drawer">
          <nav aria-label="Mobile">
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="drawer-actions">
            <a
              href={site.releasesUrl}
              className="btn"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
            >
              Download Windows beta
            </a>
            <a
              href={site.repoUrl}
              className="btn btn-line"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
            >
              View source
            </a>
          </div>
        </div>
      ) : null}
    </header>
  );
}
