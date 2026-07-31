// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOOT_INTRO_DURATION_MS,
  BOOT_INTRO_EXIT_MS,
  BOOT_INTRO_EXIT_REDUCED_MS,
  BOOT_INTRO_REDUCED_MS,
  BootIntro,
  XIAO_MARK_SRC,
  bootIntroDurationMs,
  bootIntroExitMs,
} from "./BootIntro";

describe("bootIntroDurationMs", () => {
  it("uses the cinematic duration by default and a short settle when reduced", () => {
    expect(bootIntroDurationMs(false)).toBe(BOOT_INTRO_DURATION_MS);
    expect(bootIntroDurationMs(true)).toBe(BOOT_INTRO_REDUCED_MS);
    expect(bootIntroExitMs(false)).toBe(BOOT_INTRO_EXIT_MS);
    expect(bootIntroExitMs(true)).toBe(BOOT_INTRO_EXIT_REDUCED_MS);
  });
});

describe("BootIntro", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const completeIntro = (preferReducedMotion: boolean) => {
    act(() => {
      vi.advanceTimersByTime(bootIntroDurationMs(preferReducedMotion));
    });
    act(() => {
      vi.advanceTimersByTime(bootIntroExitMs(preferReducedMotion));
    });
  };

  it("mounts children immediately under the overlay and removes the overlay after the sequence", () => {
    render(
      <BootIntro preferReducedMotion={false}>
        <div>desk content</div>
      </BootIntro>,
    );

    expect(screen.getByText("desk content")).toBeTruthy();
    const overlay = screen.getByRole("dialog", { name: /xiao workbench/i });
    expect(overlay.getAttribute("data-phase")).toBe("playing");
    expect(screen.getByText(/waking the desk/i)).toBeTruthy();
    const mark = overlay.querySelector("img.xiao-boot-mark__img");
    expect(mark).toBeTruthy();
    expect(mark?.getAttribute("src")).toBe(XIAO_MARK_SRC);

    completeIntro(false);

    expect(screen.queryByRole("dialog", { name: /xiao workbench/i })).toBeNull();
    expect(screen.getByText("desk content")).toBeTruthy();
  });

  it("can be disabled so the desk renders with no overlay", () => {
    render(
      <BootIntro disabled>
        <div>desk content</div>
      </BootIntro>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("desk content")).toBeTruthy();
  });

  it("uses the reduced-motion path without blocking forever", () => {
    const onComplete = vi.fn();
    render(
      <BootIntro preferReducedMotion onComplete={onComplete}>
        <div>desk content</div>
      </BootIntro>,
    );

    expect(screen.getByRole("dialog", { name: /xiao workbench/i })).toBeTruthy();
    completeIntro(true);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});