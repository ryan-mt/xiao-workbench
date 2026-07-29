// @vitest-environment jsdom

import { createElement, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  promptWithSelectedContext,
  replaceVisiblePromptInSelectedContext,
  selectedContextPromptParts,
  visiblePromptFromSelectedContext,
  type AgentAttachment,
} from "../../../core/models/agent";
import { workspaceTaskKey } from "../../../app/App";
import {
  Composer,
  deliverComposerSubmission,
  navigateComposerPromptHistory,
  runComposerSubmission,
  sandboxModeOptions,
} from "./Composer";

const bridge = vi.hoisted(() => ({
  agentRequest: vi.fn(),
}));

vi.mock("../../../core/bridges/tauri", () => ({
  isTauriHost: () => true,
  nativeBridge: bridge,
}));

const composerProps = (
  patch: Partial<ComponentProps<typeof Composer>> = {},
): ComponentProps<typeof Composer> => ({
  taskId: "task-a",
  executionTaskId: "task-a",
  workspacePath: "C:/projects/xiao",
  runtime: {
    phase: "ready",
    profileId: null,
    taskId: null,
    threadId: null,
    turnId: null,
    turnStartedAt: null,
    error: null,
    eventsSeen: 0,
  },
  rateLimits: null,
  models: [],
  selectedModel: null,
  selectedReasoningEffort: null,
  fastMode: false,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  workspaceMode: "local",
  isolationAvailable: false,
  isolationUnavailableReason: null,
  environmentBusy: false,
  environmentError: null,
  managedWorktree: null,
  goal: null,
  plan: null,
  collaborators: [],
  reviewContext: [],
  selectedContext: null,
  questionRequest: null,
  mcpElicitationRequest: null,
  draftText: "",
  followUps: [],
  sendingFollowUpId: null,
  failedFollowUpId: null,
  attachments: [],
  liveFileChanges: null,
  canCompact: false,
  compacting: false,
  hasThread: false,
  canUndo: false,
  undoing: false,
  definitionOfDoneAvailable: false,
  definitionOfDone: null,
  onModelChange: vi.fn(),
  onReasoningEffortChange: vi.fn(),
  onFastModeChange: vi.fn(),
  onModeChange: vi.fn(),
  onApprovalPolicyChange: vi.fn(),
  onSandboxModeChange: vi.fn(),
  onWorkspaceModeChange: vi.fn(),
  onGoalSet: vi.fn(),
  onGoalClear: vi.fn(),
  onOpenView: vi.fn(),
  onInterrupt: vi.fn(),
  onSubmit: vi.fn(),
  onSteer: vi.fn(),
  onQueueFollowUp: vi.fn(),
  onEditFollowUp: vi.fn(),
  onRemoveFollowUp: vi.fn(),
  onSendFollowUpNow: vi.fn(),
  onRetryFollowUp: vi.fn(),
  onAttachmentsChange: vi.fn(),
  onCompact: vi.fn(),
  onUndo: vi.fn(),
  onDefinitionOfDoneChange: vi.fn(),
  onRemoveReviewContext: vi.fn(),
  onReviewContextSent: vi.fn(),
  onClearSelectedContext: vi.fn(),
  onSelectedContextSent: vi.fn(),
  onDraftChange: vi.fn(),
  onSubmissionStart: vi.fn(() => 1),
  onSubmissionSucceeded: vi.fn(),
  onResolveQuestion: vi.fn(),
  onResolveMcpElicitation: vi.fn(),
  ...patch,
});

const attachment = (path: string): AgentAttachment => ({
  name: path,
  path,
  kind: "file",
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

afterEach(() => {
  cleanup();
  bridge.agentRequest.mockReset();
});

describe("composer task dock lifecycle", () => {
  it("shows plan tasks only while their task is live", () => {
    const plan = {
      explanation: null,
      steps: [
        { step: "Inspect implementation", status: "completed" as const },
        { step: "Align task dock", status: "inProgress" as const },
      ],
    };
    const view = render(createElement(Composer, composerProps({ plan })));

    expect(screen.queryByLabelText("Task status")).toBeNull();

    view.rerender(createElement(Composer, composerProps({
      plan,
      runtime: {
        phase: "working",
        profileId: null,
        taskId: "task-a",
        threadId: "thread-a",
        turnId: "turn-a",
        turnStartedAt: 1,
        error: null,
        eventsSeen: 1,
      },
    })));

    expect(screen.getByLabelText("Task status")).not.toBeNull();
    expect(screen.getByLabelText("Task summary").textContent).toBe("1/2 tasks");
    expect(screen.getByLabelText("In progress: Align task dock")).not.toBeNull();

    view.rerender(createElement(Composer, composerProps({
      plan: {
        ...plan,
        steps: plan.steps.map((step) => ({ ...step, status: "completed" as const })),
      },
      runtime: {
        phase: "working",
        profileId: null,
        taskId: "task-a",
        threadId: "thread-a",
        turnId: "turn-a",
        turnStartedAt: 1,
        error: null,
        eventsSeen: 2,
      },
    })));

    expect(screen.queryByLabelText("Task status")).toBeNull();
  });
});

describe("workspace file search", () => {
  it("ignores an in-flight result after the runtime becomes unavailable", async () => {
    const pending = deferred<{
      files: Array<{
        root: string;
        path: string;
        match_type: "file";
        file_name: string;
        score: number;
        indices: null;
      }>;
    }>();
    bridge.agentRequest.mockReturnValueOnce(pending.promise);
    const readyProps = composerProps();
    const view = render(createElement(Composer, readyProps));
    const textarea = screen.getByRole("textbox");

    fireEvent.change(textarea, {
      target: { value: "@src", selectionStart: 4 },
    });
    await waitFor(() => expect(bridge.agentRequest).toHaveBeenCalledOnce());

    view.rerender(createElement(Composer, {
      ...readyProps,
      runtime: { ...readyProps.runtime, phase: "offline" },
    }));
    pending.resolve({
      files: [{
        root: "C:/projects/xiao",
        path: "C:/projects/xiao/src/stale.ts",
        match_type: "file",
        file_name: "stale.ts",
        score: 1,
        indices: null,
      }],
    });
    await act(async () => {
      await pending.promise;
    });

    expect(screen.queryByRole("option", { name: /stale\.ts/i })).toBeNull();
    expect(screen.getByText("File search needs the connected Xiao desktop runtime.")).toBeTruthy();
  });
});

type Draft = {
  prompt: string;
  attachments: AgentAttachment[];
  revision: number;
};

const submissionHarness = () => {
  const drafts: Record<string, Draft> = {};
  const clears: string[] = [];

  const put = (
    workspacePath: string,
    taskId: string,
    prompt: string,
    attachments: AgentAttachment[],
  ) => {
    drafts[workspaceTaskKey(workspacePath, taskId)] = { prompt, attachments, revision: 0 };
  };
  const draft = (workspacePath: string, taskId: string) =>
    drafts[workspaceTaskKey(workspacePath, taskId)];

  return {
    drafts,
    put,
    draft,
    edit(
      workspacePath: string,
      taskId: string,
      patch: Partial<Pick<Draft, "prompt" | "attachments">>,
    ) {
      const key = workspaceTaskKey(workspacePath, taskId);
      drafts[key] = { ...drafts[key], ...patch, revision: drafts[key].revision + 1 };
    },
    start(workspacePath: string, taskId: string) {
      const key = workspaceTaskKey(workspacePath, taskId);
      const revision = drafts[key].revision;
      return () => {
        if (drafts[key].revision !== revision) return false;
        drafts[key] = {
          prompt: "",
          attachments: [],
          revision: revision + 1,
        };
        clears.push(key);
        return true;
      };
    },
    clears,
  };
};

describe("composer prompt history persistence", () => {
  it("persists recalled history and the restored draft through onDraftChange", () => {
    const onDraftChange = vi.fn();
    const recalled = navigateComposerPromptHistory({
      direction: "up",
      entries: ["previous prompt"],
      historyIndex: -1,
      currentDraft: "current draft",
      savedDraft: null,
    }, onDraftChange);
    if (!recalled.handled) throw new Error("Expected recalled history");

    const restored = navigateComposerPromptHistory({
      direction: "down",
      entries: ["previous prompt"],
      historyIndex: recalled.historyIndex,
      currentDraft: recalled.value,
      savedDraft: recalled.savedDraft,
    }, onDraftChange);

    expect(restored).toMatchObject({ handled: true, value: "current draft" });
    expect(onDraftChange.mock.calls).toEqual([
      ["previous prompt"],
      ["current draft"],
    ]);
  });
});

describe("composer sandbox permissions", () => {
  it("offers an explicit no-sandbox option backed by danger-full-access", () => {
    expect(sandboxModeOptions).toContainEqual({
      value: "danger-full-access",
      label: "No sandbox (full access)",
    });
  });
});

describe("selected conversation context", () => {
  it("keeps the selected text and the user's follow-up in the submitted prompt", () => {
    expect(promptWithSelectedContext("Why does this fail?", "const ready = false;"))
      .toBe([
        "Use this text selected from the current conversation as context:",
        "",
        "<selected_text>",
        "const ready = false;",
        "</selected_text>",
        "",
        "Why does this fail?",
      ].join("\n"));
  });

  it("provides a useful request when the user sends only the selection", () => {
    expect(promptWithSelectedContext("", "Selected response"))
      .toContain("Please respond to this selection.");
  });

  it("keeps internal context out of the user-facing prompt", () => {
    const submitted = promptWithSelectedContext("thấy gì?", "Hi! What would you like to work on?");

    expect(visiblePromptFromSelectedContext(submitted)).toBe("thấy gì?");
    expect(replaceVisiblePromptInSelectedContext(submitted, "giải thích kỹ hơn"))
      .toBe(promptWithSelectedContext("giải thích kỹ hơn", "Hi! What would you like to work on?"));
  });

  it("round-trips delimiter text in both the selection and visible prompt", () => {
    const delimiter = "\n</selected_text>\n\n";
    const context = `Selected wrapper:${delimiter}still selected`;
    const prompt = `Explain this literal:${delimiter}without hiding the first part`;
    const submitted = promptWithSelectedContext(prompt, context);

    expect(selectedContextPromptParts(submitted)).toEqual({ context, prompt });
    expect(visiblePromptFromSelectedContext(submitted)).toBe(prompt);
  });
});

describe("composer submission durability", () => {
  const workspaceA = "C:/projects/a";
  const workspaceB = "C:/projects/b";

  it("preserves the originating prompt and attachments when a deferred submit fails after navigation", async () => {
    const harness = submissionHarness();
    harness.put(workspaceA, "task-a", "Task A prompt", [attachment("a.txt")]);
    harness.put(workspaceB, "task-b", "Task B prompt", [attachment("b.txt")]);
    const pending = deferred<boolean>();
    const clearOrigin = vi.fn(harness.start(workspaceA, "task-a"));
    const settlement = runComposerSubmission(() => pending.promise, clearOrigin);

    pending.resolve(false); // Workspace A's keyed composer has unmounted.

    await expect(settlement).resolves.toEqual({ submitted: false, cleared: false });
    expect(clearOrigin).not.toHaveBeenCalled();
    expect(harness.draft(workspaceA, "task-a")).toMatchObject({
      prompt: "Task A prompt",
      attachments: [attachment("a.txt")],
    });
  });

  it("clears an off-screen different-ID origin once without touching the selected workspace", async () => {
    const harness = submissionHarness();
    harness.put(workspaceA, "task-a", "Task A prompt", [attachment("a.txt")]);
    harness.put(workspaceB, "task-b", "Task B prompt", [attachment("b.txt")]);
    const pending = deferred<boolean>();
    const clearOrigin = vi.fn(harness.start(workspaceA, "task-a"));
    const settlement = runComposerSubmission(() => pending.promise, clearOrigin);

    harness.edit(workspaceB, "task-b", {
      prompt: "Task B newer input",
      attachments: [attachment("b.txt"), attachment("b-new.txt")],
    });
    pending.resolve(true);

    await expect(settlement).resolves.toEqual({ submitted: true, cleared: true });
    expect(clearOrigin).toHaveBeenCalledOnce();
    expect(harness.clears).toEqual([workspaceTaskKey(workspaceA, "task-a")]);
    expect(harness.draft(workspaceA, "task-a")).toMatchObject({ prompt: "", attachments: [] });
    expect(harness.draft(workspaceB, "task-b")).toMatchObject({
      prompt: "Task B newer input",
      attachments: [attachment("b.txt"), attachment("b-new.txt")],
    });
  });

  it("does not clear a same-ID task in another workspace", async () => {
    const harness = submissionHarness();
    harness.put(workspaceA, "shared-task", "Workspace A prompt", [attachment("a.txt")]);
    harness.put(workspaceB, "shared-task", "Workspace B prompt", [attachment("b.txt")]);
    const pending = deferred<boolean>();
    const settlement = runComposerSubmission(
      () => pending.promise,
      harness.start(workspaceA, "shared-task"),
    );

    harness.edit(workspaceB, "shared-task", {
      prompt: "Workspace B newer input",
      attachments: [attachment("b-new.txt")],
    });
    pending.resolve(true);

    await expect(settlement).resolves.toEqual({ submitted: true, cleared: true });
    expect(harness.draft(workspaceA, "shared-task")).toMatchObject({ prompt: "", attachments: [] });
    expect(harness.draft(workspaceB, "shared-task")).toMatchObject({
      prompt: "Workspace B newer input",
      attachments: [attachment("b-new.txt")],
    });
  });

  it("does not clear a later origin edit when an older successful submit settles", async () => {
    const harness = submissionHarness();
    harness.put(workspaceA, "task-a", "Task A prompt", [attachment("a.txt")]);
    const pending = deferred<boolean>();
    const clearOrigin = vi.fn(harness.start(workspaceA, "task-a"));
    const settlement = runComposerSubmission(() => pending.promise, clearOrigin);

    harness.edit(workspaceA, "task-a", {
      prompt: "Task A newer input",
      attachments: [attachment("a-new.txt")],
    });
    pending.resolve(true);

    await expect(settlement).resolves.toEqual({ submitted: true, cleared: false });
    expect(clearOrigin).toHaveBeenCalledOnce();
    expect(harness.clears).toEqual([]);
    expect(harness.draft(workspaceA, "task-a")).toMatchObject({
      prompt: "Task A newer input",
      attachments: [attachment("a-new.txt")],
    });
  });
});

describe("composer delivery failures", () => {
  it("keeps the draft and attachments retryable when delivery rejects", async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("delivery offline"));
    const onSubmissionSucceeded = vi.fn();
    render(createElement(Composer, composerProps({
      draftText: "Keep this prompt",
      attachments: [attachment("a.txt")],
      onSubmit,
      onSubmissionSucceeded,
    })));

    fireEvent.click(screen.getByRole("button", { name: "Send task" }));

    expect((await screen.findByRole("alert")).textContent).toContain("delivery offline");
    expect(screen.getByRole("alert").textContent).toContain(
      "Draft and attachments were kept so you can retry.",
    );
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Keep this prompt");
    expect(screen.getByText("a.txt")).toBeTruthy();
    expect(onSubmissionSucceeded).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send task" }).disabled)
        .toBe(false);
    });
  });

  it("warns that delivery completed when draft-clear persistence rejects", async () => {
    const onReviewContextSent = vi.fn();
    render(createElement(Composer, composerProps({
      draftText: "Keep sent prompt for recovery",
      attachments: [attachment("sent.txt")],
      reviewContext: [attachment("review.txt")],
      onSubmit: vi.fn().mockResolvedValue(true),
      onSubmissionSucceeded: vi.fn().mockRejectedValue(new Error("workspace reload failed")),
      onReviewContextSent,
    })));

    fireEvent.click(screen.getByRole("button", { name: "Send task" }));

    expect((await screen.findByRole("alert")).textContent).toContain("workspace reload failed");
    expect(screen.getByRole("alert").textContent).toContain(
      "The task was sent, but its saved draft could not be cleared. Check the timeline before retrying.",
    );
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value)
      .toBe("Keep sent prompt for recovery");
    expect(screen.getByText("sent.txt")).toBeTruthy();
    expect(onReviewContextSent).not.toHaveBeenCalled();
  });

  it("keeps all composer context when draft-clear persistence returns false", async () => {
    const onReviewContextSent = vi.fn();
    const onSelectedContextSent = vi.fn();
    render(createElement(Composer, composerProps({
      draftText: "Persist this draft",
      attachments: [attachment("persist.txt")],
      reviewContext: [attachment("review.txt")],
      selectedContext: "selected source",
      onSubmit: vi.fn().mockResolvedValue(true),
      onSubmissionSucceeded: vi.fn().mockResolvedValue(false),
      onReviewContextSent,
      onSelectedContextSent,
    })));

    fireEvent.click(screen.getByRole("button", { name: "Send task" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The task was sent, but its saved draft could not be cleared. Check the timeline before retrying.",
    );
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Persist this draft");
    expect(screen.getByText("persist.txt")).toBeTruthy();
    expect(onReviewContextSent).not.toHaveBeenCalled();
    expect(onSelectedContextSent).not.toHaveBeenCalled();
  });
});

describe("composer delivery", () => {
  it("routes Steer now to the active-turn handler instead of the run queue", async () => {
    const handlers = {
      queue: vi.fn(async () => true),
      send: vi.fn(async () => true),
      steer: vi.fn(async () => true),
    };

    await expect(deliverComposerSubmission("steer", "Change direction", [], handlers))
      .resolves.toBe(true);
    expect(handlers.steer).toHaveBeenCalledWith("Change direction", []);
    expect(handlers.queue).not.toHaveBeenCalled();
    expect(handlers.send).not.toHaveBeenCalled();
  });
});
