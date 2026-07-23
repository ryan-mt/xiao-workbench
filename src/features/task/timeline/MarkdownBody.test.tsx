import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  localMarkdownImagePath,
  MarkdownBody,
  markdownUrlTransform,
} from "./MarkdownBody";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("converts local Markdown images to Tauri asset URLs", () => {
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {
        convertFileSrc: (path: string) =>
          `http://asset.localhost/${path.replaceAll("\\", "/")}`,
      },
    });

    const markup = renderToStaticMarkup(
      <MarkdownBody content="![Todo audit](C:/Users/dev/AppData/Local/Temp/audit.png)" />,
    );

    expect(markup).toContain(
      'src="http://asset.localhost/C:/Users/dev/AppData/Local/Temp/audit.png"',
    );
    expect(markup).toContain('data-local-image="true"');
    expect(markup).not.toContain("markdown-image-fallback");
  });

  it("shows a readable fallback for local images in browser preview", () => {
    vi.stubGlobal("window", {});

    const markup = renderToStaticMarkup(
      <MarkdownBody content="![Todo audit](C:/Users/dev/AppData/Local/Temp/audit.png)" />,
    );

    expect(markup).toContain("markdown-image-fallback");
    expect(markup).toContain("Todo audit");
    expect(markup).toContain("Open Xiao desktop to view this local image");
    expect(markup).not.toContain("<img");
  });

  it("normalizes file URLs before handing them to the Tauri asset protocol", () => {
    expect(localMarkdownImagePath("file:///C:/Users/dev/My%20Images/audit.png"))
      .toBe("C:/Users/dev/My Images/audit.png");
    expect(localMarkdownImagePath("https://example.com/audit.png")).toBeNull();
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
