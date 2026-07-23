import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { isTauriHost } from "../../../core/bridges/tauri";

export type TitleBarTab = {
  id: string;
  title: string;
  draft?: boolean;
  working?: boolean;
};

type TitleBarProps = {
  tabs: TitleBarTab[];
  activeTabId: string;
  sidebarOpen: boolean;
  onOpenMenu: () => void;
  onToggleSidebar: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  update?: {
    version: string;
    installing: boolean;
    disabled: boolean;
    onInstall: () => void;
  };
};

const withWindow = (action: (window: ReturnType<typeof getCurrentWindow>) => Promise<void>) => {
  if (!isTauriHost()) return;
  void action(getCurrentWindow());
};

type TabOverflowEdges = {
  left: boolean;
  right: boolean;
};

export const tabOverflowEdges = ({
  clientWidth,
  scrollLeft,
  scrollWidth,
}: Pick<HTMLElement, "clientWidth" | "scrollLeft" | "scrollWidth">): TabOverflowEdges => {
  const maximum = Math.max(0, scrollWidth - clientWidth);
  const position = Math.min(maximum, Math.max(0, scrollLeft));
  return {
    left: position > 1,
    right: maximum - position > 1,
  };
};

export function TitleBar({
  tabs,
  activeTabId,
  sidebarOpen,
  onOpenMenu,
  onToggleSidebar,
  onSelectTab,
  onCloseTab,
  onNewTab,
  update,
}: TitleBarProps) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<TabOverflowEdges>({
    left: false,
    right: false,
  });
  const syncOverflow = useCallback(() => {
    const node = tabsRef.current;
    if (!node) return;
    const next = tabOverflowEdges(node);
    setOverflow((current) =>
      current.left === next.left && current.right === next.right ? current : next
    );
  }, []);

  useEffect(() => {
    const node = tabsRef.current;
    if (!node) return;
    syncOverflow();
    window.addEventListener("resize", syncOverflow);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", syncOverflow);
    }
    const observer = new ResizeObserver(syncOverflow);
    observer.observe(node);
    for (const tab of node.children) observer.observe(tab);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncOverflow);
    };
  }, [syncOverflow, tabs.length]);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
    const frame = window.requestAnimationFrame(syncOverflow);
    return () => window.cancelAnimationFrame(frame);
  }, [activeTabId, syncOverflow]);

  return (
    <header className="title-bar" data-tauri-drag-region>
      <div className="title-bar__nav" data-tauri-drag-region>
        <button
          className="title-bar__icon"
          type="button"
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <XiaoIcon name="sidebar" size={14} />
        </button>
        <button
          className="title-bar__icon"
          type="button"
          aria-label="Open Xiao command menu"
          title="Command menu · Ctrl K"
          onClick={onOpenMenu}
        >
          <XiaoIcon name="capability" size={14} />
        </button>
      </div>

      <div
        className="title-bar__tabs"
        role="tablist"
        aria-label="Open tasks"
        data-overflow-left={overflow.left || undefined}
        data-overflow-right={overflow.right || undefined}
        ref={tabsRef}
        onScroll={syncOverflow}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              className={`title-bar__tab ${active ? "is-active" : ""} ${tab.working ? "is-working" : ""}`}
              key={tab.id}
              ref={active ? activeTabRef : undefined}
              onAuxClick={(event) => {
                if (event.button === 1) onCloseTab(tab.id);
              }}
            >
              <button
                className="title-bar__tab-main"
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.working ? `${tab.title} · Xiao is working` : tab.title}
                onClick={() => onSelectTab(tab.id)}
              >
                <span className="title-bar__tab-mark">
                  {tab.working ? (
                    <span className="title-bar__tab-activity" aria-label="Xiao is working">
                      <i /><i /><i />
                    </span>
                  ) : (
                    <XiaoIcon name={tab.draft ? "edit" : "workspace"} size={12} />
                  )}
                </span>
                <span>{tab.title}</span>
              </button>
              {tabs.length > 1 || !tab.draft ? (
                <button
                  className="title-bar__tab-close"
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => onCloseTab(tab.id)}
                >
                  <XiaoIcon name="close" size={11} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      <button className="title-bar__new-tab" type="button" aria-label="New task tab" title="New task · Ctrl T" onClick={onNewTab}>
        <XiaoIcon name="add" size={14} />
      </button>
      <div className="title-bar__drag-space" data-tauri-drag-region />
      {update ? (
        <button
          className="title-bar__update"
          type="button"
          disabled={update.disabled}
          aria-busy={update.installing}
          title={`Update Codex to ${update.version}`}
          onClick={update.onInstall}
        >
          <XiaoIcon className={update.installing ? "spin" : undefined} name="refresh" size={11} />
          <span>{update.installing ? "Updating" : "Update"}</span>
          <small>{update.version}</small>
        </button>
      ) : null}

      {isTauriHost() ? (
        <div className="window-controls">
          <button type="button" aria-label="Minimize" onClick={() => withWindow((window) => window.minimize())}>
            <XiaoIcon name="minimize" size={14} />
          </button>
          <button type="button" aria-label="Toggle maximize" onClick={() => withWindow((window) => window.toggleMaximize())}>
            <XiaoIcon name="maximize" size={11} />
          </button>
          <button className="window-controls__close" type="button" aria-label="Close" onClick={() => withWindow((window) => window.close())}>
            <XiaoIcon name="close" size={13} />
          </button>
        </div>
      ) : null}
    </header>
  );
}
