// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StashedPrompts } from "./StashedPrompts";

const workspacePath = "C:/projects/xiao";
const storageKey = (workspace = workspacePath, taskId = "task-1") =>
  `xiao.stashed-prompts.v1:${encodeURIComponent(workspace)}:${encodeURIComponent(taskId)}`;

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

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("stashes a draft, persists it, and restores it without duplication", () => {
    const onClear = vi.fn();
    const onRestore = vi.fn();
    const view = render(
      <StashedPrompts
        workspacePath={workspacePath}
        taskId="task-1"
        prompt="Finish the review panel"
        attachments={[]}
        onClear={onClear}
        onRestore={onRestore}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash current prompt" }));
    expect(onClear).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(storageKey())).toContain("Finish the review panel");

    view.rerender(
      <StashedPrompts
        workspacePath={workspacePath}
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
    expect(window.localStorage.getItem(storageKey())).toBe("[]");
  });

  it("keeps the draft when storage persistence fails", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const onClear = vi.fn();
    render(
      <StashedPrompts
        workspacePath={workspacePath}
        taskId="task-1"
        prompt="Do not lose me"
        attachments={[]}
        onClear={onClear}
        onRestore={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash current prompt" }));
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("current draft was kept");
  });

  it("opens existing items without silently stashing the current draft", () => {
    window.localStorage.setItem(storageKey(), JSON.stringify([{
      id: "saved",
      prompt: "Saved prompt",
      attachments: [],
      createdAt: 1,
    }]));
    const onClear = vi.fn();
    render(
      <StashedPrompts
        workspacePath={workspacePath}
        taskId="task-1"
        prompt="Current draft"
        attachments={[]}
        onClear={onClear}
        onRestore={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stashed prompts, 1" }));
    expect(screen.getByRole("button", { name: "Stash current" })).not.toBeNull();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("drops malformed persisted attachments before restoring a stash", () => {
    window.localStorage.setItem(storageKey(), JSON.stringify([{
      id: "saved",
      prompt: "Saved prompt",
      attachments: [{
        kind: "review",
        name: "review.ts",
        path: "review.ts",
        lineStart: "not-a-number",
      }],
      createdAt: 1,
    }]));
    const onRestore = vi.fn();
    render(
      <StashedPrompts
        workspacePath={workspacePath}
        taskId="task-1"
        prompt=""
        attachments={[]}
        onClear={vi.fn()}
        onRestore={onRestore}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stashed prompts, 1" }));
    fireEvent.click(screen.getByRole("button", { name: /Saved prompt/ }));
    expect(onRestore).toHaveBeenCalledWith("Saved prompt", []);
  });

  it("isolates stashes by workspace when task IDs match", () => {
    window.localStorage.setItem(storageKey("C:/projects/other"), JSON.stringify([{
      id: "other-workspace",
      prompt: "Other workspace prompt",
      attachments: [],
      createdAt: 1,
    }]));
    const view = render(
      <StashedPrompts
        workspacePath={workspacePath}
        taskId="task-1"
        prompt="Current workspace prompt"
        attachments={[]}
        onClear={vi.fn()}
        onRestore={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Stash current prompt" })).not.toBeNull();

    view.rerender(
      <StashedPrompts
        workspacePath="C:/projects/other"
        taskId="task-1"
        prompt=""
        attachments={[]}
        onClear={vi.fn()}
        onRestore={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Stashed prompts, 1" })).not.toBeNull();
  });
});
