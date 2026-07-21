import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { ExecutionGroup } from "./ExecutionGroup";

const command = (id: string, status: TimelineEntry["status"]): TimelineEntry => ({
  id,
  kind: "command",
  title: id,
  status,
});

const renderGroup = (entries: TimelineEntry[], expandByDefault = false) => renderToStaticMarkup(
  <ExecutionGroup entries={entries} index={0} expandByDefault={expandByDefault}>
    <span>Commands</span>
  </ExecutionGroup>,
);

describe("ExecutionGroup status", () => {
  it("does not force an active group open when tool output expansion is disabled", () => {
    const markup = renderGroup([command("running", "active")]);

    expect(markup).not.toContain("<details open=\"\"");
  });

  it("opens the group when tool output expansion is enabled", () => {
    const markup = renderGroup([command("running", "active")], true);

    expect(markup).toContain("<details open=\"\"");
  });

  it("keeps a recovering execution active after an earlier command error", () => {
    const markup = renderGroup([
      command("failed", "error"),
      command("recovery", "active"),
    ]);

    expect(markup).toContain(">Executing<");
    expect(markup).toContain("is-active");
    expect(markup).not.toContain("is-error");
    expect(markup).not.toContain("needs attention");
  });

  it("describes a settled command failure without implying pending user action", () => {
    const markup = renderGroup([command("failed", "error")]);

    expect(markup).toContain(">Executed with errors<");
    expect(markup).toContain("is-error");
    expect(markup).not.toContain("needs attention");
  });

  it("does not keep a group red after the same command succeeds on retry", () => {
    const markup = renderGroup([
      { ...command("failed", "error"), command: "npm run check" },
      { ...command("passed", "success"), command: "npm run check" },
    ]);

    expect(markup).toContain(">Executed<");
    expect(markup).toContain("1 retry");
    expect(markup).not.toContain("is-error");
  });

  it("presents sandbox failures as an environment block instead of a product error", () => {
    const markup = renderGroup([{
      ...command("blocked", "error"),
      command: "npm test",
      body: "Error: spawn EPERM",
    }]);

    expect(markup).toContain(">Environment blocked<");
    expect(markup).toContain("is-warning");
    expect(markup).not.toContain("is-error");
  });
});
