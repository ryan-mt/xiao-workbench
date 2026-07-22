import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { promptWithSelectedContext } from "../../../core/models/agent";
import { QueuedMessages } from "./QueuedMessages";

const followUps = [
  {
    id: "queued-1",
    prompt: "Check the sidebar spacing",
    attachments: [],
    createdAt: 1,
  },
  {
    id: "queued-2",
    prompt: "Then update the empty state",
    attachments: [{ name: "reference.png", path: "reference.png", kind: "image" as const }],
    createdAt: 2,
  },
];

describe("QueuedMessages", () => {
  it("keeps pending prompts in an editable tray above the composer", () => {
    const markup = renderToStaticMarkup(
      <QueuedMessages
        followUps={followUps}
        sendingFollowUpId={null}
        failedFollowUpId={null}
        canSteer
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        onSendNow={vi.fn(async () => undefined)}
      />,
    );

    expect(markup).toContain("Queued");
    expect(markup).toContain("Check the sidebar spacing");
    expect(markup).toContain("Then update the empty state");
    expect(markup).toContain("Edit");
    expect(markup).toContain("Delete");
    expect(markup).toContain("Send now");
  });

  it("renders nothing when the queue is empty", () => {
    expect(renderToStaticMarkup(
      <QueuedMessages
        followUps={[]}
        sendingFollowUpId={null}
        failedFollowUpId={null}
        canSteer={false}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        onSendNow={vi.fn(async () => undefined)}
      />,
    )).toBe("");
  });

  it("does not expose selected context in the queued message", () => {
    const markup = renderToStaticMarkup(
      <QueuedMessages
        followUps={[{
          id: "queued-selection",
          prompt: promptWithSelectedContext("thấy gì?", "Internal selected text"),
          attachments: [],
          createdAt: 3,
        }]}
        sendingFollowUpId={null}
        failedFollowUpId={null}
        canSteer={false}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        onSendNow={vi.fn(async () => undefined)}
      />,
    );

    expect(markup).toContain("thấy gì?");
    expect(markup).not.toContain("selected_text");
    expect(markup).not.toContain("Internal selected text");
  });
});
