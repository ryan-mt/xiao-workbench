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
import { isTaskPreviewTarget } from "./taskPreview";

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
  webviewLabel: string;
  navigationRequest?: { id: number; url: string } | null;
  onNavigationStart?: () => void;
  taskPreviewOnly?: boolean;
  taskId?: string;
  projectPath?: string;
  onTargetChange?: (url: string) => void;
  initialZoom?: number;
  onZoomChange?: (zoom: number) => void;
  initialViewport?: "responsive" | "desktop" | "tablet" | "mobile";
  onViewportChange?: (viewport: "responsive" | "desktop" | "tablet" | "mobile") => void;
  initialConsole?: Array<{ level: string; text: string; at: number }>;
  onConsoleChange?: (messages: Array<{ level: string; text: string; at: number }>) => void;
  onAnnotate?: (annotation: {
    target: string;
    viewport: { width: number; height: number };
    selector: string | null;
    coordinates: { x: number; y: number; width: number; height: number };
    zoom: number;
    note: string;
    screenshotReference: string;
  }) => void;
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
  webviewLabel,
  navigationRequest = null,
  onNavigationStart,
  taskPreviewOnly = false,
  taskId,
  projectPath,
  onTargetChange,
  initialZoom = 1,
  onZoomChange,
  initialViewport = "responsive",
  onViewportChange,
  initialConsole = [],
  onConsoleChange,
  onAnnotate,
}: BrowserPanelProps) {
  const host = isTauriHost();
  const viewport = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const webview = useRef<Webview | null>(null);
  const activeRef = useRef(active);
  const editingAddress = useRef(false);
  const initialHomeUrl = useRef(homeUrl);
  const initialZoomValue = useRef(initialZoom);
  const currentUrlRef = useRef(homeUrl);
  const onTargetChangeRef = useRef(onTargetChange);
  const boundsFrame = useRef(0);
  const loadingTimer = useRef<number | undefined>(undefined);
  const handledNavigationRequest = useRef<number | null>(null);
  const navigationGeneration = useRef(0);
  const navigationInFlight = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const [viewportPreset, setViewportPreset] = useState(initialViewport);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleMessages, setConsoleMessages] = useState(initialConsole);
  const [loading, setLoading] = useState(host);
  const [error, setError] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState(homeUrl);
  const [address, setAddress] = useState(homeUrl);
  const [zoom, setZoom] = useState(initialZoom);

  activeRef.current = active;
  onTargetChangeRef.current = onTargetChange;

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
    let initialNavigationGeneration: number | null = null;

    const start = async () => {
      try {
        const target = viewport.current;
        if (!target) return;
        const rect = target.getBoundingClientRect();
        instance = await Webview.getByLabel(webviewLabel);
        if (!instance) {
          instance = new Webview(getCurrentWindow(), webviewLabel, {
            url: taskPreviewOnly ? "about:blank" : homeUrl,
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
        if (taskPreviewOnly) {
          const generation = navigationGeneration.current + 1;
          navigationGeneration.current = generation;
          navigationInFlight.current = generation;
          initialNavigationGeneration = generation;
          await nativeBridge.navigateBrowser(
            initialHomeUrl.current,
            webviewLabel,
            taskId,
            projectPath,
          );
          if (navigationInFlight.current === generation) {
            navigationInFlight.current = null;
          }
        }
        await instance.setZoom(initialZoomValue.current);
        setReady(true);
        setLoading(false);
        animationTimer = window.setTimeout(queueBoundsSync, 240);
      } catch (reason) {
        if (navigationInFlight.current === initialNavigationGeneration) {
          navigationInFlight.current = null;
        }
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
  }, [host, projectPath, queueBoundsSync, syncBounds, taskId, taskPreviewOnly, webviewLabel]);

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
      if (navigationInFlight.current !== null) return;
      const observedGeneration = navigationGeneration.current;
      const url = await nativeBridge.getBrowserUrl(webviewLabel);
      if (
        navigationInFlight.current !== null ||
        observedGeneration !== navigationGeneration.current
      ) return;
      if (!url || url === currentUrlRef.current) return;
      if (taskPreviewOnly && !isTaskPreviewTarget(url)) return;
      currentUrlRef.current = url;
      setCurrentUrl(url);
      if (!editingAddress.current) setAddress(url);
      onTargetChangeRef.current?.(url);
    } catch {
      // The webview may be between navigations; keep the last known address.
    }
  }, [taskPreviewOnly, webviewLabel]);

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

  const finishLoadingSoon = (generation: number) => {
    window.clearTimeout(loadingTimer.current);
    loadingTimer.current = window.setTimeout(() => {
      if (navigationInFlight.current !== generation) return;
      navigationInFlight.current = null;
      setLoading(false);
      void refreshCurrentUrl();
    }, 700);
  };

  const runBrowserCommand = async (
    command: () => Promise<void>,
    notifyNavigationStart = true,
  ) => {
    const generation = navigationGeneration.current + 1;
    navigationGeneration.current = generation;
    navigationInFlight.current = generation;
    if (notifyNavigationStart) onNavigationStart?.();
    setError(null);
    setLoading(true);
    try {
      await command();
      if (navigationInFlight.current === generation) {
        finishLoadingSoon(generation);
      }
    } catch (reason) {
      if (navigationInFlight.current !== generation) return;
      navigationInFlight.current = null;
      const messages = [...consoleMessages, {
        level: "host",
        text: `Error: ${messageFrom(reason)}`,
        at: Date.now(),
      }].slice(-100);
      setConsoleMessages(messages);
      onConsoleChange?.(messages);
      setError(messageFrom(reason));
      setLoading(false);
    }
  };

  const navigate = async (input: string, notifyNavigationStart = true) => {
    const url = toBrowserUrl(input);
    if (taskPreviewOnly && !isTaskPreviewTarget(url)) {
      setError("Task Preview only opens host-registered files and local Task outcome servers.");
      setLoading(false);
      return;
    }
    setAddress(url);
    setCurrentUrl(url);
    currentUrlRef.current = url;
    onTargetChange?.(url);
    await runBrowserCommand(
      () => nativeBridge.navigateBrowser(url, webviewLabel, taskId, projectPath),
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

  useEffect(() => {
    if (!taskPreviewOnly || !consoleOpen || !active || !ready) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const messages = await nativeBridge.getBrowserConsole(webviewLabel);
        if (!disposed) {
          setConsoleMessages(messages);
          onConsoleChange?.(messages);
        }
      } catch {
        // The connection state already reports an unreachable preview.
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [active, consoleOpen, onConsoleChange, ready, taskPreviewOnly, webviewLabel]);

  const controlsDisabled = !host || !ready;
  const secure = currentUrl.startsWith("https://");
  const changeZoom = (next: number) => {
    const bounded = Math.min(2, Math.max(0.5, Math.round(next * 10) / 10));
    setZoom(bounded);
    onZoomChange?.(bounded);
    void webview.current?.setZoom(bounded)
      .catch((reason: unknown) => setError(messageFrom(reason)));
  };

  return (
    <section className={`browser-panel${loading ? " is-loading" : ""}`} aria-label={ariaLabel}>
      <header className="browser-panel__toolbar">
        <nav className="browser-panel__nav" aria-label={taskPreviewOnly ? "Task Preview navigation" : "Browser navigation"}>
          <button type="button" disabled={controlsDisabled} aria-label="Go back" title="Back" onClick={() => void runBrowserCommand(() => nativeBridge.goBackBrowser(webviewLabel))}>
            <XiaoIcon name="back" size={14} />
          </button>
          <button type="button" disabled={controlsDisabled} aria-label="Go forward" title="Forward" onClick={() => void runBrowserCommand(() => nativeBridge.goForwardBrowser(webviewLabel))}>
            <XiaoIcon name="forward" size={14} />
          </button>
          <button type="button" disabled={controlsDisabled || taskPreviewOnly} aria-label={`Open ${homeLabel}`} title={homeLabel} onClick={() => void navigate(homeUrl)}>
            <XiaoIcon name="home" size={14} />
          </button>
        </nav>

        <form className="browser-panel__address" onSubmit={submitAddress}>
          <XiaoIcon name={secure ? "secure" : "browser"} size={12} />
          <input
            ref={addressInput}
            value={address}
            disabled={controlsDisabled}
            readOnly={taskPreviewOnly}
            aria-label={taskPreviewOnly ? "Task Preview target" : "Address or search"}
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              if (!taskPreviewOnly) setAddress(event.target.value);
            }}
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
        {taskPreviewOnly ? (
          <div className="browser-panel__task-controls">
            <select
              aria-label="Task Preview viewport"
              value={viewportPreset}
              onChange={(event) => {
                const next = event.target.value as typeof viewportPreset;
                setViewportPreset(next);
                onViewportChange?.(next);
                queueBoundsSync();
              }}
            >
              <option value="responsive">Responsive</option>
              <option value="desktop">Desktop</option>
              <option value="tablet">Tablet</option>
              <option value="mobile">Mobile</option>
            </select>
            <button type="button" disabled={controlsDisabled} aria-label="Zoom out Task Preview" onClick={() => changeZoom(zoom - 0.1)}>−</button>
            <output aria-label="Task Preview zoom">{Math.round(zoom * 100)}%</output>
            <button type="button" disabled={controlsDisabled} aria-label="Zoom in Task Preview" onClick={() => changeZoom(zoom + 0.1)}>+</button>
            <button
              type="button"
              disabled={controlsDisabled || !isTaskPreviewTarget(currentUrl)}
              onClick={async () => {
                const note = window.prompt("Describe the Task Preview feedback");
                if (!note?.trim() || !projectPath || !taskId) return;
                const rect = viewport.current?.getBoundingClientRect();
                const viewportWidth = Math.round(rect?.width ?? 0);
                const viewportHeight = Math.round(rect?.height ?? 0);
                const selector = window.prompt("CSS selector or region label (optional)")?.trim() || null;
                const regionText = window.prompt(
                  "Region as x,y,width,height",
                  `0,0,${viewportWidth},${viewportHeight}`,
                );
                const values = regionText?.split(",").map(Number);
                const coordinates = values?.length === 4 && values.every(Number.isFinite)
                  ? {
                      x: Math.max(0, Math.min(viewportWidth, Math.round(values[0]))),
                      y: Math.max(0, Math.min(viewportHeight, Math.round(values[1]))),
                      width: Math.max(1, Math.min(viewportWidth, Math.round(values[2]))),
                      height: Math.max(1, Math.min(viewportHeight, Math.round(values[3]))),
                    }
                  : { x: 0, y: 0, width: viewportWidth, height: viewportHeight };
                try {
                  const screenshotReference = await nativeBridge.captureTaskPreview(
                    webviewLabel,
                    projectPath,
                    taskId,
                  );
                  onAnnotate?.({
                    target: currentUrl,
                    viewport: {
                      width: viewportWidth,
                      height: viewportHeight,
                    },
                    selector,
                    coordinates,
                    zoom,
                    note: note.trim().slice(0, 2_000),
                    screenshotReference,
                  });
                } catch (reason) {
                  setError(messageFrom(reason));
                }
              }}
            >
              Annotate
            </button>
            <button type="button" aria-expanded={consoleOpen} onClick={() => setConsoleOpen((open) => !open)}>
              Console
            </button>
            <button
              type="button"
              disabled={controlsDisabled || !projectPath || !taskId}
              onClick={() => {
                const selector = window.prompt("Selector to automate")?.trim();
                if (!selector || !projectPath || !taskId) return;
                const action = window.prompt("Action: click, focus, or fill", "click")?.trim();
                if (action !== "click" && action !== "focus" && action !== "fill") return;
                const value = action === "fill" ? window.prompt("Value", "") ?? "" : undefined;
                void nativeBridge.automateTaskPreview(
                  webviewLabel,
                  projectPath,
                  taskId,
                  action,
                  selector,
                  value,
                ).catch((reason) => setError(messageFrom(reason)));
              }}
            >
              Automate
            </button>
          </div>
        ) : null}
        <i className="browser-panel__progress" aria-hidden="true" />
      </header>

      <div className="browser-panel__notice" role="status" hidden={!error}>
        <XiaoIcon name="approval" size={12} />
        <span>{error}</span>
      </div>
      {taskPreviewOnly ? (
        <div className="browser-panel__notice" role="status" hidden={Boolean(error)}>
          <XiaoIcon name={error ? "approval" : ready ? "secure" : "pending"} size={12} />
          <span>{error ? "Outcome unreachable" : ready ? "Task Preview connected" : "Waiting for a Task outcome"}</span>
        </div>
      ) : null}

      {taskPreviewOnly && consoleOpen ? (
        <div className="browser-panel__console" role="log" aria-label="Task Preview console">
          {consoleMessages.length
            ? consoleMessages.map((message, index) => (
                <code key={`${message.at}-${index}`}>
                  [{message.level}] {message.text}
                </code>
              ))
            : <code>No preview events.</code>}
        </div>
      ) : null}

      <div
        className={`browser-panel__viewport is-${viewportPreset}`}
        ref={viewport}
        aria-busy={loading}
      >
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
