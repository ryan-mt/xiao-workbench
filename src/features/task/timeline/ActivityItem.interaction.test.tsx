// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  promptWithSelectedContext,
  replaceVisiblePromptInSelectedContext,
  type TimelineEntry,
} from "../../../core/models/agent";
import { ActivityItem } from "./ActivityItem";

afterEach(cleanup);

describe("ActivityItem prompt editing", () => {
  it("preserves selected context when the visible prompt is edited", () => {
    const original = promptWithSelectedContext("Explain this", "const ready = false;");
    const onEditUserMessage = vi.fn();
    const entry: TimelineEntry = {
      id: "selected-context",
      kind: "user",
      title: original,
    };

    render(
      <ActivityItem
        entry={entry}
        index={0}
        showReasoningSummaries
        expandToolOutput={false}
        workspacePath="C:\\work\\xiao"
        onOpenResource={() => true}
        taskId="task-1"
        canFork
        onForkTask={() => undefined}
        onResolveApproval={async () => undefined}
        onReviewChanges={() => undefined}
        onEditUserMessage={onEditUserMessage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit prompt" }), {
      target: { value: "Explain why it is false" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use in composer" }));

    expect(onEditUserMessage).toHaveBeenCalledWith(
      replaceVisiblePromptInSelectedContext(original, "Explain why it is false"),
      [],
    );
  });
});
