// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SystemInfo, WorkspaceSnapshot } from "../../../core/models/workspace";

const terminalState = vi.hoisted(() => ({
  instances: [] as Array<{ focus: ReturnType<typeof vi.fn> }>,
  starts: [] as Array<{ resolve: (value: { replay: string; replaySequence: number }) => void }>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() { return { cols: 100, rows: 30 }; }
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    options = {};
    focus = vi.fn();
    constructor() { terminalState.instances.push(this); }
    loadAddon() {}
    open() {}
    onData() { return { dispose: () => undefined }; }
    write() {}
    writeln() {}
    clear() {}
    dispose() {}
  },
}));

vi.mock("../../../core/bridges/tauri", () => ({
  isTauriHost: () => true,
  nativeBridge: {
    resizeTerminal: vi.fn(async () => undefined),
    writeTerminal: vi.fn(async () => undefined),
    startTerminal: vi.fn(() => new Promise((resolve) => terminalState.starts.push({ resolve }))),
    stopTerminal: vi.fn(async () => undefined),
  },
}));

import { TerminalPanel } from "./TerminalPanel";

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

const system: SystemInfo = { platform: "win32", shell: "pwsh", codexVersion: null };

describe("TerminalPanel", () => {
  beforeEach(() => {
    terminalState.instances.length = 0;
    terminalState.starts.length = 0;
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does not focus a stale session when delayed startup finishes after tab selection changes", async () => {
    render(<TerminalPanel
      active
      workspace={workspace}
      taskId="task-1"
      system={system}
      transitioning={false}
      initialSessionIds={["session-1", "session-2"]}
      initialActiveSessionId="session-1"
    />);
    await waitFor(() => expect(terminalState.starts).toHaveLength(2));
    const firstFocusCount = terminalState.instances[0].focus.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Terminal 2" }));
    act(() => terminalState.starts[0].resolve({ replay: "", replaySequence: 0 }));
    await act(async () => { await Promise.resolve(); });

    expect(terminalState.instances[0].focus).toHaveBeenCalledTimes(firstFocusCount);
    act(() => terminalState.starts[1].resolve({ replay: "", replaySequence: 0 }));
    await waitFor(() => expect(terminalState.instances[1].focus).toHaveBeenCalled());
  });
});
