import { describe, expect, it } from "vitest";

import { taskGroupForUpdatedAt } from "./task.types";

const day = 86_400_000;
const now = Date.UTC(2026, 6, 20, 12);

describe("taskGroupForUpdatedAt", () => {
  it("keeps the selected task active regardless of age", () => {
    expect(taskGroupForUpdatedAt(now - day * 30, true, now)).toBe("Active");
  });

  it("uses stable age boundaries and separates tasks older than a week", () => {
    expect(taskGroupForUpdatedAt(now + day, false, now)).toBe("Recent");
    expect(taskGroupForUpdatedAt(now - day + 1, false, now)).toBe("Recent");
    expect(taskGroupForUpdatedAt(now - day, false, now)).toBe("Yesterday");
    expect(taskGroupForUpdatedAt(now - day * 2, false, now)).toBe("This week");
    expect(taskGroupForUpdatedAt(now - day * 7, false, now)).toBe("This week");
    expect(taskGroupForUpdatedAt(now - day * 7 - 1, false, now)).toBe("Older");
    expect(taskGroupForUpdatedAt(now - day * 90, false, now)).toBe("Older");
  });
});
