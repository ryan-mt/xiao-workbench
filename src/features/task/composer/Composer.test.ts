import { describe, expect, it, vi } from "vitest";

import type { AgentAttachment } from "../../../core/models/agent";
import { workspaceTaskKey } from "../../../app/App";
import {
  navigateComposerPromptHistory,
  runComposerSubmission,
  sandboxModeOptions,
} from "./Composer";

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
