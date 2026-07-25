import { describe, expect, it } from "vitest";

import {
  codexThreadActivityAt,
  isLegacyCodexImportPath,
  sameWorkspacePath,
  workspaceContainsPath,
} from "./codexHistory";

describe("Codex history activity", () => {
  it("prefers the live updated clock over stale recency", () => {
    expect(codexThreadActivityAt(1_000, 30, 20)).toBe(30_000);
    expect(codexThreadActivityAt(1_000, undefined, 20)).toBe(20_000);
  });
});

describe("Codex history workspace matching", () => {
  it("groups nested chat working directories under their project root", () => {
    expect(
      workspaceContainsPath(
        "D:\\Project Archive",
        "D:\\Project Archive\\xiao-workbench\\src-tauri",
      ),
    ).toBe(true);
    expect(workspaceContainsPath("D:\\Project Archive", "D:\\Other")).toBe(false);
  });

  it("normalizes slash style, case, and trailing separators", () => {
    expect(
      sameWorkspacePath("D:\\Project Archive\\", "d:/project archive"),
    ).toBe(true);
  });

  it("recognizes synthetic projects created by the old Codex importer", () => {
    expect(
      isLegacyCodexImportPath(
        "C:\\Users\\xiao\\Documents\\Codex\\2026-07-13\\old-chat-title",
      ),
    ).toBe(true);
    expect(isLegacyCodexImportPath("D:\\Project Archive")).toBe(false);
  });
});
