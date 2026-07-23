import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentModelSummary, AgentRateLimitSnapshot } from "../../../core/models/agent";
import { ModelPicker } from "./ModelPicker";

const model: AgentModelSummary = {
  id: "gpt-test",
  model: "gpt-test",
  displayName: "GPT Test",
  description: "Test model",
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced reasoning" },
    { reasoningEffort: "ultra", description: "Maximum reasoning" },
  ],
  serviceTiers: [{ id: "priority", name: "Fast", description: "Faster responses" }],
};

const renderPicker = (
  fastMode: boolean,
  rateLimits: AgentRateLimitSnapshot | null = null,
) => renderToStaticMarkup(
  <ModelPicker
    models={[model]}
    selectedModel={model.model}
    selectedReasoningEffort={null}
    fastMode={fastMode}
    rateLimits={rateLimits}
    disabled={false}
    onModelChange={vi.fn()}
    onReasoningEffortChange={vi.fn()}
    onFastModeChange={vi.fn()}
  />,
);

describe("ModelPicker Fast control", () => {
  it("keeps Fast mode visibly and accessibly identifiable", () => {
    const off = renderPicker(false);
    const on = renderPicker(true);

    expect(off).toContain('aria-label="Fast mode off"');
    expect(on).toContain('aria-label="Fast mode on"');
    expect(off).toContain(">Fast<");
    expect(on).toContain(">Fast<");
    expect(on).toContain("fast-mode__trigger is-on");
  });

  it("labels Ultra reasoning explicitly", () => {
    const markup = renderToStaticMarkup(
      <ModelPicker
        models={[model]}
        selectedModel={model.model}
        selectedReasoningEffort="ultra"
        fastMode={false}
        rateLimits={null}
        disabled={false}
        onModelChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onFastModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain("reasoning-picker__trigger is-ultra");
    expect(markup).toContain(">Ultra<");
  });

  it("does not present a stale unsupported effort as active", () => {
    const markup = renderToStaticMarkup(
      <ModelPicker
        models={[{ ...model, supportedReasoningEfforts: model.supportedReasoningEfforts.slice(0, 1) }]}
        selectedModel={model.model}
        selectedReasoningEffort="ultra"
        fastMode={false}
        rateLimits={null}
        disabled={false}
        onModelChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onFastModeChange={vi.fn()}
      />,
    );

    expect(markup).not.toContain("reasoning-picker__trigger is-ultra");
    expect(markup).toContain(">Medium<");
  });

  it("places the compact weekly usage chip directly after Fast mode", () => {
    const markup = renderPicker(false, {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: null },
      secondary: null,
    });

    expect(markup.indexOf("fast-mode")).toBeLessThan(markup.indexOf("weekly-usage-chip"));
    expect(markup).toContain("<strong>83%</strong><span>left</span>");
  });
});
