import { LogicalPosition, LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { isTauriHost, nativeBridge } from "../../../core/bridges/tauri";
import {
  BROWSER_HOME_URL,
  shouldHandleBrowserNavigationRequest,
  toBrowserUrl,
} from "./browserNavigation";

const BROWSER_WEBVIEW_LABEL = "xiao-browser";

type BrowserPlaceholder = {
  title: string;
  description: string;
  meta: string;
};

type BrowserPanelProps = {
  active: boolean;
  ariaLabel?: string;
  fillWindowOnFullscreen?: boolean;
  homeLabel?: string;
  homeUrl?: string;
  muted?: boolean;
  placeholder?: BrowserPlaceholder;
  webviewLabel?: string;
  navigationRequest?: { id: number; url: string } | null;
  onNavigationStart?: () => void;
};

const defaultPlaceholder: BrowserPlaceholder = {
  title: "Desktop browser",
  description: "Open Xiao as a desktop app to browse Google, YouTube, and research links here.",
  meta: "Home · google.com",
};

const messageFrom = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

const waitForCreation = (webview: Webview) =>
  new Promise<void>((resolve, reject) => {
    void webview.once("tauri://created", () => resolve());
    void webview.once<unknown>("tauri://error", (event) => reject(new Error(messageFrom(event.payload))));
  });

export function BrowserPanel({
  active,
  ariaLabel = "Research browser",
  fillWindowOnFullscreen = false,
  homeLabel = "Google home",
  homeUrl = BROWSER_HOME_URL,
  muted = false,
  placeholder = defaultPlaceholder,
  webviewLabel = BROWSER_WEBVIEW_LABEL,
  navigationRequest = null,
  onNavigationStart,
}: BrowserPanelProps) {
  const host = isTauriHost();
  const viewport = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const webview = useRef<Webview | null>(null);
  const activeRef = useRef(active);
  const editingAddress = useRef(false);
  const boundsFrame = useRef(0);
  const loadingTimer = useRef<number | undefined>(undefined);
  const handledNavigationRequest = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(host);
  const [error, setError] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState(homeUrl);
  const [address, setAddress] = useState(homeUrl);

  activeRef.current = active;

  const syncBounds = useCallback(async () => {
    const instance = webview.current;
    const target = viewport.current;
    if (!instance || !target) return;

    const parentWindow = getCurrentWindow();
    if (fillWindowOnFullscreen && await parentWindow.isFullscreen()) {
      await instance.setPosition(new PhysicalPosition(0, 0));
      await instance.setSize(await parentWindow.innerSize());
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    await instance.setPosition(new LogicalPosition(Math.round(rect.left), Math.round(rect.top)));
    await instance.setSize(new LogicalSize(Math.round(rect.width), Math.round(rect.height)));
  }, [fillWindowOnFullscreen]);

  const queueBoundsSync = useCallback(() => {
    cancelAnimationFrame(boundsFrame.current);
    boundsFrame.current = requestAnimationFrame(() => {
      void syncBounds().catch(() => undefined);
    });
  }, [syncBounds]);

  useEffect(() => {
    if (!host) return;

    let disposed = false;
    let instance: Webview | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let animationTimer = 0;

    const start = async () => {
      try {
        const target = viewport.current;
        if (!target) return;
        const rect = target.getBoundingClientRect();
        instance = await Webview.getByLabel(webviewLabel);
        if (!instance) {
          instance = new Webview(getCurrentWindow(), webviewLabel, {
            url: homeUrl,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
            focus: activeRef.current,
          });
          await waitForCreation(instance);
        }

        if (disposed) {
          await instance.close();
          return;
        }

        webview.current = instance;
        resizeObserver = new ResizeObserver(queueBoundsSync);
        resizeObserver.observe(target);
        const workspace = target.closest(".app-workspace");
        if (workspace) resizeObserver.observe(workspace);
        const rail = target.closest(".focus-rail");
        rail?.addEventListener("animationend", queueBoundsSync);
        window.addEventListener("resize", queueBoundsSync);

        await syncBounds();
        if (activeRef.current) await instance.show();
        else await instance.hide();
        setReady(true);
        setLoading(false);
        animationTimer = window.setTimeout(queueBoundsSync, 240);
      } catch (reason) {
        if (!disposed) {
          setError(messageFrom(reason));
          setLoading(false);
        }
      }
    };

    const startFrame = requestAnimationFrame(() => void start());
    const rail = viewport.current?.closest(".focus-rail");
    return () => {
      disposed = true;
      cancelAnimationFrame(startFrame);
      cancelAnimationFrame(boundsFrame.current);
      window.clearTimeout(animationTimer);
      resizeObserver?.disconnect();
      rail?.removeEventListener("animationend", queueBoundsSync);
      window.removeEventListener("resize", queueBoundsSync);
      if (webview.current === instance) webview.current = null;
      if (instance) void instance.close().catch(() => undefined);
    };
  }, [homeUrl, host, queueBoundsSync, syncBounds, webviewLabel]);

  useEffect(() => {
    if (!ready || !webview.current) return;
    if (!active) {
      void webview.current.hide().catch(() => undefined);
      return;
    }

    let cancelled = false;
    const show = async () => {
      try {
        await syncBounds();
        if (!cancelled) await webview.current?.show();
      } catch (reason) {
        if (!cancelled) setError(messageFrom(reason));
      }
    };
    const frame = requestAnimationFrame(() => void show());
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [active, ready, syncBounds]);

  useEffect(() => {
    if (!host || !ready) return;
    void nativeBridge.setBrowserMuted(webviewLabel, muted).catch((reason) => {
      setError(messageFrom(reason));
    });
  }, [host, muted, ready, webviewLabel]);

  const refreshCurrentUrl = useCallback(async () => {
    try {
      const url = await nativeBridge.getBrowserUrl(webviewLabel);
      setCurrentUrl(url);
      if (!editingAddress.current) setAddress(url);
    } catch {
      // The webview may be between navigations; keep the last known address.
    }
  }, [webviewLabel]);

  useEffect(() => {
    if (!active || !ready) return;
    void refreshCurrentUrl();
    const interval = window.setInterval(() => void refreshCurrentUrl(), 800);
    return () => window.clearInterval(interval);
  }, [active, ready, refreshCurrentUrl]);

  useEffect(() => {
    if (!active) return;
    const selectAddress = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        addressInput.current?.focus();
        addressInput.current?.select();
      }
    };
    window.addEventListener("keydown", selectAddress);
    return () => window.removeEventListener("keydown", selectAddress);
  }, [active]);

  useEffect(() => () => window.clearTimeout(loadingTimer.current), []);

  const finishLoadingSoon = () => {
    window.clearTimeout(loadingTimer.current);
    loadingTimer.current = window.setTimeout(() => {
      setLoading(false);
      void refreshCurrentUrl();
    }, 700);
  };

  const runBrowserCommand = async (
    command: () => Promise<void>,
    notifyNavigationStart = true,
  ) => {
    if (notifyNavigationStart) onNavigationStart?.();
    setError(null);
    setLoading(true);
    try {
      await command();
      finishLoadingSoon();
    } catch (reason) {
      setError(messageFrom(reason));
      setLoading(false);
    }
  };

  const navigate = async (input: string, notifyNavigationStart = true) => {
    const url = toBrowserUrl(input);
    setAddress(url);
    setCurrentUrl(url);
    await runBrowserCommand(
      () => nativeBridge.navigateBrowser(url, webviewLabel),
      notifyNavigationStart,
    );
  };

  useEffect(() => {
    if (!active || !ready || !navigationRequest) return;
    if (!shouldHandleBrowserNavigationRequest(
      handledNavigationRequest.current,
      navigationRequest.id,
    )) return;
    handledNavigationRequest.current = navigationRequest.id;
    void navigate(navigationRequest.url, false);
  }, [active, navigationRequest, ready]);

  const submitAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    editingAddress.current = false;
    addressInput.current?.blur();
    void navigate(address);
  };

  const controlsDisabled = !host || !ready;
  const secure = currentUrl.startsWith("https://");

  return (
    <section className={`browser-panel${loading ? " is-loading" : ""}`} aria-label={ariaLabel}>
      <header className="browser-panel__toolbar">
        <nav className="browser-panel__nav" aria-label="Browser navigation">
          <button type="button" disabled={controlsDisabled} aria-label="Go back" title="Back" onClick={() => void runBrowserCommand(() => nativeBridge.goBackBrowser(webviewLabel))}>
            <XiaoIcon name="back" size={14} />
          </button>
          <button type="button" disabled={controlsDisabled} aria-label="Go forward" title="Forward" onClick={() => void runBrowserCommand(() => nativeBridge.goForwardBrowser(webviewLabel))}>
            <XiaoIcon name="forward" size={14} />
          </button>
          <button type="button" disabled={controlsDisabled} aria-label={`Open ${homeLabel}`} title={homeLabel} onClick={() => void navigate(homeUrl)}>
            <XiaoIcon name="home" size={14} />
          </button>
        </nav>

        <form className="browser-panel__address" onSubmit={submitAddress}>
          <XiaoIcon name={secure ? "secure" : "browser"} size={12} />
          <input
            ref={addressInput}
            value={address}
            disabled={controlsDisabled}
            aria-label="Address or search"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              editingAddress.current = true;
              event.currentTarget.select();
            }}
            onBlur={() => {
              editingAddress.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setAddress(currentUrl);
              event.currentTarget.blur();
            }}
          />
        </form>

        <button className="browser-panel__reload" type="button" disabled={controlsDisabled} aria-label="Reload page" title="Reload" onClick={() => void runBrowserCommand(() => nativeBridge.reloadBrowser(webviewLabel))}>
          <XiaoIcon className={loading ? "is-spinning" : undefined} name="refresh" size={13} />
        </button>
        <i className="browser-panel__progress" aria-hidden="true" />
      </header>

      <div className="browser-panel__notice" role="status" hidden={!error}>
        <XiaoIcon name="approval" size={12} />
        <span>{error}</span>
      </div>

      <div className="browser-panel__viewport" ref={viewport} aria-busy={loading}>
        {!host ? (
          <div className="browser-panel__placeholder">
            <span><XiaoIcon name="browser" size={22} /></span>
            <strong>{placeholder.title}</strong>
            <p>{placeholder.description}</p>
            <small>{placeholder.meta}</small>
          </div>
        ) : !ready && !error ? (
          <div className="browser-panel__placeholder is-compact">
            <XiaoIcon className="is-spinning" name="pending" size={16} />
            <span>Starting browser</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
