import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type MenuState = {
  left: number;
  top: number;
  target: HTMLElement;
};

export function GlobalContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const open = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const target = event.target instanceof HTMLElement ? event.target : document.body;
      setMenu({
        left: Math.min(event.clientX, window.innerWidth - 140),
        top: Math.min(event.clientY, window.innerHeight - 50),
        target,
      });
    };
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const closeMenu = () => setMenu(null);

    document.addEventListener("contextmenu", open);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnKey);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    document.addEventListener("scroll", closeMenu, true);
    return () => {
      document.removeEventListener("contextmenu", open);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
      document.removeEventListener("scroll", closeMenu, true);
    };
  }, []);

  const selectAll = () => {
    const editable = menu?.target.closest("input, textarea, [contenteditable='true']");
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
      editable.focus();
      editable.select();
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editable ?? document.body);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    setMenu(null);
  };

  return menu
    ? createPortal(
        <div
          className="global-context-menu"
          ref={menuRef}
          role="menu"
          aria-label="Text actions"
          style={{ left: menu.left, top: menu.top }}
        >
          <button type="button" role="menuitem" autoFocus onClick={selectAll}>Select all</button>
        </div>,
        document.body,
      )
    : null;
}
