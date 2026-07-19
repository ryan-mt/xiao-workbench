import { lexer, type Tokens } from "marked";
import remend from "remend";

export type MarkdownStreamBlock = {
  raw: string;
  source: string;
  mode: "stable" | "live" | "code";
  language?: string;
  complete?: boolean;
};

export type MarkdownStreamProjection = {
  text: string;
  blocks: MarkdownStreamBlock[];
};

const hasReferenceDefinitions = (text: string) =>
  text.includes("]:") && /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:\S+|\r?\n[ \t]+\S+)/m.test(text);

const fenceLanguage = (value: string | undefined) =>
  value?.trim().split(/\s+/, 1)[0]?.toLowerCase() || undefined;

const openFenceBody = (raw: string) => {
  const newline = raw.indexOf("\n");
  return newline < 0 ? "" : raw.slice(newline + 1);
};

const fenceIsOpen = (raw: string) => {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match?.[1]) return false;
  const marker = match[1];
  const lastLine = raw.trimEnd().split("\n").at(-1)?.trim() ?? "";
  return !new RegExp(`^[\\t ]{0,3}${marker[0]}{${marker.length},}[\\t ]*$`).test(lastLine);
};

const appendedTextClosesFence = (raw: string, suffix: string) => {
  const marker = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1];
  if (!marker) return suffix.includes("```") || suffix.includes("~~~");
  return `${raw.slice(-(marker.length - 1))}${suffix}`.includes(marker);
};

const repairIncompleteMarkdown = (text: string) => {
  try {
    return remend(text, { linkMode: "text-only" });
  } catch {
    return text;
  }
};

const stableGroupBlockLimit = 8;
const stableGroupCharacterLimit = 4_096;

// Keep settled React roots coarse without letting a growing tail invalidate the
// whole answer. Only the final partial group can change as new blocks arrive.
const groupStableBlocks = (blocks: MarkdownStreamBlock[]) => {
  const grouped: MarkdownStreamBlock[] = [];
  let groupSize = 0;

  for (const block of blocks) {
    const previous = grouped.at(-1);
    if (
      block.mode === "stable" &&
      previous?.mode === "stable" &&
      groupSize < stableGroupBlockLimit &&
      previous.source.length + block.source.length <= stableGroupCharacterLimit
    ) {
      grouped[grouped.length - 1] = {
        ...previous,
        raw: previous.raw + block.raw,
        source: previous.source + block.source,
      };
      groupSize += 1;
      continue;
    }
    grouped.push(block);
    groupSize = block.mode === "stable" ? 1 : 0;
  }

  return grouped;
};

const finalizeStreamingBlocks = (text: string, blocks: MarkdownStreamBlock[]) => {
  const grouped = groupStableBlocks(blocks);
  // Some partial constructs make Marked normalize trailing whitespace. Never
  // use normalized raw text as an offset into the provider's original stream.
  if (grouped.map((block) => block.raw).join("") === text) return grouped;
  return [{ raw: text, source: repairIncompleteMarkdown(text), mode: "live" } as MarkdownStreamBlock];
};

export const markdownStreamBlocks = (text: string, streaming: boolean): MarkdownStreamBlock[] => {
  if (!streaming) return [{ raw: text, source: text, mode: "stable" }];
  if (hasReferenceDefinitions(text)) {
    return [{ raw: text, source: repairIncompleteMarkdown(text), mode: "live" }];
  }

  const tokens = lexer(text);
  let tailIndex = tokens.length - 1;
  while (tailIndex >= 0 && tokens[tailIndex]?.type === "space") tailIndex -= 1;
  if (tailIndex < 0) {
    return [{ raw: text, source: repairIncompleteMarkdown(text), mode: "live" }];
  }
  const tail = tokens[tailIndex];
  if (!tail) return [{ raw: text, source: repairIncompleteMarkdown(text), mode: "live" }];

  const blocks: MarkdownStreamBlock[] = [];
  for (let index = 0; index < tailIndex; index += 1) {
    const token = tokens[index];
    if (!token || token.type === "space") continue;
    let raw = token.raw;
    while (tokens[index + 1]?.type === "space" && index + 1 < tailIndex) {
      raw += tokens[index + 1]!.raw;
      index += 1;
    }
    if (token.type === "code") {
      const code = token as Tokens.Code;
      blocks.push({
        raw,
        source: code.text,
        mode: "code",
        language: fenceLanguage(code.lang),
        complete: true,
      });
      continue;
    }
    blocks.push({ raw, source: raw, mode: "stable" });
  }

  const raw = tokens.slice(tailIndex).map((token) => token.raw).join("");
  if (tail.type !== "code") {
    return finalizeStreamingBlocks(text, [
      ...blocks,
      { raw, source: repairIncompleteMarkdown(raw), mode: "live" },
    ]);
  }

  const code = tail as Tokens.Code;
  if (!fenceIsOpen(code.raw)) {
    return finalizeStreamingBlocks(text, [
      ...blocks,
      {
        raw,
        source: code.text,
        mode: "code",
        language: fenceLanguage(code.lang),
        complete: true,
      },
    ]);
  }
  return finalizeStreamingBlocks(text, [
    ...blocks,
    {
      raw,
      source: openFenceBody(code.raw),
      mode: "code",
      language: fenceLanguage(code.lang),
      complete: false,
    },
  ]);
};

export const projectStreamingMarkdown = (
  previous: MarkdownStreamProjection | undefined,
  text: string,
  streaming: boolean,
): MarkdownStreamProjection => {
  if (!streaming || !previous || !text.startsWith(previous.text)) {
    return { text, blocks: markdownStreamBlocks(text, streaming) };
  }

  const tail = previous.blocks.at(-1);
  const suffix = text.slice(previous.text.length);
  if (!suffix) return previous;
  if (
    tail?.mode === "code" &&
    !tail.complete &&
    tail.raw.includes("\n") &&
    !appendedTextClosesFence(tail.raw, suffix)
  ) {
    return {
      text,
      blocks: [
        ...previous.blocks.slice(0, -1),
        { ...tail, raw: tail.raw + suffix, source: tail.source + suffix },
      ],
    };
  }

  if (hasReferenceDefinitions(text) || previous.blocks.length <= 2) {
    return { text, blocks: markdownStreamBlocks(text, streaming) };
  }

  // Appended Markdown can retroactively alter the last block (lists, tables,
  // fences) or the one before it (Setext headings), so keep the older groups
  // by identity and re-lex only the final two groups plus the new suffix.
  const settled = previous.blocks.slice(0, -2);
  const settledLength = settled.reduce((length, block) => length + block.raw.length, 0);
  if (settledLength <= 0 || !text.startsWith(previous.text.slice(0, settledLength))) {
    return { text, blocks: markdownStreamBlocks(text, streaming) };
  }

  const blocks = [
    ...settled,
    ...markdownStreamBlocks(text.slice(settledLength), streaming),
  ];
  return {
    text,
    blocks: blocks.map((block) => block.raw).join("") === text
      ? blocks
      : markdownStreamBlocks(text, streaming),
  };
};
