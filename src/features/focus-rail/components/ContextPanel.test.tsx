import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentModelSummary, TimelineEntry } from "../../../core/models/agent";
import { ContextPanel } from "./ContextPanel";

const model: AgentModelSummary = {
  id: "gpt-5",
  model: "gpt-5",
  displayName: "GPT-5",
  description: "Default model",
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [],
  serviceTiers: [],
  contextWindow: 100_000,
};

const timeline: TimelineEntry[] = Array.from({ length: 20 }, (_, index) => ({
  id: `event-${index}`,
  kind: index % 3 === 0 ? "user" : index % 3 === 1 ? "command" : "result",
  title: `Event ${index}`,
  body: `Payload ${index}`,
  createdAt: 1_700_000_000_000 + index,
}));

describe("ContextPanel", () => {
  it("keeps context details and only renders the latest message batch", () => {
    const markup = renderToStaticMarkup(
      <ContextPanel
        taskTitle="Inspect context"
        taskCreatedAt={1_700_000_000_000}
        timeline={timeline}
        threadId="thread-123456789"
        models={[model]}
        selectedModel="gpt-5"
        usage={{
          modelContextWindow: 100_000,
          last: {
            totalTokens: 56_000,
            inputTokens: 42_000,
            cachedInputTokens: 12_000,
            outputTokens: 14_000,
            reasoningOutputTokens: 6_000,
          },
          total: {
            totalTokens: 100_000,
            inputTokens: 70_000,
            cachedInputTokens: 20_000,
            outputTokens: 30_000,
            reasoningOutputTokens: 10_000,
          },
        }}
      />,
    );

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="50"');
    expect(markup).toContain("56,000</strong> active tokens");
    expect(markup).toContain("Session token flow");
    expect(markup).toContain("Reasoning");
    expect(markup).toContain("Raw messages");
    expect(markup).not.toContain('title="event-0"');
    expect(markup).not.toContain('title="event-1"');
    expect(markup).toContain('title="event-2"');
    expect(markup).toContain('title="event-19"');
    expect(markup).toContain("Show 2 more");
  });
});
