import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceSnapshot } from "../../../core/models/workspace";

const bridge = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  getSystemInfo: vi.fn(),
}));

const hooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  let cursor = 0;
  let effects: Array<() => void | (() => void)> = [];

  return {
    reset() {
      slots.length = 0;
      cursor = 0;
      effects = [];
    },
    beginRender() {
      cursor = 0;
      effects = [];
    },
    flushEffects() {
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
    },
    useState<T>(initial: T | (() => T)) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = typeof initial === "function" ? (initial as () => T)() : initial;
      const setState = (value: T | ((current: T) => T)) => {
        const current = slots[slot] as T;
        slots[slot] = typeof value === "function" ? (value as (current: T) => T)(current) : value;
      };
      return [slots[slot] as T, setState] as const;
    },
    useRef<T>(initial: T) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot] as { current: T };
    },
    useEffect(effect: () => void | (() => void)) {
      cursor++;
      effects.push(effect);
    },
    useLayoutEffect(effect: () => void | (() => void)) {
      cursor++;
      effect();
    },
    useCallback<T>(callback: T) {
      cursor++;
      return callback;
    },
  };
});

vi.mock("react", () => ({
  useState: hooks.useState,
  useRef: hooks.useRef,
  useEffect: hooks.useEffect,
  useLayoutEffect: hooks.useLayoutEffect,
  useCallback: hooks.useCallback,
}));

vi.mock("../../../core/bridges/tauri", () => ({
  isTauriHost: () => true,
  nativeBridge: bridge,
}));

import { useWorkspace } from "./useWorkspace";

const snapshot = (projectPath: string, taskId: string): WorkspaceSnapshot => ({
  name: taskId,
  path: `${projectPath}/${taskId}`,
  execution: {
    projectPath,
    executionRoot: `${projectPath}/${taskId}`,
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
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const renderWorkspace = (projectPath: string, taskId: string) => {
  hooks.beginRender();
  return useWorkspace(projectPath, taskId);
};

describe("useWorkspace snapshot identity", () => {
  beforeEach(() => {
    hooks.reset();
    bridge.getWorkspace.mockReset();
    bridge.getSystemInfo.mockReset().mockResolvedValue({
      platform: "Windows",
      shell: "PowerShell",
      codexVersion: null,
    });
  });

  it("does not let a stalled system probe block the workspace snapshot", async () => {
    const workspace = deferred<WorkspaceSnapshot>();
    const system = deferred<{ platform: string; shell: string; codexVersion: string | null }>();
    bridge.getWorkspace.mockReturnValue(workspace.promise);
    bridge.getSystemInfo.mockReturnValue(system.promise);

    let view = renderWorkspace("C:/project-a", "task-a");
    hooks.flushEffects();
    workspace.resolve(snapshot("C:/project-a", "task-a"));
    await settle();

    view = renderWorkspace("C:/project-a", "task-a");
    expect(view.workspace.path).toBe("C:/project-a/task-a");
    expect(view.loading).toBe(false);
    expect(view.actionable).toBe(true);
  });

  it("fails closed synchronously while a confirmed task switch is unresolved", async () => {
    const taskA = deferred<WorkspaceSnapshot>();
    const taskB = deferred<WorkspaceSnapshot>();
    bridge.getWorkspace.mockImplementation((_path: string, taskId: string) =>
      taskId === "task-a" ? taskA.promise : taskB.promise,
    );

    let view = renderWorkspace("C:/project-a", "task-a");
    hooks.flushEffects();
    taskA.resolve(snapshot("C:/project-a", "task-a"));
    await settle();
    view = renderWorkspace("C:/project-a", "task-a");
    expect(view.actionable).toBe(true);
    expect(view.loadedTaskId).toBe("task-a");

    view = renderWorkspace("C:/project-a", "task-b");
    expect(view.workspace.path).toBe("C:/project-a/task-a");
    expect(view.identityStale).toBe(true);
    expect(view.loading).toBe(true);
    expect(view.actionable).toBe(false);
    hooks.flushEffects();

    taskB.resolve(snapshot("C:/project-a", "task-b"));
    await settle();
    view = renderWorkspace("C:/project-a", "task-b");
    expect(view.workspace.path).toBe("C:/project-a/task-b");
    expect(view.loadedTaskId).toBe("task-b");
    expect(view.identityStale).toBe(false);
    expect(view.actionable).toBe(true);
  });

  it("keeps project switches and failed loads non-actionable", async () => {
    const taskA = deferred<WorkspaceSnapshot>();
    const projectB = deferred<WorkspaceSnapshot>();
    bridge.getWorkspace.mockImplementation((path: string) =>
      path === "C:/project-a" ? taskA.promise : projectB.promise,
    );

    let view = renderWorkspace("C:/project-a", "task-a");
    hooks.flushEffects();
    taskA.resolve(snapshot("C:/project-a", "task-a"));
    await settle();
    view = renderWorkspace("C:/project-a", "task-a");
    expect(view.actionable).toBe(true);

    view = renderWorkspace("C:/project-b", "task-a");
    expect(view.loadedProjectPath).toBe("C:/project-a");
    expect(view.identityStale).toBe(true);
    expect(view.actionable).toBe(false);
    hooks.flushEffects();

    projectB.reject(new Error("workspace unavailable"));
    await settle();
    view = renderWorkspace("C:/project-b", "task-a");
    expect(view.workspace.path).toBe("C:/project-a/task-a");
    expect(view.loading).toBe(true);
    expect(view.error).toBe("workspace unavailable");
    expect(view.actionable).toBe(false);
  });
});
