import { describe, expect, it } from "vitest";

import {
  defaultTaskRunDefaults,
  normalizeAppPreferences,
} from "./useAppPreferences";

describe("normalizeAppPreferences", () => {
  it("restores every saved task run setting", () => {
    const preferences = normalizeAppPreferences({
      showReasoningSummaries: false,
      expandToolOutput: true,
      focusNewTasks: false,
      fastMode: true,
      launchBrand: "wordmark",
      wrapCode: true,
      notifyCompletions: false,
      notifyErrors: false,
      notifyApprovals: false,
      hiddenModels: ["hidden-model"],
      shortcutBindings: {
        "task.create": "Ctrl+N",
      },
      taskRunDefaults: {
        model: "gpt-custom",
        reasoningEffort: "high",
        mode: "plan",
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
    });

    expect(preferences).toEqual({
      showReasoningSummaries: false,
      expandToolOutput: true,
      focusNewTasks: false,
      fastMode: true,
      launchBrand: "wordmark",
      wrapCode: true,
      notifyCompletions: false,
      notifyErrors: false,
      notifyApprovals: false,
      hiddenModels: ["hidden-model"],
      shortcutBindings: {
        "command-menu.open": "Ctrl+K",
        "task-switcher.open": "Ctrl+Tab",
        "task.create": "Ctrl+N",
        "task.close": "Ctrl+W",
        "runtime.open": "Ctrl+`",
      },
      taskRunDefaults: {
        model: "gpt-custom",
        reasoningEffort: "high",
        mode: "plan",
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
    });
  });

  it("adds safe defaults to preferences saved by older versions", () => {
    const preferences = normalizeAppPreferences({ wrapCode: true });

    expect(preferences.fastMode).toBe(false);
    expect(preferences.launchBrand).toBe("logo");
    expect(preferences.taskRunDefaults).toEqual(defaultTaskRunDefaults);
  });

  it("keeps valid partial defaults and rejects invalid enum values", () => {
    expect(normalizeAppPreferences({
      taskRunDefaults: {
        approvalPolicy: "never",
        sandboxMode: "outside-the-sandbox",
      },
    }).taskRunDefaults).toEqual({
      ...defaultTaskRunDefaults,
      approvalPolicy: "never",
    });
  });
});
