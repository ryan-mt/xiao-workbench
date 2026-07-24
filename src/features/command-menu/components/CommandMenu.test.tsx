import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import { CommandMenu } from "./CommandMenu";

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
        workspace={workspace}
        onClose={noop}
        onSearchHistory={async () => []}
        onSelectHistoryResult={noop}
        onSelectTask={noop}
        onSelectView={noop}
      />,
    );

    expect(markup).not.toContain("command-menu__result-key");
    expect(markup.match(/<kbd>Enter<\/kbd>/g)).toHaveLength(1);
  });
});
