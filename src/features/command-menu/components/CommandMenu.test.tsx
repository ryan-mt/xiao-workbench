// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { XiaoHistorySearchResult } from "../../../core/models/xiao";
import { CommandMenu, matchesCodexThreadSearch } from "./CommandMenu";

const workspace: WorkspaceSnapshot = {
  name: "Xiao",
  path: "C:/workspace/xiao",
  execution: {
    projectPath: "C:/workspace/xiao",
    executionRoot: "C:/workspace/xiao",
    environment: {
      id: "windows",
      kind: "windows",
      label: "Windows",
      availability: "available",
    },
    workspaceMode: "local",
    managedWorktree: null,
    isolationAvailable: true,
    isolationUnavailableReason: null,
  },
  files: [],
  git: null,
};

const noop = () => undefined;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CommandMenu", () => {
  it("keeps the Enter hint in the footer instead of repeating it on every result", () => {
    const markup = renderToStaticMarkup(
      <CommandMenu
        open
        tasks={[]}
        codexThreads={[]}
        workspace={workspace}
        onClose={noop}
        onSearchHistory={async () => []}
        onSelectHistoryResult={noop}
        onSelectCodexThread={noop}
        onSelectTask={noop}
        onSelectView={noop}
      />,
    );

    expect(markup).not.toContain("command-menu__result-key");
    expect(markup.match(/<kbd>Enter<\/kbd>/g)).toHaveLength(1);
  });

  it("finds cached Codex chats instantly by title, preview, and path", () => {
    const thread = {
      id: "019f",
      title: "Repair live history",
      preview: "Restore streaming command updates",
      cwd: "D:/Project Archive/xiao-workbench",
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    };

    expect(matchesCodexThreadSearch(thread, "repair live")).toBe(true);
    expect(matchesCodexThreadSearch(thread, "streaming command")).toBe(true);
    expect(matchesCodexThreadSearch(thread, "project archive")).toBe(true);
    expect(matchesCodexThreadSearch({ ...thread, archived: true }, "repair")).toBe(false);
  });

  it("preserves the selected item when async history changes the result count", async () => {
    vi.useFakeTimers();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    let resolveHistory: ((results: XiaoHistorySearchResult[]) => void) | undefined;
    render(
      <CommandMenu
        open
        tasks={[]}
        codexThreads={[]}
        workspace={workspace}
        onClose={noop}
        onSearchHistory={() => new Promise((resolve) => {
          resolveHistory = resolve;
        })}
        onSelectHistoryResult={noop}
        onSelectCodexThread={noop}
        onSelectTask={noop}
        onSelectView={noop}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Search tasks, messages, and actions" });
    fireEvent.change(input, { target: { value: "task" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /Task Preview/ }).classList.contains("is-active"))
      .toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(180);
      resolveHistory?.([{
        projectPath: "C:/other",
        projectName: "Other",
        taskId: "history-task",
        taskTitle: "History task",
        taskArchived: false,
        entryId: "entry-1",
        role: "task",
        matchKind: "title",
        snippet: "Task from history",
        createdAt: 1,
      }]);
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: /Task Preview/ }).classList.contains("is-active"))
      .toBe(true);
  });
});
