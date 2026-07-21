import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { ActivityItem } from "./ActivityItem";
import { statusLabel } from "./LiveTurnStatus";

const renderCompaction = (entry: TimelineEntry) => renderToStaticMarkup(
  <ActivityItem
    entry={entry}
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
  />,
);

describe("ActivityItem user message", () => {
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
});

describe("ActivityItem context compaction", () => {
  it("renders the active compaction animation hook", () => {
    const markup = renderCompaction({
      id: "compact-1",
      kind: "result",
      title: "Compacting context",
      createdAt: 1,
      meta: "Context",
      status: "active",
    });

    expect(markup).toContain("activity--context-compaction activity--active");
    expect(markup).toContain("context-compaction__glyph");
    expect(markup).toContain("Compacting context");
    expect(statusLabel([{
      id: "compact-1",
      kind: "result",
      title: "Compacting context",
      createdAt: 1,
      meta: "Context",
      status: "active",
    }])).toBe("Compacting context");
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
    expect(markup).toContain("context-compaction__state--success");
    expect(markup).toContain("Context compacted");
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
    expect(markup).not.toContain("<details open=\"\"");
  });

  it("renders a compact completed-turn file summary after the Markdown response", () => {
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
    expect(markup).toContain("Edited 2 files");
    expect(markup).toContain("+25");
    expect(markup).toContain("-2");
    expect(markup).toContain("src/App.tsx");
    expect(markup).toContain("Review");
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
    expect(statusLabel([{
      id: "collab-1",
      kind: "agent",
      title: "Waiting for subagent results",
      status: "active",
      collaborationTool: "wait",
    }])).toBe("Waiting for subagent results");
  });
});
