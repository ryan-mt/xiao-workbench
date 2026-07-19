import { describe, expect, it } from "vitest";

import { markdownStreamBlocks, projectStreamingMarkdown } from "./markdownStream";

describe("streaming markdown projection", () => {
  it("repairs only the unfinished tail", () => {
    expect(markdownStreamBlocks("hello **world", true)).toEqual([
      { raw: "hello **world", source: "hello **world**", mode: "live" },
    ]);
    expect(markdownStreamBlocks("see [docs](https://example.com/gu", true)).toEqual([
      { raw: "see [docs](https://example.com/gu", source: "see docs", mode: "live" },
    ]);
  });

  it("freezes completed blocks and leaves only the tail live", () => {
    expect(markdownStreamBlocks("# Plan\n\nFinished paragraph.\n\n- live item", true)).toEqual([
      {
        raw: "# Plan\n\nFinished paragraph.\n\n",
        source: "# Plan\n\nFinished paragraph.\n\n",
        mode: "stable",
      },
      { raw: "- live item", source: "- live item", mode: "live" },
    ]);
  });

  it("renders unfinished fenced code separately from stable prose", () => {
    expect(markdownStreamBlocks("before\n\n```ts title=example\nconst x = 1", true)).toEqual([
      { raw: "before\n\n", source: "before\n\n", mode: "stable" },
      {
        raw: "```ts title=example\nconst x = 1",
        source: "const x = 1",
        mode: "code",
        language: "ts",
        complete: false,
      },
    ]);
  });

  it("settles a fence once its closing marker arrives across deltas", () => {
    const open = projectStreamingMarkdown(undefined, "```ts\nconst x = 1\n", true);
    const one = projectStreamingMarkdown(open, `${open.text}\``, true);
    const two = projectStreamingMarkdown(one, `${one.text}\``, true);
    const closed = projectStreamingMarkdown(two, `${two.text}\``, true);

    expect(closed.blocks).toEqual([
      {
        raw: "```ts\nconst x = 1\n```",
        source: "const x = 1",
        mode: "code",
        language: "ts",
        complete: true,
      },
    ]);
  });

  it("reprojects fence metadata until the opening line is complete", () => {
    const partial = projectStreamingMarkdown(undefined, "```t", true);
    const language = projectStreamingMarkdown(partial, "```ts", true);
    const opened = projectStreamingMarkdown(language, "```ts\nconst x = 1", true);

    expect(opened.blocks).toEqual([
      {
        raw: "```ts\nconst x = 1",
        source: "const x = 1",
        mode: "code",
        language: "ts",
        complete: false,
      },
    ]);
  });

  it("appends open code directly without reprojecting stable blocks", () => {
    const previous = projectStreamingMarkdown(undefined, "# Plan\n\n```ts\nconst one = 1\n", true);
    const next = projectStreamingMarkdown(previous, `${previous.text}const two = 2\n`, true);

    expect(next.blocks[0]).toBe(previous.blocks[0]);
    expect(next.blocks.at(-1)?.source).toBe("const one = 1\nconst two = 2\n");
  });

  it("reuses settled prose groups and only re-lexes the tail", () => {
    const text = Array.from({ length: 25 }, (_, index) => `Paragraph ${index}.`).join("\n\n");
    const previous = projectStreamingMarkdown(undefined, text, true);
    const next = projectStreamingMarkdown(previous, `${text}\n\nNew tail`, true);

    expect(previous.blocks.length).toBeGreaterThan(2);
    expect(next.blocks[0]).toBe(previous.blocks[0]);
    expect(next.blocks.map((block) => block.raw).join("")).toBe(`${text}\n\nNew tail`);
  });

  it("reconstructs growing lists, tables, quotes, and fences exactly", () => {
    const text = [
      "# Plan",
      "",
      "- one",
      "- two",
      "",
      "> quoted",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```ts",
      "const x = 1",
      "```",
      "",
      "Done.",
    ].join("\n");
    let projection = projectStreamingMarkdown(undefined, "", true);
    for (let index = 1; index <= text.length; index += 1) {
      const prefix = text.slice(0, index);
      projection = projectStreamingMarkdown(projection, prefix, true);
      expect(projection.blocks.map((block) => block.raw).join("")).toBe(prefix);
    }
  });

  it("keeps reference-style links in one parsing scope", () => {
    expect(markdownStreamBlocks("[docs][1]\n\n[1]: https://example.com", true)).toEqual([
      {
        raw: "[docs][1]\n\n[1]: https://example.com",
        source: "[docs][1]\n\n[1]: https://example.com",
        mode: "live",
      },
    ]);
  });

  it("returns one authoritative block when streaming finishes", () => {
    const text = "# Done\n\nFinal answer";
    expect(markdownStreamBlocks(text, false)).toEqual([
      { raw: text, source: text, mode: "stable" },
    ]);
  });
});
