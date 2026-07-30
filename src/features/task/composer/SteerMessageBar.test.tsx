// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
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

const renderBar = (items = followUps) => renderToStaticMarkup(
  <SteerMessageBar
    followUps={items}
    sendingFollowUpId={null}
    failedFollowUpId={null}
    canSteer
    interactiveRequestOpen={false}
    onEdit={vi.fn()}
    onRemove={vi.fn()}
    onRetry={vi.fn()}
    onSendNow={vi.fn(async () => undefined)}
  />,
);

describe("SteerMessageBar", () => {
  it("shows every queued prompt with direct actions instead of hiding extras", () => {
    const markup = renderBar();
    expect(markup).toContain("Check the sidebar spacing");
    expect(markup).toContain("Then update the empty state");
    expect(markup).toContain(">Steer<");
    expect(markup).toContain("Delete queued message 1");
    expect(markup).toContain("Delete queued message 2");
    expect(markup).toContain("Edit queued message 1");
    expect(markup).toContain("Edit queued message 2");
    expect(markup).toContain("2</small>");
    expect(markup).not.toContain("+1");
    expect(markup).not.toContain("More queued message actions");
  });

  it("renders nothing when the queue is empty", () => {
    expect(renderBar([])).toBe("");
  });

  it("disables steer while an interactive request is open", () => {
    const markup = renderToStaticMarkup(
      <SteerMessageBar
        followUps={followUps}
        sendingFollowUpId={null}
        failedFollowUpId={null}
        canSteer
        interactiveRequestOpen
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        onSendNow={vi.fn(async () => undefined)}
      />,
    );
    expect(markup).toMatch(/class="steer-message__send"[^>]*disabled/);
  });

  it("does not expose selected context in the steer bar", () => {
    const markup = renderBar([{
      id: "queued-selection",
      prompt: promptWithSelectedContext("What changed?", "Internal selected text"),
      attachments: [],
      createdAt: 3,
    }]);
    expect(markup).toContain("What changed?");
    expect(markup).not.toContain("selected_text");
    expect(markup).not.toContain("Internal selected text");
  });

  it("lets the operator edit a later queued message directly", () => {
    const onEdit = vi.fn();
    render(
      <SteerMessageBar
        followUps={followUps}
        sendingFollowUpId={null}
        failedFollowUpId={null}
        canSteer
        interactiveRequestOpen={false}
        onEdit={onEdit}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        onSendNow={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit queued message 2" }));
    fireEvent.change(screen.getByLabelText("Edit queued message 2"), {
      target: { value: "Rewrite the empty state copy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onEdit).toHaveBeenCalledWith("queued-2", "Rewrite the empty state copy");
  });
});
