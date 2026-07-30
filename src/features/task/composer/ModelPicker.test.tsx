// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentModelSummary, AgentRateLimitSnapshot } from "../../../core/models/agent";
import { ModelPicker, parseCodexProfileModels } from "./ModelPicker";

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

const grokModel: AgentModelSummary = {
  id: "grok-4.5",
  model: "grok-4.5",
  displayName: "Grok 4.5",
  description: "xAI reasoning model",
  isDefault: true,
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: [
    { reasoningEffort: "high", description: "Deep reasoning" },
  ],
  serviceTiers: [],
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

describe("ModelPicker multi-profile catalog", () => {
  afterEach(() => {
    cleanup();
  });

  it("lists profiles first, then the selected profile's models", () => {
    const onProfileModelSelect = vi.fn(() => true);
    render(
      createElement(ModelPicker, {
        models: [model],
        profiles: [
          {
            id: "default",
            displayName: "Default Codex",
            providerId: "openai",
            availability: "available",
            models: [model],
          },
          {
            id: "grok",
            displayName: "Grok 4.5 (xAI)",
            providerId: "xai",
            availability: "available",
            models: [grokModel],
          },
        ],
        selectedProfileId: "default",
        selectedModel: model.model,
        selectedReasoningEffort: null,
        fastMode: false,
        rateLimits: null,
        disabled: false,
        onModelChange: vi.fn(),
        onProfileModelSelect,
        onReasoningEffortChange: vi.fn(),
        onFastModeChange: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByLabelText("Choose model"));
    expect(screen.getByLabelText("Profiles")).toBeTruthy();
    expect(screen.getByText("Default Codex")).toBeTruthy();
    expect(screen.getByText("Grok 4.5 (xAI)")).toBeTruthy();
    expect(screen.queryByText("Grok 4.5")).toBeNull();

    fireEvent.click(screen.getByText("Grok 4.5 (xAI)"));
    const modelList = screen.getByLabelText("Models");
    expect(modelList).toBeTruthy();
    expect(modelList.textContent).toContain("Grok 4.5");
    expect(modelList.textContent).not.toContain("GPT Test");

    fireEvent.click(screen.getByRole("option", { name: "Grok 4.5" }));
    expect(onProfileModelSelect).toHaveBeenCalledWith({
      profileId: "grok",
      model: null,
    });
  });

  it("parses durable Codex profile model snapshots", () => {
    const models = parseCodexProfileModels([
      {
        id: "grok-4.5",
        model: "grok-4.5",
        displayName: "Grok 4.5",
        description: "xAI reasoning model",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "high", description: "Deep reasoning" },
        ],
        serviceTiers: [],
        contextWindow: 500_000,
      },
      { model: "" },
      null,
    ]);

    expect(models).toEqual([
      {
        id: "grok-4.5",
        model: "grok-4.5",
        displayName: "Grok 4.5",
        description: "xAI reasoning model",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "high", description: "Deep reasoning" },
        ],
        serviceTiers: [],
        contextWindow: 500_000,
      },
    ]);
  });
});
