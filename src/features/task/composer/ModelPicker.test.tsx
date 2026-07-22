import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentModelSummary } from "../../../core/models/agent";
import { ModelPicker } from "./ModelPicker";

const model: AgentModelSummary = {
  id: "gpt-test",
  model: "gpt-test",
  displayName: "GPT Test",
  description: "Test model",
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [],
  serviceTiers: [{ id: "priority", name: "Fast", description: "Faster responses" }],
};

const renderPicker = (fastMode: boolean) => renderToStaticMarkup(
  <ModelPicker
    models={[model]}
    selectedModel={model.model}
    selectedReasoningEffort={null}
    fastMode={fastMode}
    disabled={false}
    onModelChange={vi.fn()}
    onReasoningEffortChange={vi.fn()}
    onFastModeChange={vi.fn()}
  />,
);

describe("ModelPicker Fast control", () => {
  it("uses an icon-only control while retaining an accessible state label", () => {
    const off = renderPicker(false);
    const on = renderPicker(true);

    expect(off).toContain('aria-label="Fast mode off"');
    expect(on).toContain('aria-label="Fast mode on"');
    expect(on).toContain("fast-mode__glyph");
    expect(off).not.toContain(">Fast off<");
    expect(on).not.toContain(">Fast on<");
  });
});
