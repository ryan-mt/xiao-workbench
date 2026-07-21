import { describe, expect, it } from "vitest";

import {
  normalizeWorkspacePath,
  workspacePathComparisonKey,
  workspacePathIsWithin,
  workspacePathRelativeTo,
} from "./workspacePath";

describe("workspace path identity", () => {
  it("normalizes Windows drive and UNC paths case-insensitively", () => {
    expect(workspacePathComparisonKey("C:\\Projects\\Xiao\\")).toBe("c:/projects/xiao");
    expect(workspacePathComparisonKey("c:/projects/xiao")).toBe("c:/projects/xiao");
    expect(workspacePathComparisonKey("\\\\Server\\Share\\Project\\")).toBe(
      "//server/share/project",
    );
  });

  it("preserves POSIX case and filesystem roots", () => {
    expect(workspacePathComparisonKey("/work/Project/")).toBe("/work/Project");
    expect(workspacePathComparisonKey("/work/project")).toBe("/work/project");
    expect(workspacePathComparisonKey("/work/Project")).not.toBe(
      workspacePathComparisonKey("/work/project"),
    );
    expect(normalizeWorkspacePath("/")).toBe("/");
    expect(normalizeWorkspacePath("C:\\")).toBe("C:/");
  });

  it("checks containment at path-segment boundaries", () => {
    expect(workspacePathIsWithin("C:\\Work\\App", "c:/work/app/src/main.ts")).toBe(true);
    expect(workspacePathIsWithin("/work/app", "/work/app/src/main.ts")).toBe(true);
    expect(workspacePathIsWithin("/work/app", "/work/app2/main.ts")).toBe(false);
    expect(workspacePathIsWithin("/work/App", "/work/app/main.ts")).toBe(false);
    expect(workspacePathRelativeTo("/", "/src/main.ts")).toBe("src/main.ts");
    expect(workspacePathRelativeTo("C:/", "c:/src/main.ts")).toBe("src/main.ts");
    expect(workspacePathRelativeTo("/work/app", "/work/app2/main.ts")).toBeNull();
    expect(workspacePathRelativeTo("/work/app", "src/main.ts")).toBe("src/main.ts");
  });
});
