import type * as ReactModule from "react";
import type { DependencyList, ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntimeState } from "../../../core/models/agent";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";

const hookState = vi.hoisted(() => ({
  stateCall: 0,
  refCall: 0,
  effectCall: 0,
  callbackCall: 0,
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ dependencies: DependencyList | undefined; cleanup?: () => void }>,
  callbacks: [] as Array<{ callback: (...arguments_: never[]) => unknown; dependencies: DependencyList }>,
}));

const bridgeState = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useCallback: <T extends (...arguments_: never[]) => unknown>(callback: T, dependencies: DependencyList) => {
      const index = hookState.callbackCall++;
      const previous = hookState.callbacks[index];
      const changed = !previous ||
        dependencies.length !== previous.dependencies.length ||
        dependencies.some((dependency, dependencyIndex) => !Object.is(dependency, previous.dependencies[dependencyIndex]));
      if (changed) hookState.callbacks[index] = { callback, dependencies };
      return hookState.callbacks[index].callback as T;
    },
    useEffect: (effect: () => void | (() => void), dependencies?: DependencyList) => {
      const index = hookState.effectCall++;
      const previous = hookState.effects[index];
      const changed = !previous || !dependencies || !previous.dependencies ||
        dependencies.length !== previous.dependencies.length ||
        dependencies.some((dependency, dependencyIndex) => !Object.is(dependency, previous.dependencies?.[dependencyIndex]));
      if (!changed) return;
      previous?.cleanup?.();
      const cleanup = effect();
      hookState.effects[index] = { dependencies, cleanup: cleanup || undefined };
    },
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: (initializer: unknown) => {
      const index = hookState.refCall++;
      const ref = hookState.refs[index] ?? { current: initializer };
      hookState.refs[index] = ref;
      return ref;
    },
    useState: (initializer: unknown) => {
      const index = hookState.stateCall++;
      if (!(index in hookState.states)) {
        hookState.states[index] = typeof initializer === "function"
          ? (initializer as () => unknown)()
          : initializer;
      }
      const setter = (next: unknown) => {
        hookState.states[index] = typeof next === "function"
          ? (next as (current: unknown) => unknown)(hookState.states[index])
          : next;
      };
      return [hookState.states[index], setter];
    },
  };
});

vi.mock("../../../core/bridges/tauri", () => ({
  nativeBridge: { agentRequest: bridgeState.request },
}));

import { ExtensionsPanel } from "./ExtensionsPanel";

type RowProps = {
  name: string;
  action?: string;
  onAction?: () => void;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const runtime = {
  phase: "ready",
  profileId: null,
  taskId: null,
  threadId: null,
  turnId: null,
  turnStartedAt: null,
  error: null,
  eventsSeen: 0,
} satisfies AgentRuntimeState;

const workspace = (path: string): WorkspaceSnapshot => ({
  name: path.split("/").at(-1) ?? path,
  path,
  execution: {
    projectPath: path,
    executionRoot: path,
    environment: { id: "windows", kind: "windows", label: "Windows", availability: "available" },
    workspaceMode: "local",
    managedWorktree: null,
    isolationAvailable: true,
    isolationUnavailableReason: null,
  },
  files: [],
  git: null,
});

const renderPanel = (path: string, taskId: string | null) => {
  hookState.stateCall = 0;
  hookState.refCall = 0;
  hookState.effectCall = 0;
  hookState.callbackCall = 0;
  return ExtensionsPanel({ workspace: workspace(path), taskId, runtime });
};

const capabilityRows = (node: unknown, found: RowProps[] = []): RowProps[] => {
  if (!node || typeof node !== "object") return found;
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "function" && element.type.name === "CapabilityRow") {
    found.push(element.props as RowProps);
  }
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) capabilityRows(child, found);
  } else {
    capabilityRows(children, found);
  }
  return found;
};

const findRefreshButton = (node: unknown): ReactElement<{ disabled: boolean }> | null => {
  if (!node || typeof node !== "object") return null;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.props?.["aria-label"] === "Refresh capabilities") {
    return element as ReactElement<{ disabled: boolean }>;
  }
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findRefreshButton(child);
      if (found) return found;
    }
    return null;
  }
  return findRefreshButton(children);
};

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const skillPayload = (taskId: string, enabled = false) => ({
  data: [{ skills: [{ name: `${taskId} skill`, description: `${taskId} description`, path: `C:/${taskId}/skill.md`, enabled }] }],
});

const pluginPayload = (taskId: string) => ({
  marketplaces: [{
    name: `${taskId} marketplace`,
    path: `C:/${taskId}/marketplace`,
    plugins: [{ id: `${taskId}-plugin`, name: `${taskId} plugin`, installed: false, enabled: false }],
  }],
});

const installCapabilityResponses = (mutation: Deferred<unknown>, mutationMethod: "plugin/install" | "skills/config/write") => {
  bridgeState.request.mockImplementation((method: string, _parameters: unknown, context: { taskId: string }) => {
    if (method === mutationMethod) return mutation.promise;
    if (method === "skills/list") return Promise.resolve(skillPayload(context.taskId));
    if (method === "plugin/list") return Promise.resolve(pluginPayload(context.taskId));
    if (method === "mcpServerStatus/list" || method === "app/list") return Promise.resolve({ data: [] });
    throw new Error(`Unexpected method ${method}`);
  });
};

beforeEach(() => {
  hookState.stateCall = 0;
  hookState.refCall = 0;
  hookState.effectCall = 0;
  hookState.callbackCall = 0;
  hookState.states = [];
  hookState.refs = [];
  hookState.effects = [];
  hookState.callbacks = [];
  bridgeState.request.mockReset();
});

describe("ExtensionsPanel capability identity", () => {
  it.each([
    { rowName: "task-a skill", mutationMethod: "skills/config/write" as const },
    { rowName: "task-a plugin", mutationMethod: "plugin/install" as const },
  ])("keeps task B authoritative after a deferred $mutationMethod from task A", async ({ rowName, mutationMethod }) => {
    const mutation = deferred<unknown>();
    installCapabilityResponses(mutation, mutationMethod);

    renderPanel("C:/workspace", "task-a");
    await settle();
    const panelA = renderPanel("C:/workspace", "task-a");
    const originRow = capabilityRows(panelA).find((row) => row.name === rowName);
    expect(originRow?.onAction).toBeTypeOf("function");
    originRow?.onAction?.();

    const firstPanelB = renderPanel("C:/workspace", "task-b");
    expect(capabilityRows(firstPanelB)).toEqual([]);
    await settle();
    const settledPanelB = renderPanel("C:/workspace", "task-b");
    expect(capabilityRows(settledPanelB).map((row) => row.name)).toEqual([
      "task-b skill",
      "task-b plugin",
    ]);

    const mutationCall = bridgeState.request.mock.calls.find(([method]) => method === mutationMethod);
    expect(mutationCall?.[2]).toEqual({ projectPath: "C:/workspace", taskId: "task-a" });
    mutation.resolve(undefined);
    await settle();

    const finalPanelB = renderPanel("C:/workspace", "task-b");
    expect(capabilityRows(finalPanelB).map((row) => row.name)).toEqual([
      "task-b skill",
      "task-b plugin",
    ]);
    expect(bridgeState.request.mock.calls.filter(([method, , context]) =>
      method === "skills/list" && context.taskId === "task-a")).toHaveLength(1);
  });

  it("does not surface a stale task A mutation error under task B", async () => {
    const mutation = deferred<unknown>();
    installCapabilityResponses(mutation, "plugin/install");

    renderPanel("C:/workspace", "task-a");
    await settle();
    capabilityRows(renderPanel("C:/workspace", "task-a"))
      .find((row) => row.name === "task-a plugin")?.onAction?.();

    renderPanel("C:/workspace", "task-b");
    await settle();
    mutation.reject(new Error("task A install failed"));
    await settle();

    const panelB = renderPanel("C:/workspace", "task-b");
    expect(JSON.stringify(panelB)).not.toContain("task A install failed");
    expect(capabilityRows(panelB).map((row) => row.name)).toContain("task-b plugin");
  });

  it("clears capability rows and actions immediately for a draft task", async () => {
    const mutation = deferred<unknown>();
    installCapabilityResponses(mutation, "skills/config/write");

    renderPanel("C:/workspace", "task-a");
    await settle();
    expect(capabilityRows(renderPanel("C:/workspace", "task-a"))).not.toHaveLength(0);

    const draftPanel = renderPanel("C:/workspace", null);
    expect(capabilityRows(draftPanel)).toEqual([]);
    expect(findRefreshButton(draftPanel)?.props.disabled).toBe(true);
  });

  it("refreshes the current task after a same-scope mutation", async () => {
    const mutation = deferred<unknown>();
    let enabled = false;
    bridgeState.request.mockImplementation((method: string, _parameters: unknown, context: { taskId: string }) => {
      if (method === "skills/config/write") return mutation.promise;
      if (method === "skills/list") return Promise.resolve(skillPayload(context.taskId, enabled));
      if (method === "plugin/list") return Promise.resolve(pluginPayload(context.taskId));
      if (method === "mcpServerStatus/list" || method === "app/list") return Promise.resolve({ data: [] });
      throw new Error(`Unexpected method ${method}`);
    });

    renderPanel("C:/workspace", "task-a");
    await settle();
    const initialSkill = capabilityRows(renderPanel("C:/workspace", "task-a"))
      .find((row) => row.name === "task-a skill");
    expect(initialSkill?.action).toBe("Enable");
    initialSkill?.onAction?.();

    enabled = true;
    mutation.resolve(undefined);
    await settle();
    const refreshedSkill = capabilityRows(renderPanel("C:/workspace", "task-a"))
      .find((row) => row.name === "task-a skill");
    expect(refreshedSkill?.action).toBe("Disable");
    expect(bridgeState.request.mock.calls.filter(([method]) => method === "skills/list")).toHaveLength(2);
  });
});
