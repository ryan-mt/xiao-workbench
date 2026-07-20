import { describe, expect, it } from "vitest";

import { workspaceServiceErrorMessage } from "./service";

describe("workspace service error scoping", () => {
  it("accepts only errors owned by the current workspace", () => {
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
    })).toBeNull();
    expect(workspaceServiceErrorMessage("/work/Project", {
      workspacePath: "/work/project",
      message: "different Unix workspace",
    })).toBeNull();
  });
});
