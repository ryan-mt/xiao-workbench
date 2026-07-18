import type * as ReactModule from "react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import type {
  AcceptanceContractDraft,
  AcceptanceContractVersionSummary,
} from "../../../core/models/verification";

const hookState = vi.hoisted(() => ({
  draft: null as AcceptanceContractDraft | null,
  editorReady: true,
  stateCall: 0,
  refCall: 0,
  refs: [] as Array<{ current: unknown }>,
  setters: [] as Mock[],
  cleanups: [] as Array<() => void>,
}));

const bridgeState = vi.hoisted(() => ({
  save: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (cleanup) hookState.cleanups.push(cleanup);
    },
    useRef: (initializer: unknown) => {
      const refIndex = hookState.refCall++;
      const ref = hookState.refs[refIndex] ?? { current: initializer };
      hookState.refs[refIndex] = ref;
      return ref;
    },
    useState: (initializer: unknown) => {
      const stateIndex = hookState.stateCall++;
      const value = stateIndex === 0
        ? hookState.draft
        : stateIndex === 4
          ? hookState.editorReady
          : typeof initializer === "function"
            ? (initializer as () => unknown)()
            : initializer;
      const setter = vi.fn();
      hookState.setters.push(setter);
      return [value, setter];
    },
  };
});

vi.mock("../../../core/bridges/tauri", () => ({
  isTauriHost: () => true,
  nativeBridge: {
    saveXiaoTaskAcceptanceContract: bridgeState.save,
  },
}));

import {
  createBufferedFieldState,
  isBufferedFieldReady,
  parseExitCodesField,
  transitionBufferedFieldState,
} from "./AcceptanceContractEditor";
import { canSaveAcceptanceContract, VerificationPanel } from "./VerificationPanel";

const savedContract: AcceptanceContractVersionSummary = {
  versionId: "version-1",
  contractId: "contract-1",
  version: 1,
  schema: 1,
  name: "Acceptance checks",
  gates: [],
  hash: "1234567890abcdef",
  createdAt: 1,
  updatedAt: 1,
};

type ButtonProps = {
  className?: string;
  children?: unknown;
  disabled?: boolean;
  onClick: () => void;
};

const findPrimaryButton = (node: unknown): ReactElement<ButtonProps> | null => {
  if (!node || typeof node !== "object") return null;
  const element = node as ReactElement<ButtonProps>;
  if (element.props?.className === "button button--primary") return element;
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findPrimaryButton(child);
      if (found) return found;
    }
    return null;
  }
  return findPrimaryButton(children);
};

const findResetButton = (node: unknown): ReactElement<ButtonProps> | null => {
  if (!node || typeof node !== "object") return null;
  const element = node as ReactElement<ButtonProps>;
  if (element.type === "button" && element.props?.children === "Reset") return element;
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findResetButton(child);
      if (found) return found;
    }
    return null;
  }
  return findResetButton(children);
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

beforeEach(() => {
  hookState.draft = null;
  hookState.editorReady = true;
  hookState.stateCall = 0;
  hookState.refCall = 0;
  hookState.refs = [];
  hookState.setters = [];
  hookState.cleanups = [];
  bridgeState.save.mockReset();
});

describe("VerificationPanel editor readiness", () => {
  it("blocks the exact trailing-comma draft before blur or save can persist stale codes", () => {
    const rawText = "0,";
    let exitCodes = createBufferedFieldState("0", JSON.stringify([0]), "task-1\u00000");
    exitCodes = transitionBufferedFieldState(exitCodes, {
      type: "edit",
      text: rawText,
      valid: parseExitCodesField(rawText) !== null,
    });
    hookState.draft = { name: "Acceptance checks", gates: [] };
    hookState.editorReady = isBufferedFieldReady(exitCodes);

    expect(canSaveAcceptanceContract({
      nativeAvailable: true,
      saving: false,
      editorReady: hookState.editorReady,
      hasDraftOrContract: true,
    })).toBe(false);

    const panel = VerificationPanel({
      projectPath: "C:/workspace",
      taskId: "task-1",
      contract: null,
      onSaved: vi.fn(),
    });
    const saveButton = findPrimaryButton(panel);
    expect(saveButton?.props.disabled).toBe(true);

    saveButton?.props.onClick();
    expect(bridgeState.save).not.toHaveBeenCalled();
  });

  it("advances the buffer reset revision when Reset discards raw fields", () => {
    hookState.draft = { name: "Acceptance checks", gates: [] };
    const panel = VerificationPanel({
      projectPath: "C:/workspace",
      taskId: "task-1",
      contract: savedContract,
      onSaved: vi.fn(),
    });
    const resetButton = findResetButton(panel);
    expect(resetButton).not.toBeNull();
    for (const setter of hookState.setters) setter.mockClear();

    resetButton?.props.onClick();

    expect(hookState.setters[4]).toHaveBeenCalledWith(true);
    const advanceRevision = hookState.setters[5]?.mock.calls[0]?.[0] as
      | ((revision: number) => number)
      | undefined;
    expect(advanceRevision?.(4)).toBe(5);
  });

  it("advances the buffer reset revision after a semantically equal successful save", async () => {
    hookState.draft = { name: "Acceptance checks", gates: [] };
    bridgeState.save.mockResolvedValueOnce(savedContract);
    const panel = VerificationPanel({
      projectPath: "C:/workspace",
      taskId: "task-1",
      contract: savedContract,
      onSaved: vi.fn(),
    });
    for (const setter of hookState.setters) setter.mockClear();

    findPrimaryButton(panel)?.props.onClick();
    await Promise.resolve();
    await Promise.resolve();

    expect(hookState.setters[4]).toHaveBeenCalledWith(true);
    const advanceRevision = hookState.setters[5]?.mock.calls[0]?.[0] as
      | ((revision: number) => number)
      | undefined;
    expect(advanceRevision?.(9)).toBe(10);
  });
});

describe("VerificationPanel save completion", () => {
  it.each([
    {
      name: "saving a contract",
      draft: { name: "Acceptance checks", gates: [] } satisfies AcceptanceContractDraft,
      current: null,
      saved: savedContract,
    },
    {
      name: "removing a contract",
      draft: null,
      current: savedContract,
      saved: null,
    },
  ])("notifies the task after $name resolves following unmount", async ({ draft, current, saved }) => {
    hookState.draft = draft;
    const completion = deferred<AcceptanceContractVersionSummary | null>();
    bridgeState.save.mockReturnValueOnce(completion.promise);
    const onSaved = vi.fn();

    const panel = VerificationPanel({
      projectPath: "C:/workspace",
      taskId: "task-1",
      contract: current,
      onSaved,
    });
    const saveButton = findPrimaryButton(panel);
    expect(saveButton).not.toBeNull();

    saveButton?.props.onClick();
    expect(bridgeState.save).toHaveBeenCalledWith({
      projectPath: "C:/workspace",
      taskId: "task-1",
      expectedCurrentVersionId: current?.versionId ?? null,
      contract: draft,
    });

    for (const setter of hookState.setters) setter.mockClear();
    hookState.cleanups[0]?.();
    completion.resolve(saved);
    await Promise.resolve();
    await Promise.resolve();

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith({
      projectPath: "C:/workspace",
      taskId: "task-1",
      contract: saved,
    });
    for (const setter of hookState.setters) expect(setter).not.toHaveBeenCalled();
  });

  it("keeps the observed draft and does not notify on a CAS conflict", async () => {
    hookState.draft = { name: "Locally edited checks", gates: [] };
    bridgeState.save.mockRejectedValueOnce(
      new Error("The Xiao task acceptance contract changed. Refresh and try again."),
    );
    const onSaved = vi.fn();
    const panel = VerificationPanel({
      projectPath: "C:/workspace",
      taskId: "task-1",
      contract: savedContract,
      onSaved,
    });
    for (const setter of hookState.setters) setter.mockClear();

    findPrimaryButton(panel)?.props.onClick();
    await Promise.resolve();
    await Promise.resolve();

    expect(bridgeState.save).toHaveBeenCalledWith({
      projectPath: "C:/workspace",
      taskId: "task-1",
      expectedCurrentVersionId: savedContract.versionId,
      contract: hookState.draft,
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(hookState.setters[0]).not.toHaveBeenCalled();
    expect(hookState.setters[2]).toHaveBeenCalledWith(
      "The Xiao task acceptance contract changed. Refresh and try again.",
    );
  });

  it.each([
    {
      name: "the same task ID in a different project",
      nextProjectPath: "D:/other-workspace",
      nextTaskId: "task-1",
    },
    {
      name: "a different task in the same project",
      nextProjectPath: "C:/workspace",
      nextTaskId: "task-2",
    },
  ])("routes a deferred save to its origin, not $name", async ({
    nextProjectPath,
    nextTaskId,
  }) => {
    hookState.draft = { name: "Acceptance checks", gates: [] };
    const completion = deferred<AcceptanceContractVersionSummary | null>();
    bridgeState.save.mockReturnValueOnce(completion.promise);
    const contracts = new Map([
      ["C:/workspace\u0000task-1", null as AcceptanceContractVersionSummary | null],
      [`${nextProjectPath}\u0000${nextTaskId}`, null as AcceptanceContractVersionSummary | null],
    ]);
    const onSaved = vi.fn((saved: {
      projectPath: string;
      taskId: string;
      contract: AcceptanceContractVersionSummary | null;
    }) => {
      contracts.set(`${saved.projectPath}\u0000${saved.taskId}`, saved.contract);
    });

    hookState.stateCall = 0;
    hookState.refCall = 0;
    const originPanel = VerificationPanel({
      projectPath: "C:/workspace",
      taskId: "task-1",
      contract: null,
      onSaved,
    });
    findPrimaryButton(originPanel)?.props.onClick();

    hookState.stateCall = 0;
    hookState.refCall = 0;
    VerificationPanel({
      projectPath: nextProjectPath,
      taskId: nextTaskId,
      contract: null,
      onSaved,
    });
    for (const setter of hookState.setters) setter.mockClear();

    completion.resolve(savedContract);
    await Promise.resolve();
    await Promise.resolve();

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith({
      projectPath: "C:/workspace",
      taskId: "task-1",
      contract: savedContract,
    });
    expect(contracts.get("C:/workspace\u0000task-1")).toBe(savedContract);
    expect(contracts.get(`${nextProjectPath}\u0000${nextTaskId}`)).toBeNull();
    for (const setter of hookState.setters) expect(setter).not.toHaveBeenCalled();
  });
});
