import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AttentionItem } from "../../core/models/xiao";
import { AttentionCenter, retryAttentionWithStableFocus } from "./AttentionCenter";
import type { AttentionHydrationStatus } from "./useAttentionCenter";

const item = (patch: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "run:run-a",
  projectPath: "C:\\projects\\xiao",
  projectName: "Xiao",
  taskId: "task-a",
  taskTitle: "Ship outcome supervision",
  taskStage: "in_progress",
  taskStageVersion: 2,
  runId: "run-a",
  kind: "failure",
  priority: 1,
  title: "Run failed",
  safeSummary: "Review workspace changes",
  sourceOccurrenceKey: "run:run-a:failed",
  surface: "observatory",
  createdAt: 1_700_000_000_000,
  resolvedAt: null,
  acknowledgedAt: null,
  ...patch,
});

const renderCenter = (
  items: AttentionItem[],
  hydrationStatus: AttentionHydrationStatus = "live",
) => renderToStaticMarkup(
  <AttentionCenter
    items={items}
    hydrationStatus={hydrationStatus}
    onRetry={() => undefined}
    onOpenItem={() => undefined}
    onAcknowledge={() => undefined}
    onClose={() => undefined}
  />,
);

describe("AttentionCenter", () => {
  it("renders a flat cross-Project list with safe summaries, run context, and actions", () => {
    const markup = renderCenter([
      item(),
      item({
        id: "pending:pending-a",
        runId: null,
        kind: "decision",
        title: "Question from Xiao",
      }),
    ]);

    expect(markup.match(/<ol/g)).toHaveLength(1);
    expect(markup.match(/<li/g)).toHaveLength(2);
    expect(markup).toContain("<strong>2</strong><span>items</span>");
    expect(markup).toContain("Run failed");
    expect(markup).toContain("Question from Xiao");
    expect(markup).toContain("Review workspace changes");
    expect(markup).toContain("Xiao");
    expect(markup).toContain("Run run-a");
    expect(markup).toContain("<time dateTime=");
    expect(markup).toContain("Open task");
    expect(markup).toContain("Acknowledge");
  });

  it("renders live empty without claiming exhaustive run history", () => {
    const markup = renderCenter([], "live");

    expect(markup).toContain("Nothing needs attention");
    expect(markup).toContain("recent run issues");
    expect(markup).toContain("<strong>0</strong><span>items</span>");
    expect(markup).not.toContain("Workspace attention items");
    expect(markup.toLowerCase()).not.toContain("history");
  });

  it("renders loading instead of live empty without an authoritative count", () => {
    const markup = renderCenter([], "loading");

    expect(markup).toContain("Loading attention");
    expect(markup).toContain("Checking active and recent runs");
    expect(markup).toContain('aria-label="0 available, loading attention data"');
    expect(markup).toContain("<strong>0</strong><span>available</span>");
    expect(markup).not.toContain("<strong>0</strong><span>items</span>");
    expect(markup).not.toContain("Nothing needs attention");
  });

  it("renders partial empty with Retry and a non-authoritative count", () => {
    const markup = renderCenter([], "partial");

    expect(markup).toContain("Some attention data is unavailable");
    expect(markup).toContain("Some attention data could not load");
    expect(markup).not.toContain("run data");
    expect(markup).toContain('aria-label="0 available, partial attention data"');
    expect(markup).toContain("<strong>0</strong><span>available</span>");
    expect(markup).toContain('<button class="attention-center__retry" type="button">Retry</button>');
    expect(markup).not.toContain("Nothing needs attention");
  });

  it.each([
    ["loading", "Checking every Project for attention items"],
    ["partial", "Some attention data is unavailable."],
    ["stale", "Attention data is stale."],
  ] as const)("retains populated items with a restrained %s notice", (status, notice) => {
    const markup = renderCenter([item()], status);

    expect(markup).toContain("Workspace attention items");
    expect(markup).toContain("Run failed");
    expect(markup).toContain(notice);
    expect(markup).toContain("<strong>1</strong><span>available</span>");
    expect(markup).toContain(`aria-label="1 available, ${status} attention data"`);
    if (status === "partial" || status === "stale") expect(markup).toContain("Retry");
  });

  it("bounds and escapes the privacy-safe summary", () => {
    const unsafe = `<img src=x onerror=alert(1)> ${"long detail ".repeat(30)}`;
    const markup = renderCenter([item({ safeSummary: unsafe })]);
    const detail = unsafe.replace(/\s+/g, " ").trim();
    const bounded = `${detail.slice(0, 159).trimEnd()}…`;

    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain(bounded.replace("<", "&lt;").replace(">", "&gt;"));
    expect(bounded.length).toBeLessThanOrEqual(160);
  });

  it.each([
    ["stale", "Attention data is stale", "Reconnect to the primary host"],
    ["unavailable", "Attention Center unavailable", "could not provide a cross-Project view"],
  ] as const)("renders an explicit %s empty state with retry", (status, heading, detail) => {
    const markup = renderCenter([], status);

    expect(markup).toContain(heading);
    expect(markup).toContain(detail);
    expect(markup).toContain("<strong>0</strong><span>available</span>");
    expect(markup).toContain(">Retry</button>");
    expect(markup).not.toContain("Nothing needs attention");
  });

  it("focuses the stable heading synchronously before retrying", () => {
    const calls: string[] = [];

    retryAttentionWithStableFocus(
      { focus: () => { calls.push("focus"); } },
      () => { calls.push("retry"); },
    );

    expect(calls).toEqual(["focus", "retry"]);
  });

  it("marks the mount-focused heading without adding it to tab order", () => {
    const markup = renderCenter([]);

    expect(markup).toContain('id="attention-heading" tabindex="-1"');
    expect(markup).toContain('aria-labelledby="attention-heading"');
  });

  it("provides accessible open, acknowledge, and close labels", () => {
    const markup = renderCenter([item()]);

    expect(markup).toContain('aria-label="Close attention center"');
    expect(markup).toContain('aria-label="Open task: Review workspace changes"');
    expect(markup).toContain('aria-label="Acknowledge: Review workspace changes"');
    expect(markup).toContain('aria-label="Workspace attention items"');
  });
});
