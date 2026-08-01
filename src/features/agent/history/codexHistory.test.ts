import { afterEach, describe, expect, it, vi } from "vitest";

import { nativeBridge } from "../../../core/bridges/tauri";
import {
  codexPlanFromTimeline,
  codexTimelineHasFinalResponse,
  codexTimelineIsWorking,
  codexThreadActivityAt,
  isLegacyCodexImportPath,
  readCodexThreadChangeSummary,
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
  it("counts raw file contents for added and deleted files", async () => {
    vi.spyOn(nativeBridge, "agentRequest").mockResolvedValue({
      data: [{
        items: [{
          type: "fileChange",
          changes: [
            { path: "added.txt", kind: "add", diff: "one\ntwo\n" },
            { path: "deleted.txt", kind: "delete", diff: "old\n" },
          ],
        }],
      }],
    });

    await expect(readCodexThreadChangeSummary(
      "thread-1",
      { projectPath: "C:/project", taskId: "task-1" },
    )).resolves.toEqual({ additions: 2, deletions: 1 });
  });

  it("paginates every turn and restores structured reasoning summaries", async () => {
    vi.spyOn(nativeBridge, "agentRequest")
      .mockResolvedValueOnce({
        data: [{
          id: "turn-new",
          startedAt: 2,
          items: [{
            id: "user-new",
            type: "userMessage",
            content: [{ type: "text", text: "Newer" }],
          }],
        }],
        nextCursor: "older",
      })
      .mockResolvedValueOnce({
        data: [{
          id: "turn-old",
          startedAt: 1,
          items: [{
            id: "user-old",
            type: "userMessage",
            content: [{ type: "text", text: "Older" }],
          }, {
            id: "reasoning-old",
            type: "reasoning",
            summary: [{ text: "Recovered thought" }],
          }],
        }],
        nextCursor: null,
      });
    vi.spyOn(nativeBridge, "readCodexRolloutCommands").mockResolvedValue([]);

    const timeline = await readCodexThreadTimeline(
      "thread-1",
      { projectPath: "D:\\Project Archive\\xiao-workbench", taskId: "task-1" },
    );

    expect(timeline.map((entry) => entry.id)).toEqual([
      "user-old",
      "reasoning-old",
      "user-new",
    ]);
    expect(timeline[1]).toEqual(expect.objectContaining({
      kind: "thought",
      body: "Recovered thought",
    }));
  });

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
        status: "in-progress",
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

  it("ignores a stale rollout turn ID and infers the returned owning turn", async () => {
    vi.spyOn(nativeBridge, "agentRequest").mockResolvedValue({
      data: [{
        id: "turn-current",
        status: "completed",
        startedAt: 1,
        items: [{
          id: "user-current",
          type: "userMessage",
          content: [{ type: "text", text: "Current turn" }],
        }],
      }],
    });
    vi.spyOn(nativeBridge, "readCodexRolloutCommands").mockResolvedValue([{
      id: "call-stale",
      turnId: "turn-missing",
      turnIndex: 0,
      activityKind: "command",
      command: "npm test",
      output: "passed",
      createdAt: "1970-01-01T00:00:01.100Z",
      exitCode: 0,
    }]);

    const timeline = await readCodexThreadTimeline(
      "thread-1",
      { projectPath: "D:\\Project Archive\\xiao-workbench", taskId: "task-1" },
    );

    expect(timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "rollout-command:call-stale",
        turnId: "turn-current",
      }),
    ]));
  });

  it("falls back to rollout turn order when a stale turn ID has no timestamp", async () => {
    vi.spyOn(nativeBridge, "agentRequest").mockResolvedValue({
      data: [{
        id: "turn-current",
        status: "completed",
        startedAt: 1,
        items: [{
          id: "user-current",
          type: "userMessage",
          content: [{ type: "text", text: "Current turn" }],
        }],
      }],
    });
    vi.spyOn(nativeBridge, "readCodexRolloutCommands").mockResolvedValue([{
      id: "call-stale",
      turnId: "turn-missing",
      turnIndex: 0,
      activityKind: "command",
      command: "npm test",
      output: "passed",
      exitCode: 0,
    }]);

    const timeline = await readCodexThreadTimeline(
      "thread-1",
      { projectPath: "D:\\Project Archive\\xiao-workbench", taskId: "task-1" },
    );

    expect(timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "rollout-command:call-stale",
        turnId: "turn-current",
      }),
    ]));
  });

  it("keeps an imported raw in-progress turn working", async () => {
    vi.spyOn(nativeBridge, "agentRequest").mockResolvedValue({
      data: [{
        id: "turn-live",
        status: "inProgress",
        startedAt: 1,
        items: [{
          id: "user-live",
          type: "userMessage",
          content: [{ type: "text", text: "Keep going" }],
        }],
      }],
    });
    vi.spyOn(nativeBridge, "readCodexRolloutCommands").mockResolvedValue([]);

    const timeline = await readCodexThreadTimeline(
      "thread-1",
      { projectPath: "D:\\Project Archive\\xiao-workbench", taskId: "task-1" },
    );

    expect(codexTimelineIsWorking(timeline)).toBe(true);
    expect(timeline.at(-1)).toMatchObject({
      id: "codex-turn:turn-live:active",
      status: "active",
      turnId: "turn-live",
    });
  });

  it("restores imported image-view activity with its local thumbnail", async () => {
    vi.spyOn(nativeBridge, "agentRequest").mockResolvedValue({
      data: [{
        id: "turn-1",
        status: "completed",
        startedAt: 1_000,
        items: [{
          id: "user-1",
          type: "userMessage",
          content: [{ type: "text", text: "Inspect the reference" }],
        }],
      }],
    });
    vi.spyOn(nativeBridge, "readCodexRolloutCommands").mockResolvedValue([{
      id: "call-image",
      turnId: "turn-1",
      turnIndex: 0,
      activityKind: "imageView",
      label: "Viewed an image",
      command: "C:\\Temp\\reference.png",
      output: null,
      createdAt: "1970-01-01T00:00:01.100Z",
    }]);

    const timeline = await readCodexThreadTimeline(
      "thread-1",
      { projectPath: "D:\\Project Archive\\xiao-workbench", taskId: "task-1" },
    );

    expect(timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Viewed an image",
        meta: "Image tool",
        attachments: [expect.objectContaining({
          name: "reference.png",
          path: "C:\\Temp\\reference.png",
          kind: "image",
        })],
      }),
    ]));
  });

  it("preserves rollout chronology between commentary and recovered commands", async () => {
    vi.spyOn(nativeBridge, "agentRequest").mockResolvedValue({
      data: [{
        id: "turn-1",
        status: "inProgress",
        startedAt: 1,
        items: [{
          id: "user-1",
          type: "userMessage",
          content: [{ type: "text", text: "Fix it" }],
        }, {
          id: "item-commentary-1",
          type: "agentMessage",
          phase: "commentary",
          text: "Inspecting the importer.",
        }, {
          id: "item-reasoning-1",
          type: "reasoning",
          summary: ["Checking sequence", "Matching phases", "Preserving boundaries"],
        }, {
          id: "item-commentary-2",
          type: "agentMessage",
          phase: "commentary",
          text: "Fixing the chronology.",
        }],
      }],
    });
    vi.spyOn(nativeBridge, "readCodexRolloutCommands").mockResolvedValue([{
      id: "msg-commentary-1",
      turnId: "turn-stale",
      turnIndex: null,
      activityKind: "timelineMarker",
      label: "commentary",
      command: "",
      createdAt: "1970-01-01T00:00:01.100Z",
    }, {
      id: "call-1",
      turnId: "turn-1",
      turnIndex: 0,
      activityKind: "command",
      command: "git status --short",
      createdAt: "1970-01-01T00:00:01.200Z",
      output: "clean",
      exitCode: 0,
    }, {
      id: "rs-reasoning-1",
      turnId: "turn-stale",
      turnIndex: null,
      activityKind: "timelineMarker",
      label: "reasoning",
      command: "",
      createdAt: "1970-01-01T00:00:01.250Z",
      markerSpan: 1,
    }, {
      id: "rs-reasoning-2",
      turnId: "turn-stale",
      turnIndex: null,
      activityKind: "timelineMarker",
      label: "reasoning",
      command: "",
      createdAt: "1970-01-01T00:00:01.270Z",
      markerSpan: 2,
    }, {
      id: "msg-commentary-2",
      turnId: "turn-stale",
      turnIndex: null,
      activityKind: "timelineMarker",
      label: "commentary",
      command: "",
      createdAt: "1970-01-01T00:00:01.300Z",
    }, {
      id: "call-2",
      turnId: "turn-1",
      turnIndex: 0,
      activityKind: "command",
      command: "npm run check",
      createdAt: "1970-01-01T00:00:01.400Z",
      output: "passed",
      exitCode: 0,
    }]);

    const timeline = await readCodexThreadTimeline(
      "thread-1",
      { projectPath: "D:\\Project Archive\\xiao-workbench", taskId: "task-1" },
    );

    expect(timeline.map((entry) => entry.id)).toEqual([
      "user-1",
      "item-commentary-1",
      "rollout-command:call-1",
      "item-reasoning-1",
      "item-commentary-2",
      "rollout-command:call-2",
    ]);
  });

  it("falls back to rollout turn order for stale markers without turn clocks", async () => {
    vi.spyOn(nativeBridge, "agentRequest").mockResolvedValue({
      data: [{
        id: "turn-current",
        status: "completed",
        items: [{
          id: "commentary-current",
          type: "agentMessage",
          phase: "commentary",
          text: "Still here.",
        }],
      }],
    });
    vi.spyOn(nativeBridge, "readCodexRolloutCommands").mockResolvedValue([{
      id: "marker-stale",
      turnId: "turn-stale",
      turnIndex: 0,
      activityKind: "timelineMarker",
      label: "commentary",
      command: "",
      createdAt: "1970-01-01T00:00:01.100Z",
    }]);

    const timeline = await readCodexThreadTimeline(
      "thread-1",
      { projectPath: "D:\\Project Archive\\xiao-workbench", taskId: "task-1" },
    );

    expect(timeline).toEqual([
      expect.objectContaining({
        id: "commentary-current",
        createdAt: 1_100,
        turnId: "turn-current",
      }),
    ]);
  });

  it("contains rollout rejection when listing turns fails first", async () => {
    vi.spyOn(nativeBridge, "agentRequest").mockRejectedValue(
      new Error("turns unavailable"),
    );
    vi.spyOn(nativeBridge, "readCodexRolloutCommands").mockRejectedValue(
      new Error("rollout unavailable"),
    );

    await expect(readCodexThreadTimeline(
      "thread-1",
      { projectPath: "D:\\Project Archive\\xiao-workbench", taskId: "task-1" },
    )).rejects.toThrow("turns unavailable");
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

  it("keeps POSIX path matching case-sensitive", () => {
    expect(sameWorkspacePath("/work/Project", "/work/project")).toBe(false);
    expect(workspaceContainsPath("/work/Project", "/work/project/src")).toBe(false);
    expect(workspaceContainsPath("/work/Project", "/work/Project/src")).toBe(true);
  });

  it("keeps Windows drive and UNC path matching case-insensitive", () => {
    expect(sameWorkspacePath("C:\\Work\\Project", "c:/work/project")).toBe(true);
    expect(
      workspaceContainsPath("\\\\Server\\Share\\Project", "//server/share/project/src"),
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
