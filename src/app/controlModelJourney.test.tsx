// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  const state = {
    document: {
      schemaVersion: 1,
      workspacePath: "C:/journey",
      activeTaskId: null as string | null,
      showArchived: false,
      tasks: [] as Array<Record<string, any>>,
    },
    runs: [] as Array<Record<string, any>>,
    pendingInputs: [] as Array<Record<string, any>>,
    worktrees: [] as string[],
    resolutions: [] as string[],
    terminals: [] as string[],
    navigations: [] as string[],
    browserUrls: new Map<string, string>(),
  };
  const methods: Record<string, (...arguments_: any[]) => any> = {};
  const bridge = new Proxy({}, {
    get: (_target, property: string) => (...arguments_: any[]) => {
      const implementation = methods[property];
      if (!implementation) throw new Error(`Journey host does not implement ${property}`);
      return implementation(...arguments_);
    },
  });
  return {
    bridge,
    listeners,
    methods,
    state,
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) listener({ payload });
    },
  };
});

vi.mock("../core/bridges/tauri", () => ({
  isTauriHost: () => true,
  nativeBridge: host.bridge,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, listener: (event: { payload: unknown }) => void) => {
    const listeners = host.listeners.get(event) ?? new Set();
    listeners.add(listener);
    host.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  },
}));

const webviews = vi.hoisted(() => new Map<string, any>());
vi.mock("@tauri-apps/api/webview", () => ({
  Webview: class {
    label: string;
    constructor(_window: unknown, label: string) {
      this.label = label;
      webviews.set(label, this);
    }
    static async getByLabel(label: string) {
      return webviews.get(label) ?? null;
    }
    async once(event: string, callback: (event: { payload: unknown }) => void) {
      if (event === "tauri://created") queueMicrotask(() => callback({ payload: null }));
      return () => undefined;
    }
    async setPosition() {}
    async setSize() {}
    async setZoom() {}
    async show() {}
    async hide() {}
    async close() { webviews.delete(this.label); }
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    setTheme: async () => undefined,
    innerSize: async () => ({ width: 1440, height: 900 }),
    scaleFactor: async () => 1,
    listen: async () => () => undefined,
  }),
}));
vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalPosition: class { constructor(public x: number, public y: number) {} },
  LogicalSize: class { constructor(public width: number, public height: number) {} },
  PhysicalPosition: class { constructor(public x: number, public y: number) {} },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    write() {}
    writeln() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() { return { cols: 100, rows: 30 }; }
  },
}));

import { App } from "./App";

const workspacePath = "C:/journey";
const profile = {
  id: "profile-journey",
  displayName: "Journey profile",
  codexHome: null,
  authenticationHome: null,
  environment: {},
  availability: "available",
  authenticatedIdentity: { email: "journey@example.test" },
  models: [],
  capabilities: {},
  usage: null,
  rateLimits: null,
  diagnostic: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
};
const model = {
  model: "gpt-journey",
  displayName: "GPT Journey",
  description: "Deterministic journey model",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
  isDefault: true,
  supportsImages: true,
  supportsFastMode: false,
  serviceTiers: [],
};
const git = {
  branch: "codex/journey",
  repositoryRoot: workspacePath,
  workspaceScoped: true,
  added: 0,
  modified: 1,
  deleted: 0,
  untracked: 0,
  clean: false,
  changes: [{
    path: "src/journey.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: "@@ -1 +1,2 @@\n-old\n+new\n+journey",
    patchTruncated: false,
  }],
  changesTruncated: false,
};

const clone = <T,>(value: T): T => structuredClone(value);

const runSnapshot = (request: Record<string, any>, task: Record<string, any>) => ({
  id: `run-${host.state.runs.length + 1}`,
  workspacePath,
  taskId: request.taskId,
  idempotencyKey: request.idempotencyKey,
  parentRunId: null,
  candidateGroupId: null,
  routineOccurrenceId: null,
  acceptanceContractSourceVersionId: null,
  acceptanceContractSnapshot: null,
  acceptanceContractSnapshotSha256: null,
  verificationBaselineState: "notRequired",
  verificationBaselineArtifactId: null,
  verificationBaselineDiagnostic: null,
  latestVerificationAttemptId: null,
  codexProfileId: task.codexProfileId,
  capabilitySnapshot: { dynamicTools: true, taskPreview: true },
  policySnapshot: {
    approvalPolicy: task.approvalPolicy,
    sandboxMode: task.sandboxMode,
  },
  workspaceSnapshot: {
    projectPath: workspacePath,
    executionRoot: `${workspacePath}/.xiao/${task.id}`,
  },
  status: "queued",
  agentOutcome: "pending",
  verificationOutcome: "not_requested",
  executionEnvironmentId: "windows",
  executionRoot: `${workspacePath}/.xiao/${task.id}`,
  managedWorktreeId: `worktree-${task.id}`,
  prompt: request.prompt,
  model: request.defaultModel,
  reasoningEffort: request.defaultReasoningEffort,
  serviceTier: request.serviceTier,
  mode: task.mode,
  approvalPolicy: task.approvalPolicy,
  sandboxMode: task.sandboxMode,
  threadId: `thread-${task.id}`,
  threadSource: "xiao-workbench",
  cliVersion: "0.200.0",
  runtimeGeneration: 1,
  turnId: `turn-${task.id}`,
  cancelRequested: false,
  queuedAt: Date.now(),
  startedAt: null,
  finishedAt: null,
  version: 0,
});

const installHost = () => {
  host.listeners.clear();
  host.state.document = {
    schemaVersion: 1,
    workspacePath,
    activeTaskId: null,
    showArchived: false,
    tasks: [],
  };
  host.state.runs = [];
  host.state.pendingInputs = [];
  host.state.worktrees = [];
  host.state.resolutions = [];
  host.state.terminals = [];
  host.state.navigations = [];
  host.state.browserUrls.clear();
  webviews.clear();

  const execution = (taskId?: string | null) => ({
    projectPath: workspacePath,
    executionRoot: taskId ? `${workspacePath}/.xiao/${taskId}` : workspacePath,
    environment: { id: "windows", kind: "windows", label: "Windows", availability: "available" },
    workspaceMode: taskId ? "managed-worktree" : "local",
    managedWorktree: taskId ? {
      id: `worktree-${taskId}`,
      taskId,
      branch: `xiao/${taskId}`,
      checkoutPath: `${workspacePath}/.xiao/${taskId}`,
      executionRoot: `${workspacePath}/.xiao/${taskId}`,
      status: "active",
      baseCommit: "abc123",
      failureReason: null,
      diskBytes: 1024,
      sizeComplete: true,
      hasChanges: true,
      createdAt: 1,
    } : null,
    isolationAvailable: true,
    isolationUnavailableReason: null,
  });

  Object.assign(host.methods, {
    getWorkspace: async (_path?: string, taskId?: string | null) => ({
      name: "journey",
      path: workspacePath,
      execution: execution(taskId),
      files: [{
        name: "src",
        path: "src",
        kind: "directory",
        children: [{ name: "journey.ts", path: "src/journey.ts", kind: "file", children: [] }],
      }],
      git,
    }),
    listWorkspaceFiles: async () => [],
    readWorkspaceFile: async (_path: string, taskId: string, relativePath: string) =>
      `export const journeyTask = "${taskId}";\n// ${relativePath}`,
    getSystemInfo: async () => ({ platform: "windows", shell: "powershell", codexVersion: "0.200.0" }),
    listXiaoProjects: async () => [{
      path: workspacePath,
      name: "journey",
      updatedAt: 1,
      pinned: false,
      hidden: false,
      projectGroupId: null,
      projectGroupPosition: 0,
    }],
    listXiaoProjectGroups: async () => [],
    listXiaoCodexProfiles: async () => [profile],
    loadXiaoWorkspace: async () => clone(host.state.document),
    loadXiaoTimelinePage: async (_path: string, taskId: string) => {
      const task = host.state.document.tasks.find((item) => item.id === taskId);
      return {
        entries: clone(task?.timeline ?? []),
        start: 0,
        total: task?.timeline?.length ?? 0,
        hasMore: false,
      };
    },
    saveXiaoWorkspace: async (update: Record<string, any>) => {
      const byId = new Map(host.state.document.tasks.map((task) => [task.id, task]));
      for (const task of update.tasks) byId.set(task.id, clone(task));
      host.state.document = {
        schemaVersion: 1,
        workspacePath,
        activeTaskId: update.activeTaskId,
        showArchived: false,
        tasks: update.taskIds.map((id: string) => byId.get(id)).filter(Boolean),
      };
    },
    bindXiaoTaskCodexProfile: async (
      _path: string,
      taskId: string,
      codexProfileId: string,
      expectedStageVersion: number,
    ) => ({ taskId, codexProfileId, stageVersion: expectedStageVersion }),
    prepareXiaoManagedWorktree: async (_path: string, taskId: string) => {
      host.state.worktrees.push(taskId);
      return execution(taskId);
    },
    getXiaoExecutionContext: async (_path: string, taskId: string | null) => execution(taskId),
    listXiaoManagedWorktrees: async () => [],
    startAgent: async (_path: string, taskId: string | null) => ({
      version: "0.200.0",
      alreadyRunning: true,
      environmentId: "windows",
      generation: 1,
      profileId: taskId ? "profile-journey" : null,
    }),
    stopAgent: async () => undefined,
    readAgentAccount: async () => ({ type: "chatgpt", email: "journey@example.test", planType: "plus" }),
    readAgentUsage: async () => ({ planType: "plus", credits: null }),
    readAgentRateLimits: async () => ({ rateLimits: null, rateLimitsByLimitId: {} }),
    listAgentModels: async () => [model],
    agentRequest: async (method: string) => {
      if (method === "config/read") return { config: {} };
      if (method === "skills/list") return { data: [] };
      if (method === "plugin/list") return { marketplaces: [] };
      return { data: [] };
    },
    listXiaoRuns: async (_path: string, taskId?: string | null) =>
      clone(host.state.runs.filter((run) => !taskId || run.taskId === taskId)),
    listXiaoPendingInputs: async (_path: string, taskId?: string | null) => {
      const runIds = new Set(host.state.runs.filter((run) => !taskId || run.taskId === taskId).map((run) => run.id));
      return clone(host.state.pendingInputs.filter((pending) => runIds.has(pending.runId)));
    },
    loadXiaoRunEvents: async () => ({ events: [], nextSequence: null }),
    enqueueXiaoRun: async (request: Record<string, any>) => {
      const task = host.state.document.tasks.find((item) => item.id === request.taskId);
      if (!task) throw new Error("Task must be persisted before its Run");
      const run = runSnapshot(request, task);
      host.state.runs.push(run);
      setTimeout(() => {
        const waiting = {
          ...run,
          status: "waiting_for_input",
          startedAt: Date.now(),
          version: 1,
        };
        host.state.runs = host.state.runs.map((item) => item.id === run.id ? waiting : item);
        const pending = {
          id: `pending-${run.id}`,
          runId: run.id,
          runtimeGeneration: 1,
          requestId: JSON.stringify(`approval-${run.id}`),
          threadId: run.threadId,
          turnId: run.turnId,
          itemId: `command-${run.id}`,
          kind: "command_approval",
          safeSummary: { command: "npm test", cwd: run.executionRoot },
          openedAt: Date.now(),
          resolvedAt: null,
          invalidatedAt: null,
        };
        host.state.pendingInputs.push(pending);
        host.emit("xiao://run-update", { snapshot: waiting, event: null, pendingInput: pending });
        host.emit("xiao://run-protocol", {
          runId: run.id,
          taskId: run.taskId,
          executionEnvironmentId: run.executionEnvironmentId,
          runtimeGeneration: 1,
          threadId: run.threadId,
          turnId: run.turnId,
          itemId: pending.itemId,
          message: {
            id: `approval-${run.id}`,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: run.threadId,
              turnId: run.turnId,
              itemId: pending.itemId,
              command: "npm test",
              cwd: run.executionRoot,
            },
          },
          pendingInput: pending,
          turnDiff: null,
        });
      }, 20);
      return clone(run);
    },
    resolveXiaoRunInput: async (pendingInputId: string) => {
      host.state.resolutions.push(pendingInputId);
      const pending = host.state.pendingInputs.find((item) => item.id === pendingInputId)!;
      pending.resolvedAt = Date.now();
      const run = host.state.runs.find((item) => item.id === pending.runId)!;
      const previewPort = 4101 + host.state.runs.findIndex((item) => item.id === run.id);
      const completed = {
        ...run,
        status: "completed",
        agentOutcome: "completed",
        finishedAt: Date.now(),
        version: run.version + 1,
      };
      host.emit("xiao://run-protocol", {
        runId: run.id,
        taskId: run.taskId,
        executionEnvironmentId: run.executionEnvironmentId,
        runtimeGeneration: 1,
        threadId: run.threadId,
        turnId: run.turnId,
        itemId: `outcome-${run.id}`,
        message: {
          method: "item/completed",
          params: {
            threadId: run.threadId,
            turnId: run.turnId,
            item: {
              id: `outcome-${run.id}`,
              type: "agentMessage",
              text: `Open [Task Preview outcome](http://127.0.0.1:${previewPort}/)`,
            },
          },
        },
        pendingInput: null,
        turnDiff: null,
      });
      host.state.runs = host.state.runs.map((item) => item.id === run.id ? completed : item);
      host.emit("xiao://run-update", { snapshot: completed, event: null, pendingInput: clone(pending) });
      return clone(completed);
    },
    listXiaoRoutines: async () => [],
    listXiaoTurnCheckpoints: async () => [],
    listXiaoVerificationEvidence: async () => ({ attempts: [], nextCursor: null }),
    getGitBranches: async () => [{ name: "codex/journey", current: true, remote: false }],
    compareGitBranch: async () => git,
    getGitWorktrees: async () => [],
    getGitPullRequest: async () => null,
    getGitPullRequestChecks: async () => [],
    startTerminal: async (sessionId: string) => {
      host.state.terminals.push(sessionId);
      return { sessionId, shell: "powershell", replay: "", replaySequence: 0 };
    },
    writeTerminal: async () => undefined,
    resizeTerminal: async () => undefined,
    stopTerminal: async () => undefined,
    navigateBrowser: async (url: string, label: string) => {
      host.state.navigations.push(url);
      host.state.browserUrls.set(label, url);
    },
    getBrowserUrl: async (label: string) => host.state.browserUrls.get(label) ?? "",
    getBrowserConsole: async () => [{ level: "log", text: "journey ready", at: 1 }],
    setBrowserMuted: async () => undefined,
    openWorkspacePreview: async () => {
      return host.state.document.tasks.length === 1
        ? "http://127.0.0.1:4101/"
        : "http://127.0.0.1:4102/";
    },
    automateTaskPreview: async () => undefined,
    captureTaskPreview: async () => "C:/journey/evidence/preview.png",
    reloadBrowser: async () => undefined,
    goBackBrowser: async () => undefined,
    goForwardBrowser: async () => undefined,
    searchXiaoHistoryGlobal: async () => [],
    saveXiaoTaskAcceptanceContract: async () => null,
    saveXiaoCodexProfile: async (update: Record<string, any>) => ({
      ...profile,
      ...clone(update),
      version: (update.expectedVersion ?? profile.version) + 1,
      updatedAt: Date.now(),
    }),
    updateXiaoCodexProfileRuntime: async () => profile,
  });
};

const clickWorkspaceTool = async (name: string) => {
  fireEvent.click(screen.getByLabelText("Open workspace tools"));
  fireEvent.click(await screen.findByRole("menuitem", { name: new RegExp(name) }));
};

const taskButton = (title: string) => screen.getAllByText(title)
  .map((element) => element.closest(".task-list__item"))
  .find((element): element is HTMLElement => element instanceof HTMLElement)!;

describe("control-model application shell journey", () => {
  beforeEach(() => {
    installHost();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    window.localStorage.clear();
    window.localStorage.setItem("xiao.active-project.v1", workspacePath);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllTimers();
  });

  it("creates, runs, reviews, and resumes two isolated Task workbenches without leakage", async () => {
    const firstMount = render(<App />);

    await screen.findByText("Ready");
    const prompt = screen.getByLabelText("Prompt");
    fireEvent.change(prompt, { target: { value: "Journey Task A" } });
    const firstSend = screen.getByRole("button", { name: "Send task" }) as HTMLButtonElement;
    await waitFor(() => expect(firstSend.disabled).toBe(false));
    fireEvent.click(firstSend);

    await screen.findAllByText("Journey Task A");
    await waitFor(() => expect(host.state.worktrees).toHaveLength(1));
    fireEvent.click(await screen.findByText("Allow once"));
    await waitFor(() => expect(host.state.resolutions).toHaveLength(1));
    fireEvent.click(screen.getByLabelText("Review workspace changes"));
    await clickWorkspaceTool("Terminal");
    await waitFor(() => expect(host.state.terminals).toHaveLength(1));
    await clickWorkspaceTool("Task Preview");
    await waitFor(() => expect(host.state.navigations).toContain("http://127.0.0.1:9/"));
    const firstPreviewLink = await screen.findByRole("link", { name: "Task Preview outcome" });
    expect(firstPreviewLink.getAttribute("href")).toContain(":4101/");
    fireEvent.click(firstPreviewLink);
    await waitFor(() => {
      expect((screen.getByLabelText("Task Preview target") as HTMLInputElement).value)
        .toContain(":4101");
    });

    fireEvent.click(screen.getByLabelText("New task tab"));
    fireEvent.click(await screen.findByLabelText("Add context or task settings"));
    fireEvent.click(screen.getByText("Run settings"));
    fireEvent.click(screen.getByLabelText("Approval policy"));
    fireEvent.click(await screen.findByText("Never ask"));
    const secondPrompt = screen.getByLabelText("Prompt");
    fireEvent.change(secondPrompt, { target: { value: "Journey Task B" } });
    const secondSend = screen.getByRole("button", { name: "Send task" }) as HTMLButtonElement;
    await waitFor(() => expect(secondSend.disabled).toBe(false));
    fireEvent.click(secondSend);

    await screen.findAllByText("Journey Task B");
    await waitFor(() => expect(host.state.worktrees).toHaveLength(2));
    await waitFor(() => expect(host.state.resolutions).toHaveLength(2));
    expect(host.state.runs.map((run) => run.approvalPolicy)).toEqual(["on-request", "never"]);
    expect(new Set(host.state.runs.map((run) => run.executionRoot)).size).toBe(2);

    fireEvent.click(screen.getByLabelText("Review workspace changes"));
    expect(await screen.findByText("src/journey.ts")).toBeTruthy();
    await clickWorkspaceTool("Open file");
    fireEvent.click(await screen.findByRole("button", { name: "journey.ts" }));
    await waitFor(() => expect(document.body.textContent).toContain("journeyTask"));
    await clickWorkspaceTool("Terminal");
    await waitFor(() => expect(host.state.terminals).toHaveLength(2));
    await clickWorkspaceTool("Task Preview");
    fireEvent.click(await screen.findByRole("link", { name: "Task Preview outcome" }));
    await waitFor(() => expect(host.state.navigations).toContain("http://127.0.0.1:4102/"));

    fireEvent.click(taskButton("Journey Task A"));
    fireEvent.click(screen.getByLabelText("Review workspace changes"));
    await clickWorkspaceTool("Task Preview");
    await waitFor(() => {
      expect((screen.getByLabelText("Task Preview target") as HTMLInputElement).value)
        .toBe("http://127.0.0.1:4101/");
    });
    fireEvent.click(taskButton("Journey Task B"));
    await waitFor(() => {
      expect((screen.getByLabelText("Task Preview target") as HTMLInputElement).value)
        .toBe("http://127.0.0.1:4102/");
    });
    await waitFor(() => {
      const task = host.state.document.tasks.find((item) => item.title === "Journey Task B");
      expect(task?.workbenchState?.previewTarget).toBe("http://127.0.0.1:4102/");
      expect(task?.workbenchState?.terminalSessionIds).toHaveLength(1);
      expect(task?.workbenchState?.activeFile).toBe("src/journey.ts");
    });

    firstMount.unmount();
    render(<App />);
    await screen.findAllByText("Journey Task A");
    await screen.findAllByText("Journey Task B");
    await waitFor(() => {
      expect((screen.getByLabelText("Task Preview target") as HTMLInputElement).value)
        .toBe("http://127.0.0.1:4102/");
    });
    const resumedTaskB = host.state.document.tasks.find((item) => item.title === "Journey Task B");
    expect(resumedTaskB?.approvalPolicy).toBe("never");
    expect(resumedTaskB?.workbenchState?.activeFile).toBe("src/journey.ts");
    expect(resumedTaskB?.workbenchState?.terminalSessionIds).toHaveLength(1);

    fireEvent.click(taskButton("Journey Task A"));
    fireEvent.click(screen.getByLabelText("Review workspace changes"));
    await clickWorkspaceTool("Task Preview");
    await waitFor(() => {
      expect((screen.getByLabelText("Task Preview target") as HTMLInputElement).value)
        .toBe("http://127.0.0.1:4101/");
    });
    const resumedTaskA = host.state.document.tasks.find((item) => item.title === "Journey Task A");
    expect(resumedTaskA?.approvalPolicy).toBe("on-request");
    expect(resumedTaskA?.workbenchState?.activeFile).not.toBe("src/journey.ts");
    expect(resumedTaskA?.workbenchState?.terminalSessionIds).toHaveLength(1);
    expect(resumedTaskA?.workbenchState?.terminalSessionIds[0])
      .not.toBe(resumedTaskB?.workbenchState?.terminalSessionIds[0]);
  });
});
