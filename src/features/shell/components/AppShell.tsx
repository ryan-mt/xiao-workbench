import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import "../styles/shell.css";

type AppShellProps = {
  titleBar: ReactNode;
  sidebar: ReactNode;
  content: ReactNode;
  focusRail?: ReactNode;
  statusBar: ReactNode;
  sidebarOpen: boolean;
  focusRailOverlay?: boolean;
  onCloseSidebar: () => void;
};

const defaultSidebarWidth = 272;
const minSidebarWidth = 240;
const sidebarWidthStorageKey = "xiao.sidebar.width.v3";
const defaultFocusRailWidth = 400;
const minFocusRailWidth = 360;
const defaultFocusRailPeekWidth = 560;
const minFocusRailPeekWidth = 480;
const minTaskWidth = 600;
const focusRailWidthStorageKey = "xiao.focus-rail.dock.width.v3";
const focusRailPeekWidthStorageKey = "xiao.focus-rail.peek.width.v3";

const maxSidebarWidth = () =>
  Math.max(minSidebarWidth, Math.min(380, Math.floor(window.innerWidth * 0.4)));

const clampSidebarWidth = (width: number) =>
  Math.min(maxSidebarWidth(), Math.max(minSidebarWidth, width));

const readSidebarWidth = () => {
  try {
    const stored = Number(window.localStorage.getItem(sidebarWidthStorageKey));
    return Number.isFinite(stored) && stored > 0
      ? clampSidebarWidth(stored)
      : clampSidebarWidth(defaultSidebarWidth);
  } catch {
    return clampSidebarWidth(defaultSidebarWidth);
  }
};

const readFocusRailWidth = (storageKey: string, minimum: number, fallback: number) => {
  try {
    const stored = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0
      ? Math.max(minimum, stored)
      : fallback;
  } catch {
    return fallback;
  }
};

export function AppShell({
  titleBar,
  sidebar,
  content,
  focusRail,
  statusBar,
  sidebarOpen,
  focusRailOverlay: preferFocusRailOverlay = false,
  onCloseSidebar,
}: AppShellProps) {
  const focusRailOpen = Boolean(focusRail);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [focusRailDockWidth, setFocusRailDockWidth] = useState(() =>
    readFocusRailWidth(focusRailWidthStorageKey, minFocusRailWidth, defaultFocusRailWidth),
  );
  const [focusRailPeekWidth, setFocusRailPeekWidth] = useState(() =>
    readFocusRailWidth(
      focusRailPeekWidthStorageKey,
      minFocusRailPeekWidth,
      defaultFocusRailPeekWidth,
    ),
  );
  const [focusRailMaxWidth, setFocusRailMaxWidth] = useState(defaultFocusRailPeekWidth);
  const [focusRailConstrained, setFocusRailConstrained] = useState(true);
  const [resizingFocusRail, setResizingFocusRail] = useState(false);
  const sidebarResizeStart = useRef({ pointerX: 0, sidebarWidth: defaultSidebarWidth });
  const focusRailResizeStart = useRef({ pointerX: 0, focusRailWidth: defaultFocusRailWidth });
  const workspaceRef = useRef<HTMLDivElement>(null);
  const focusRailWidth = preferFocusRailOverlay ? focusRailPeekWidth : focusRailDockWidth;
  const focusRailMinimum = preferFocusRailOverlay
    ? minFocusRailPeekWidth
    : minFocusRailWidth;
  const focusRailDefault = preferFocusRailOverlay
    ? defaultFocusRailPeekWidth
    : defaultFocusRailWidth;

  const updateFocusRailWidth = (update: (width: number) => number) => {
    if (preferFocusRailOverlay) {
      setFocusRailPeekWidth(update);
      return;
    }
    setFocusRailDockWidth(update);
  };

  const clampFocusRailWidth = (width: number) =>
    Math.min(focusRailMaxWidth, Math.max(focusRailMinimum, width));

  useEffect(() => {
    if (resizingSidebar) return;
    try {
      window.localStorage.setItem(sidebarWidthStorageKey, String(sidebarWidth));
    } catch {
      // Keep the resized width for this session when storage is unavailable.
    }
  }, [resizingSidebar, sidebarWidth]);

  useEffect(() => {
    if (resizingFocusRail) return;
    try {
      window.localStorage.setItem(focusRailWidthStorageKey, String(focusRailDockWidth));
      window.localStorage.setItem(focusRailPeekWidthStorageKey, String(focusRailPeekWidth));
    } catch {
      // Keep the resized widths for this session when storage is unavailable.
    }
  }, [focusRailDockWidth, focusRailPeekWidth, resizingFocusRail]);

  useEffect(() => {
    const keepWidthInViewport = () => setSidebarWidth((width) => clampSidebarWidth(width));
    window.addEventListener("resize", keepWidthInViewport);
    return () => window.removeEventListener("resize", keepWidthInViewport);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const closeCompactSidebar = (event: KeyboardEvent) => {
      if (event.key === "Escape" && window.matchMedia("(max-width: 760px)").matches) {
        onCloseSidebar();
      }
    };
    window.addEventListener("keydown", closeCompactSidebar);
    return () => window.removeEventListener("keydown", closeCompactSidebar);
  }, [onCloseSidebar, sidebarOpen]);

  useEffect(() => {
    if (!resizingSidebar) return;

    const resize = (event: PointerEvent) => {
      setSidebarWidth(
        clampSidebarWidth(
          sidebarResizeStart.current.sidebarWidth +
            event.clientX -
            sidebarResizeStart.current.pointerX,
        ),
      );
    };
    const stopResizing = () => setResizingSidebar(false);
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    window.addEventListener("blur", stopResizing);
    return () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
      window.removeEventListener("blur", stopResizing);
    };
  }, [resizingSidebar]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || !focusRailOpen) return;

    const keepFocusRailInWorkspace = () => {
      const overlaysTask =
        window.matchMedia("(max-width: 1040px)").matches ||
        workspace.clientWidth < minTaskWidth + focusRailMinimum;
      const nextMax = Math.max(
        focusRailMinimum,
        workspace.clientWidth - (overlaysTask ? 0 : minTaskWidth),
      );
      setFocusRailConstrained(overlaysTask);
      setFocusRailMaxWidth(nextMax);
      updateFocusRailWidth((width) =>
        Math.min(nextMax, Math.max(focusRailMinimum, width)),
      );
    };
    keepFocusRailInWorkspace();
    const observer = new ResizeObserver(keepFocusRailInWorkspace);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [focusRailOpen, preferFocusRailOverlay]);

  useEffect(() => {
    if (!resizingFocusRail) return;

    const resize = (event: PointerEvent) => {
      updateFocusRailWidth(() =>
        clampFocusRailWidth(
          focusRailResizeStart.current.focusRailWidth -
            (event.clientX - focusRailResizeStart.current.pointerX),
        ),
      );
    };
    const stopResizing = () => setResizingFocusRail(false);
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    window.addEventListener("blur", stopResizing);
    return () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
      window.removeEventListener("blur", stopResizing);
    };
  }, [focusRailMaxWidth, preferFocusRailOverlay, resizingFocusRail]);

  return (
    <div
      className={`app-frame ${resizingSidebar ? "app-frame--resizing-sidebar" : ""} ${
        resizingFocusRail ? "app-frame--resizing-focus-rail" : ""
      }`}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--focus-rail-width": `${focusRailWidth}px`,
        } as CSSProperties
      }
    >
      {titleBar}
      <div className={`app-layout ${sidebarOpen ? "" : "app-layout--sidebar-hidden"}`}>
        {sidebar}
        {sidebarOpen ? (
          <button
            className="sidebar-backdrop"
            type="button"
            aria-label="Close navigation"
            onClick={onCloseSidebar}
          />
        ) : null}
        {sidebarOpen ? (
          <div
            className="sidebar-resizer"
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuemin={minSidebarWidth}
            aria-valuemax={maxSidebarWidth()}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            onDoubleClick={() => setSidebarWidth(clampSidebarWidth(defaultSidebarWidth))}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              setSidebarWidth((width) =>
                clampSidebarWidth(width + (event.key === "ArrowLeft" ? -10 : 10)),
              );
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              sidebarResizeStart.current = { pointerX: event.clientX, sidebarWidth };
              setResizingSidebar(true);
            }}
          />
        ) : null}
        <div
          className={`app-workspace ${focusRailOpen ? "app-workspace--split" : ""} ${
            focusRailOpen && (preferFocusRailOverlay || focusRailConstrained)
              ? "app-workspace--focus-overlay"
              : ""
          }`}
          ref={workspaceRef}
        >
          <main className="app-content" tabIndex={-1}>{content}</main>
          {focusRailOpen ? (
            <div
              className="focus-rail-resizer"
              role="separator"
              aria-label="Resize review panel"
              aria-orientation="vertical"
              aria-valuemin={focusRailMinimum}
              aria-valuemax={focusRailMaxWidth}
              aria-valuenow={focusRailWidth}
              tabIndex={0}
              onDoubleClick={() =>
                updateFocusRailWidth(() => clampFocusRailWidth(focusRailDefault))
              }
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                updateFocusRailWidth((width) =>
                  clampFocusRailWidth(width + (event.key === "ArrowLeft" ? 10 : -10)),
                );
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                focusRailResizeStart.current = { pointerX: event.clientX, focusRailWidth };
                setResizingFocusRail(true);
              }}
            />
          ) : null}
          {focusRail ?? null}
        </div>
      </div>
      {statusBar}
    </div>
  );
}
