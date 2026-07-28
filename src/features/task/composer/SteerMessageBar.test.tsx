import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { promptWithSelectedContext } from "../../../core/models/agent";
import { SteerMessageBar } from "./SteerMessageBar";

const followUps = [{
  id: "queued-1",
  prompt: "Check the sidebar spacing",
  attachments: [],
  createdAt: 1,
}, {
  id: "queued-2",
  prompt: "Then update the empty state",
  attachments: [{ name: "reference.png", path: "reference.png", kind: "image" as const }],
  createdAt: 2,
}];

const render = (items = followUps) => renderToStaticMarkup(
  <SteerMessageBar
    followUps={items}
    sendingFollowUpId={null}
    failedFollowUpId={null}
    canSteer
    onEdit={vi.fn()}
    onRemove={vi.fn()}
    onRetry={vi.fn()}
    onSendNow={vi.fn(async () => undefined)}
  />,
);

describe("SteerMessageBar", () => {
  it("shows the next prompt with direct steer, delete, and overflow actions", () => {
    const markup = render();
    expect(markup).toContain("Check the sidebar spacing");
    expect(markup).toContain(">Steer<");
    expect(markup).toContain("Delete queued message");
    expect(markup).toContain("More queued message actions");
    expect(markup).toContain("+1");
  });

  it("renders nothing when the queue is empty", () => {
    expect(render([])).toBe("");
  });

  it("does not expose selected context in the steer bar", () => {
    const markup = render([{
      id: "queued-selection",
      prompt: promptWithSelectedContext("What changed?", "Internal selected text"),
      attachments: [],
      createdAt: 3,
    }]);
    expect(markup).toContain("What changed?");
    expect(markup).not.toContain("selected_text");
    expect(markup).not.toContain("Internal selected text");
  });
});
