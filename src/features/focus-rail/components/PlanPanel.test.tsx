import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentRuntimeState } from "../../../core/models/agent";
import { PlanPanel } from "./PlanPanel";

const runtime: AgentRuntimeState = {
  phase: "working",
  taskId: "task",
  threadId: "thread",
  turnId: "turn",
  turnStartedAt: 1,
  error: null,
  eventsSeen: 1,
};

describe("PlanPanel", () => {
  it("renders a quiet checklist with one pulsing in-progress marker", () => {
    const markup = renderToStaticMarkup(
      <PlanPanel
        runtime={runtime}
        plan={{
          explanation: null,
          steps: [
            { step: "Done", status: "completed" },
            { step: "Working", status: "inProgress" },
            { step: "Later", status: "pending" },
          ],
        }}
      />,
    );

    expect(markup).toContain("1 of 3 complete");
    expect(markup.match(/plan-list__check/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="In progress: Working"');
    expect(markup).toContain("lucide-check");
    expect(markup).not.toContain("lucide-loader-circle");
    expect(markup).not.toContain("lucide-circle-dashed");
  });
});
