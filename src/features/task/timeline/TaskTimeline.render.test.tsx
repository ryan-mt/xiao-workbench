import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  AgentAttachment,
  AgentRuntimeState,
  TimelineEntry,
} from "../../../core/models/agent";
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
  onEditUserMessage?: (text: string, attachments: AgentAttachment[]) => void,
  canFork = false,
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
    canFork={canFork}
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

  it("opens live execution and labels viewed image output", () => {
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
    }], false, {
      ...idleRuntime,
      phase: "working",
      taskId: "task-1",
      turnStartedAt: Date.now() - 2_000,
    });

    expect(markup).toContain("Working for");
    expect(markup).toContain("aria-expanded=\"true\"");
    expect(markup).toContain("Viewed an image");
    expect(markup.match(/src="data:image\/png;base64,iVBORw0KGgo="/g)).toHaveLength(1);
    expect(markup).toContain("npm test");
  });

  it("keeps the final response visible when completed work is collapsed", () => {
    const markup = render([{
      id: "user",
      kind: "user",
      title: "Fix the import",
    }, {
      id: "shell",
      kind: "command",
      title: "Ran command",
      command: "npm test",
      status: "success",
    }, {
      id: "response",
      kind: "result",
      title: "Agent response",
      body: "The import is fixed.",
      status: "success",
    }]);

    expect(markup).toContain("aria-expanded=\"false\"");
    expect(markup).not.toContain("npm test");
    expect(markup).toContain("The import is fixed.");
  });

  it("renders the latest live thought as an animated status without inventing execution", () => {
    const markup = render([{
      id: "user",
      kind: "user",
      title: "Fix chronological rendering",
    }, {
      id: "thinking",
      kind: "thought",
      title: "Reasoning",
      body: "Planning chronological flow rendering and grouping",
      status: "active",
    }], false, {
      ...idleRuntime,
      phase: "working",
      taskId: "task-1",
      turnStartedAt: Date.now() - 43_000,
    });

    expect(markup).toContain("Working for 43s");
    expect(markup).toContain("conversation-turn__thinking");
    expect(markup).toContain("Planning chronological flow rendering and grouping");
    expect(markup).not.toContain("Execution details");
  });

  it("uses a live thought as the disclosure title when execution follows it", () => {
    const markup = render([{
      id: "user",
      kind: "user",
      title: "Inspect the app",
    }, {
      id: "thinking",
      kind: "thought",
      title: "Reasoning",
      body: "Designing selected task refresh",
      status: "success",
    }, {
      id: "command",
      kind: "command",
      title: "Ran command",
      command: "rg -n selectedTask src/app/App.tsx",
      status: "success",
    }], false, {
      ...idleRuntime,
      phase: "working",
      taskId: "task-1",
      turnStartedAt: Date.now() - 10_000,
    });

    expect(markup).toContain("Designing selected task refresh");
    expect(markup).toContain("rg -n selectedTask src/app/App.tsx");
    expect(markup).not.toMatch(
      /execution-trace__icon[^>]*>[\s\S]*?Designing selected task refresh/,
    );
  });

  it("keeps command batches between commentary and splits them at thought boundaries", () => {
    const markup = render([{
      id: "user",
      kind: "user",
      title: "Fix the chronology",
    }, {
      id: "commentary-one",
      kind: "result",
      title: "Agent response",
      meta: "Commentary",
      body: "Inspecting the importer.",
    }, {
      id: "command-one",
      kind: "command",
      title: "Ran command",
      command: "git status --short",
    }, {
      id: "thought",
      kind: "thought",
      title: "Reasoning",
      body: "Checking the app-server sequence",
    }, {
      id: "terminal",
      kind: "command",
      title: "Read chat terminal",
      meta: "Codex tool",
      body: "No terminal session is attached.",
    }, {
      id: "commentary-two",
      kind: "result",
      title: "Agent response",
      meta: "Commentary",
      body: "Applying the measured fix.",
    }], false, {
      ...idleRuntime,
      phase: "working",
      taskId: "task-1",
      turnStartedAt: Date.now() - 10_000,
    });

    expect(markup.indexOf("Inspecting the importer.")).toBeLessThan(
      markup.indexOf("git status --short"),
    );
    expect(markup.indexOf("git status --short")).toBeLessThan(
      markup.indexOf("Checking the app-server sequence"),
    );
    expect(markup.indexOf("Read chat terminal")).toBeLessThan(
      markup.indexOf("Applying the measured fix."),
    );
    expect(markup.match(/class="execution-trace is-live/g)).toHaveLength(1);
    expect(markup).toContain('src="/codex-mark.png"');
  });

  it("keeps steered user messages visible when completed work is collapsed", () => {
    const markup = render([{
      id: "user",
      kind: "user",
      title: "Start the task",
      turnId: "turn-1",
    }, {
      id: "command",
      kind: "command",
      title: "Ran command",
      command: "npm run check",
      turnId: "turn-1",
    }, {
      id: "steer",
      kind: "user",
      title: "Keep the layout compact",
      turnId: "turn-1",
    }, {
      id: "response",
      kind: "result",
      title: "Agent response",
      body: "Finished.",
      turnId: "turn-1",
    }]);

    expect(markup).toContain("Keep the layout compact");
    expect(markup).not.toContain("npm run check");
    expect(markup).toContain("Finished.");
  });

  it("keeps a final response before later same-turn entries with equal timestamps", () => {
    const markup = render([{
      id: "user",
      kind: "user",
      title: "Start the task",
      turnId: "turn-1",
      createdAt: 1_000,
    }, {
      id: "response",
      kind: "result",
      title: "Agent response",
      body: "First result.",
      turnId: "turn-1",
      createdAt: 2_000,
    }, {
      id: "command",
      kind: "command",
      title: "Ran command",
      command: "npm test",
      turnId: "turn-1",
      createdAt: 2_000,
    }, {
      id: "steer",
      kind: "user",
      title: "Now verify tests",
      turnId: "turn-1",
      createdAt: 2_000,
    }]);

    expect(markup.indexOf("First result.")).toBeLessThan(markup.indexOf("Now verify tests"));
  });

  it("does not render the edited-files summary card before a final response", () => {
    const markup = render([{
      id: "user",
      kind: "user",
      title: "Edit the app",
    }, {
      id: "change",
      kind: "change",
      title: "Editing 1 file",
      status: "active",
      files: [{ path: "src/App.tsx", additions: 2, deletions: 1 }],
    }], false, {
      ...idleRuntime,
      phase: "working",
      taskId: "task-1",
      turnStartedAt: Date.now() - 5_000,
    });

    expect(markup).toContain("Edited files");
    expect(markup).not.toContain("edited-files__heading");
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
      command: "\"powershell.exe\" -Command \"rg -n '[invalid' src\"",
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

  it("offers Fork on every user entry in a backend turn", () => {
    const markup = render([{
      id: "initial",
      kind: "user",
      title: "Start",
      turnId: "turn-1",
    }, {
      id: "steer",
      kind: "user",
      title: "Also check tests",
      turnId: "turn-1",
    }], false, idleRuntime, undefined, true);

    expect(markup.match(/title="Fork from here"/g)).toHaveLength(2);
  });

  it("never marks standalone historical entries as live", () => {
    const markup = render([{
      id: "historical-command",
      kind: "command",
      title: "Historical command",
      command: "npm test",
      status: "active",
    }], false, {
      ...idleRuntime,
      phase: "working",
      taskId: "task-1",
      turnStartedAt: Date.now() - 1_000,
    });

    expect(markup).toContain(">Ran command<");
    expect(markup).not.toContain("Running command for");
    expect(markup).not.toContain('class="lucide lucide-loader-circle spin"');
  });
});
