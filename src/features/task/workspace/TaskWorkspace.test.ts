import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import {
  activeCollaboratorsFromTimeline,
  distanceFromScrollBottom,
  latestTimelineScrollTop,
  newTaskProjectOptions,
  shouldFollowLiveOutput,
  taskOutcomeAction,
  TaskWorkspaceFrame,
} from "./TaskWorkspace";

const taskWorkspaceStyles = readFileSync(
  new URL("../styles/task.css", import.meta.url),
  "utf8",
);

const chatCanvasStyles = readFileSync(
  new URL("../styles/chat-canvas.css", import.meta.url),
  "utf8",
);

const themeTokenStyles = readFileSync(
  new URL("../../../styles/tokens.css", import.meta.url),
  "utf8",
);

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
  it("opens a conversation at its latest rendered content", () => {
    expect(latestTimelineScrollTop({ scrollHeight: 2480 })).toBe(2480);
  });

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

describe("task workspace frame", () => {
  it("keeps historical user bubbles theme-aware", () => {
    expect(chatCanvasStyles).toMatch(
      /\.timeline \.activity__user-bubble\s*{[^}]*background:\s*var\(--surface-deep\);/s,
    );
  });

  it("keeps non-media chat chrome theme-aware", () => {
    const mediaStart = chatCanvasStyles.indexOf(".message-image {");
    const messageActionsStart = chatCanvasStyles.indexOf(".message-actions {");
    const themeSensitiveStyles = [
      chatCanvasStyles.slice(0, mediaStart),
      chatCanvasStyles.slice(messageActionsStart),
    ].join("\n");

    expect(mediaStart).toBeGreaterThan(0);
    expect(messageActionsStart).toBeGreaterThan(mediaStart);
    expect(themeSensitiveStyles).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(chatCanvasStyles).toMatch(
      /\.message-image\s*{[^}]*border:\s*1px solid var\(--line\);[^}]*background:\s*var\(--code-surface\);/s,
    );
  });

  it("defines distinct light and dark values for every chat color token", () => {
    const lightTokens = themeTokenStyles.match(/:root\s*{([^}]*)}/s)?.[1] ?? "";
    const darkTokens = themeTokenStyles.match(
      /:root\[data-theme="dark"\]\s*{([^}]*)}/s,
    )?.[1] ?? "";
    const valueOf = (block: string, token: string) =>
      block.match(new RegExp(`--${token}:\\s*([^;]+);`))?.[1]?.trim();
    const chatColorTokens = [
      "surface-deep",
      "surface-raised",
      "surface-hover",
      "code-surface",
      "text",
      "text-soft",
      "muted",
      "muted-strong",
      "line",
      "line-strong",
      "info",
      "danger",
      "success",
      "focus",
    ];

    for (const token of chatColorTokens) {
      const lightValue = valueOf(lightTokens, token);
      const darkValue = valueOf(darkTokens, token);
      expect(lightValue, `${token} must exist in light mode`).toBeTruthy();
      expect(darkValue, `${token} must exist in dark mode`).toBeTruthy();
      expect(darkValue, `${token} must change with the theme`).not.toBe(lightValue);
    }
  });

  it("keeps queued follow-ups in layout without covering Todo content or composer controls", () => {
    expect(taskWorkspaceStyles).toMatch(
      /\.steer-message\s*{[^}]*position:\s*relative;[^}]*width:\s*min\(100%,\s*var\(--task-content-width\)\);/s,
    );
    expect(taskWorkspaceStyles).not.toMatch(/\.steer-message\s*{[^}]*position:\s*absolute;/s);
  });

  it("assigns the flexible grid row to the timeline in conversation mode", () => {
    expect(taskWorkspaceStyles).toMatch(
      /\.task-workspace\s*{[^}]*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\) auto;/s,
    );
  });

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

  it("centers the live changes pill as a block-level flex control", () => {
    expect(taskWorkspaceStyles).toMatch(
      /\.composer-live-changes\s*{[^}]*display:\s*flex;[^}]*width:\s*fit-content;[^}]*margin:\s*0 auto -16px;/s,
    );
  });
});
