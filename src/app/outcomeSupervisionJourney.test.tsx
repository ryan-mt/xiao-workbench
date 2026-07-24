// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  const state = {
    document: null as Record<string, any> | null,
    runs: [] as Array<Record<string, any>>,
    pendingInputs: [] as Array<Record<string, any>>,
    attention: [] as Array<Record<string, any>>,
    resolutions: [] as string[],
    acknowledgements: [] as string[],
    transitions: [] as Array<Record<string, any>>,
    publicationCalls: [] as string[],
    routineCalls: [] as string[],
    restoreCalls: [] as string[],
    handoffCalls: [] as string[],
  };
  const methods: Record<string, (...arguments_: any[]) => any> = {};
  const bridge = new Proxy({}, {
    get: (_target, property: string) => (...arguments_: any[]) => {
      const implementation = methods[property];
      if (!implementation) throw new Error(`Supervision host does not implement ${property}`);
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
    async close() {
      webviews.delete(this.label);
    }
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
  LogicalPosition: class {
    constructor(public x: number, public y: number) {}
  },
  LogicalSize: class {
    constructor(public width: number, public height: number) {}
  },
  PhysicalPosition: class {
    constructor(public x: number, public y: number) {}
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: async () => "C:/handoffs/task-supervision.xiao-handoff",
  open: async () => "C:/handoffs/task-supervision.xiao-handoff",
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    writeln() {}
    focus() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() {
      return { cols: 100, rows: 30 };
    }
  },
}));

import { App } from "./App";

const workspacePath = "C:/supervision-journey";
const taskId = "task-supervision";
const runId = "run-supervision";
const now = 1_780_000_000_000;

const contract = {
  versionId: "contract-version-7",
  contractId: "contract-supervision",
  version: 7,
  schema: 1,
  name: "Outcome quality gates",
  gates: [{
    type: "command",
    executable: "npm",
    argv: ["test"],
    timeoutMs: 120_000,
    expectedExitCodes: [0],
  }],
  hash: "0123456789abcdef",
  createdAt: now - 20_000,
  updatedAt: now - 20_000,
};

const task = () => ({
  id: taskId,
  title: "Supervise current outcome",
  meta: "Now",
  group: "Active",
  archived: false,
  pinned: false,
  unread: false,
  createdAt: now - 30_000,
  updatedAt: now - 10_000,
  stage: "in_progress",
  stageVersion: 2,
  codexProfileId: "profile-supervision",
  workbenchState: {},
  draftText: "",
  followUps: [],
  model: "gpt-supervision",
  reasoningEffort: "medium",
  threadId: "thread-supervision",
  threadBinding: null,
  mode: "agent",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  goal: null,
  acceptanceContract: contract,
  timeline: [],
  timelineLoaded: true,
  timelineComplete: true,
  timelineStart: 0,
  timelineEntryCount: 0,
  plan: null,
  executionEnvironmentId: "windows",
  workspaceMode: "managed-worktree",
  managedWorktreeId: "worktree-supervision",
});

const failedRun = () => ({
  id: runId,
  workspacePath,
  taskId,
  idempotencyKey: "run-request-supervision",
  parentRunId: null,
  candidateGroupId: null,
  routineOccurrenceId: null,
  acceptanceContractSourceVersionId: contract.versionId,
  acceptanceContractSnapshot: {
    schemaVersion: contract.schema,
    name: contract.name,
    gates: contract.gates,
  },
  acceptanceContractSnapshotSha256: contract.hash,
  verificationBaselineState: "ready",
  verificationBaselineArtifactId: "artifact-baseline",
  verificationBaselineDiagnostic: null,
  latestVerificationAttemptId: "verification-attempt-1",
  codexProfileId: "profile-supervision",
  capabilitySnapshot: { dynamicTools: true },
  policySnapshot: {
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
  },
  workspaceSnapshot: {
    projectPath: workspacePath,
    executionRoot: `${workspacePath}/.xiao/${taskId}`,
  },
  status: "needs_attention",
  agentOutcome: "completed",
  verificationOutcome: "failed",
  executionEnvironmentId: "windows",
  executionRoot: `${workspacePath}/.xiao/${taskId}`,
  managedWorktreeId: "worktree-supervision",
  prompt: "Deliver and verify the supervised outcome",
  model: "gpt-supervision",
  reasoningEffort: "medium",
  serviceTier: null,
  mode: "agent",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  threadId: "thread-supervision",
  threadSource: "xiao-workbench",
  cliVersion: "0.200.0",
  runtimeGeneration: 1,
  turnId: "turn-supervision",
  cancelRequested: false,
  queuedAt: now - 15_000,
  startedAt: now - 14_000,
  finishedAt: now - 10_000,
  version: 3,
});

const waitingRun = () => ({
  ...failedRun(),
  latestVerificationAttemptId: null,
  status: "waiting_for_input",
  agentOutcome: "pending",
  verificationOutcome: "pending",
  finishedAt: null,
  version: 2,
});

const otherWaitingRun = () => ({
  ...waitingRun(),
  id: "run-other",
  idempotencyKey: "run-request-other",
  threadId: "thread-other",
  turnId: "turn-other",
  prompt: "Handle the unrelated approval",
  queuedAt: now - 16_000,
  startedAt: now - 15_500,
});

const pendingInput = () => ({
  id: "pending-supervision",
  runId,
  runtimeGeneration: 1,
  requestId: JSON.stringify("approval-supervision"),
  threadId: "thread-supervision",
  turnId: "turn-supervision",
  itemId: "command-supervision",
  kind: "command_approval",
  safeSummary: {
    command: "npm test",
    cwd: `${workspacePath}/.xiao/${taskId}`,
    reason: "Frozen gate approval.",
  },
  openedAt: now - 11_000,
  resolvedAt: null,
  invalidatedAt: null,
});

const otherPendingInput = () => ({
  ...pendingInput(),
  id: "pending-other",
  runId: "run-other",
  requestId: JSON.stringify("approval-other"),
  threadId: "thread-other",
  turnId: "turn-other",
  itemId: "command-other",
  safeSummary: {
    command: "npm run lint",
    cwd: `${workspacePath}/.xiao/${taskId}`,
    reason: "Unrelated lint approval.",
  },
  openedAt: now - 12_000,
});

const routine = () => ({
  id: "routine-supervision",
  workspacePath,
  taskId,
  title: "Daily supervision",
  prompt: "Run the durable supervision task",
  acceptanceContract: contract,
  scheduleKind: "daily",
  timezone: "UTC",
  scheduledFor: null,
  dailyTime: "09:00",
  missedRunPolicy: "run_once",
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  mode: "agent",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  executionEnvironmentId: "windows",
  executionRoot: `${workspacePath}/.xiao/${taskId}`,
  managedWorktreeId: "worktree-supervision",
  workspaceMode: "managed-worktree",
  enabled: true,
  nextRunAt: now + 86_400_000,
  lastRunAt: null,
  lastError: null,
  isolationWarning: null,
  lastStatus: null,
  history: [],
  version: 1,
  createdAt: now - 20_000,
  updatedAt: now - 20_000,
});

const attentionItem = (
  patch: Partial<Record<string, any>> = {},
) => ({
  id: "attention-verification-1",
  projectPath: workspacePath,
  projectName: "supervision-journey",
  taskId,
  taskTitle: "Supervise current outcome",
  taskStage: "in_progress",
  taskStageVersion: 2,
  runId,
  kind: "verification",
  priority: 1,
  title: "Verification failed",
  safeSummary: "The frozen npm test gate failed for the current outcome.",
  sourceOccurrenceKey: "verification:run-supervision:verification-attempt-1",
  surface: "observatory",
  createdAt: now - 10_000,
  resolvedAt: null,
  acknowledgedAt: null,
  ...patch,
});

const pendingAttentionItem = () => attentionItem({
  id: "attention-pending-1",
  kind: "decision",
  priority: 0,
  title: "Command approval needed",
  safeSummary: "Run the frozen npm test gate.",
  sourceOccurrenceKey: "workspace:1:pending:pending-supervision",
  surface: "timeline",
  createdAt: now - 11_000,
});

const clone = <T,>(value: T): T => structuredClone(value);

const verificationAttempt = (passed: boolean) => ({
  attempt: {
    id: passed ? "verification-attempt-2" : "verification-attempt-1",
    runId,
    requestKey: passed ? "rerun-request" : "initial-request",
    attemptNumber: passed ? 2 : 1,
    trigger: passed ? "rerun" : "initial",
    contractSnapshot: failedRun().acceptanceContractSnapshot,
    contractSnapshotSha256: contract.hash,
    expectedGateCount: 1,
    status: passed ? "passed" : "failed",
    diagnostic: passed ? null : "npm test exited with code 1",
    startedAt: now - (passed ? 4_000 : 12_000),
    finishedAt: now - (passed ? 3_000 : 10_000),
    updatedAt: now - (passed ? 3_000 : 10_000),
    version: 1,
  },
  gates: [{
    result: {
      id: passed ? "gate-result-2" : "gate-result-1",
      verificationAttemptId: passed ? "verification-attempt-2" : "verification-attempt-1",
      gateIndex: 0,
      gateType: "command",
      outcome: passed ? "passed" : "failed",
      durationMs: 1_200,
      exitCode: passed ? 0 : 1,
      diagnostic: passed ? null : "One journey assertion failed",
      startedAt: now - (passed ? 4_000 : 12_000),
      finishedAt: now - (passed ? 3_000 : 10_000),
    },
    evidence: [],
  }],
});

const installHost = () => {
  host.listeners.clear();
  host.state.document = {
    schemaVersion: 1,
    workspacePath,
    activeTaskId: taskId,
    showArchived: false,
    tasks: [task()],
  };
  host.state.runs = [waitingRun(), otherWaitingRun()];
  host.state.pendingInputs = [otherPendingInput(), pendingInput()];
  host.state.attention = [pendingAttentionItem()];
  host.state.resolutions = [];
  host.state.acknowledgements = [];
  host.state.transitions = [];
  host.state.publicationCalls = [];
  host.state.routineCalls = [];
  host.state.restoreCalls = [];
  host.state.handoffCalls = [];
  webviews.clear();

  const profile = {
    id: "profile-supervision",
    displayName: "Supervision profile",
    codexHome: null,
    authenticationHome: null,
    environment: {},
    availability: "available",
    authenticatedIdentity: { email: "operator@example.test" },
    models: [],
    capabilities: {},
    usage: null,
    rateLimits: null,
    diagnostic: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const git = {
    branch: "codex/supervision",
    repositoryRoot: workspacePath,
    workspaceScoped: true,
    added: 0,
    modified: 1,
    deleted: 0,
    untracked: 0,
    clean: false,
    changes: [{
      path: "src/outcome.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: "@@ -1 +1,2 @@\n-old\n+verified\n+published",
      patchTruncated: false,
    }],
    changesTruncated: false,
  };
  const execution = (activeTaskId?: string | null) => ({
    projectPath: workspacePath,
    executionRoot: activeTaskId ? `${workspacePath}/.xiao/${activeTaskId}` : workspacePath,
    environment: {
      id: "windows",
      kind: "windows",
      label: "Windows",
      availability: "available",
    },
    workspaceMode: activeTaskId ? "managed-worktree" : "local",
    managedWorktree: activeTaskId ? {
      id: "worktree-supervision",
      taskId: activeTaskId,
      branch: "codex/supervision",
      checkoutPath: `${workspacePath}/.xiao/${activeTaskId}`,
      executionRoot: `${workspacePath}/.xiao/${activeTaskId}`,
      status: "active",
      baseCommit: "abc123",
      failureReason: null,
      diskBytes: 2048,
      sizeComplete: true,
      hasChanges: true,
      createdAt: now,
    } : null,
    isolationAvailable: true,
    isolationUnavailableReason: null,
  });

  Object.assign(host.methods, {
    getWorkspace: async (_path?: string, activeTaskId?: string | null) => ({
      name: "supervision-journey",
      path: workspacePath,
      execution: execution(activeTaskId),
      files: [],
      git,
    }),
    listWorkspaceFiles: async () => [],
    readWorkspaceFile: async () => "",
    getSystemInfo: async () => ({
      platform: "windows",
      shell: "powershell",
      codexVersion: "0.200.0",
    }),
    listXiaoProjects: async () => [{
      path: workspacePath,
      name: "supervision-journey",
      updatedAt: now,
      pinned: true,
      hidden: false,
      projectGroupId: null,
      projectGroupPosition: 0,
    }],
    listXiaoProjectGroups: async () => [],
    listXiaoCodexProfiles: async () => [profile],
    loadXiaoWorkspace: async () => clone(host.state.document),
    loadXiaoTimelinePage: async () => ({
      entries: [],
      start: 0,
      total: 0,
      hasMore: false,
    }),
    saveXiaoWorkspace: async (update: Record<string, any>) => {
      const persisted = host.state.document!;
      const byId = new Map<string, Record<string, any>>(
        persisted.tasks.map((item: Record<string, any>) => [item.id, item]),
      );
      for (const item of update.tasks) {
        const canonical = byId.get(item.id);
        byId.set(item.id, canonical
          ? {
            ...clone(item),
            stage: canonical.stage,
            stageVersion: canonical.stageVersion,
          }
          : clone(item));
      }
      host.state.document = {
        schemaVersion: 1,
        workspacePath,
        activeTaskId: update.activeTaskId,
        showArchived: false,
        tasks: update.taskIds.map((id: string) => byId.get(id)).filter(Boolean),
      };
    },
    getXiaoExecutionContext: async (_path: string, activeTaskId: string | null) =>
      execution(activeTaskId),
    prepareXiaoManagedWorktree: async (_path: string, activeTaskId: string) =>
      execution(activeTaskId),
    listXiaoManagedWorktrees: async () => [],
    startAgent: async () => ({
      version: "0.200.0",
      alreadyRunning: true,
      environmentId: "windows",
      generation: 1,
      profileId: "profile-supervision",
    }),
    stopAgent: async () => undefined,
    readAgentAccount: async () => ({
      type: "chatgpt",
      email: "operator@example.test",
      planType: "plus",
    }),
    readAgentUsage: async () => ({ planType: "plus", credits: null }),
    readAgentRateLimits: async () => ({ rateLimits: null, rateLimitsByLimitId: {} }),
    listAgentModels: async () => [{
      model: "gpt-supervision",
      displayName: "GPT Supervision",
      description: "Journey model",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{
        reasoningEffort: "medium",
        description: "Medium",
      }],
      isDefault: true,
      supportsImages: true,
      supportsFastMode: false,
      serviceTiers: [],
    }],
    agentRequest: async (method: string) => {
      if (method === "config/read") return { config: {} };
      if (method === "skills/list") return { data: [] };
      if (method === "plugin/list") return { marketplaces: [] };
      return { data: [] };
    },
    listXiaoRuns: async (_path: string, activeTaskId?: string | null) =>
      clone(host.state.runs.filter((run) => !activeTaskId || run.taskId === activeTaskId)),
    listXiaoPendingInputs: async (_path: string, activeTaskId?: string | null) => {
      const runIds = new Set(
        host.state.runs
          .filter((run) => !activeTaskId || run.taskId === activeTaskId)
          .map((run) => run.id),
      );
      return clone(host.state.pendingInputs.filter((pending) => runIds.has(pending.runId)));
    },
    resolveXiaoRunInput: async (pendingInputId: string) => {
      const pending = host.state.pendingInputs.find((item) => item.id === pendingInputId);
      if (!pending) throw new Error(`Unknown pending input ${pendingInputId}`);
      host.state.resolutions.push(pendingInputId);
      pending.resolvedAt = now - 9_000;
      const resolvedRun = pending.runId === runId
        ? failedRun()
        : {
            ...otherWaitingRun(),
            status: "cancelled",
            agentOutcome: "cancelled",
            verificationOutcome: "not_requested",
            finishedAt: now - 8_500,
            version: 3,
          };
      host.state.runs = host.state.runs.map((run) =>
        run.id === resolvedRun.id ? resolvedRun : run
      );
      if (pending.runId === runId) host.state.attention = [attentionItem()];
      queueMicrotask(() => {
        host.emit("xiao://run-update", {
          snapshot: clone(resolvedRun),
          event: null,
          pendingInput: clone(pending),
        });
      });
      return clone(resolvedRun);
    },
    loadXiaoRunEvents: async () => ({ events: [], nextSequence: null }),
    listXiaoTurnCheckpoints: async () => [{
      id: "checkpoint-supervision",
      runId,
      turnId: "turn-supervision",
      prompt: "Verify and publish",
      runStatus: "completed",
      patchBytes: 128,
      beforeFingerprint: "before-fingerprint",
      afterFingerprint: "after-fingerprint",
      createdAt: now - 5_000,
      restoredAt: null,
    }],
    restoreXiaoTurns: async (_path: string, _taskId: string, checkpointId: string) => {
      host.state.restoreCalls.push(checkpointId);
      return {
        restoreBatchId: "restore-batch-supervision",
        restoredCheckpointIds: [checkpointId],
        restoredTurnCount: 1,
        targetFingerprint: "before-fingerprint",
        restoredAt: now + 1,
      };
    },
    exportXiaoHandoff: async (
      _path: string,
      _taskId: string,
      destinationPath: string,
    ) => {
      host.state.handoffCalls.push(`export:${destinationPath}`);
      return {
        destinationPath,
        bundleSha256: "a".repeat(64),
        byteLength: 512,
        entryCount: 4,
      };
    },
    importXiaoHandoff: async (_path: string, bundlePath: string) => {
      host.state.handoffCalls.push(`import:${bundlePath}`);
      return {
        taskId,
        runId,
        bundleSha256: "a".repeat(64),
        importedAt: now + 2,
        alreadyImported: true,
      };
    },
    listXiaoRoutines: async () => [routine()],
    runXiaoRoutineNow: async (routineId: string) => {
      host.state.routineCalls.push(routineId);
      return routine();
    },
    listXiaoVerificationEvidence: async () => {
      const passed = host.state.runs[0]?.verificationOutcome === "passed";
      return {
        attempts: [verificationAttempt(passed)],
        hasMore: false,
      };
    },
    readXiaoVerificationArtifact: async () => null,
    discoverXiaoAcceptancePresets: async () => [],
    saveXiaoTaskAcceptanceContract: async () => contract,
    listXiaoAttentionItems: async () => ({
      items: clone(host.state.attention),
      status: "live",
      generatedAt: now,
    }),
    acknowledgeXiaoAttentionItem: async (itemId: string) => {
      host.state.acknowledgements.push(itemId);
      host.state.attention = host.state.attention.filter((item) => item.id !== itemId);
      return true;
    },
    listXiaoTaskPublications: async () => [{
      id: "publication-42",
      projectPath: workspacePath,
      taskId,
      sourceRunId: runId,
      kind: "pull_request",
      status: "active",
      branch: "codex/supervision",
      remote: "origin",
      url: "https://github.example/xiao/pull/42",
      pullRequestNumber: 42,
      checkState: "passing",
      createdAt: now,
      updatedAt: now,
    }],
    rerunXiaoVerification: async () => {
      const passed = {
        ...host.state.runs[0],
        status: "completed",
        verificationOutcome: "passed",
        latestVerificationAttemptId: "verification-attempt-2",
        finishedAt: now - 3_000,
        version: 4,
      };
      host.state.runs = [passed];
      const persistedTask = host.state.document!.tasks[0];
      persistedTask.stage = "ready_for_review";
      persistedTask.stageVersion = 3;
      persistedTask.updatedAt = now - 3_000;
      host.state.attention = [attentionItem({
        id: "attention-review-3",
        runId: null,
        kind: "review",
        priority: 2,
        title: "Outcome ready for review",
        safeSummary: "Supervise current outcome",
        sourceOccurrenceKey: "task-stage:task-supervision:ready_for_review:3",
        taskStage: "ready_for_review",
        taskStageVersion: 3,
        createdAt: now - 3_000,
      })];
      queueMicrotask(() => {
        host.emit("xiao://run-update", {
          snapshot: clone(passed),
          event: null,
          pendingInput: null,
        });
      });
      return clone(passed);
    },
    transitionXiaoTaskStage: async (request: Record<string, any>) => {
      const persistedTask = host.state.document!.tasks[0];
      if (request.expectedVersion !== persistedTask.stageVersion) {
        throw new Error(
          `Task stage changed (expected v${request.expectedVersion}, current v${persistedTask.stageVersion}).`,
        );
      }
      const transition = {
        id: `transition-${host.state.transitions.length + 1}`,
        taskId,
        fromStage: persistedTask.stage,
        toStage: request.toStage,
        expectedVersion: request.expectedVersion,
        resultingVersion: request.expectedVersion + 1,
        actor: request.actor,
        reason: request.reason,
        sourceRunId: request.sourceRunId,
        idempotencyKey: request.idempotencyKey,
        createdAt: now + host.state.transitions.length,
      };
      host.state.transitions.push(clone(transition));
      persistedTask.stage = transition.toStage;
      persistedTask.stageVersion = transition.resultingVersion;
      persistedTask.updatedAt = transition.createdAt;
      host.state.attention = [];
      return transition;
    },
    getGitBranches: async () => [{ name: "codex/supervision", current: true, remote: false }],
    compareGitBranch: async () => git,
    getGitWorktrees: async () => [],
    mutateGit: async (
      _path: string,
      _activeTaskId: string,
      action: string,
    ) => {
      host.state.publicationCalls.push(action);
      return action === "commit" ? "committed outcome" : `${action} completed`;
    },
    publishGitBranch: async () => {
      host.state.publicationCalls.push("push");
      const persistedTask = host.state.document!.tasks[0];
      if (persistedTask.stage !== "ready_for_review") {
        throw new Error("Only the current ready outcome can be published.");
      }
      persistedTask.stage = "published";
      persistedTask.stageVersion = 4;
      persistedTask.updatedAt = now;
      host.state.attention = [attentionItem({
        id: "attention-publication-4",
        runId,
        kind: "publication",
        priority: 2,
        title: "Published outcome awaits acceptance",
        safeSummary: "Supervise current outcome",
        sourceOccurrenceKey:
          "workspace:1:publication:publication-42:active:passing:1780000000000",
        surface: "changes",
        taskStage: "published",
        taskStageVersion: 4,
        createdAt: now,
      })];
      return {
        branch: "codex/supervision",
        remote: "origin",
        upstream: "origin/codex/supervision",
        output: "pushed",
      };
    },
    getGitPullRequest: async () => {
      host.state.publicationCalls.push("find-pr");
      return null;
    },
    createGitDraftPullRequest: async () => {
      host.state.publicationCalls.push("create-pr");
      return {
        number: 42,
        url: "https://github.example/xiao/pull/42",
        title: "Supervise current outcome",
        isDraft: true,
        state: "OPEN",
        baseRefName: "main",
        headRefName: "codex/supervision",
      };
    },
    getGitPullRequestChecks: async () => {
      host.state.publicationCalls.push("checks");
      return [{
        name: "journey",
        state: "SUCCESS",
        bucket: "pass",
        link: "https://github.example/xiao/actions/42",
        workflow: "CI",
      }];
    },
    getGitPullRequestComments: async () => [],
    searchXiaoHistoryGlobal: async () => [],
    saveXiaoCodexProfile: async () => profile,
    updateXiaoCodexProfileRuntime: async () => profile,
  });
};

const openAttention = async () => {
  const trigger = await screen.findByRole("button", { name: /^Attention,/ });
  fireEvent.click(trigger);
  return screen.findByRole("heading", { name: "Attention" });
};

const mcpSummary = (serverName: string, fieldName: string) => ({
  mode: "form",
  serverName,
  message: `${serverName} needs one value.`,
  requestedSchema: {
    type: "object",
    properties: {
      [fieldName]: {
        type: "string",
        title: `${serverName} value`,
      },
    },
    required: [fieldName],
  },
});

describe("outcome and supervision application-shell journey", () => {
  beforeEach(() => {
    installHost();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    window.localStorage.clear();
    window.localStorage.setItem("xiao.active-project.v1", workspacePath);
    vi.stubGlobal("confirm", vi.fn(() => true));
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

  it("moves a frozen-contract outcome from failed verification through publication, acceptance, and explicit reopen", async () => {
    render(<App />);

    await screen.findAllByText("Supervise current outcome");
    expect(await screen.findByText("In progress")).toBeTruthy();
    expect(host.state.runs[0]?.acceptanceContractSourceVersionId).toBe(contract.versionId);
    expect(host.state.runs[0]?.acceptanceContractSnapshotSha256).toBe(contract.hash);
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView);
    scrollIntoView.mockClear();

    const attentionHeading = await openAttention();
    const attentionCenter = attentionHeading.closest(".attention-center") as HTMLElement;
    expect(within(attentionCenter).getByText(/Run the frozen npm test gate\./))
      .toBeTruthy();
    expect(within(attentionCenter).getByText(`Run ${runId}`)).toBeTruthy();
    fireEvent.click(within(attentionCenter).getByRole("button", {
      name: "Open task: Run the frozen npm test gate.",
    }));

    const allowButtons = await screen.findAllByText("Allow once");
    expect(allowButtons).toHaveLength(2);
    const unrelatedApproval = (await screen.findByText("Unrelated lint approval."))
      .closest(".activity") as HTMLElement;
    const targetedApproval = (await screen.findByText("Frozen gate approval."))
      .closest(".activity") as HTMLElement;
    await waitFor(() => {
      expect(targetedApproval.classList.contains("timeline-search-hit")).toBe(true);
      expect(unrelatedApproval.classList.contains("timeline-search-hit")).toBe(false);
    });
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.instances[0]).toBe(targetedApproval);

    fireEvent.click(within(targetedApproval).getByText("Allow once"));
    await waitFor(() => {
      expect(host.state.resolutions).toEqual(["pending-supervision"]);
      expect(host.state.pendingInputs[0]?.resolvedAt).toBeNull();
      expect(host.state.pendingInputs[1]?.resolvedAt).toBe(now - 9_000);
      expect(host.state.runs[0]?.status).toBe("needs_attention");
    });
    fireEvent.click(within(unrelatedApproval).getByText("Decline"));
    await waitFor(() => expect(host.state.resolutions).toEqual([
      "pending-supervision",
      "pending-other",
    ]));
    expect(scrollIntoView).toHaveBeenCalledOnce();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findAllByText("Verification failed")).toHaveLength(2);

    const failedAttentionHeading = await openAttention();
    const failedAttentionCenter = failedAttentionHeading.closest(".attention-center") as HTMLElement;
    expect(within(failedAttentionCenter).getByText(
      /The frozen npm test gate failed for the current outcome\./,
    )).toBeTruthy();
    fireEvent.click(within(failedAttentionCenter).getByRole("button", {
      name: "Open task: The frozen npm test gate failed for the current outcome.",
    }));

    expect(await screen.findByRole("heading", { name: "Runs, agents, and recovery" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Observable run" }).textContent)
      .toContain("run-sup");
    await openAttention();
    fireEvent.click(screen.getByRole("button", {
      name: "Acknowledge: The frozen npm test gate failed for the current outcome.",
    }));
    await waitFor(() => expect(host.state.acknowledgements).toEqual([
      "attention-verification-1",
    ]));
    fireEvent.click(screen.getByRole("button", { name: "Close attention center" }));

    fireEvent.click(await screen.findByRole("button", { name: "Rerun gates" }));
    await screen.findByText("Ready for review");
    expect(host.state.document!.tasks[0]).toMatchObject({
      stage: "ready_for_review",
      stageVersion: 3,
    });

    fireEvent.click(screen.getByLabelText("Review workspace changes"));
    const commitMessage = await screen.findByPlaceholderText("Commit message");
    fireEvent.change(commitMessage, { target: { value: "Publish supervised outcome" } });
    fireEvent.click(screen.getByRole("button", { name: "Ship draft PR" }));
    expect(await screen.findByText("Draft PR #42 shipped. CI status loaded.")).toBeTruthy();
    expect(host.state.publicationCalls).toEqual([
      "commit",
      "push",
      "find-pr",
      "create-pr",
      "checks",
    ]);

    await screen.findByText("Published");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(async () => {
      const trigger = await screen.findByRole("button", { name: "Attention, 1 item" });
      expect(trigger).toBeTruthy();
    });
    await openAttention();
    expect(screen.getByText("Published outcome awaits acceptance")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {
      name: "Open task: Supervise current outcome",
    }));
    expect((await screen.findByRole("region", { name: "Attention publication" })).textContent)
      .toContain("PR #42");

    fireEvent.click(await screen.findByRole("button", { name: "Accept outcome" }));
    await screen.findByText("Completed");
    fireEvent.click(screen.getByRole("button", { name: "Reopen task" }));
    await screen.findByText("In progress");

    expect(host.state.transitions.map((transition) => ({
      fromStage: transition.fromStage,
      toStage: transition.toStage,
      expectedVersion: transition.expectedVersion,
      resultingVersion: transition.resultingVersion,
    }))).toEqual([
      {
        fromStage: "published",
        toStage: "completed",
        expectedVersion: 4,
        resultingVersion: 5,
      },
      {
        fromStage: "completed",
        toStage: "in_progress",
        expectedVersion: 5,
        resultingVersion: 6,
      },
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: /Schedule/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Expand Daily supervision" }));
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(host.state.routineCalls).toEqual(["routine-supervision"]));

    fireEvent.click(screen.getByRole("menuitem", { name: /Observatory/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore 1" }));
    await waitFor(() => expect(host.state.restoreCalls).toEqual(["checkpoint-supervision"]));

    fireEvent.click(screen.getByRole("button", { name: "Handoff" }));
    fireEvent.click(screen.getByRole("button", { name: "Export handoff" }));
    expect(await screen.findByText("Exported 4 entries (512 B).")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose bundle" }));
    expect(await screen.findByText(
      "This bundle was already imported; Xiao opened its existing task.",
    )).toBeTruthy();
    expect(host.state.handoffCalls).toEqual([
      "export:C:/handoffs/task-supervision.xiao-handoff",
      "import:C:/handoffs/task-supervision.xiao-handoff",
    ]);
    expect(confirm).toHaveBeenCalledTimes(4);
  });

  it("opens and focuses the exact non-head interactive pending request", async () => {
    host.state.pendingInputs = [
      {
        ...otherPendingInput(),
        kind: "mcp_elicitation",
        requestId: JSON.stringify("shared-mcp-request"),
        safeSummary: mcpSummary("Unrelated server", "unrelated"),
      },
      {
        ...pendingInput(),
        kind: "mcp_elicitation",
        requestId: JSON.stringify("shared-mcp-request"),
        safeSummary: mcpSummary("Target server", "target"),
      },
    ];
    host.state.attention = [attentionItem({
      id: "attention-target-mcp",
      kind: "decision",
      priority: 0,
      title: "MCP input requested",
      safeSummary: "Target server needs one value.",
      sourceOccurrenceKey: "workspace:1:pending:pending-supervision",
      surface: "timeline",
      createdAt: now - 10_000,
    })];

    render(<App />);
    await screen.findAllByText("Supervise current outcome");
    const attentionHeading = await openAttention();
    const attentionCenter = attentionHeading.closest(".attention-center") as HTMLElement;
    fireEvent.click(within(attentionCenter).getByRole("button", {
      name: "Open task: Target server needs one value.",
    }));

    expect(await screen.findByText("Target server · MCP")).toBeTruthy();
    expect(screen.queryByText("Unrelated server · MCP")).toBeNull();
    const targetInput = screen.getByRole("textbox", { name: /Target server value/ });
    await waitFor(() => expect(document.activeElement).toBe(targetInput));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => {
      expect(host.state.resolutions).toEqual(["pending-supervision"]);
      expect(host.state.pendingInputs[0]?.resolvedAt).toBeNull();
      expect(host.state.pendingInputs[1]?.resolvedAt).toBe(now - 9_000);
    });
    expect(await screen.findByText("Unrelated server · MCP")).toBeTruthy();
  });

  it("releases an exact pending selection after external resolution before projection refresh", async () => {
    host.state.pendingInputs = [
      {
        ...otherPendingInput(),
        kind: "mcp_elicitation",
        requestId: JSON.stringify("shared-mcp-request"),
        safeSummary: mcpSummary("Unrelated server", "unrelated"),
      },
      {
        ...pendingInput(),
        kind: "mcp_elicitation",
        requestId: JSON.stringify("shared-mcp-request"),
        safeSummary: mcpSummary("Target server", "target"),
      },
    ];
    host.state.attention = [attentionItem({
      id: "attention-target-mcp",
      kind: "decision",
      priority: 0,
      title: "MCP input requested",
      safeSummary: "Target server needs one value.",
      sourceOccurrenceKey: "workspace:1:pending:pending-supervision",
      surface: "timeline",
      createdAt: now - 10_000,
    })];

    render(<App />);
    await screen.findAllByText("Supervise current outcome");
    const attentionHeading = await openAttention();
    const attentionCenter = attentionHeading.closest(".attention-center") as HTMLElement;
    fireEvent.click(within(attentionCenter).getByRole("button", {
      name: "Open task: Target server needs one value.",
    }));
    expect(await screen.findByText("Target server · MCP")).toBeTruthy();

    act(() => {
      host.emit("xiao://run-protocol", {
        runId,
        taskId,
        executionEnvironmentId: "windows",
        runtimeGeneration: 1,
        threadId: "thread-supervision",
        turnId: "turn-supervision",
        itemId: "command-supervision",
        sequence: 1,
        message: {
          method: "serverRequest/resolved",
          params: { requestId: "shared-mcp-request" },
        },
        turnDiff: null,
        pendingInput: clone(host.state.pendingInputs[1]),
      });
    });

    expect(await screen.findByText("Unrelated server · MCP")).toBeTruthy();
    expect(host.state.pendingInputs[1]?.resolvedAt).toBeNull();
    expect(host.state.resolutions).toEqual([]);
  });

  it("releases a stale pending target that resolves before its dialog mounts", async () => {
    host.state.pendingInputs = [{
      ...otherPendingInput(),
      kind: "mcp_elicitation",
      requestId: JSON.stringify("shared-mcp-request"),
      safeSummary: mcpSummary("Unrelated server", "unrelated"),
    }];
    host.state.attention = [attentionItem({
      id: "attention-stale-mcp",
      kind: "decision",
      priority: 0,
      title: "MCP input requested",
      safeSummary: "Resolved target server input.",
      sourceOccurrenceKey: "workspace:1:pending:pending-supervision",
      surface: "timeline",
      createdAt: now - 10_000,
    })];

    render(<App />);
    await screen.findAllByText("Supervise current outcome");
    const attentionHeading = await openAttention();
    const attentionCenter = attentionHeading.closest(".attention-center") as HTMLElement;
    fireEvent.click(within(attentionCenter).getByRole("button", {
      name: "Open task: Resolved target server input.",
    }));

    expect(await screen.findByText("Unrelated server · MCP")).toBeTruthy();
    expect(screen.queryByText("Target server · MCP")).toBeNull();
  });

  it("opens and focuses the exact non-head multi-question request", async () => {
    const questionSummary = (
      prefix: string,
      questions: Array<{ id: string; question: string; answer: string }>,
    ) => ({
      questions: questions.map((question) => ({
        id: question.id,
        header: `${prefix} choice`,
        question: question.question,
        isOther: false,
        isSecret: false,
        options: [{
          label: question.answer,
          description: `Use the ${prefix.toLowerCase()} answer.`,
        }],
      })),
      autoResolutionMs: null,
    });
    host.state.pendingInputs = [
      {
        ...otherPendingInput(),
        kind: "question",
        requestId: JSON.stringify("shared-question-request"),
        safeSummary: questionSummary("Unrelated", [{
          id: "unrelated-question",
          question: "Which unrelated option?",
          answer: "Unrelated answer",
        }]),
      },
      {
        ...pendingInput(),
        kind: "question",
        requestId: JSON.stringify("shared-question-request"),
        safeSummary: questionSummary("Target", [
          {
            id: "target-question-one",
            question: "Which target option comes first?",
            answer: "Target answer",
          },
          {
            id: "target-question-two",
            question: "Which target option comes second?",
            answer: "Second target answer",
          },
        ]),
      },
    ];
    host.state.attention = [attentionItem({
      id: "attention-target-question",
      kind: "decision",
      priority: 0,
      title: "Question input requested",
      safeSummary: "Choose the target answer.",
      sourceOccurrenceKey: "workspace:1:pending:pending-supervision",
      surface: "timeline",
      createdAt: now - 10_000,
    })];

    render(<App />);
    await screen.findAllByText("Supervise current outcome");
    const attentionHeading = await openAttention();
    const attentionCenter = attentionHeading.closest(".attention-center") as HTMLElement;
    fireEvent.click(within(attentionCenter).getByRole("button", {
      name: "Open task: Choose the target answer.",
    }));

    expect(await screen.findByText("Which target option comes first?")).toBeTruthy();
    expect(screen.queryByText("Which unrelated option?")).toBeNull();
    const targetAnswer = screen.getByRole("radio", { name: /Target answer/ });
    await waitFor(() => expect(document.activeElement).toBe(targetAnswer));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => {
      expect(host.state.resolutions).toEqual(["pending-supervision"]);
      expect(host.state.pendingInputs[0]?.resolvedAt).toBeNull();
      expect(host.state.pendingInputs[1]?.resolvedAt).toBe(now - 9_000);
    });
    expect(await screen.findByText("Which unrelated option?")).toBeTruthy();
  });
});
