import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "../../../core/models/workspace";
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
});
