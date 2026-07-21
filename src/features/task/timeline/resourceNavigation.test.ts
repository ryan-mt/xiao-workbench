import { describe, expect, it } from "vitest";

import { resolveTimelineResource } from "./resourceNavigation";

describe("resolveTimelineResource", () => {
  const root = "C:\\Users\\dev\\project";

  it("routes web links to Xiao's browser", () => {
    expect(resolveTimelineResource("https://example.com/docs?q=1", root)).toEqual({
      kind: "browser",
      url: "https://example.com/docs?q=1",
    });
  });

  it("routes absolute and relative HTML files to workspace previews", () => {
    expect(resolveTimelineResource("C:/Users/dev/project/index.html", root)).toEqual({
      kind: "html",
      relativePath: "index.html",
      fragment: "",
    });
    expect(resolveTimelineResource("./pages/demo.htm#result", root)).toEqual({
      kind: "html",
      relativePath: "pages/demo.htm",
      fragment: "#result",
    });
  });

  it("routes supported source files to Xiao's file viewer", () => {
    expect(resolveTimelineResource("src/main.tsx:42", root)).toEqual({
      kind: "file",
      relativePath: "src/main.tsx",
    });
  });

  it("routes absolute UNC paths within a UNC workspace", () => {
    const uncRoot = "\\\\SERVER\\share\\project";

    expect(resolveTimelineResource("\\\\server\\SHARE\\project\\src\\main.ts:42", uncRoot)).toEqual({
      kind: "file",
      relativePath: "src/main.ts",
    });
    expect(resolveTimelineResource("\\\\SERVER\\share\\secret.ts", uncRoot)).toBeNull();
  });

  it("rejects paths outside the execution workspace and unsafe schemes", () => {
    expect(resolveTimelineResource("../secret.html", root)).toBeNull();
    expect(resolveTimelineResource("C:/Users/dev/secret.html", root)).toBeNull();
    expect(resolveTimelineResource("javascript:alert(1)", root)).toBeNull();
  });
});
