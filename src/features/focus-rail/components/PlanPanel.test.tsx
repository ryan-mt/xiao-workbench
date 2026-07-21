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
  it("spins only the in-progress step indicator", () => {
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

    expect(markup.match(/is-spinning/g)).toHaveLength(1);
    expect(markup).toContain("lucide-loader-circle");
    expect(markup).toContain("lucide-circle-dashed");
  });
});
