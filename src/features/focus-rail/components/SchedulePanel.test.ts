import type * as ReactModule from "react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RoutineSummary } from "../../../core/models/routine";

const hookState = vi.hoisted(() => ({
  stateCall: 0,
  refCall: 0,
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useEffect: () => undefined,
    useMemo: (factory: () => unknown) => factory(),
    useRef: (initialValue: unknown) => {
      const index = hookState.refCall++;
      const ref = hookState.refs[index] ?? { current: initialValue };
      hookState.refs[index] = ref;
      return ref;
    },
    useState: (initializer: unknown) => {
      const index = hookState.stateCall++;
      if (index >= hookState.states.length) {
        hookState.states[index] = typeof initializer === "function"
          ? (initializer as () => unknown)()
          : initializer;
      }
      const setState = (update: unknown) => {
        hookState.states[index] = typeof update === "function"
          ? (update as (current: unknown) => unknown)(hookState.states[index])
          : update;
      };
      return [hookState.states[index], setState];
    },
  };
});

import { routinePresetTaskId, SchedulePanel } from "./SchedulePanel";

describe("routine preset discovery context", () => {
  it("uses project-root context for a new routine", () => {
    expect(routinePresetTaskId(null)).toBeNull();
  });

  it("uses the persisted task binding when editing a routine", () => {
    expect(routinePresetTaskId({ taskId: "routine-task-123" })).toBe("routine-task-123");
  });
});

const scheduleProps = {
  projectPath: "C:/workspaces/project-a",
  routines: [],
  loading: false,
  error: null,
  creating: false,
  busyIds: new Set<string>(),
  nativeAvailable: true,
  dangerousAccessDefault: false,
  dangerousRoutineIds: new Set<string>(),
  openRunId: null,
  onCreate: async () => undefined,
  onUpdate: async () => undefined,
  onSetEnabled: async () => undefined,
  onRunNow: async () => undefined,
  onDelete: async () => undefined,
  onClearError: () => undefined,
} satisfies Parameters<typeof SchedulePanel>[0];

describe("schedule workspace identity", () => {
  it("remounts the state owner when the same rail switches projects", () => {
    const updateProjectA = async () => undefined;
    const deleteProjectA = async () => undefined;
    const updateProjectB = async () => undefined;
    const deleteProjectB = async () => undefined;
    const projectA = SchedulePanel({
      ...scheduleProps,
      onUpdate: updateProjectA,
      onDelete: deleteProjectA,
    });
    const refreshedProjectA = SchedulePanel({
      ...scheduleProps,
      routines: [],
    });
    const projectB = SchedulePanel({
      ...scheduleProps,
      projectPath: "C:/workspaces/project-b",
      onUpdate: updateProjectB,
      onDelete: deleteProjectB,
    });

    expect(refreshedProjectA.key).toBe(projectA.key);
    expect(projectB.key).not.toBe(projectA.key);
    expect(projectB.key).toBe("C:/workspaces/project-b");
    expect(projectB.props.onUpdate).toBe(updateProjectB);
    expect(projectB.props.onUpdate).not.toBe(updateProjectA);
    expect(projectB.props.onDelete).toBe(deleteProjectB);
    expect(projectB.props.onDelete).not.toBe(deleteProjectA);
  });
});

const routine = (id: string, title: string): RoutineSummary => ({
  id,
  workspacePath: "C:/workspaces/project-a",
  taskId: `task-${id}`,
  title,
  prompt: `${title} prompt`,
  acceptanceContract: null,
  scheduleKind: "daily",
  timezone: "UTC",
  scheduledFor: null,
  dailyTime: "09:00",
  missedRunPolicy: "run_once",
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  mode: "execute",
  approvalPolicy: "never",
  sandboxMode: "workspace-write",
  executionEnvironmentId: "local",
  executionRoot: "C:/workspaces/project-a",
  managedWorktreeId: null,
  workspaceMode: "local",
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  lastError: null,
  isolationWarning: null,
  lastStatus: null,
  history: [],
  version: 1,
  createdAt: 1,
  updatedAt: 1,
});

type TestElement = ReactElement<Record<string, unknown>>;

const renderWorkspace = (
  props: Parameters<typeof SchedulePanel>[0],
): TestElement => {
  hookState.stateCall = 0;
  hookState.refCall = 0;
  const owner = SchedulePanel(props);
  const Workspace = owner.type as (workspaceProps: typeof props) => TestElement;
  return Workspace(owner.props);
};

const elements = (node: unknown): TestElement[] => {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as TestElement;
  return [element, ...elements(element.props.children)];
};

const textContent = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return textContent((node as TestElement).props.children);
};

const findButton = (tree: TestElement, label: string, occurrence = 0) =>
  elements(tree).filter((element) =>
    element.type === "button" && textContent(element).includes(label)
  )[occurrence] as ReactElement<{ onClick: () => void }>;

const findTitleInput = (tree: TestElement) =>
  elements(tree).find((element) =>
    element.type === "input" && element.props.placeholder === "Daily code review"
  ) as ReactElement<{
    value: string;
    onChange: (event: { target: { value: string } }) => void;
  }>;

const findAriaButton = (tree: TestElement, label: string) =>
  elements(tree).find((element) =>
    element.type === "button" && element.props["aria-label"] === label
  ) as ReactElement<{ onClick: () => void }>;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

beforeEach(() => {
  hookState.stateCall = 0;
  hookState.refCall = 0;
  hookState.states = [];
  hookState.refs = [];
  vi.stubGlobal("window", {
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
  });
});

describe("schedule submit generation", () => {
  it("does not let update A completion wipe a newer edited B draft", async () => {
    const updateA = deferred();
    const onUpdate = vi.fn((id: string) =>
      id === "a" ? updateA.promise : Promise.resolve()
    );
    const props = {
      ...scheduleProps,
      routines: [routine("a", "Routine A"), routine("b", "Routine B")],
      onUpdate,
    };

    let tree = renderWorkspace(props);
    findAriaButton(tree, "Expand Routine A").props.onClick();
    tree = renderWorkspace(props);
    findButton(tree, "Edit").props.onClick();
    tree = renderWorkspace(props);
    findButton(tree, "Save routine").props.onClick();
    expect(onUpdate).toHaveBeenCalledWith("a", expect.objectContaining({
      title: "Routine A",
      prompt: "Routine A prompt",
    }));

    findAriaButton(tree, "Expand Routine B").props.onClick();
    tree = renderWorkspace(props);
    findButton(tree, "Edit").props.onClick();
    tree = renderWorkspace(props);
    findTitleInput(tree).props.onChange({ target: { value: "Newer B draft" } });
    updateA.resolve();
    await Promise.resolve();
    await Promise.resolve();

    tree = renderWorkspace(props);
    expect(textContent(tree)).toContain("Edit routine");
    expect(findTitleInput(tree).props.value).toBe("Newer B draft");
  });

  it("resets after a successful same-generation update", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const props = {
      ...scheduleProps,
      routines: [routine("a", "Routine A")],
      onUpdate,
    };

    let tree = renderWorkspace(props);
    findAriaButton(tree, "Expand Routine A").props.onClick();
    tree = renderWorkspace(props);
    findButton(tree, "Edit").props.onClick();
    tree = renderWorkspace(props);
    findButton(tree, "Save routine").props.onClick();
    await Promise.resolve();
    await Promise.resolve();

    tree = renderWorkspace(props);
    expect(textContent(tree)).toContain("New routine");
    expect(findTitleInput(tree).props.value).toBe("");
  });

  it("preserves the form and controller error after an update fails", async () => {
    const onUpdate = vi.fn(async () => {
      throw new Error("native update failed");
    });
    const initialProps = {
      ...scheduleProps,
      routines: [routine("a", "Routine A")],
      onUpdate,
    };

    let tree = renderWorkspace(initialProps);
    findAriaButton(tree, "Expand Routine A").props.onClick();
    tree = renderWorkspace(initialProps);
    findButton(tree, "Edit").props.onClick();
    tree = renderWorkspace(initialProps);
    findButton(tree, "Save routine").props.onClick();
    await Promise.resolve();
    await Promise.resolve();

    tree = renderWorkspace({ ...initialProps, error: "Native update failed." });
    expect(textContent(tree)).toContain("Edit routine");
    expect(textContent(tree)).toContain("Native update failed.");
    expect(findTitleInput(tree).props.value).toBe("Routine A");
  });
});
