import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentAttachment } from "../core/models/agent";
import {
  composerAttachmentRecovery,
  readComposerAttachmentRecoveries,
  storeComposerAttachmentRecovery,
} from "../features/task/composer/attachmentRecovery";

import type {
  AcceptanceContractVersionSummary,
  AcceptanceGate,
} from "../core/models/verification";
import {
  applyTaskAcceptanceContractSave,
  applyCurrentFocusResourceCompletion,
  attentionHydrationStatusForTaskState,
  attentionRetryTargets,
  attentionTaskStateMatchesWorkspace,
  applyCurrentWorkspaceArchiveCompletion,
  applyCurrentWorkspaceSaveCompletion,
  applyCurrentTaskOperationCompletion,
  clearTaskReviewContext,
  archivedProjectTaskState,
  beginNativeTaskConfirmation,
  canChangeDraftLaunchProject,
  captureTaskOperationScope,
  clearProjectGroup,
  clearVisibleTaskUnread,
  completeUndoRecovery,
  confirmedExecutionTaskId,
  confirmNativeTaskIds,
  codexProfileRuntimeSignature,
  createContinuationTask,
  explicitlyOpenedTaskSuppressesFocusedLaunch,
  isTaskWorkspaceStateLoading,
  markTaskUnreadAfterCompletion,
  queuedFollowUpIdForAutoSend,
  removeTaskOperationRevision,
  removeTaskReviewContext,
  restoreTaskAfterUndo,
  shouldAdoptResolvedWorkspacePath,
  shouldAutoConnectAgentRuntime,
  shouldInvalidateTaskWorkspaceState,
  shouldLoadTaskWorkspaceState,
  shouldCreateDraftWhenOpeningNewTaskTab,
  stageTaskReviewContext,
  submitTaskFollowUpAfterPersistence,
  taskIsVisible,
  taskReviewContext,
  isAcceptanceContractVersionSummary,
  readBrowserTaskState,
  type ConfirmedNativeTaskScope,
  type ConfirmedNativeTaskState,
  type StoredTaskState,
  WorkspaceTaskSaveDebouncer,
} from "./App";

describe("profile and project group state", () => {
  it("deduplicates runtime synchronization per profile", () => {
    const snapshot = { availability: "available" };

    expect(codexProfileRuntimeSignature("profile-a", snapshot)).not.toBe(
      codexProfileRuntimeSignature("profile-b", snapshot),
    );
  });

  it("clears a deleted group from visible and hidden project state", () => {
    const projects = [
      {
        path: "C:/projects/xiao",
        name: "Xiao",
        updatedAt: 1,
        projectGroupId: "group-a",
        projectGroupPosition: 3,
      },
      {
        path: "C:/projects/other",
        name: "Other",
        updatedAt: 2,
        projectGroupId: "group-b",
        projectGroupPosition: 0,
      },
    ];

    expect(clearProjectGroup(projects, "group-a")).toEqual([
      {
        ...projects[0],
        projectGroupId: null,
        projectGroupPosition: 0,
      },
      projects[1],
    ]);
  });
});

const workspacePath = "C:/projects/contract-validation";
const storageKey = `xiao.tasks.v2:${workspacePath}`;

const contract = (
  gates: AcceptanceGate[] = [],
): AcceptanceContractVersionSummary => ({
  versionId: "version-1",
  contractId: "contract-1",
  version: 1,
  schema: 1,
  name: "Acceptance",
  gates,
  hash: "sha256",
  createdAt: 100,
  updatedAt: 200,
});

const storedTask = (acceptanceContract: unknown) => ({
  id: "task-1",
  title: "Persisted task",
  meta: "Now",
  group: "Active",
  archived: false,
  pinned: false,
  createdAt: 100,
  updatedAt: 200,
  model: null,
  acceptanceContract,
  timeline: [],
});

const installStoredState = (acceptanceContract: unknown) => {
  const values: Record<string, string> = {
    [storageKey]: JSON.stringify({
      tasks: [storedTask(acceptanceContract)],
      activeTaskId: "task-1",
      showArchived: false,
    }),
  };
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => {
        values[key] = value;
      },
    },
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("stored task acceptance-contract validation", () => {
  it("resets stored workspace data when a contract is only an object", () => {
    installStoredState({});

    expect(readBrowserTaskState(workspacePath)).toEqual({
      tasks: [],
      activeTaskId: null,
      showArchived: false,
    });
  });

  it.each<AcceptanceGate>([
    {
      type: "command",
      executable: "npm",
      argv: ["test"],
      timeoutMs: 120_000,
      expectedExitCodes: [0],
    },
    {
      type: "diffScope",
      allowedPatterns: ["src/**"],
      deniedPatterns: ["dist/**"],
    },
    {
      type: "cleanliness",
      allowStaged: true,
      allowUnstaged: false,
      allowUntracked: false,
    },
  ])("accepts a valid $type contract summary from storage", (gate) => {
    const validContract = contract([gate]);
    installStoredState(validContract);

    expect(readBrowserTaskState(workspacePath).tasks[0]?.acceptanceContract).toEqual(
      validContract,
    );
  });

  it("keeps historical summaries with an empty gate list valid", () => {
    const historicalContract = contract();

    expect(isAcceptanceContractVersionSummary(historicalContract)).toBe(true);
  });

  it.each([
    "versionId",
    "contractId",
    "version",
    "schema",
    "name",
    "gates",
    "hash",
    "createdAt",
    "updatedAt",
  ] as const)("rejects a summary missing %s", (field) => {
    const invalidContract: Record<string, unknown> = { ...contract() };
    delete invalidContract[field];

    expect(isAcceptanceContractVersionSummary(invalidContract)).toBe(false);
  });

  it.each([
    [
      {
        type: "command",
        executable: "npm",
        argv: ["test"],
        timeoutMs: 120_000,
        expectedExitCodes: [0],
      },
      ["executable", "argv", "timeoutMs", "expectedExitCodes"],
    ],
    [
      {
        type: "diffScope",
        allowedPatterns: ["src/**"],
        deniedPatterns: [],
      },
      ["allowedPatterns", "deniedPatterns"],
    ],
    [
      {
        type: "cleanliness",
        allowStaged: true,
        allowUnstaged: true,
        allowUntracked: true,
      },
      ["allowStaged", "allowUnstaged", "allowUntracked"],
    ],
  ] as const)("rejects a %s gate missing a required field", (gate, fields) => {
    for (const field of fields) {
      const invalidGate: Record<string, unknown> = { ...gate };
      delete invalidGate[field];
      expect(isAcceptanceContractVersionSummary(contract([invalidGate as AcceptanceGate]))).toBe(
        false,
      );
    }
  });
});

describe("continuation task acceptance contract", () => {
  it("starts without the source task's immutable contract", () => {
    const sourceContract = Object.freeze(contract());
    installStoredState(sourceContract);
    const source = readBrowserTaskState(workspacePath).tasks[0]!;

    const continuation = createContinuationTask(source, {
      id: "continuation-task",
      createdAt: 300,
    });

    expect(continuation).toMatchObject({
      id: "continuation-task",
      title: "Continue: Persisted task",
      createdAt: 300,
      updatedAt: 300,
      stage: "draft",
      stageVersion: 0,
      workbenchState: {},
      acceptanceContract: null,
    });
    expect(continuation.timeline).toEqual(source.timeline);
    expect(continuation.timeline).not.toBe(source.timeline);
    expect(source.acceptanceContract).toEqual(sourceContract);
  });
});

describe("new-task draft lifecycle", () => {
  it("reuses an already-open draft when New task is opened again", () => {
    expect(shouldCreateDraftWhenOpeningNewTaskTab(true)).toBe(false);
    expect(shouldCreateDraftWhenOpeningNewTaskTab(false)).toBe(true);
  });

  it.each([
    ["draft text", { draftText: "unsaved prompt" }],
    ["composer attachments", { attachmentCount: 1 }],
    ["review context", { reviewContextCount: 1 }],
    ["definition of done", { definitionOfDoneChanged: true }],
  ])("locks project changes while the draft has unsaved %s", (_name, change) => {
    expect(canChangeDraftLaunchProject({
      selectedTask: false,
      hasActiveRuns: false,
      draftText: "",
      attachmentCount: 0,
      reviewContextCount: 0,
      definitionOfDoneChanged: false,
      ...change,
    })).toBe(false);
  });

  it("allows project changes for a clean, idle draft", () => {
    expect(canChangeDraftLaunchProject({
      selectedTask: false,
      hasActiveRuns: false,
      draftText: "",
      attachmentCount: 0,
      reviewContextCount: 0,
      definitionOfDoneChanged: false,
    })).toBe(true);
  });
});

describe("explicit Task navigation", () => {
  it("keeps a consumed deep link out of focused-launch mode", () => {
    const explicitTaskKey = "c:/projects/xiao\u0000task-a";

    expect(
      explicitlyOpenedTaskSuppressesFocusedLaunch(
        explicitTaskKey,
        "C:/projects/xiao",
        "task-a",
      ),
    ).toBe(true);
    expect(
      explicitlyOpenedTaskSuppressesFocusedLaunch(
        explicitTaskKey,
        "C:/projects/xiao",
        "task-b",
      ),
    ).toBe(false);
  });
});

describe("acceptance-contract save identity", () => {
  it("does not apply a stale result to the same task ID in another project", () => {
    installStoredState(null);
    const tasks = readBrowserTaskState(workspacePath).tasks;

    const result = applyTaskAcceptanceContractSave("D:/projects/other", tasks, {
      projectPath: workspacePath,
      taskId: "task-1",
      contract: contract(),
    });

    expect(result).toBe(tasks);
    expect(result[0]?.acceptanceContract).toBeNull();
  });

  it("updates the originating task without applying its contract to the active task", () => {
    installStoredState(null);
    const origin = readBrowserTaskState(workspacePath).tasks[0]!;
    const active = { ...origin, id: "task-2", title: "Active task" };

    const result = applyTaskAcceptanceContractSave(workspacePath, [origin, active], {
      projectPath: workspacePath,
      taskId: origin.id,
      contract: contract(),
    });

    expect(result[0]?.acceptanceContract).toEqual(contract());
    expect(result[1]?.acceptanceContract).toBeNull();
  });
});

const attachmentRecoveryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const scopeOf = (state: ConfirmedNativeTaskState): ConfirmedNativeTaskScope => ({
  workspacePath: state.workspacePath,
  generation: state.generation,
});

describe("active project archive completion identity", () => {
  it("keeps the incoming workspace intact when the outgoing archive save resolves", async () => {
    installStoredState(null);
    const firstPath = workspacePath;
    const secondPath = "D:/projects/incoming";
    const firstTask = readBrowserTaskState(firstPath).tasks[0]!;
    const firstState: StoredTaskState = {
      tasks: [firstTask],
      activeTaskId: firstTask.id,
      showArchived: false,
    };
    const archivedFirstState = archivedProjectTaskState(firstState.tasks, 300);
    let confirmation = confirmNativeTaskIds(
      beginNativeTaskConfirmation(
        { workspacePath: "", generation: 0, taskIds: new Set() },
        firstPath,
      ),
      { workspacePath: firstPath, generation: 1 },
      [firstTask.id],
    );
    const archiveScope = scopeOf(confirmation);
    const archiveSave = deferred<void>();
    let visibleState = firstState;
    let latest: { path: string; state: StoredTaskState } = {
      path: firstPath,
      state: firstState,
    };
    const completion = archiveSave.promise.then(() =>
      applyCurrentWorkspaceArchiveCompletion(
        confirmation,
        archiveScope,
        archivedFirstState,
        (state) => {
          visibleState = state;
          latest = { path: confirmation.workspacePath, state };
        },
      )
    );

    const secondTask = {
      ...firstTask,
      id: "task-incoming",
      title: "Incoming workspace task",
    };
    const secondState: StoredTaskState = {
      tasks: [secondTask],
      activeTaskId: secondTask.id,
      showArchived: false,
    };
    confirmation = beginNativeTaskConfirmation(confirmation, secondPath);
    confirmation = confirmNativeTaskIds(
      confirmation,
      scopeOf(confirmation),
      [secondTask.id],
    );
    visibleState = secondState;
    latest = { path: secondPath, state: secondState };

    archiveSave.resolve();
    await expect(completion).resolves.toBe(false);
    expect(visibleState).toBe(secondState);

    const persist = vi.fn(async (_path: string, _state: StoredTaskState) => undefined);
    const debouncer = new WorkspaceTaskSaveDebouncer(persist);
    await debouncer.flushOnDispose(latest);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(secondPath, secondState);
    expect(persist).not.toHaveBeenCalledWith(secondPath, archivedFirstState);
  });

  it("archives and clears the active task when the workspace generation is unchanged", async () => {
    installStoredState(null);
    const task = readBrowserTaskState(workspacePath).tasks[0]!;
    const archivedState = archivedProjectTaskState([task], 300);
    const confirmation = confirmNativeTaskIds(
      beginNativeTaskConfirmation(
        { workspacePath: "", generation: 0, taskIds: new Set() },
        workspacePath,
      ),
      { workspacePath, generation: 1 },
      [task.id],
    );
    const archiveSave = deferred<void>();
    let visibleState: StoredTaskState = {
      tasks: [task],
      activeTaskId: task.id,
      showArchived: false,
    };
    const completion = archiveSave.promise.then(() =>
      applyCurrentWorkspaceArchiveCompletion(
        confirmation,
        scopeOf(confirmation),
        archivedState,
        (state) => {
          visibleState = state;
        },
      )
    );

    archiveSave.resolve();
    await expect(completion).resolves.toBe(true);
    expect(visibleState).toEqual({
      tasks: [{
        ...task,
        archived: true,
        pinned: false,
        updatedAt: 300,
        meta: "Now",
      }],
      activeTaskId: null,
      showArchived: false,
    });
  });
});

describe("task workspace-mode completion identity", () => {
  it("does not apply an outgoing environment to the same task ID in the incoming workspace", async () => {
    installStoredState(null);
    const firstPath = workspacePath;
    const secondPath = "D:/projects/incoming";
    const firstTask = readBrowserTaskState(firstPath).tasks[0]!;
    let confirmation = confirmNativeTaskIds(
      beginNativeTaskConfirmation(
        { workspacePath: "", generation: 0, taskIds: new Set() },
        firstPath,
      ),
      { workspacePath: firstPath, generation: 1 },
      [firstTask.id],
    );
    const environmentScope = scopeOf(confirmation);
    const nativeOperation = deferred<{
      executionEnvironmentId: string;
      managedWorktreeId: string;
      workspaceMode: "managed-worktree";
    }>();
    let visibleState: StoredTaskState = {
      tasks: [firstTask],
      activeTaskId: firstTask.id,
      showArchived: false,
    };
    let latest = { path: firstPath, state: visibleState };
    let environmentBusyTaskId: string | null = firstTask.id;
    const completion = nativeOperation.promise
      .then((executionPatch) =>
        applyCurrentWorkspaceSaveCompletion(
          confirmation,
          environmentScope,
          () => {
            visibleState = {
              ...visibleState,
              tasks: visibleState.tasks.map((task) =>
                task.id === firstTask.id ? { ...task, ...executionPatch } : task
              ),
            };
            latest = { path: confirmation.workspacePath, state: visibleState };
          },
        )
      )
      .finally(() => {
        applyCurrentWorkspaceSaveCompletion(
          confirmation,
          environmentScope,
          () => {
            if (environmentBusyTaskId === firstTask.id) environmentBusyTaskId = null;
          },
        );
      });

    const secondTask = {
      ...firstTask,
      title: "Incoming task with the same ID",
    };
    const secondState: StoredTaskState = {
      tasks: [secondTask],
      activeTaskId: secondTask.id,
      showArchived: false,
    };
    confirmation = beginNativeTaskConfirmation(confirmation, secondPath);
    confirmation = confirmNativeTaskIds(
      confirmation,
      scopeOf(confirmation),
      [secondTask.id],
    );
    visibleState = secondState;
    latest = { path: secondPath, state: secondState };
    environmentBusyTaskId = secondTask.id;

    nativeOperation.resolve({
      executionEnvironmentId: "environment-from-first-workspace",
      managedWorktreeId: "worktree-from-first-workspace",
      workspaceMode: "managed-worktree",
    });
    await expect(completion).resolves.toBe(false);

    expect(visibleState).toBe(secondState);
    expect(environmentBusyTaskId).toBe(secondTask.id);
    const persist = vi.fn(async (_path: string, _state: StoredTaskState) => undefined);
    const debouncer = new WorkspaceTaskSaveDebouncer(persist);
    await debouncer.flushOnDispose(latest);
    expect(persist).toHaveBeenCalledWith(secondPath, secondState);
    expect(persist).not.toHaveBeenCalledWith(
      secondPath,
      expect.objectContaining({
        tasks: [expect.objectContaining({
          executionEnvironmentId: "environment-from-first-workspace",
        })],
      }),
    );
  });
});

describe("workspace task persistence debounce", () => {
  it("adopts an imported snapshot without replaying the stale pre-import state", async () => {
    vi.useFakeTimers();
    installStoredState(null);
    const task = readBrowserTaskState(workspacePath).tasks[0]!;
    const oldState: StoredTaskState = {
      tasks: [task],
      activeTaskId: task.id,
      showArchived: false,
    };
    const imported = { ...task, id: "imported-task", title: "Imported task" };
    const importedState: StoredTaskState = {
      tasks: [task, imported],
      activeTaskId: imported.id,
      showArchived: false,
    };
    const persist = vi.fn(async () => undefined);
    const debouncer = new WorkspaceTaskSaveDebouncer(persist);

    debouncer.schedule({ path: workspacePath, state: oldState });
    debouncer.adoptPersisted({ path: workspacePath, state: importedState });
    vi.advanceTimersByTime(250);
    debouncer.schedule({ path: workspacePath, state: importedState });
    vi.advanceTimersByTime(250);

    expect(persist).not.toHaveBeenCalled();
    await expect(debouncer.waitForWorkspacePersistence(workspacePath)).resolves.toBeNull();
  });

  it.each(["edit", "new task"] as const)(
    "flushes a pending %s once to the outgoing workspace",
    async (change) => {
      vi.useFakeTimers();
      installStoredState(null);
      const firstPath = workspacePath;
      const secondPath = "D:/projects/incoming";
      const original = readBrowserTaskState(firstPath).tasks[0]!;
      const initialState = {
        tasks: [original],
        activeTaskId: original.id,
        showArchived: false,
      };
      const changedTasks = change === "edit"
        ? [{ ...original, title: "Edited before switching", updatedAt: 300 }]
        : [
            { ...original, id: "task-2", title: "Created before switching", updatedAt: 300 },
            original,
          ];
      const outgoingState = {
        tasks: changedTasks,
        activeTaskId: changedTasks[0]!.id,
        showArchived: false,
      };
      const bridgeSave = deferred<void>();
      const persist = vi.fn((_path: string, _state: StoredTaskState) => bridgeSave.promise);
      const debouncer = new WorkspaceTaskSaveDebouncer(persist);

      debouncer.schedule({ path: firstPath, state: initialState });
      debouncer.schedule({ path: firstPath, state: outgoingState });
      const completion = debouncer.flushBeforeWorkspaceTransition(
        firstPath,
        secondPath,
        { path: firstPath, state: outgoingState },
      );
      vi.advanceTimersByTime(250);

      expect(persist).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledWith(firstPath, outgoingState);
      expect(persist).not.toHaveBeenCalledWith(secondPath, expect.anything());

      bridgeSave.resolve();
      await completion;
    },
  );

  it("retries an identical snapshot after its debounced save rejects", async () => {
    vi.useFakeTimers();
    installStoredState(null);
    const task = readBrowserTaskState(workspacePath).tasks[0]!;
    const state = {
      tasks: [{ ...task, title: "Retry this edit", updatedAt: 300 }],
      activeTaskId: task.id,
      showArchived: false,
    };
    const firstSave = deferred<void>();
    const retrySave = deferred<void>();
    const persist = vi.fn()
      .mockImplementationOnce((_path: string, _state: typeof state) => firstSave.promise)
      .mockImplementationOnce((_path: string, _state: typeof state) => retrySave.promise);
    const debouncer = new WorkspaceTaskSaveDebouncer(persist);
    const snapshot = { path: workspacePath, state };

    debouncer.schedule(snapshot);
    vi.advanceTimersByTime(250);
    expect(persist).toHaveBeenCalledTimes(1);

    firstSave.reject(new Error("transient save failure"));
    await expect(firstSave.promise).rejects.toThrow("transient save failure");
    debouncer.schedule(snapshot);
    vi.advanceTimersByTime(250);

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith(workspacePath, state);

    retrySave.resolve();
    await retrySave.promise;
    debouncer.schedule(snapshot);
    vi.advanceTimersByTime(250);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("retries a failed immediate snapshot on wait without displacing another workspace debounce", async () => {
    vi.useFakeTimers();
    installStoredState(null);
    const secondPath = "D:/projects/incoming";
    const task = readBrowserTaskState(workspacePath).tasks[0]!;
    const recoveredState: StoredTaskState = {
      tasks: [{ ...task, draftText: "Recovered A draft", updatedAt: 300 }],
      activeTaskId: task.id,
      showArchived: false,
    };
    const pendingState: StoredTaskState = {
      tasks: [{ ...task, title: "Pending B edit", updatedAt: 400 }],
      activeTaskId: task.id,
      showArchived: false,
    };
    const firstSave = deferred<void>();
    const retrySave = deferred<void>();
    const pendingSave = deferred<void>();
    const persist = vi.fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => retrySave.promise)
      .mockImplementationOnce(() => pendingSave.promise);
    const debouncer = new WorkspaceTaskSaveDebouncer(persist);

    debouncer.schedule({ path: secondPath, state: pendingState });
    const immediateSave = debouncer.persistImmediately({
      path: workspacePath,
      state: recoveredState,
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(workspacePath, recoveredState);

    firstSave.reject(new Error("transient recovery save failure"));
    await expect(immediateSave).rejects.toThrow("transient recovery save failure");

    const returningToOrigin = debouncer.waitForWorkspacePersistence(workspacePath);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith(workspacePath, recoveredState);

    retrySave.resolve();
    await expect(returningToOrigin).resolves.toEqual({
      snapshot: { path: workspacePath, state: recoveredState },
      error: null,
    });

    vi.advanceTimersByTime(250);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(persist).toHaveBeenLastCalledWith(secondPath, pendingState);
    pendingSave.resolve();
    await pendingSave.promise;
  });

  it("retries an identical in-flight failure when flushing a workspace transition", async () => {
    vi.useFakeTimers();
    installStoredState(null);
    const secondPath = "D:/projects/incoming";
    const task = readBrowserTaskState(workspacePath).tasks[0]!;
    const state = {
      tasks: [{ ...task, title: "Keep this outgoing edit", updatedAt: 300 }],
      activeTaskId: task.id,
      showArchived: false,
    };
    const firstSave = deferred<void>();
    const retrySave = deferred<void>();
    const persist = vi.fn()
      .mockImplementationOnce((_path: string, _state: typeof state) => firstSave.promise)
      .mockImplementationOnce((_path: string, _state: typeof state) => retrySave.promise);
    const debouncer = new WorkspaceTaskSaveDebouncer(persist);
    const snapshot = { path: workspacePath, state };

    debouncer.schedule(snapshot);
    vi.advanceTimersByTime(250);
    const transitionSave = debouncer.flushBeforeWorkspaceTransition(
      workspacePath,
      secondPath,
      snapshot,
    );
    expect(persist).toHaveBeenCalledTimes(1);

    firstSave.reject(new Error("transient save failure"));
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith(workspacePath, state);
    expect(persist).not.toHaveBeenCalledWith(secondPath, expect.anything());

    retrySave.resolve();
    await transitionSave;
  });

  it("waits for the matching outgoing save before reloading A without blocking B", async () => {
    vi.useFakeTimers();
    installStoredState(null);
    const secondPath = "D:/projects/incoming";
    const task = readBrowserTaskState(workspacePath).tasks[0]!;
    const oldState: StoredTaskState = {
      tasks: [task],
      activeTaskId: task.id,
      showArchived: false,
    };
    const latestState: StoredTaskState = {
      tasks: [{ ...task, title: "Newest A edit", updatedAt: 300 }],
      activeTaskId: task.id,
      showArchived: false,
    };
    const saveA = deferred<void>();
    const persist = vi.fn((_path: string, _state: StoredTaskState) => saveA.promise);
    const debouncer = new WorkspaceTaskSaveDebouncer(persist);
    const snapshot = { path: workspacePath, state: latestState };

    debouncer.schedule(snapshot);
    const outgoingSave = debouncer.flushBeforeWorkspaceTransition(
      workspacePath,
      secondPath,
      snapshot,
    );
    const loadB = vi.fn(async () => undefined);
    await debouncer.waitForWorkspacePersistence(secondPath).then(loadB);
    expect(loadB).toHaveBeenCalledOnce();

    const loadA = vi.fn(async () => oldState);
    const returningToA = debouncer.waitForWorkspacePersistence(workspacePath).then(
      async (barrier) => {
        const loaded = await loadA();
        return barrier?.snapshot.state ?? loaded;
      },
    );
    await Promise.resolve();
    expect(loadA).not.toHaveBeenCalled();

    saveA.resolve();
    await outgoingSave;
    const visibleState = await returningToA;

    expect(loadA).toHaveBeenCalledOnce();
    expect(visibleState).toBe(latestState);
    expect(visibleState.tasks[0]?.title).toBe("Newest A edit");
    debouncer.schedule({ path: workspacePath, state: visibleState });
    vi.advanceTimersByTime(250);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("preserves and retries the latest A snapshot after repeated save failure", async () => {
    vi.useFakeTimers();
    installStoredState(null);
    const secondPath = "D:/projects/incoming";
    const task = readBrowserTaskState(workspacePath).tasks[0]!;
    const oldState: StoredTaskState = {
      tasks: [task],
      activeTaskId: task.id,
      showArchived: false,
    };
    const latestState: StoredTaskState = {
      tasks: [{ ...task, title: "Unsaved A edit", updatedAt: 300 }],
      activeTaskId: task.id,
      showArchived: false,
    };
    const firstSave = deferred<void>();
    const retrySave = deferred<void>();
    const nextDebounce = deferred<void>();
    const persist = vi.fn()
      .mockImplementationOnce((_path: string, _state: StoredTaskState) => firstSave.promise)
      .mockImplementationOnce((_path: string, _state: StoredTaskState) => retrySave.promise)
      .mockImplementationOnce((_path: string, _state: StoredTaskState) => nextDebounce.promise);
    const debouncer = new WorkspaceTaskSaveDebouncer(persist);
    const snapshot = { path: workspacePath, state: latestState };
    debouncer.schedule(snapshot);
    vi.advanceTimersByTime(250);
    const outgoingSave = debouncer.flushBeforeWorkspaceTransition(
      workspacePath,
      secondPath,
      snapshot,
    );
    const outgoingSettled = outgoingSave?.catch(() => undefined);
    const loadA = vi.fn(async () => oldState);
    const returningToA = debouncer.waitForWorkspacePersistence(workspacePath).then(
      async (barrier) => {
        const loaded = await loadA();
        return {
          barrier,
          visibleState: barrier?.snapshot.state ?? loaded,
        };
      },
    );

    firstSave.reject(new Error("first save failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(2);
    retrySave.reject(new Error("retry save failed"));
    const result = await returningToA;
    await outgoingSettled;

    expect(result.barrier?.error).toEqual(new Error("retry save failed"));
    expect(loadA).toHaveBeenCalledOnce();

    debouncer.schedule({ path: workspacePath, state: result.visibleState });
    vi.advanceTimersByTime(250);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(persist).toHaveBeenLastCalledWith(workspacePath, latestState);
    nextDebounce.resolve();
    await nextDebounce.promise;
  });

  it("does not apply a stale save failure to the incoming workspace error", async () => {
    const firstPath = workspacePath;
    const secondPath = "D:/projects/incoming";
    let confirmation = beginNativeTaskConfirmation(
      { workspacePath: "", generation: 0, taskIds: new Set() },
      firstPath,
    );
    const firstSaveScope = scopeOf(confirmation);
    const bridgeSave = deferred<void>();
    let incomingError = "incoming workspace load failed";
    const staleCompletion = bridgeSave.promise.catch((reason) => {
      applyCurrentWorkspaceSaveCompletion(
        confirmation,
        firstSaveScope,
        () => {
          incomingError = reason instanceof Error ? reason.message : String(reason);
        },
      );
    });

    confirmation = beginNativeTaskConfirmation(confirmation, secondPath);
    bridgeSave.reject(new Error("outgoing save failed"));
    await staleCompletion;

    expect(incomingError).toBe("incoming workspace load failed");
    expect(confirmedExecutionTaskId(confirmation, secondPath, "task-1")).toBeNull();
  });
});

describe("follow-up task persistence barrier", () => {
  it("waits for the current workspace snapshot before submitting", async () => {
    const save = deferred<void>();
    const snapshot = {
      path: workspacePath,
      state: { tasks: [], activeTaskId: null, showArchived: false },
    };
    const persist = vi.fn(() => save.promise);
    const submit = vi.fn(async () => true);

    const result = submitTaskFollowUpAfterPersistence(snapshot, persist, submit);

    expect(persist).toHaveBeenCalledWith(snapshot);
    expect(submit).not.toHaveBeenCalled();
    save.resolve();
    await expect(result).resolves.toBe(true);
    expect(submit).toHaveBeenCalledOnce();
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(
      submit.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps submission blocked when task persistence fails", async () => {
    const snapshot = {
      path: workspacePath,
      state: { tasks: [], activeTaskId: null, showArchived: false },
    };
    const persist = vi.fn(async () => {
      throw new Error("task save failed");
    });
    const submit = vi.fn(async () => true);

    await expect(
      submitTaskFollowUpAfterPersistence(snapshot, persist, submit),
    ).resolves.toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("queued follow-up auto-send readiness", () => {
  const followUps = [{
    id: "queued-1",
    prompt: "Continue after hydration",
    attachments: [],
    createdAt: 1,
  }];
  const readyState = {
    followUps,
    runtimeReady: true,
    taskStateReady: true,
    timelineReady: true,
    environmentBusy: false,
    taskStateError: null,
    workspaceError: null,
    sendingFollowUpId: null,
    failedFollowUpId: null,
    nativeTaskConfirmed: true,
  };

  it.each([
    ["timeline hydration", { timelineReady: false }],
    ["environment setup", { environmentBusy: true }],
    ["task-state loading", { taskStateReady: false }],
    ["native task confirmation", { nativeTaskConfirmed: false }],
  ])("retries the same queued item after %s completes", (_name, blocked) => {
    expect(queuedFollowUpIdForAutoSend({ ...readyState, ...blocked })).toBeNull();
    expect(queuedFollowUpIdForAutoSend(readyState)).toBe("queued-1");
  });

  it("waits for explicit retry after a send failure", () => {
    expect(queuedFollowUpIdForAutoSend({
      ...readyState,
      failedFollowUpId: "queued-1",
    })).toBeNull();
  });
});

describe("Attention task workspace gating and retry", () => {
  it("hides stale task state and never reports ready-empty for incomplete data", () => {
    const oldWorkspacePath = "C:/projects/old";

    expect(attentionTaskStateMatchesWorkspace(true, oldWorkspacePath, workspacePath)).toBe(false);
    expect(attentionHydrationStatusForTaskState(
      true,
      oldWorkspacePath,
      workspacePath,
      false,
      null,
      null,
      "ready",
    )).toBe("loading");
    expect(attentionHydrationStatusForTaskState(
      false,
      workspacePath,
      workspacePath,
      false,
      null,
      null,
      "ready",
    )).toBe("loading");
  });

  it("accepts canonical paths and preserves runtime hydration status", () => {
    const canonicalPath = "C:\\PROJECTS\\contract-validation\\";

    expect(attentionTaskStateMatchesWorkspace(true, canonicalPath, workspacePath)).toBe(true);
    expect(attentionHydrationStatusForTaskState(
      true,
      canonicalPath,
      workspacePath,
      false,
      null,
      null,
      "ready",
    )).toBe("ready");
  });

  it("stays loading while a workspace refresh is unsettled", () => {
    expect(attentionHydrationStatusForTaskState(
      true,
      workspacePath,
      workspacePath,
      true,
      null,
      null,
      "ready",
    )).toBe("loading");
  });

  it("maps current task and workspace load errors to partial", () => {
    expect(attentionHydrationStatusForTaskState(
      false,
      workspacePath,
      workspacePath,
      false,
      "task load failed",
      null,
      "ready",
    )).toBe("partial");
    expect(attentionHydrationStatusForTaskState(
      false,
      "C:/projects/old",
      workspacePath,
      false,
      null,
      "workspace load failed",
      "ready",
    )).toBe("partial");
  });

  it("prioritizes workspace and matching task errors over loading", () => {
    expect(attentionHydrationStatusForTaskState(
      false,
      "C:/projects/old",
      workspacePath,
      true,
      null,
      "workspace load failed",
      "ready",
    )).toBe("partial");
    expect(attentionHydrationStatusForTaskState(
      false,
      workspacePath,
      workspacePath,
      true,
      "task load failed",
      null,
      "ready",
    )).toBe("partial");
  });

  it("targets only contributing workspace and task-load failures on retry", () => {
    expect(attentionRetryTargets(
      workspacePath,
      workspacePath,
      "task load failed",
      "workspace load failed",
    )).toEqual({ agent: true, workspace: true, taskState: true });
    expect(attentionRetryTargets(
      "C:/projects/old",
      workspacePath,
      "stale task load failed",
      null,
    )).toEqual({ agent: true, workspace: false, taskState: false });
    expect(attentionRetryTargets(workspacePath, workspacePath, null, null)).toEqual({
      agent: true,
      workspace: false,
      taskState: false,
    });
  });
});

describe("visible task unread transitions", () => {
  const tasks = () => {
    installStoredState(null);
    const first = readBrowserTaskState(workspacePath).tasks[0]!;
    return [first, { ...first, id: "task-2", title: "Second task" }];
  };

  it.each(["attention", "profile", "settings"] as const)(
    "marks completion unread while the selected task is on %s",
    (page) => {
      const current = tasks();
      const visible = taskIsVisible(page, "task-1", "task-1");
      const next = markTaskUnreadAfterCompletion(current, "task-1", visible, 300);

      expect(visible).toBe(false);
      expect(next[0]).toMatchObject({ unread: true, updatedAt: 300, meta: "Now" });
    },
  );

  it("does not mark a task unread while that task is visible", () => {
    const current = tasks();
    const visible = taskIsVisible("tasks", "task-1", "task-1");

    expect(markTaskUnreadAfterCompletion(current, "task-1", visible, 300)).toBe(current);
  });

  it("clears unread only when the matching task becomes visible", () => {
    const current = tasks().map((task) => ({ ...task, unread: true }));

    expect(clearVisibleTaskUnread(current, "attention", "task-1")).toBe(current);
    expect(clearVisibleTaskUnread(current, "tasks", "task-1")).toEqual([
      { ...current[0], unread: false },
      current[1],
    ]);
  });

  it("preserves a manual mark until a later visibility transition", () => {
    const initiallyVisible = clearVisibleTaskUnread(tasks(), "tasks", "task-1");
    const manuallyMarked = initiallyVisible.map((task) =>
      task.id === "task-1" ? { ...task, unread: true } : task
    );

    expect(manuallyMarked[0].unread).toBe(true);
    expect(clearVisibleTaskUnread(manuallyMarked, "profile", "task-1")).toBe(manuallyMarked);
    expect(clearVisibleTaskUnread(manuallyMarked, "tasks", "task-1")[0].unread).toBe(false);
  });

  it("returns stable state when no visible unread task needs clearing", () => {
    const current = tasks();

    expect(clearVisibleTaskUnread(current, "tasks", "task-1")).toBe(current);
    expect(markTaskUnreadAfterCompletion(current, "missing", false, 300)).toBe(current);
  });
});

describe("task workspace hydration readiness", () => {
  it("adopts the resolved project root before hydrating task state", () => {
    expect(
      shouldAdoptResolvedWorkspacePath(
        false,
        "C:/projects/xiao/src-tauri",
        "C:/projects/xiao",
      ),
    ).toBe(true);
    expect(
      shouldAdoptResolvedWorkspacePath(
        false,
        "C:\\PROJECTS\\xiao\\",
        "C:/projects/xiao",
      ),
    ).toBe(false);
    expect(
      shouldAdoptResolvedWorkspacePath(
        true,
        "C:/projects/xiao/src-tauri",
        "C:/projects/xiao",
      ),
    ).toBe(false);
  });

  it("keeps task actions disabled until the visible workspace is fully hydrated", () => {
    expect(isTaskWorkspaceStateLoading(true, true, workspacePath, workspacePath, false)).toBe(true);
    expect(isTaskWorkspaceStateLoading(false, false, workspacePath, workspacePath, false)).toBe(true);
    expect(
      isTaskWorkspaceStateLoading(false, true, "D:/projects/other", workspacePath, false),
    ).toBe(true);
    expect(isTaskWorkspaceStateLoading(false, true, workspacePath, workspacePath, true)).toBe(true);
  });

  it("accepts equivalent Windows workspace paths once history is ready", () => {
    expect(
      isTaskWorkspaceStateLoading(
        false,
        true,
        "C:\\PROJECTS\\contract-validation\\",
        workspacePath,
        false,
      ),
    ).toBe(false);
  });

  it("invalidates ready state as soon as another project is requested", () => {
    expect(shouldInvalidateTaskWorkspaceState("D:/projects/other", workspacePath)).toBe(true);
    expect(
      shouldInvalidateTaskWorkspaceState("C:\\PROJECTS\\contract-validation\\", workspacePath),
    ).toBe(false);
    expect(shouldInvalidateTaskWorkspaceState(undefined, workspacePath)).toBe(false);
  });

  it("reloads a retained workspace after an intervening hydration is cancelled", () => {
    expect(shouldLoadTaskWorkspaceState(false, false, null, workspacePath, workspacePath)).toBe(true);
    expect(shouldLoadTaskWorkspaceState(false, true, null, workspacePath, workspacePath)).toBe(false);
  });

  it("allows a failed workspace to retry after a project round trip clears its error", () => {
    expect(shouldInvalidateTaskWorkspaceState("D:/projects/other", workspacePath)).toBe(true);
    expect(shouldLoadTaskWorkspaceState(false, false, null, workspacePath, workspacePath)).toBe(true);
  });

  it("does not loop a failed load or hydrate before the workspace is available", () => {
    expect(
      shouldLoadTaskWorkspaceState(false, false, "load failed", workspacePath, workspacePath),
    ).toBe(false);
    expect(
      shouldLoadTaskWorkspaceState(false, false, "old load failed", workspacePath, "D:/new"),
    ).toBe(true);
    expect(shouldLoadTaskWorkspaceState(true, false, null, workspacePath, workspacePath)).toBe(false);
    expect(shouldLoadTaskWorkspaceState(false, false, null, "", "")).toBe(false);
  });
});

describe("focus resource completion identity", () => {
  it("ignores a stale preview success after newer browser navigation", async () => {
    const preview = deferred<string>();
    let currentRequestId = 1;
    let visible = { id: 1, view: "preview" };
    const completion = preview.promise.then((url) =>
      applyCurrentFocusResourceCompletion(currentRequestId, 1, () => {
        visible = { id: 1, view: url };
      })
    );

    currentRequestId = 2;
    visible = { id: 2, view: "https://example.com/" };
    preview.resolve("xiao-preview://localhost/old/index.html");

    await expect(completion).resolves.toBe(false);
    expect(visible).toEqual({ id: 2, view: "https://example.com/" });
  });

  it("ignores a stale preview failure after newer file navigation", async () => {
    const preview = deferred<string>();
    let currentRequestId = 1;
    let visible = { id: 1, view: "preview" };
    const completion = preview.promise.catch(() =>
      applyCurrentFocusResourceCompletion(currentRequestId, 1, () => {
        visible = { id: 1, view: "old.html" };
      })
    );

    currentRequestId = 2;
    visible = { id: 2, view: "src/current.ts" };
    preview.reject(new Error("preview failed"));

    await expect(completion).resolves.toBe(false);
    expect(visible).toEqual({ id: 2, view: "src/current.ts" });
  });

  it("keeps a routine schedule open after invalidating a pending preview", () => {
    const previewRequestId = 7;
    const currentRequestId = previewRequestId + 1;
    let view = "schedule";

    expect(
      applyCurrentFocusResourceCompletion(currentRequestId, previewRequestId, () => {
        view = "browser";
      }),
    ).toBe(false);
    expect(view).toBe("schedule");
  });

  it("applies success and fallback for the current request", () => {
    let view = "pending";
    expect(applyCurrentFocusResourceCompletion(3, 3, () => { view = "browser"; })).toBe(true);
    expect(view).toBe("browser");
    expect(applyCurrentFocusResourceCompletion(4, 4, () => { view = "files"; })).toBe(true);
    expect(view).toBe("files");
  });
});

describe("confirmed native task materialization", () => {
  it("allows the workspace runtime to connect before a draft task is confirmed", () => {
    const confirmation = beginNativeTaskConfirmation(
      { workspacePath: "", generation: 0, taskIds: new Set() },
      workspacePath,
    );

    expect(confirmedExecutionTaskId(confirmation, workspacePath, null)).toBeNull();
    expect(
      shouldAutoConnectAgentRuntime(false, true, true, workspacePath, workspacePath),
    ).toBe(true);
  });

  it("blocks runtime auto-connect during updates and stale workspace transitions", () => {
    expect(
      shouldAutoConnectAgentRuntime(true, true, true, workspacePath, workspacePath),
    ).toBe(false);
    expect(
      shouldAutoConnectAgentRuntime(false, true, true, "D:/projects/other", workspacePath),
    ).toBe(false);
  });

  it("keeps a fresh task unconfirmed while its bridge save is pending and after failure", async () => {
    let confirmation = confirmNativeTaskIds(
      beginNativeTaskConfirmation(
        { workspacePath: "", generation: 0, taskIds: new Set() },
        workspacePath,
      ),
      { workspacePath, generation: 1 },
      ["persisted-task"],
    );
    const saveScope = scopeOf(confirmation);
    const bridgeSave = deferred<void>();
    const saveCompletion = bridgeSave.promise.then(() => {
      confirmation = confirmNativeTaskIds(
        confirmation,
        saveScope,
        ["persisted-task", "fresh-task"],
      );
    });

    expect(confirmedExecutionTaskId(confirmation, workspacePath, "fresh-task")).toBeNull();
    expect(confirmedExecutionTaskId(confirmation, workspacePath, "persisted-task")).toBe(
      "persisted-task",
    );

    bridgeSave.reject(new Error("database unavailable"));
    await expect(saveCompletion).rejects.toThrow("database unavailable");

    expect(confirmedExecutionTaskId(confirmation, workspacePath, "fresh-task")).toBeNull();
    expect(confirmedExecutionTaskId(confirmation, workspacePath, "persisted-task")).toBe(
      "persisted-task",
    );
  });

  it.each(["create", "draft", "fork", "continue", "workspace-mode"])(
    "does not infer confirmation from a local %s producer",
    (producer) => {
      const confirmation = beginNativeTaskConfirmation(
        { workspacePath: "", generation: 0, taskIds: new Set() },
        workspacePath,
      );

      expect(
        confirmedExecutionTaskId(confirmation, workspacePath, `${producer}-task`),
      ).toBeNull();
    },
  );

  it("confirms a fresh task only after the matching workspace bridge save resolves", async () => {
    let confirmation = beginNativeTaskConfirmation(
      { workspacePath: "", generation: 0, taskIds: new Set() },
      workspacePath,
    );
    const saveScope = scopeOf(confirmation);
    const bridgeSave = deferred<void>();
    const saveCompletion = bridgeSave.promise.then(() => {
      confirmation = confirmNativeTaskIds(confirmation, saveScope, ["fresh-task"]);
    });

    expect(confirmedExecutionTaskId(confirmation, workspacePath, "fresh-task")).toBeNull();
    bridgeSave.resolve();
    await saveCompletion;
    expect(confirmedExecutionTaskId(confirmation, workspacePath, "fresh-task")).toBe("fresh-task");
  });

  it("seeds persisted task IDs from a successful workspace load", () => {
    const loading = beginNativeTaskConfirmation(
      { workspacePath: "", generation: 0, taskIds: new Set() },
      workspacePath,
    );
    const loaded = confirmNativeTaskIds(loading, scopeOf(loading), ["persisted-task"]);

    expect(confirmedExecutionTaskId(loaded, workspacePath, "persisted-task")).toBe(
      "persisted-task",
    );
  });

  it.each([
    "c:\\PROJECTS\\CONTRACT-VALIDATION\\",
    "C:/projects/contract-validation/",
    "c:/PROJECTS/contract-validation",
  ])("keeps a confirmed task enabled across equivalent Windows path %s", (activePath) => {
    const loading = beginNativeTaskConfirmation(
      { workspacePath: "", generation: 0, taskIds: new Set() },
      workspacePath,
    );
    const loaded = confirmNativeTaskIds(loading, scopeOf(loading), ["persisted-task"]);

    expect(confirmedExecutionTaskId(loaded, activePath, "persisted-task")).toBe(
      "persisted-task",
    );
  });

  it("stays cleared when the replacement workspace load fails", async () => {
    const firstPath = "C:/projects/first";
    const secondPath = "D:/projects/second";
    let confirmation = beginNativeTaskConfirmation(
      { workspacePath: "", generation: 0, taskIds: new Set() },
      firstPath,
    );
    confirmation = confirmNativeTaskIds(confirmation, scopeOf(confirmation), ["shared-task"]);
    confirmation = beginNativeTaskConfirmation(confirmation, secondPath);
    const bridgeLoad = deferred<void>();

    expect(confirmedExecutionTaskId(confirmation, secondPath, "shared-task")).toBeNull();
    bridgeLoad.reject(new Error("load failed"));
    await expect(bridgeLoad.promise).rejects.toThrow("load failed");
    expect(confirmedExecutionTaskId(confirmation, secondPath, "shared-task")).toBeNull();
  });

  it("ignores an out-of-order load from an earlier workspace generation", async () => {
    const firstPath = "C:/projects/first";
    const secondPath = "D:/projects/second";
    let confirmation = beginNativeTaskConfirmation(
      { workspacePath: "", generation: 0, taskIds: new Set() },
      firstPath,
    );
    const firstLoadScope = scopeOf(confirmation);
    const firstBridgeLoad = deferred<void>();
    const firstCompletion = firstBridgeLoad.promise.then(() => {
      confirmation = confirmNativeTaskIds(confirmation, firstLoadScope, ["shared-task"]);
    });

    confirmation = beginNativeTaskConfirmation(confirmation, secondPath);
    const secondLoadScope = scopeOf(confirmation);
    firstBridgeLoad.resolve();
    await firstCompletion;
    expect(confirmedExecutionTaskId(confirmation, secondPath, "shared-task")).toBeNull();

    confirmation = confirmNativeTaskIds(confirmation, secondLoadScope, ["second-task"]);
    expect(confirmedExecutionTaskId(confirmation, secondPath, "second-task")).toBe("second-task");
  });

  it("clears same IDs on workspace switch and ignores stale save completion", async () => {
    const firstPath = "C:/projects/first";
    const secondPath = "D:/projects/second";
    let confirmation = beginNativeTaskConfirmation(
      { workspacePath: "", generation: 0, taskIds: new Set() },
      firstPath,
    );
    confirmation = confirmNativeTaskIds(confirmation, scopeOf(confirmation), ["shared-task"]);
    const firstSaveScope = scopeOf(confirmation);
    const firstBridgeSave = deferred<void>();
    const staleCompletion = firstBridgeSave.promise.then(() => {
      confirmation = confirmNativeTaskIds(confirmation, firstSaveScope, ["shared-task"]);
    });

    confirmation = beginNativeTaskConfirmation(confirmation, secondPath);
    expect(confirmedExecutionTaskId(confirmation, secondPath, "shared-task")).toBeNull();

    firstBridgeSave.resolve();
    await staleCompletion;
    expect(confirmedExecutionTaskId(confirmation, secondPath, "shared-task")).toBeNull();

    confirmation = confirmNativeTaskIds(
      confirmation,
      scopeOf(confirmation),
      ["shared-task"],
    );
    expect(confirmedExecutionTaskId(confirmation, secondPath, "shared-task")).toBe("shared-task");
  });
});

describe("task operation workspace identity", () => {
  const firstPath = "C:/projects/first";
  const secondPath = "D:/projects/second";
  const sharedTaskId = "shared-task";

  const confirmedAt = (path: string, generation = 1): ConfirmedNativeTaskState => ({
    workspacePath: path,
    generation,
    taskIds: new Set([sharedTaskId]),
  });

  const attachment = (path: string): AgentAttachment => ({
    name: path,
    path,
    kind: "file",
  });

  const undoRecoveryHarness = (taskId = "task-a") => {
    const scope = { workspacePath: firstPath, taskId, revision: 0 };
    let currentPath = firstPath;
    let revision = 0;
    let firstState = {
      tasks: [{ id: taskId, draftText: "A draft" }],
      activeTaskId: taskId,
    };
    let visible = { taskId, draft: "A draft" };
    let storedAttachments: AgentAttachment[] = [];
    const persist = vi.fn(async (state: typeof firstState) => {
      firstState = state;
    });
    const applyVisible = vi.fn((
      visibleTaskId: string,
      result: { prompt: string },
      restoreComposer: boolean,
    ) => {
      visible = {
        taskId: visibleTaskId,
        draft: restoreComposer ? result.prompt : visible.draft,
      };
    });
    const storeAttachments = vi.fn((
      _visibleTaskId: string,
      attachments: AgentAttachment[],
    ) => {
      storedAttachments = attachments;
    });
    const callbacks = {
      currentWorkspacePath: () => currentPath,
      currentRevision: () => revision,
      claimRevision: () => ++revision,
      loadOriginState: async () => firstState,
      persistOriginState: persist,
      restoreTask: (
        task: typeof firstState.tasks[number],
        result: { prompt: string },
        restoreComposer: boolean,
      ) => ({
        ...task,
        draftText: restoreComposer ? result.prompt : task.draftText,
      }),
      applyVisible,
      storeAttachments,
    };
    return {
      scope,
      callbacks,
      persist,
      applyVisible,
      storeAttachments,
      current: () => ({ firstState, visible, storedAttachments, revision }),
      switchTo: (path: string, task: { taskId: string; draft: string }) => {
        currentPath = path;
        visible = task;
      },
      edit: (draft: string) => {
        revision += 1;
        visible = { ...visible, draft };
      },
    };
  };

  it("applies returned timeline truncation, plan clearing, and complete metadata", () => {
    installStoredState(null);
    const source = {
      ...readBrowserTaskState(workspacePath).tasks[0]!,
      title: "Existing title",
      draftText: "Old draft",
      timeline: [
        { id: "turn-1", kind: "user" as const, title: "First", createdAt: 1, status: "success" as const },
        { id: "turn-2", kind: "result" as const, title: "Second", createdAt: 2, status: "success" as const },
      ],
      plan: { explanation: null, steps: [{ step: "Work", status: "inProgress" as const }] },
      timelineLoaded: true,
      timelineComplete: false,
      timelineStart: 8,
      timelineEntryCount: 10,
    };
    const returnedTimeline = [source.timeline[0]!];

    const restored = restoreTaskAfterUndo(source, {
      prompt: "Restored prompt",
      attachments: [],
      timeline: returnedTimeline,
      resetTitle: false,
    }, true, 500);

    expect(restored).toMatchObject({
      draftText: "Restored prompt",
      timeline: returnedTimeline,
      plan: null,
      timelineLoaded: true,
      timelineComplete: true,
      timelineStart: 0,
      timelineEntryCount: 1,
      updatedAt: 500,
      meta: "Now",
    });
  });

  it("persists off-screen returned timeline truncation and plan clearing", async () => {
    installStoredState(null);
    const source = {
      ...readBrowserTaskState(workspacePath).tasks[0]!,
      id: "task-a",
      draftText: "A draft",
      timeline: [
        { id: "keep", kind: "user" as const, title: "Keep", createdAt: 1, status: "success" as const },
        { id: "undo", kind: "result" as const, title: "Undo", createdAt: 2, status: "success" as const },
      ],
      plan: { explanation: null, steps: [{ step: "Work", status: "pending" as const }] },
    };
    let revision = 0;
    let originState: StoredTaskState = {
      tasks: [source],
      activeTaskId: source.id,
      showArchived: false,
    };

    await expect(completeUndoRecovery(
      { workspacePath: firstPath, taskId: source.id, revision: 0 },
      { prompt: "Undo prompt", attachments: [], timeline: [source.timeline[0]!] },
      {
        currentWorkspacePath: () => secondPath,
        currentRevision: () => revision,
        claimRevision: () => ++revision,
        loadOriginState: async () => originState,
        persistOriginState: async (state) => { originState = state; },
        restoreTask: restoreTaskAfterUndo,
        applyVisible: vi.fn(),
        storeAttachments: vi.fn(),
      },
    )).resolves.toBe(true);

    expect(originState.tasks[0]).toMatchObject({
      timeline: [source.timeline[0]],
      plan: null,
      timelineComplete: true,
      timelineStart: 0,
      timelineEntryCount: 1,
    });
  });

  it("settles first-turn title and metadata while preserving a newer composer", () => {
    installStoredState(null);
    const source = {
      ...readBrowserTaskState(workspacePath).tasks[0]!,
      title: "Automatic title",
      draftText: "Newer draft",
      plan: { explanation: "old", steps: [] },
      timeline: [{
        id: "turn-1",
        kind: "user" as const,
        title: "First",
        createdAt: 1,
        status: "success" as const,
      }],
      timelineComplete: false,
      timelineStart: 3,
      timelineEntryCount: 4,
    };

    const restored = restoreTaskAfterUndo(source, {
      prompt: "Stale restored prompt",
      attachments: [attachment("stale.txt")],
      timeline: [],
      resetTitle: true,
    }, false, 600);

    expect(restored).toMatchObject({
      title: "New task",
      draftText: "Newer draft",
      timeline: [],
      plan: null,
      timelineLoaded: true,
      timelineComplete: true,
      timelineStart: 0,
      timelineEntryCount: 0,
      updatedAt: 600,
      meta: "Now",
    });
  });

  it("persists deferred undo attachments for off-screen A across reload", async () => {
    const harness = undoRecoveryHarness();
    const storage = attachmentRecoveryStorage();
    const undo = deferred<{ prompt: string; attachments: AgentAttachment[] }>();
    const completion = undo.promise.then((result) =>
      completeUndoRecovery(harness.scope, result, {
        ...harness.callbacks,
        storeAttachments: (taskId, attachments) => {
          harness.callbacks.storeAttachments(taskId, attachments);
          storeComposerAttachmentRecovery(firstPath, taskId, attachments, storage);
        },
      })
    );

    harness.switchTo(secondPath, { taskId: "task-b", draft: "B draft" });
    undo.resolve({
      prompt: "A restored prompt",
      attachments: [attachment("A.txt")],
    });

    await expect(completion).resolves.toBe(true);
    const reloaded = readComposerAttachmentRecoveries(storage);
    expect(harness.current().visible).toEqual({ taskId: "task-b", draft: "B draft" });
    expect(harness.current().firstState.tasks[0]?.draftText).toBe("A restored prompt");
    expect(composerAttachmentRecovery(reloaded, firstPath, "task-a")).toEqual([
      attachment("A.txt"),
    ]);
    expect(composerAttachmentRecovery(reloaded, secondPath, "task-a")).toEqual([]);
    expect(harness.persist).toHaveBeenCalledOnce();
    expect(harness.applyVisible).not.toHaveBeenCalled();
  });

  it("isolates deferred undo recovery when A and B share a task ID", async () => {
    const harness = undoRecoveryHarness(sharedTaskId);
    harness.switchTo(secondPath, { taskId: sharedTaskId, draft: "B draft" });

    await expect(completeUndoRecovery(
      harness.scope,
      { prompt: "A restored prompt", attachments: [attachment("A.txt")] },
      harness.callbacks,
    )).resolves.toBe(true);

    expect(harness.current().visible).toEqual({ taskId: sharedTaskId, draft: "B draft" });
    expect(harness.current().firstState.tasks[0]?.draftText).toBe("A restored prompt");
    expect(harness.applyVisible).not.toHaveBeenCalled();
  });

  it("keeps a newer A composer selection and does not reload stale undo attachments", async () => {
    const harness = undoRecoveryHarness();
    const storage = attachmentRecoveryStorage();
    let composerAttachments = [attachment("old.txt")];
    const undo = deferred<{ prompt: string; attachments: AgentAttachment[] }>();
    const completion = undo.promise.then((result) =>
      completeUndoRecovery(harness.scope, result, {
        ...harness.callbacks,
        storeAttachments: (taskId, attachments) => {
          composerAttachments = attachments;
          harness.callbacks.storeAttachments(taskId, attachments);
          storeComposerAttachmentRecovery(firstPath, taskId, attachments, storage);
        },
      })
    );

    storeComposerAttachmentRecovery(firstPath, "task-a", composerAttachments, storage);
    harness.switchTo(secondPath, { taskId: "task-b", draft: "B draft" });
    harness.switchTo(firstPath, { taskId: "task-a", draft: "A draft" });
    harness.edit("Newer A selection");
    composerAttachments = [attachment("newer.txt")];
    storeComposerAttachmentRecovery(firstPath, "task-a", [], storage);
    undo.resolve({ prompt: "Stale undo prompt", attachments: [attachment("stale.txt")] });

    await expect(completion).resolves.toBe(true);
    expect(composerAttachments).toEqual([attachment("newer.txt")]);
    expect(composerAttachmentRecovery(
      readComposerAttachmentRecoveries(storage),
      firstPath,
      "task-a",
    )).toEqual([]);
    expect(harness.current().firstState.tasks[0]?.draftText).toBe("A draft");
    expect(harness.current().storedAttachments).toEqual([]);
    expect(harness.applyVisible).toHaveBeenCalledWith(
      "task-a",
      expect.objectContaining({ prompt: "Stale undo prompt" }),
      false,
    );
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it("applies same-workspace undo recovery exactly once", async () => {
    const harness = undoRecoveryHarness();

    await expect(completeUndoRecovery(
      harness.scope,
      { prompt: "Restored once", attachments: [attachment("once.txt")] },
      harness.callbacks,
    )).resolves.toBe(true);

    expect(harness.applyVisible).toHaveBeenCalledOnce();
    expect(harness.storeAttachments).toHaveBeenCalledOnce();
    expect(harness.current().visible.draft).toBe("Restored once");
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it.each(["create", "update"] as const)(
    "does not apply an A routine %s binding or persist it under same-ID B",
    async (operation) => {
      let confirmation = confirmedAt(firstPath);
      const operationScope = captureTaskOperationScope(
        confirmation,
        firstPath,
        sharedTaskId,
      )!;
      const nativeRoutine = deferred<{ title: string; environmentId: string }>();
      let visible = { title: "B task", environmentId: "B environment" };
      const persist = vi.fn();
      const completion = nativeRoutine.promise.then((routine) =>
        applyCurrentTaskOperationCompletion(
          confirmation,
          operationScope,
          (taskId) => {
            visible = {
              title: `Routine: ${routine.title}`,
              environmentId: routine.environmentId,
            };
            persist(confirmation.workspacePath, taskId, visible);
          },
        )
      );

      confirmation = confirmedAt(secondPath, 2);
      nativeRoutine.resolve({
        title: `${operation} in A`,
        environmentId: "A environment",
      });

      await expect(completion).resolves.toBe(false);
      expect(visible).toEqual({ title: "B task", environmentId: "B environment" });
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it.each([
    { success: true, expectedError: "B failure" },
    { success: false, expectedError: "B failure" },
  ])(
    "does not settle an A follow-up in same-ID B when submit resolves $success",
    async ({ success, expectedError }) => {
      let confirmation = confirmedAt(firstPath);
      const operationScope = captureTaskOperationScope(
        confirmation,
        firstPath,
        sharedTaskId,
      )!;
      const submit = deferred<boolean>();
      let visible = { followUps: ["shared-follow-up"], error: expectedError };
      const persist = vi.fn();
      const completion = submit.promise.then((submitted) =>
        applyCurrentTaskOperationCompletion(
          confirmation,
          operationScope,
          () => {
            visible = submitted
              ? { followUps: [], error: visible.error }
              : { ...visible, error: "A failure" };
            persist(confirmation.workspacePath, visible);
          },
        )
      );

      confirmation = confirmedAt(secondPath, 2);
      submit.resolve(success);

      await expect(completion).resolves.toBe(false);
      expect(visible).toEqual({
        followUps: ["shared-follow-up"],
        error: expectedError,
      });
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it("removes a failed first-save routine task and allows a clean retry", async () => {
    const confirmation = confirmedAt(firstPath);
    const baseTask = { id: "base-task", title: "Existing" };
    let visible = [baseTask];
    const nativeCreate = vi.fn();

    const attempt = async (
      routineTask: { id: string; title: string },
      save: Promise<void>,
    ) => {
      const operationScope = captureTaskOperationScope(
        confirmation,
        firstPath,
        routineTask.id,
      )!;
      visible = [routineTask, ...visible];
      try {
        await save;
        nativeCreate(routineTask.id);
      } catch (reason) {
        applyCurrentTaskOperationCompletion(confirmation, operationScope, () => {
          visible = removeTaskOperationRevision(visible, operationScope, routineTask);
        });
        throw reason;
      }
    };

    const firstSave = deferred<void>();
    const firstTask = { id: "routine-1", title: "Routine: First" };
    const firstAttempt = attempt(firstTask, firstSave.promise);
    firstSave.reject(new Error("save failed"));

    await expect(firstAttempt).rejects.toThrow("save failed");
    expect(visible).toEqual([baseTask]);
    expect(nativeCreate).not.toHaveBeenCalled();

    const secondSave = deferred<void>();
    const secondTask = { id: "routine-2", title: "Routine: Retry" };
    const secondAttempt = attempt(secondTask, secondSave.promise);
    secondSave.resolve();

    await expect(secondAttempt).resolves.toBeUndefined();
    expect(visible).toEqual([secondTask, baseTask]);
    expect(nativeCreate).toHaveBeenCalledOnce();
    expect(nativeCreate).toHaveBeenCalledWith(secondTask.id);
  });

  it("does not roll back a later revision of the originating routine task", () => {
    const confirmation = confirmedAt(firstPath);
    const original = { id: sharedTaskId, title: "Routine: Original" };
    const edited = { ...original, title: "User edited title" };
    const operationScope = captureTaskOperationScope(
      confirmation,
      firstPath,
      sharedTaskId,
    )!;
    const current = [edited];

    expect(removeTaskOperationRevision(current, operationScope, original)).toBe(current);
  });

  it.each(["undo", "routine create", "routine update", "send follow-up"])(
    "applies a same-workspace %s completion exactly once",
    async () => {
      const confirmation = confirmedAt(firstPath);
      const operationScope = captureTaskOperationScope(
        confirmation,
        "c:\\PROJECTS\\FIRST\\",
        sharedTaskId,
      )!;
      const nativeCompletion = deferred<void>();
      const apply = vi.fn();
      const completion = nativeCompletion.promise.then(() =>
        applyCurrentTaskOperationCompletion(confirmation, operationScope, apply)
      );

      nativeCompletion.resolve();

      await expect(completion).resolves.toBe(true);
      expect(apply).toHaveBeenCalledOnce();
      expect(apply).toHaveBeenCalledWith(sharedTaskId);
    },
  );
});

describe("review context workspace identity", () => {
  const attachment = (id: string, comment: string): AgentAttachment => ({
    id,
    name: "src/app/App.tsx",
    path: "src/app/App.tsx",
    kind: "review",
    comment,
  });

  it("isolates a shared task ID by normalized workspace and restores each context", () => {
    const firstPath = "C:\\Projects\\First\\";
    const secondPath = "D:/projects/second";
    const taskId = "shared-task";
    const first = attachment("first-review", "First workspace");
    const second = attachment("second-review", "Second workspace");
    let state = stageTaskReviewContext({}, firstPath, taskId, first);

    expect(taskReviewContext(state, secondPath, taskId)).toEqual([]);

    state = stageTaskReviewContext(state, secondPath, taskId, second);
    expect(taskReviewContext(state, secondPath, taskId)).toEqual([second]);
    expect(taskReviewContext(state, "c:/projects/first", taskId)).toEqual([first]);
  });

  it("keeps stale removal and clearing callbacks scoped to their original workspace", () => {
    const firstPath = "C:/projects/first";
    const secondPath = "D:/projects/second";
    const taskId = "shared-task";
    const first = attachment("first-review", "First workspace");
    const second = attachment("second-review", "Second workspace");
    let state = stageTaskReviewContext({}, firstPath, taskId, first);
    state = stageTaskReviewContext(state, secondPath, taskId, second);

    state = removeTaskReviewContext(state, firstPath, taskId, first.id!);
    expect(taskReviewContext(state, secondPath, taskId)).toEqual([second]);

    state = stageTaskReviewContext(state, firstPath, taskId, first);
    state = clearTaskReviewContext(state, firstPath, taskId, [first]);
    expect(taskReviewContext(state, firstPath, taskId)).toEqual([]);
    expect(taskReviewContext(state, secondPath, taskId)).toEqual([second]);
  });

  it("clears only submitted review objects after a deferred success", () => {
    const path = "C:/projects/shared";
    const taskId = "task-a";
    const submittedThenReplaced = attachment("replaced-review", "Submitted comment");
    const submittedAndUnchanged = attachment("unchanged-review", "Unchanged comment");
    const replacement = attachment("replaced-review", "Newer replacement");
    const addedWhilePending = attachment("new-review", "Added while pending");
    let state = stageTaskReviewContext({}, path, taskId, submittedThenReplaced);
    state = stageTaskReviewContext(state, path, taskId, submittedAndUnchanged);
    const submitted = [...taskReviewContext(state, path, taskId)];

    state = stageTaskReviewContext(state, path, taskId, replacement);
    state = stageTaskReviewContext(state, path, taskId, addedWhilePending);
    state = clearTaskReviewContext(state, path, taskId, submitted);

    const remaining = taskReviewContext(state, path, taskId);
    expect(remaining).toEqual([replacement, addedWhilePending]);
    expect(remaining[0]).toBe(replacement);
  });

  it("retains existing task isolation within one workspace", () => {
    const path = "C:/projects/shared";
    const first = attachment("first-review", "First task");
    const second = attachment("second-review", "Second task");
    let state = stageTaskReviewContext({}, path, "task-a", first);
    state = stageTaskReviewContext(state, path, "task-b", second);

    expect(taskReviewContext(state, path, "task-a")).toEqual([first]);
    expect(taskReviewContext(state, path, "task-b")).toEqual([second]);
  });
});

describe("control-model application-shell restart journey", () => {
  it("resumes two concurrent Task workbenches without cross-Task state leakage", () => {
    const projectPath = "C:/projects/two-task-journey";
    const key = `xiao.tasks.v2:${projectPath}`;
    const task = (
      id: string,
      approvalPolicy: "on-request" | "never",
      terminalId: string,
      previewTarget: string,
    ) => ({
      id,
      title: `Task ${id}`,
      meta: "Now",
      group: "Active",
      archived: false,
      pinned: false,
      unread: false,
      createdAt: 1,
      updatedAt: 2,
      stage: "in_progress",
      stageVersion: 1,
      codexProfileId: `profile-${id}`,
      workbenchState: {
        focusView: "browser",
        timelineScrollTop: id === "a" ? 120 : 420,
        terminalSessionIds: [terminalId],
        activeTerminalSessionId: terminalId,
        terminalSessionNames: { [terminalId]: `${id} shell` },
        previewTarget,
        previewTabs: [{ id: `${id}-preview`, target: previewTarget }],
        activePreviewTabId: `${id}-preview`,
      },
      draftText: `queued follow-up ${id}`,
      followUps: [{ id: `follow-up-${id}`, prompt: `continue ${id}`, attachments: [], createdAt: 3 }],
      model: "gpt-5",
      reasoningEffort: "high",
      threadId: null,
      threadBinding: null,
      mode: "default",
      approvalPolicy,
      sandboxMode: "workspace-write",
      goal: null,
      acceptanceContract: null,
      timeline: [{
        id: `pending-${id}`,
        kind: "approval",
        title: `Pending input ${id}`,
        status: "warning",
      }],
      timelineLoaded: true,
      timelineComplete: true,
      timelineStart: 0,
      timelineEntryCount: 1,
      plan: null,
      executionEnvironmentId: `environment-${id}`,
      workspaceMode: "managed-worktree",
      managedWorktreeId: `worktree-${id}`,
    });
    const stored = JSON.stringify({
      tasks: [
        task("a", "on-request", "terminal-a", "http://127.0.0.1:4101/"),
        task("b", "never", "terminal-b", "http://127.0.0.1:4102/"),
      ],
      activeTaskId: "b",
      showArchived: false,
    });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (requested: string) => requested === key ? stored : null,
        setItem: vi.fn(),
      },
    });

    const restarted = readBrowserTaskState(projectPath);

    expect(restarted.activeTaskId).toBe("b");
    expect(restarted.tasks.map((item) => ({
      id: item.id,
      policy: item.approvalPolicy,
      profile: item.codexProfileId,
      worktree: item.managedWorktreeId,
      terminal: item.workbenchState.activeTerminalSessionId,
      preview: item.workbenchState.previewTarget,
      scroll: item.workbenchState.timelineScrollTop,
      pending: item.timeline[0]?.title,
    }))).toEqual([
      {
        id: "a",
        policy: "on-request",
        profile: "profile-a",
        worktree: "worktree-a",
        terminal: "terminal-a",
        preview: "http://127.0.0.1:4101/",
        scroll: 120,
        pending: "Pending input a",
      },
      {
        id: "b",
        policy: "never",
        profile: "profile-b",
        worktree: "worktree-b",
        terminal: "terminal-b",
        preview: "http://127.0.0.1:4102/",
        scroll: 420,
        pending: "Pending input b",
      },
    ]);
  });
});
