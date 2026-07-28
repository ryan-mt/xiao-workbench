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
  />,
);

describe("TaskTimeline turn canvas", () => {
  it("keeps image output visible outside a completed turn's collapsed execution list", () => {
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

    expect(markup).toContain("Worked for 0s");
    expect(markup).toContain("aria-expanded=\"false\"");
    expect(markup.match(/src="data:image\/png;base64,iVBORw0KGgo="/g)).toHaveLength(1);
    expect(markup).not.toContain("npm test");
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
});
