// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ComposerPrimaryAction } from "./ComposerPrimaryAction";

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

  it("morphs into queue and exposes steer from the same control while typing", () => {
    const onInterrupt = vi.fn();
    const onDeliver = vi.fn();
    render(
      <ComposerPrimaryAction working hasContent canSubmit canSteer
        onDeliver={onDeliver} onInterrupt={onInterrupt} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Queue follow-up" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Steer/ }));
    expect(onDeliver.mock.calls).toEqual([["queue"], ["steer"]]);
    expect(onInterrupt).not.toHaveBeenCalled();
  });
});
