import { describe, expect, it } from "vitest";

import { workspaceServiceErrorMessage } from "./service";

describe("workspace service error scoping", () => {
  it("accepts global and current-workspace errors but filters concrete mismatches", () => {
    expect(workspaceServiceErrorMessage("C:\\Project", {
      workspacePath: "c:/project/",
      message: "current failure",
    })).toBe("current failure");
    expect(workspaceServiceErrorMessage("C:/project-a", {
      workspacePath: "C:/project-b",
      message: "background failure",
    })).toBeNull();
    expect(workspaceServiceErrorMessage("C:/project-a", {
      workspacePath: null,
      message: "global failure",
    })).toBe("global failure");
    expect(workspaceServiceErrorMessage("/work/Project", {
      workspacePath: "/work/project",
      message: "different Unix workspace",
    })).toBeNull();
  });
});
