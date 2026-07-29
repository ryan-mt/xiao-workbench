// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MessageImage } from "./MessageImage";

afterEach(cleanup);

describe("MessageImage", () => {
  it("closes the lightbox and shows a fallback when the preview cannot load", () => {
    render(<MessageImage source="https://example.com/image.png" name="Preview" />);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const dialog = screen.getByRole("dialog", { name: "Preview" });
    fireEvent.error(within(dialog).getByRole("img", { name: "Preview" }));

    expect(screen.queryByRole("dialog", { name: "Preview" })).toBeNull();
    expect(screen.getByRole("img", { name: "Preview: image unavailable" })).toBeTruthy();
  });
});
