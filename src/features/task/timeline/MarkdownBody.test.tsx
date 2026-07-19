import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownBody, markdownUrlTransform } from "./MarkdownBody";

describe("MarkdownBody resource links", () => {
  it("preserves Windows file links only when Xiao can route them internally", () => {
    const path = "C:/Users/dev/project/index.html";
    expect(markdownUrlTransform(path, true)).toBe(path);
    expect(markdownUrlTransform(path, false)).toBe("");

    const markup = renderToStaticMarkup(
      <MarkdownBody
        content={`Open [index.html](${path})`}
        onOpenResource={() => true}
      />,
    );
    expect(markup).toContain(`href="${path}"`);
  });

  it("continues to reject executable URL schemes", () => {
    expect(markdownUrlTransform("javascript:alert(1)", true)).toBe("");
  });
});
