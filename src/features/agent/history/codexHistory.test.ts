import { describe, expect, it } from "vitest";

import {
  codexPlanFromTimeline,
  codexThreadActivityAt,
  isLegacyCodexImportPath,
  sameWorkspacePath,
  userEntryFromItem,
  workspaceContainsPath,
} from "./codexHistory";

describe("Codex history activity", () => {
  it("prefers the live updated clock over stale recency", () => {
    expect(codexThreadActivityAt(1_000, 30, 20)).toBe(30_000);
    expect(codexThreadActivityAt(1_000, undefined, 20)).toBe(20_000);
  });

  it("restores persisted plan progress for the live composer pill", () => {
    expect(codexPlanFromTimeline([{
      id: "plan",
      kind: "thought",
      title: "Plan",
      meta: "Plan",
      body: "- [x] Inspect events\n- [>] Fix projection\n- [ ] Verify app",
    }])).toEqual({
      explanation: null,
      steps: [
        { step: "Inspect events", status: "completed" },
        { step: "Fix projection", status: "inProgress" },
        { step: "Verify app", status: "pending" },
      ],
    });
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

describe("Codex history user media", () => {
  it("preserves local and remote images while hiding the attachment manifest", () => {
    const entry = userEntryFromItem({
      id: "message-1",
      content: [{
        type: "text",
        text: [
          "# Files mentioned by the user:",
          "## codex-clipboard-test.png: C:/Users/test/AppData/Local/Temp/codex-clipboard-test.png",
          "## My request for Codex:",
          "Fix this image.",
        ].join("\n"),
      }, {
        type: "localImage",
        path: "C:\\Users\\test\\AppData\\Local\\Temp\\codex-clipboard-test.png",
      }, {
        type: "image",
        url: "https://example.com/reference.png",
      }],
    }, 1_000, "turn-1");

    expect(entry?.title).toBe("Fix this image.");
    expect(entry?.attachments).toEqual([
      expect.objectContaining({
        kind: "image",
        path: "C:\\Users\\test\\AppData\\Local\\Temp\\codex-clipboard-test.png",
        name: "codex-clipboard-test.png",
      }),
      expect.objectContaining({
        kind: "image",
        url: "https://example.com/reference.png",
      }),
    ]);
  });
});
