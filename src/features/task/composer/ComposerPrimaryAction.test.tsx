// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

    fireEvent.click(screen.getByRole("menuitem", { name: /Queue/ }));
    fireEvent.click(primary);
    fireEvent.click(screen.getByRole("menuitem", { name: /Steer/ }));
    expect(onDeliver.mock.calls).toEqual([["queue"], ["steer"]]);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(primary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
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
});
