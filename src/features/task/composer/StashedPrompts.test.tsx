// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StashedPrompts } from "./StashedPrompts";

describe("StashedPrompts", () => {
  beforeEach(() => {
    if (!window.localStorage) {
      const values = new Map<string, string>();
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
          clear: () => values.clear(),
          getItem: (key: string) => values.get(key) ?? null,
          removeItem: (key: string) => values.delete(key),
          setItem: (key: string, value: string) => values.set(key, value),
        },
      });
    }
    window.localStorage.clear();
  });

  it("stashes a draft, persists it, and restores it without duplication", () => {
    const onClear = vi.fn();
    const onRestore = vi.fn();
    const view = render(
      <StashedPrompts
        taskId="task-1"
        prompt="Finish the review panel"
        attachments={[]}
        onClear={onClear}
        onRestore={onRestore}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash current prompt" }));
    expect(onClear).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem("xiao.stashed-prompts.v1:task-1")).toContain("Finish the review panel");

    view.rerender(
      <StashedPrompts
        taskId="task-1"
        prompt=""
        attachments={[]}
        onClear={onClear}
        onRestore={onRestore}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stashed prompts, 1" }));
    fireEvent.click(screen.getByRole("button", { name: /Finish the review panel/ }));
    expect(onRestore).toHaveBeenCalledWith("Finish the review panel", []);
    expect(window.localStorage.getItem("xiao.stashed-prompts.v1:task-1")).toBe("[]");
  });
});
