import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { ToolCallGroup } from "./ToolCallGroup";

const tool = (
  id: string,
  patch: Partial<TimelineEntry> = {},
): TimelineEntry => ({
  id,
  kind: "command",
  title: "node_repl · js",
  status: "success",
  ...patch,
});

describe("ToolCallGroup", () => {
  it("collapses repeated calls behind one Show calls disclosure", () => {
    const markup = renderToStaticMarkup(
      <ToolCallGroup
        entries={[tool("one"), tool("two"), tool("three")]}
        expandByDefault={false}
        index={0}
      >
        <span>Tool details</span>
      </ToolCallGroup>,
    );

    expect(markup).toContain(">node_repl · js<");
    expect(markup).toContain("Show 3 calls");
    expect(markup).toContain("Hide calls");
    expect(markup).not.toContain("<details open=\"\"");
  });

  it("keeps unresolved failures in the same group and reports them in the summary", () => {
    const markup = renderToStaticMarkup(
      <ToolCallGroup
        entries={[
          tool("one"),
          tool("two", { title: "Shell failed", status: "error" }),
          tool("three"),
        ]}
        expandByDefault={false}
        index={0}
      >
        <span>Tool details</span>
      </ToolCallGroup>,
    );

    expect(markup).toContain("tool-call-group is-error");
    expect(markup).toContain(">Used tools<");
    expect(markup).toContain("Show 3 calls · 1 failed");
  });

  it("presents a corrected shell call as recovered instead of leaving the group red", () => {
    const markup = renderToStaticMarkup(
      <ToolCallGroup
        entries={[
          tool("one", {
            title: "Command did not complete",
            command: "\"powershell.exe\" -Command \"rg -n '[invalid' src\"",
            status: "error",
          }),
          tool("two", {
            title: "Command completed",
            command: "\"powershell.exe\" -Command \"rg -n -F 'valid' src\"",
            status: "success",
          }),
        ]}
        expandByDefault={false}
        index={0}
      >
        <span>Tool details</span>
      </ToolCallGroup>,
    );

    expect(markup).toContain("tool-call-group is-recovered");
    expect(markup).not.toContain("tool-call-group is-error");
    expect(markup).toContain("Show 2 calls · 1 recovered");
  });
});
