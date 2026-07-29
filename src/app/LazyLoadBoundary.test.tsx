// @vitest-environment jsdom

import { lazy, Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FocusOnMount,
  LazyLoadBoundary,
  LazyLoadFocusFallback,
} from "./LazyLoadBoundary";

const BrokenPanel = () => {
  throw new Error("review panel chunk failed");
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe("LazyLoadBoundary", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps a failed lazy panel recoverable without crashing the Task Workbench", () => {
    const onReload = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <LazyLoadBoundary label="review panel" onReload={onReload}>
        <BrokenPanel />
      </LazyLoadBoundary>,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "The review panel could not be loaded.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload Xiao" }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("moves focus from the loading status to the resolved panel control", async () => {
    const panel = deferred<{ default: () => React.JSX.Element }>();
    const Panel = lazy(() => panel.promise);

    render(
      <LazyLoadBoundary label="review panel" onReload={() => undefined}>
        <Suspense fallback={<LazyLoadFocusFallback label="review panel" />}>
          <FocusOnMount targetSelector="#loaded-review-panel button">
            <Panel />
          </FocusOnMount>
        </Suspense>
      </LazyLoadBoundary>,
    );

    const loading = screen.getByRole("status", { name: "Loading review panel" });
    expect(document.activeElement).toBe(loading);

    await act(async () => {
      panel.resolve({
        default: () => (
          <aside id="loaded-review-panel">
            <button type="button">Close review panel</button>
          </aside>
        ),
      });
      await panel.promise;
    });

    const close = await screen.findByRole("button", { name: "Close review panel" });
    await waitFor(() => expect(document.activeElement).toBe(close));
  });

  it("focuses Reload Xiao when the lazy panel chunk rejects", async () => {
    const panel = deferred<{ default: () => React.JSX.Element }>();
    const Panel = lazy(() => panel.promise);
    const onReload = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <LazyLoadBoundary label="review panel" onReload={onReload}>
        <Suspense fallback={<LazyLoadFocusFallback label="review panel" />}>
          <Panel />
        </Suspense>
      </LazyLoadBoundary>,
    );

    await act(async () => {
      panel.reject(new Error("review panel chunk failed"));
      try {
        await panel.promise;
      } catch {
        // The error boundary owns the rejected lazy import.
      }
    });

    const reload = await screen.findByRole("button", { name: "Reload Xiao" });
    expect(document.activeElement).toBe(reload);
    fireEvent.click(reload);
    expect(onReload).toHaveBeenCalledOnce();
  });
});
