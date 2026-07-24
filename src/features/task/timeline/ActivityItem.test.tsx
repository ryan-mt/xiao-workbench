import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  promptWithSelectedContext,
  type AgentRuntimeState,
  type TimelineEntry,
} from "../../../core/models/agent";
import { ActivityItem } from "./ActivityItem";
import { currentTurnHasVisibleContent, LiveTurnStatus } from "./LiveTurnStatus";

const renderCompaction = (
  entry: TimelineEntry,
  attemptCount = 1,
  isLive = true,
  recovered = false,
) => renderToStaticMarkup(
  <ActivityItem
    entry={entry}
    attemptCount={attemptCount}
    index={0}
    showReasoningSummaries
    expandToolOutput={false}
    workspacePath={"C:\\work\\xiao"}
    onOpenResource={() => true}
    taskId="task-1"
    canFork={false}
    onForkTask={() => undefined}
    onResolveApproval={async () => undefined}
    onReviewChanges={() => undefined}
    recovered={recovered}
    isLive={isLive}
  />,
);

describe("ActivityItem user message", () => {
  it("shows only the user's question when selected context was sent internally", () => {
    const markup = renderCompaction({
      id: "user-selection-1",
      kind: "user",
      title: promptWithSelectedContext("thấy gì?", "Hi! What would you like to work on?"),
      status: "active",
      meta: "You",
    });

    expect(markup).toContain("thấy gì?");
    expect(markup).not.toContain("selected_text");
    expect(markup).not.toContain("Hi! What would you like to work on?");
  });

  it("shows the fork action only while forking is available", () => {
    const entry: TimelineEntry = {
      id: "user-1",
      kind: "user",
      title: "Try another approach",
      status: "success",
    };
    const renderUser = (canFork: boolean) => renderToStaticMarkup(
      <ActivityItem
        entry={entry}
        index={0}
        showReasoningSummaries
        expandToolOutput={false}
        workspacePath={"C:\\work\\xiao"}
        onOpenResource={() => true}
        taskId="task-1"
        canFork={canFork}
        onForkTask={() => undefined}
        onResolveApproval={async () => undefined}
        onReviewChanges={() => undefined}
      />,
    );

    expect(renderUser(true)).toContain("Fork from here");
    expect(renderUser(false)).not.toContain("Fork from here");
  });

  it("keeps sent images visible while the prompt is queued", () => {
    const markup = renderCompaction({
      id: "user-image-1",
      kind: "user",
      title: "Please inspect this screenshot",
      status: "active",
      meta: "Queued",
      attachments: [{
        id: "attachment-1",
        kind: "image",
        name: "clipboard.png",
        path: "clipboard:image-1",
        url: "data:image/png;base64,aGVsbG8=",
      }],
    });

    expect(markup).toContain("aria-label=\"Sent attachments\"");
    expect(markup).toContain("src=\"data:image/png;base64,aGVsbG8=\"");
    expect(markup).toContain("alt=\"clipboard.png\"");
    expect(markup).toContain("Queued");
    expect(markup).toContain("class=\"lucide lucide-loader-circle spin\"");
  });
});

describe("ActivityItem approval actions", () => {
  it("hides decision buttons after an approval request is settled", () => {
    const markup = renderCompaction({
      id: "approval-1",
      kind: "approval",
      title: "Command permission requested",
      requestId: 0,
      pendingInputId: "pending-1",
      status: "success",
      meta: "Request no longer active",
    });

    expect(markup).not.toContain("approval-actions");
    expect(markup).not.toContain("Allow once");
  });
});

describe("ActivityItem command retries", () => {
  it("shows one warning row with its attempt count for an environment block", () => {
    const markup = renderCompaction({
      id: "command-1",
      kind: "command",
      title: "Run tests",
      command: "npm test",
      body: "Error: spawn EPERM",
      status: "error",
    }, 3);

    expect(markup).toContain("activity--warning");
    expect(markup).toContain(">Shell blocked<");
    expect(markup).toContain("3 attempts");
  });

  it("shows an unavailable LSP as failed instead of blocked", () => {
    const markup = renderCompaction({
      id: "command-2",
      kind: "command",
      title: "xiao_lsp diagnostics",
      body: "typescript-language-server was not found. Install it in the workspace or on PATH.",
      status: "error",
    });

    expect(markup).toContain("activity--error");
    expect(markup).toContain(">Shell failed<");
    expect(markup).not.toContain(">Shell blocked<");
  });

  it("shows a failed shell attempt as recovered after a corrected call succeeds", () => {
    const markup = renderCompaction({
      id: "command-3",
      kind: "command",
      title: "Run search",
      command: "rg -n '[invalid' src",
      body: "regex parse error",
      status: "error",
    }, 1, true, true);

    expect(markup).toContain("activity--warning");
    expect(markup).toContain(">Shell retry<");
    expect(markup).toContain(">recovered<");
    expect(markup).not.toContain(">Shell failed<");
  });
});

describe("ActivityItem image output", () => {
  it("renders tool images directly in the timeline instead of a local-file link", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgo=";
    const markup = renderCompaction({
      id: "image-tool-1",
      kind: "command",
      title: "image_gen · imagegen",
      status: "success",
      attachments: [{
        id: "image-tool-1-image-1",
        kind: "image",
        name: "Image output 1",
        path: "tool-output:image-tool-1:image:1",
        mime: "image/png",
        url: imageUrl,
      }],
    });

    expect(markup).toContain("aria-label=\"Image output\"");
    expect(markup).toContain(`src="${imageUrl}"`);
    expect(markup).toContain("alt=\"Image output 1\"");
    expect(markup).not.toContain("href=");
  });

  it("supports image parts attached directly to an assistant response", () => {
    const markup = renderCompaction({
      id: "response-image-1",
      kind: "result",
      title: "Agent response",
      body: "Here is the result.",
      status: "success",
      attachments: [{
        kind: "image",
        name: "Result image",
        path: "tool-output:result:image:1",
        url: "https://example.com/result.png",
      }],
    });

    expect(markup).toContain("Here is the result.");
    expect(markup).toContain("src=\"https://example.com/result.png\"");
  });
});

describe("ActivityItem browser tools", () => {
  it("renders web searches as a flat tool row instead of a generic card", () => {
    const markup = renderCompaction({
      id: "search-1",
      kind: "result",
      title: "Searched: site:github.com/example/project message part",
      meta: "Browser tool",
      status: "success",
    });

    expect(markup).toContain("activity__tool-summary-row");
    expect(markup).toContain(">Web search<");
    expect(markup).toContain("site:github.com/example/project message part");
    expect(markup).not.toContain("activity__body");
    expect(markup).not.toContain("Browser tool");
  });
});

describe("ActivityItem image security policy", () => {
  it("allows the network image schemes accepted by timeline attachments", () => {
    const config = JSON.parse(readFileSync(
      new URL("../../../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    )) as { app: { security: { csp: string } } };
    const imageDirective = config.app.security.csp
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("img-src "));
    const sources = imageDirective?.split(/\s+/) ?? [];

    expect(sources).toEqual(expect.arrayContaining(["http:", "https:"]));
  });
});

describe("ActivityItem context compaction", () => {
  it("renders the active compaction as a quiet divider", () => {
    const markup = renderCompaction({
      id: "compact-1",
      kind: "result",
      title: "Compacting context",
      createdAt: 1,
      meta: "Context",
      status: "active",
    });

    expect(markup).toContain("activity--context-compaction activity--active");
    expect(markup).toContain("class=\"context-compaction\"");
    expect(markup).toContain("aria-busy=\"true\"");
    expect(markup).toContain("Compacting session");
    expect(markup).not.toContain("Compacting context");
    expect(markup.match(/context-compaction__line/g)).toHaveLength(2);
    expect(markup).not.toContain("context-compaction__glyph");
    expect(markup).not.toContain("context-compaction__meter");
  });

  it("settles the same marker into its completed state", () => {
    const markup = renderCompaction({
      id: "compact-1",
      kind: "result",
      title: "Context compacted",
      createdAt: 1,
      meta: "Context",
      status: "success",
    });

    expect(markup).toContain("activity--context-compaction activity--success");
    expect(markup).toContain("class=\"context-compaction\"");
    expect(markup).toContain("Session compacted");
    expect(markup).not.toContain("Context compacted");
    expect(markup.match(/context-compaction__line/g)).toHaveLength(2);
  });
});

describe("live turn presentation", () => {
  const workingRuntime: AgentRuntimeState = {
    phase: "working",
    profileId: "profile-default",
    taskId: "task-1",
    threadId: "thread-1",
    turnId: "turn-1",
    turnStartedAt: 1,
    error: null,
    eventsSeen: 1,
  };

  it("shows a quiet thinking row before the first visible part", () => {
    const markup = renderToStaticMarkup(
      <LiveTurnStatus
        taskId="task-1"
        runtime={workingRuntime}
        timeline={[{
          id: "user-1",
          kind: "user",
          title: "Please fix this",
        }, {
          id: "thought-1",
          kind: "thought",
          title: "Reasoning",
          status: "active",
        }]}
      />,
    );

    expect(markup).toContain(">Thinking<");
    expect(markup).not.toContain("Finishing");
  });

  it("does not append a duplicate finishing row after response content exists", () => {
    expect(currentTurnHasVisibleContent([{
      id: "user-1",
      kind: "user",
      title: "Please fix this",
    }, {
      id: "response-1",
      kind: "result",
      title: "Agent response",
      body: "Done.",
      status: "success",
    }])).toBe(true);
  });

  it("keeps the quiet thinking state before the first visible part arrives", () => {
    expect(currentTurnHasVisibleContent([{
      id: "user-1",
      kind: "user",
      title: "Please fix this",
    }])).toBe(false);
  });

  it("does not animate stale active entries after their run stops", () => {
    const markup = renderCompaction({
      id: "response-stale",
      kind: "result",
      title: "Agent response",
      body: "The last visible response.",
      status: "active",
    }, 1, false);

    expect(markup).toContain("The last visible response.");
    expect(markup).not.toContain("aria-busy=\"true\"");
    expect(markup).not.toContain("is-streaming");
    expect(markup).toContain("Copy response");
  });
});

describe("ActivityItem timeline disclosures", () => {
  it("keeps active tool output collapsed when the preference is off", () => {
    const markup = renderCompaction({
      id: "command-1",
      kind: "command",
      title: "Run checks",
      command: "npm test",
      status: "active",
    });

    expect(markup).toContain("activity__tool-disclosure");
    expect(markup).not.toContain("<details class=\"activity__tool-disclosure\" open=\"\"");
  });

  it("shows an absolute patch path and first changed line", () => {
    const markup = renderCompaction({
      id: "patch-1",
      kind: "change",
      title: "Changed file",
      status: "active",
      files: [{
        path: "src/index.html",
        additions: 1,
        deletions: 0,
        patch: "@@ -9,0 +10,1 @@\n+<main />",
      }],
    });

    expect(markup).toContain("C:\\work\\xiao\\src\\index.html");
    expect(markup).toContain("line 10");
    expect(markup).toContain(">Edit<");
    expect(markup).toContain("patch-activity__verb is-active");
    expect(markup).not.toContain("<details open=\"\"");
  });

  it("keeps completed-turn actions compact without repeating edited files", () => {
    const markup = renderToStaticMarkup(
      <ActivityItem
        entry={{
          id: "result-1",
          kind: "result",
          title: "Agent response",
          body: "Implemented the requested feature.",
          status: "success",
        }}
        index={3}
        showReasoningSummaries
        expandToolOutput={false}
        workspacePath={"C:\\work\\xiao"}
        onOpenResource={() => true}
        taskId="task-1"
        canFork={false}
        onForkTask={() => undefined}
        onResolveApproval={async () => undefined}
        onReviewChanges={() => undefined}
        turnFiles={[
          { path: "src/App.tsx", additions: 14, deletions: 0 },
          { path: "src/app.css", additions: 11, deletions: 2 },
        ]}
        canUndo
        undoing={false}
        onUndo={() => undefined}
      />,
    );

    expect(markup).toContain("Implemented the requested feature.");
    expect(markup).not.toContain(">Response<");
    expect(markup).not.toContain("activity__assistant-header");
    expect(markup).not.toContain("Edited 2 files");
    expect(markup).not.toContain("src/App.tsx");
    expect(markup).toContain("Review changes");
    expect(markup).toContain("Undo");
  });
});

describe("ActivityItem agent collaboration", () => {
  it("shows subagent identity, current status, and delegated work", () => {
    const markup = renderCompaction({
      id: "collab-1",
      kind: "agent",
      title: "Waiting for subagent results",
      body: "Inspect the streaming path",
      meta: "1 subagent - gpt-test",
      status: "active",
      collaborators: [{
        threadId: "thread-child-123456",
        status: "running",
        message: "Reading the backend",
      }],
      collaborationTool: "wait",
    });

    expect(markup).toContain("activity--agent activity--active");
    expect(markup).toContain("Waiting for subagent results");
    expect(markup).toContain("Subagent 1");
    expect(markup).toContain("thread-child");
    expect(markup).toContain("Reading the backend");
    expect(markup).toContain("Working");
    expect(markup).toContain("agent-progress-indicator");
    expect(markup).not.toContain("agent-activity__state is-active");
  });
});
