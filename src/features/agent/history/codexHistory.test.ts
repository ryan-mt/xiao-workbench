import { afterEach, describe, expect, it, vi } from "vitest";

import { nativeBridge } from "../../../core/bridges/tauri";
import {
  codexPlanFromTimeline,
  codexTimelineHasFinalResponse,
  codexThreadActivityAt,
  isLegacyCodexImportPath,
  readCodexThreadTimeline,
  sameCodexTimeline,
  sameWorkspacePath,
  userEntryFromItem,
  workspaceContainsPath,
} from "./codexHistory";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Codex history activity", () => {
  it("preserves a stable timeline across identical live import polls", () => {
    const current = [{
      id: "command",
      kind: "command" as const,
      title: "Ran command",
      command: "git status --short",
      body: "clean",
      status: "success" as const,
      files: [{ path: "src/App.tsx", additions: 1, deletions: 0 }],
    }];
    expect(sameCodexTimeline(current, current.map((entry) => ({
      ...entry,
      files: entry.files.map((file) => ({ ...file })),
    })))).toBe(true);
    expect(sameCodexTimeline(current, [{
      ...current[0],
      body: "changed",
    }])).toBe(false);
  });

  it("attaches recovered shell commands to the matching app-server turn", async () => {
    vi.spyOn(nativeBridge, "agentRequest").mockResolvedValue({
      data: [{
        id: "turn-1",
        status: "inProgress",
        startedAt: 1_000,
        items: [{
          id: "user-1",
          type: "userMessage",
          content: [{ type: "text", text: "Fix it" }],
        }],
      }],
    });
    vi.spyOn(nativeBridge, "readCodexRolloutCommands").mockResolvedValue([{
      id: "call-1",
      turnId: "turn-1",
      turnIndex: 0,
      activityKind: "command",
      label: null,
      command: "git status --short",
      output: " M src/app/App.tsx",
      createdAt: "1970-01-01T00:00:01.100Z",
      durationMs: 25,
      exitCode: 0,
    }]);

    const timeline = await readCodexThreadTimeline(
      "thread-1",
      { projectPath: "D:\\Project Archive\\xiao-workbench", taskId: "task-1" },
    );

    expect(timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "rollout-command:call-1",
        kind: "command",
        command: "git status --short",
        turnId: "turn-1",
      }),
    ]));
  });

  it("opens app-server history when an optional local rollout no longer exists", async () => {
    vi.spyOn(nativeBridge, "agentRequest").mockResolvedValue({
      data: [{
        id: "turn-1",
        status: "completed",
        startedAt: 1_000,
        items: [{
          id: "user-1",
          type: "userMessage",
          content: [{ type: "text", text: "Open this chat" }],
        }, {
          id: "answer-1",
          type: "agentMessage",
          phase: "final_answer",
          text: "The chat remains readable.",
        }],
      }],
    });
    vi.spyOn(nativeBridge, "readCodexRolloutCommands").mockRejectedValue(
      "Could not find the local Codex rollout for this task.",
    );

    const timeline = await readCodexThreadTimeline(
      "thread-1",
      { projectPath: "D:\\Project Archive\\xiao-workbench", taskId: "task-1" },
    );

    expect(timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "user", title: "Open this chat" }),
      expect.objectContaining({ kind: "result", body: "The chat remains readable." }),
    ]));
  });

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

  it("only treats a real final response as terminal", () => {
    const live = [{
      id: "user",
      kind: "user" as const,
      title: "Continue",
    }, {
      id: "commentary",
      kind: "result" as const,
      title: "Agent response",
      meta: "Commentary",
      status: "success" as const,
    }];
    expect(codexTimelineHasFinalResponse(live)).toBe(false);
    expect(codexTimelineHasFinalResponse([...live, {
      id: "final",
      kind: "result",
      title: "Agent response",
      status: "success",
    }])).toBe(true);
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
