import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AttentionHydrationStatus } from "../agent/hooks/useAgentRuntime";
import type { AttentionItem } from "./attentionProjection";
import { AttentionCenter, retryAttentionWithStableFocus } from "./AttentionCenter";

const item = (patch: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "run:run-a",
  taskId: "task-a",
  runId: "run-a",
  kind: "failure",
  title: "Run failed",
  detail: "Review workspace changes",
  timestamp: 1_700_000_000_000,
  ...patch,
});

const renderCenter = (
  items: AttentionItem[],
  hydrationStatus: AttentionHydrationStatus = "ready",
) => renderToStaticMarkup(
  <AttentionCenter
    items={items}
    hydrationStatus={hydrationStatus}
    onRetry={() => undefined}
    onOpenTask={() => undefined}
    onClose={() => undefined}
  />,
);

describe("AttentionCenter", () => {
  it("renders a flat populated list with reasons, details, times, and actions", () => {
    const markup = renderCenter([
      item(),
      item({
        id: "pending:pending-a",
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
    expect(markup).toContain("<time dateTime=");
    expect(markup).toContain("Open task");
  });

  it("renders ready empty without claiming exhaustive run history", () => {
    const markup = renderCenter([], "ready");

    expect(markup).toContain("Nothing needs attention");
    expect(markup).toContain("recent run issues");
    expect(markup).toContain("<strong>0</strong><span>items</span>");
    expect(markup).not.toContain("Workspace attention items");
    expect(markup.toLowerCase()).not.toContain("history");
  });

  it("renders loading instead of ready empty without an authoritative count", () => {
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
    ["loading", "Checking for more attention items…"],
    ["partial", "Some attention data is unavailable."],
  ] as const)("retains populated items with a restrained %s notice", (status, notice) => {
    const markup = renderCenter([item()], status);

    expect(markup).toContain("Workspace attention items");
    expect(markup).toContain("Run failed");
    expect(markup).toContain(notice);
    expect(markup).toContain(`<strong>1</strong><span>available</span>`);
    expect(markup).toContain(`aria-label="1 available, ${status} attention data"`);
    if (status === "partial") expect(markup).toContain("Retry");
  });

  it("bounds and escapes plain-text detail", () => {
    const unsafe = `<img src=x onerror=alert(1)> ${"long detail ".repeat(30)}`;
    const markup = renderCenter([item({ detail: unsafe })]);
    const detail = unsafe.replace(/\s+/g, " ").trim();
    const bounded = `${detail.slice(0, 159).trimEnd()}…`;

    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain(bounded.replace("<", "&lt;").replace(">", "&gt;"));
    expect(bounded.length).toBeLessThanOrEqual(160);
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

  it("provides accessible open and close labels", () => {
    const markup = renderCenter([item()]);

    expect(markup).toContain('aria-label="Close attention center"');
    expect(markup).toContain('aria-label="Open task: Review workspace changes"');
    expect(markup).toContain('aria-label="Workspace attention items"');
  });
});
