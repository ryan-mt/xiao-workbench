import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusBar } from "./StatusBar";

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
        onOpenRuntime={() => undefined}
        onOpenChanges={() => undefined}
        onOpenContext={() => undefined}
      />,
    );

    expect(markup).toContain("1 active");
    expect(markup).toContain("class=\"lucide lucide-loader-circle spin\"");
  });
});
