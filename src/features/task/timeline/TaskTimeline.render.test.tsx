import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentRuntimeState, TimelineEntry } from "../../../core/models/agent";
import { TaskTimeline } from "./TaskTimeline";

const idleRuntime: AgentRuntimeState = {
  phase: "offline",
  profileId: null,
  taskId: null,
  threadId: null,
  turnId: null,
  turnStartedAt: null,
  error: null,
  eventsSeen: 0,
};

const render = (
  timeline: TimelineEntry[],
  expandToolOutput = false,
  runtime: AgentRuntimeState = idleRuntime,
  onEditUserMessage?: (text: string) => void,
) => renderToStaticMarkup(
  <TaskTimeline
    timeline={timeline}
    runtime={runtime}
    latestRun={null}
    showReasoningSummaries
    expandToolOutput={expandToolOutput}
    workspacePath="C:\\work\\xiao"
    onOpenResource={() => true}
    historyLoading={false}
    canFork={false}
    onForkTask={() => undefined}
    onResolveApproval={async () => undefined}
    taskId="task-1"
    onReviewChanges={() => undefined}
    onFixVerificationFailures={async () => true}
    fixVerificationFailuresDisabled={false}
    canUndo={false}
    undoing={false}
    onUndo={() => undefined}
    onEditUserMessage={onEditUserMessage}
  />,
);

describe("TaskTimeline turn canvas", () => {
  it("marks only the newest unfinished turn as live", () => {
    const markup = render([{
      id: "older-user",
      kind: "user",
      title: "Older completed work",
      createdAt: 1_000,
    }, {
      id: "older-commentary",
      kind: "result",
      title: "Progress",
      meta: "Commentary",
      createdAt: 2_000,
    }, {
      id: "current-user",
      kind: "user",
      title: "Current work",
      createdAt: 3_000,
    }], false, {
      ...idleRuntime,
      phase: "working",
      taskId: "task-1",
      turnStartedAt: Date.now() - 3_000,
    });

    expect(markup.match(/Working for/g)).toHaveLength(1);
    expect(markup).toContain("Worked for 1s");
  });

  it("opens the latest completed execution and labels viewed image output", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgo=";
    const markup = render([{
      id: "user",
      kind: "user",
      title: "Generate an image",
    }, {
      id: "image-tool",
      kind: "command",
      title: "image_gen · imagegen",
      status: "success",
      attachments: [{
        kind: "image",
        name: "Image output 1",
        path: "tool-output:image-tool:image:1",
        url: imageUrl,
      }],
    }, {
      id: "shell",
      kind: "command",
      title: "Command did not complete",
      command: "npm test",
      body: "failed",
      status: "error",
    }]);

    expect(markup).toContain(">Worked<");
    expect(markup).toContain("aria-expanded=\"true\"");
    expect(markup).toContain("Viewed an image");
    expect(markup.match(/src="data:image\/png;base64,iVBORw0KGgo="/g)).toHaveLength(1);
    expect(markup).toContain("npm test");
  });

  it("marks a failed shell call as recovered when a corrected call succeeds", () => {
    const markup = render([{
      id: "user",
      kind: "user",
      title: "Search the workspace",
    }, {
      id: "failed-search",
      kind: "command",
      title: "Command did not complete",
      command: "\"powershell.exe\" -Command \"rg -n '[invalid' src\"",
      body: "regex parse error",
      status: "error",
    }, {
      id: "fixed-search",
      kind: "command",
      title: "Command completed",
      command: "\"powershell.exe\" -Command \"rg -n -F 'valid' src\"",
      status: "success",
    }], true, {
      ...idleRuntime,
      phase: "working",
      taskId: "task-1",
      turnStartedAt: Date.now() - 2_000,
    });

    expect(markup).toContain(">Shell retry<");
    expect(markup).toContain(">recovered<");
    expect(markup).not.toContain(">Shell failed<");
  });

  it("offers Edit only on the newest user message", () => {
    const markup = render([{
      id: "older-user",
      kind: "user",
      title: "Older prompt",
    }, {
      id: "older-response",
      kind: "result",
      title: "Agent response",
      body: "Older response",
    }, {
      id: "newest-user",
      kind: "user",
      title: "Newest prompt",
    }], false, idleRuntime, () => undefined);

    expect(markup.match(/Edit this prompt in the composer/g)).toHaveLength(1);
  });
});
