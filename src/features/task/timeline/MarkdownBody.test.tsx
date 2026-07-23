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
    expect(markup).toContain('href="#"');
    expect(markup).not.toContain(`href="${path}"`);
    expect(markup).not.toContain('target="_blank"');
  });

  it("preserves UNC file URLs for internal routing", () => {
    const path = "file://server/share/project/src/main.ts";
    expect(markdownUrlTransform(path, true)).toBe(path);
    expect(markdownUrlTransform(path, false)).toBe("");

    const markup = renderToStaticMarkup(
      <MarkdownBody
        content={`Open [main.ts](${path})`}
        onOpenResource={() => true}
      />,
    );
    expect(markup).toContain('href="#"');
    expect(markup).not.toContain(`href="${path}"`);
    expect(markup).not.toContain('target="_blank"');
  });

  it("continues to reject executable URL schemes", () => {
    expect(markdownUrlTransform("javascript:alert(1)", true)).toBe("");
  });

  it("renders an incomplete streaming fence as a code card", () => {
    const markup = renderToStaticMarkup(
      <MarkdownBody
        content={"Stable paragraph.\n\n```ts\nconst answer = 42"}
        streaming
      />,
    );

    expect(markup).toContain("Stable paragraph.");
    expect(markup).toContain('class="markdown-code"');
    expect(markup).toContain('data-language="typescript"');
    expect(markup).toContain("const answer = 42");
    expect(markup).not.toContain("```ts");
  });

  it("repairs incomplete emphasis while streaming", () => {
    const markup = renderToStaticMarkup(<MarkdownBody content="Streaming **now" streaming />);

    expect(markup).toContain("<strong>now</strong>");
  });

  it("keeps fenced-code actions minimal without removing line wrapping", () => {
    const markup = renderToStaticMarkup(
      <MarkdownBody content={"```ts\nconst answer = 42;\n```"} />,
    );

    expect(markup).toContain('class="markdown-code__actions"');
    expect(markup).toContain('aria-label="Copy to clipboard"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain(">Wrap</button>");
    expect(markup).not.toContain("lines</small>");
  });

  it("falls back to plain text for responses too large to parse safely", () => {
    const markup = renderToStaticMarkup(<MarkdownBody content={"a".repeat(200_001)} />);

    expect(markup).toContain("markdown-body--huge");
    expect(markup).toContain("Large response · shown as plain text");
  });
});
