// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const host = {
    closeCount: 0,
    constructorCount: 0,
    navigations: [] as string[],
    observedUrl: "http://127.0.0.1:4101/redirected",
    browserUrlReads: 0,
    readBrowserUrl: async () => "http://127.0.0.1:4101/redirected",
    performNavigation: async (_url: string): Promise<void> => undefined,
    zooms: [] as number[],
  };
  const webviews = new Map<string, FakeWebview>();

  class FakeWebview {
    label: string;

    constructor(_window: unknown, label: string) {
      this.label = label;
      host.constructorCount += 1;
      webviews.set(label, this);
    }

    static async getByLabel(label: string) {
      return webviews.get(label) ?? null;
    }

    async once(event: string, callback: (event: { payload: unknown }) => void) {
      if (event === "tauri://created") queueMicrotask(() => callback({ payload: null }));
      return () => undefined;
    }

    async setPosition() {}
    async setSize() {}
    async show() {}
    async hide() {}

    async setZoom(zoom: number) {
      host.zooms.push(zoom);
    }

    async close() {
      host.closeCount += 1;
      webviews.delete(this.label);
    }
  }

  return { FakeWebview, host, webviews };
});

const { host, webviews } = mocks;

vi.mock("../../../core/bridges/tauri", () => ({
  isTauriHost: () => true,
  nativeBridge: {
    getBrowserUrl: async () => {
      mocks.host.browserUrlReads += 1;
      return mocks.host.readBrowserUrl();
    },
    navigateBrowser: async (url: string) => {
      mocks.host.navigations.push(url);
      await mocks.host.performNavigation(url);
    },
    setBrowserMuted: async () => undefined,
  },
}));

vi.mock("@tauri-apps/api/webview", () => ({
  Webview: mocks.FakeWebview,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    innerSize: async () => ({ width: 1200, height: 800 }),
    isFullscreen: async () => false,
  }),
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalPosition: class {
    constructor(public x: number, public y: number) {}
  },
  LogicalSize: class {
    constructor(public width: number, public height: number) {}
  },
  PhysicalPosition: class {
    constructor(public x: number, public y: number) {}
  },
}));

import { BrowserPanel } from "./BrowserPanel";

describe("BrowserPanel Task Preview lifecycle", () => {
  beforeEach(() => {
    host.closeCount = 0;
    host.constructorCount = 0;
    host.navigations = [];
    host.observedUrl = "http://127.0.0.1:4101/redirected";
    host.browserUrlReads = 0;
    host.readBrowserUrl = async () => host.observedUrl;
    host.performNavigation = async () => undefined;
    host.zooms = [];
    webviews.clear();
    let frame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++frame;
      queueMicrotask(() => callback(0));
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("persists observed navigation without recreating the webview and restores zoom", async () => {
    const targetChanges: string[] = [];
    const initialTarget = "http://127.0.0.1:4101/";
    const view = render(
      <BrowserPanel
        active
        taskPreviewOnly
        taskId="task"
        projectPath="C:/project"
        webviewLabel="xiao-task-preview-label"
        homeUrl={initialTarget}
        initialZoom={1.4}
        onTargetChange={(url) => {
          targetChanges.push(url);
          view.rerender(
            <BrowserPanel
              active
              taskPreviewOnly
              taskId="task"
              projectPath="C:/project"
              webviewLabel="xiao-task-preview-label"
              homeUrl={url}
              initialZoom={1.4}
              onTargetChange={(next) => targetChanges.push(next)}
            />,
          );
        }}
      />,
    );

    await waitFor(() => {
      expect(targetChanges).toEqual([host.observedUrl]);
    });

    expect(host.navigations).toEqual([initialTarget]);
    expect(host.constructorCount).toBe(1);
    expect(host.closeCount).toBe(0);
    expect(host.zooms).toContain(1.4);
  });

  it("ignores a URL observation that started before a newer navigation request", async () => {
    let resolveStaleObservation: ((url: string) => void) | undefined;
    const staleObservation = new Promise<string>((resolve) => {
      resolveStaleObservation = resolve;
    });
    host.readBrowserUrl = () => staleObservation;
    const targetChanges: string[] = [];
    const commonProps = {
      active: true,
      taskPreviewOnly: true,
      taskId: "task",
      projectPath: "C:/project",
      webviewLabel: "xiao-task-preview-label",
      homeUrl: "http://127.0.0.1:9/",
      onTargetChange: (url: string) => targetChanges.push(url),
    };
    const view = render(<BrowserPanel {...commonProps} />);

    await waitFor(() => {
      expect(host.browserUrlReads).toBeGreaterThan(0);
    });

    view.rerender(
      <BrowserPanel
        {...commonProps}
        navigationRequest={{ id: 1, url: "http://127.0.0.1:4102/" }}
      />,
    );
    await waitFor(() => {
      expect(host.navigations).toContain("http://127.0.0.1:4102/");
    });

    host.readBrowserUrl = async () => "http://127.0.0.1:4102/";
    await act(async () => {
      resolveStaleObservation?.("http://127.0.0.1:9/");
      await staleObservation;
    });

    await waitFor(() => {
      expect((screen.getByLabelText("Task Preview target") as HTMLInputElement).value)
        .toBe("http://127.0.0.1:4102/");
    });
    expect(targetChanges).toEqual(["http://127.0.0.1:4102/"]);
  });

  it("does not poll the old URL while a newer navigation command is in flight", async () => {
    let finishNavigation: (() => void) | undefined;
    const navigationPending = new Promise<void>((resolve) => {
      finishNavigation = resolve;
    });
    host.performNavigation = (url) => url.endsWith(":4102/")
      ? navigationPending
      : Promise.resolve();
    host.readBrowserUrl = async () => "http://127.0.0.1:9/";
    const targetChanges: string[] = [];
    const view = render(
      <BrowserPanel
        active
        taskPreviewOnly
        taskId="task"
        projectPath="C:/project"
        webviewLabel="xiao-task-preview-label"
        homeUrl="http://127.0.0.1:9/"
        onTargetChange={(url) => targetChanges.push(url)}
      />,
    );

    await waitFor(() => {
      expect(host.navigations).toContain("http://127.0.0.1:9/");
    });
    view.rerender(
      <BrowserPanel
        active
        taskPreviewOnly
        taskId="task"
        projectPath="C:/project"
        webviewLabel="xiao-task-preview-label"
        homeUrl="http://127.0.0.1:4102/"
        navigationRequest={{ id: 1, url: "http://127.0.0.1:4102/" }}
        onTargetChange={(url) => targetChanges.push(url)}
      />,
    );
    await waitFor(() => {
      expect(host.navigations).toContain("http://127.0.0.1:4102/");
    });

    await new Promise((resolve) => window.setTimeout(resolve, 900));
    expect(targetChanges).toEqual(["http://127.0.0.1:4102/"]);

    await act(async () => {
      finishNavigation?.();
      await navigationPending;
    });
  });
});
