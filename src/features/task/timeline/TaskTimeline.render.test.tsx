import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentRuntimeState, TimelineEntry } from "../../../core/models/agent";
import { TaskTimeline } from "./TaskTimeline";

const idleRuntime: AgentRuntimeState = {
  phase: "offline",
  taskId: null,
  threadId: null,
  turnId: null,
  turnStartedAt: null,
  error: null,
  eventsSeen: 0,
};

describe("TaskTimeline grouped tool output", () => {
  it("keeps image output visible once outside the collapsed tool list", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgo=";
    const timeline: TimelineEntry[] = [{
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
    }];

    const markup = renderToStaticMarkup(
      <TaskTimeline
        timeline={timeline}
        runtime={idleRuntime}
        latestRun={null}
        showReasoningSummaries
        expandToolOutput={false}
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

    expect(markup).toContain("Show 2 calls · 1 failed");
    expect(markup.match(/src="data:image\/png;base64,iVBORw0KGgo="/g)).toHaveLength(1);
    expect(markup).toContain(
      "</details></article><div class=\"activity__image-attachments\" aria-label=\"Image output\">",
    );
  });
});
