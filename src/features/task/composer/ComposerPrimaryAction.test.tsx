// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComposerPrimaryAction } from "./ComposerPrimaryAction";

afterEach(cleanup);

describe("ComposerPrimaryAction", () => {
  it("uses the single primary control to stop an active empty composer", () => {
    const onInterrupt = vi.fn();
    const onDeliver = vi.fn();
    render(
      <ComposerPrimaryAction working hasContent={false} canSubmit={false} canSteer
        onDeliver={onDeliver} onInterrupt={onInterrupt} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop current turn" }));
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(onDeliver).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("stops from the advertised Escape shortcut while focused", () => {
    const onInterrupt = vi.fn();
    render(
      <ComposerPrimaryAction working hasContent={false} canSubmit={false} canSteer
        onDeliver={vi.fn()} onInterrupt={onInterrupt} />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Stop current turn" }), {
      key: "Escape",
    });
    expect(onInterrupt).toHaveBeenCalledOnce();
  });

  it("synchronizes the Queue and Steer menu with its disclosure state", () => {
    const onInterrupt = vi.fn();
    const onDeliver = vi.fn();
    render(
      <ComposerPrimaryAction working hasContent canSubmit canSteer
        onDeliver={onDeliver} onInterrupt={onInterrupt} />,
    );
    const primary = screen.getByRole("button", { name: "Choose message delivery" });
    expect(primary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(primary);
    const menu = screen.getByRole("menu");
    expect(primary.getAttribute("aria-expanded")).toBe("true");
    expect(primary.getAttribute("aria-controls")).toBe(menu.id);

    const queue = screen.getByRole("menuitem", { name: /Queue/ });
    fireEvent.focus(queue);
    fireEvent.click(queue);
    expect(document.activeElement).toBe(primary);
    fireEvent.click(primary);
    const steer = screen.getByRole("menuitem", { name: /Steer/ });
    fireEvent.focus(steer);
    fireEvent.click(steer);
    expect(onDeliver.mock.calls).toEqual([["queue"], ["steer"]]);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(primary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(primary);
  });

  it("closes the delivery disclosure with Escape and returns focus to the primary action", () => {
    render(
      <ComposerPrimaryAction working hasContent canSubmit canSteer
        onDeliver={vi.fn()} onInterrupt={vi.fn()} />,
    );
    const primary = screen.getByRole("button", { name: "Choose message delivery" });
    fireEvent.click(primary);
    const steer = screen.getByRole("menuitem", { name: /Steer/ });
    fireEvent.focus(steer);
    fireEvent.keyDown(steer, { key: "Escape" });

    expect(primary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(primary);
  });

  it("steers from the advertised Ctrl+Enter shortcut while the queue action is focused", () => {
    const onDeliver = vi.fn();
    render(
      <ComposerPrimaryAction working hasContent canSubmit canSteer
        onDeliver={onDeliver} onInterrupt={vi.fn()} />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Choose message delivery" }), {
      key: "Enter",
      ctrlKey: true,
    });

    expect(onDeliver).toHaveBeenCalledWith("steer");
  });

  it("does not reopen a stale disclosure after delivery options disappear and return", () => {
    const props = {
      canSubmit: true,
      canSteer: true,
      onDeliver: vi.fn(),
      onInterrupt: vi.fn(),
    };
    const view = render(
      <ComposerPrimaryAction {...props} working hasContent />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose message delivery" }));
    expect(screen.getByRole("menu")).not.toBeNull();

    view.rerender(
      <ComposerPrimaryAction {...props} working={false} hasContent />,
    );
    expect(screen.queryByRole("menu")).toBeNull();

    view.rerender(
      <ComposerPrimaryAction {...props} working hasContent />,
    );
    expect(screen.getByRole("button", { name: "Choose message delivery" })
      .getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("restores focus only when an open delivery menu becomes unavailable", () => {
    const props = {
      canSubmit: true,
      canSteer: true,
      onDeliver: vi.fn(),
      onInterrupt: vi.fn(),
    };
    const state = (working: boolean, hasContent: boolean) => (
      <>
        <button type="button">Outside</button>
        <ComposerPrimaryAction {...props} working={working} hasContent={hasContent} />
      </>
    );
    const view = render(state(true, true));
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    expect(document.activeElement).toBe(outside);

    view.rerender(state(false, true));
    expect(document.activeElement).toBe(outside);

    view.rerender(state(true, true));
    fireEvent.click(screen.getByRole("button", { name: "Choose message delivery" }));
    const steer = screen.getByRole("menuitem", { name: /Steer/ });
    fireEvent.focus(steer);
    view.rerender(state(true, false));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Stop current turn" }),
    );
  });

  it("dismisses the delivery menu on outside pointerdown but not inside pointerdown", () => {
    render(
      <>
        <ComposerPrimaryAction working hasContent canSubmit canSteer
          onDeliver={vi.fn()} onInterrupt={vi.fn()} />
        <button type="button" onPointerDown={(event) => event.stopPropagation()}>Outside</button>
      </>,
    );
    const primary = screen.getByRole("button", { name: "Choose message delivery" });
    fireEvent.click(primary);
    const queue = screen.getByRole("menuitem", { name: /Queue/ });

    fireEvent.pointerDown(queue);
    expect(screen.getByRole("menu")).not.toBeNull();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(primary.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens from either Arrow key and wraps focus through enabled menu items", async () => {
    render(
      <ComposerPrimaryAction working hasContent canSubmit canSteer
        onDeliver={vi.fn()} onInterrupt={vi.fn()} />,
    );
    const primary = screen.getByRole("button", { name: "Choose message delivery" });

    fireEvent.keyDown(primary, { key: "ArrowDown" });
    const queue = await screen.findByRole("menuitem", { name: /Queue/ });
    const steer = screen.getByRole("menuitem", { name: /Steer/ });
    await waitFor(() => expect(document.activeElement).toBe(queue));

    fireEvent.keyDown(queue, { key: "ArrowDown" });
    expect(document.activeElement).toBe(steer);
    fireEvent.keyDown(steer, { key: "ArrowDown" });
    expect(document.activeElement).toBe(queue);
    fireEvent.keyDown(queue, { key: "ArrowUp" });
    expect(document.activeElement).toBe(steer);

    fireEvent.keyDown(steer, { key: "Escape" });
    fireEvent.keyDown(primary, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(steer));
  });
});
