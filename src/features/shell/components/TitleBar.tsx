import { getCurrentWindow } from "@tauri-apps/api/window";

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

      <div className="title-bar__tabs" role="tablist" aria-label="Open tasks">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              className={`title-bar__tab ${active ? "is-active" : ""} ${tab.working ? "is-working" : ""}`}
              key={tab.id}
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
