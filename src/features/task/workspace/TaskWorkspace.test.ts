import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import {
  activeCollaboratorsFromTimeline,
  canSelectCodexProfile,
  distanceFromScrollBottom,
  newTaskProjectOptions,
  shouldFollowLiveOutput,
  taskOutcomeAction,
  TaskWorkspaceFrame,
} from "./TaskWorkspace";

const collaboratorEntry = (
  id: string,
  threadId: string,
  status: NonNullable<TimelineEntry["collaborators"]>[number]["status"],
): TimelineEntry => ({
  id,
  kind: "agent",
  title: "Collaboration update",
  collaborators: [{ threadId, status, message: threadId }],
});

describe("activeCollaboratorsFromTimeline", () => {
  it("keeps independently spawned agents until each receives a terminal status", () => {
    const timeline = [
      collaboratorEntry("spawn-a", "thread-a", "running"),
      collaboratorEntry("spawn-b", "thread-b", "running"),
      collaboratorEntry("wait-a", "thread-a", "completed"),
    ];

    expect(activeCollaboratorsFromTimeline(timeline)).toEqual([
      { threadId: "thread-b", status: "running", message: "thread-b" },
    ]);
  });

  it("includes every independently spawned agent that is still running", () => {
    const timeline = [
      collaboratorEntry("spawn-a", "thread-a", "running"),
      collaboratorEntry("spawn-b", "thread-b", "pendingInit"),
    ];

    expect(activeCollaboratorsFromTimeline(timeline)).toHaveLength(2);
  });
});

describe("live output scroll behavior", () => {
  it("follows output while the viewport is near the bottom", () => {
    const metrics = { scrollHeight: 1200, scrollTop: 528, clientHeight: 600 };

    expect(distanceFromScrollBottom(metrics)).toBe(72);
    expect(shouldFollowLiveOutput(metrics)).toBe(true);
  });

  it("pauses follow mode after the user scrolls away from the bottom", () => {
    const metrics = { scrollHeight: 1200, scrollTop: 400, clientHeight: 600 };

    expect(distanceFromScrollBottom(metrics)).toBe(200);
    expect(shouldFollowLiveOutput(metrics)).toBe(false);
  });
});

describe("new task project options", () => {
  it("keeps the active project selectable when the project list has not loaded it yet", () => {
    expect(newTaskProjectOptions(
      [{ path: "C:\\code\\other", name: "Other" }],
      { path: "C:\\code\\xiao", name: "Xiao" },
      true,
    )).toEqual([
      { value: "C:\\code\\xiao", label: "Xiao", disabled: false },
      { value: "C:\\code\\other", label: "Other", disabled: false },
    ]);
  });

  it("locks other projects after task setup begins", () => {
    expect(newTaskProjectOptions(
      [
        { path: "C:\\code\\xiao", name: "Xiao" },
        { path: "C:\\code\\other", name: "Other" },
      ],
      { path: "C:\\code\\xiao", name: "Xiao" },
      false,
    )).toEqual([
      { value: "C:\\code\\xiao", label: "Xiao", disabled: false },
      { value: "C:\\code\\other", label: "Other", disabled: true },
    ]);
  });
});

describe("task outcome actions", () => {
  it.each([
    "completed",
    "needs_attention",
    "failed",
    "cancelled",
    "interrupted",
  ])("allows manual review after a terminal %s run without an Acceptance Contract", (status) => {
    expect(taskOutcomeAction("in_progress", false, false, status)).toEqual({
      label: "Mark ready for review",
      nextStage: "ready_for_review",
    });
  });

  it.each([
    ["an active run", false, true, "completed"],
    ["a frozen Acceptance Contract", true, false, "completed"],
    ["no completed run", false, false, null],
    ["a running latest run", false, false, "running"],
  ] as const)("does not offer manual review with %s", (_reason, contract, active, status) => {
    expect(taskOutcomeAction("in_progress", contract, active, status)).toBeNull();
  });

  it.each(["ready_for_review", "published"] as const)(
    "allows accepting a %s outcome",
    (stage) => {
      expect(taskOutcomeAction(stage, false, false, null)).toEqual({
        label: "Accept outcome",
        nextStage: "completed",
      });
    },
  );

  it("allows explicitly reopening a completed task", () => {
    expect(taskOutcomeAction("completed", false, false, null)).toEqual({
      label: "Reopen task",
      nextStage: "in_progress",
    });
  });

  it.each(["ready_for_review", "published", "completed"] as const)(
    "suppresses the %s action while a run is active",
    (stage) => {
      expect(taskOutcomeAction(stage, false, true, "running")).toBeNull();
    },
  );

  it("does not offer an outcome action for a draft", () => {
    expect(taskOutcomeAction("draft", false, false, null)).toBeNull();
  });
});

describe("Codex profile selection", () => {
  it("stays disabled while task state has a storage error", () => {
    expect(canSelectCodexProfile({
      taskArchived: false,
      taskStateLoading: false,
      taskStateError: "Could not save Task state.",
      environmentBusy: false,
      runtimeBusy: false,
      profileCount: 2,
    })).toBe(false);
  });
});

describe("task workspace frame", () => {
  it("keeps one unconditional composer slot across launch and conversation modes", () => {
    const renderFrame = (launchMode: boolean) => renderToStaticMarkup(createElement(
      TaskWorkspaceFrame,
      {
        launchMode,
        launchContent: createElement("div", { "data-view": "launch" }),
        conversationContent: createElement("div", { "data-view": "conversation" }),
        composer: createElement("textarea", { "data-composer": true }),
        launchContext: createElement("footer", { "data-view": "context" }),
      },
    ));

    const launchMarkup = renderFrame(true);
    const conversationMarkup = renderFrame(false);

    expect(launchMarkup).toContain('class="task-workspace task-workspace--launch"');
    expect(launchMarkup).toContain('data-view="launch"');
    expect(launchMarkup).not.toContain('data-view="conversation"');
    expect(conversationMarkup).toContain('class="task-workspace"');
    expect(conversationMarkup).toContain('data-view="conversation"');
    expect(conversationMarkup).not.toContain('data-view="launch"');
    expect(launchMarkup.match(/task-workspace__composer-slot/g)).toHaveLength(1);
    expect(conversationMarkup.match(/task-workspace__composer-slot/g)).toHaveLength(1);
    expect(launchMarkup.match(/data-composer="true"/g)).toHaveLength(1);
    expect(conversationMarkup.match(/data-composer="true"/g)).toHaveLength(1);
  });
});
