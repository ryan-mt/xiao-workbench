import { describe, expect, it } from "vitest";

import { isTaskPreviewTarget, taskPreviewWebviewLabel } from "./taskPreview";

describe("Task Preview targets", () => {
  it("accepts host-registered previews and loopback outcome servers", () => {
    expect(isTaskPreviewTarget(
      "xiao-preview://018f47a2-a9b3-7c11-8c52-cc14251c6789/index.html",
    )).toBe(true);
    expect(isTaskPreviewTarget("http://localhost:4173/")).toBe(true);
    expect(isTaskPreviewTarget("https://127.0.0.1:8443/result")).toBe(true);
  });

  it("rejects general browsing and privileged schemes", () => {
    expect(isTaskPreviewTarget("https://example.com/")).toBe(false);
    expect(isTaskPreviewTarget("file:///private/result.html")).toBe(false);
    expect(isTaskPreviewTarget("javascript:alert(1)")).toBe(false);
  });

  it("derives an isolated native webview label from the Task identity", () => {
    const label = taskPreviewWebviewLabel("C:/project", "task/A weird id");
    expect(label).toMatch(/^xiao-task-preview-[0-9a-f]{16}-task-A-weird$/);
    expect(taskPreviewWebviewLabel("C:/other", "task/A weird id")).not.toBe(label);
    expect(taskPreviewWebviewLabel("C:/project", "task-A weird id")).not.toBe(label);
  });
});
