import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusBar, StatusPopover } from "./StatusBar";

describe("StatusBar", () => {
  it("spins the active-task indicator", () => {
    const markup = renderToStaticMarkup(
      <StatusBar
        runtimePhase="working"
        workspaceName="xiao"
        workspacePath="C:\\work\\xiao"
        branch="dev"
        model="gpt-test"
        reasoningEffort="high"
        contextPercent={12}
        sandboxMode="workspace-write"
        approvalPolicy="on-request"
        workspaceMode="local"
        workingTaskCount={1}
        runtimeError={null}
        onOpenRuntime={() => undefined}
        onOpenCapabilities={() => undefined}
        onOpenChanges={() => undefined}
        onOpenContext={() => undefined}
      />,
    );

    expect(markup).toContain("1 active");
    expect(markup).toContain("class=\"lucide lucide-loader-circle spin\"");
    expect(markup).toContain("aria-controls=\"status-popover\"");
    expect(markup).toContain("aria-expanded=\"false\"");
  });

  it("summarizes system state in the status popover", () => {
    const markup = renderToStaticMarkup(
      <StatusPopover
        runtimePhase="error"
        runtimeError="Runtime disconnected"
        workspaceName="xiao"
        workspacePath="C:\\work\\xiao"
        branch="dev"
        model="gpt-test"
        reasoningEffort="high"
        contextPercent={64}
        sandboxMode="danger-full-access"
        approvalPolicy="never"
        workspaceMode="managed-worktree"
        workingTaskCount={2}
        onOpenRuntime={() => undefined}
        onOpenCapabilities={() => undefined}
      />,
    );

    expect(markup).toContain("Needs attention");
    expect(markup).toContain("Runtime disconnected");
    expect(markup).toContain("Managed worktree");
    expect(markup).toContain("64% used");
    expect(markup).toContain("aria-valuenow=\"64\"");
    expect(markup).toContain("Full access");
    expect(markup).toContain("Never ask");
    expect(markup).toContain("Runtime logs");
    expect(markup).toContain("Tools");
  });
});
