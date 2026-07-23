import { describe, expect, it } from "vitest";

import type { AgentAttachment } from "../../../core/models/agent";
import {
  indexReviewAttachmentsByLine,
  OPEN_FILE_RENDER_BATCH_SIZE,
  visibleFileLines,
} from "./OpenFilePanel";

describe("OpenFilePanel large file rendering", () => {
  it("bounds the initial render to a small line batch", () => {
    const lines = Array.from({ length: 2_671 }, (_, index) => `line ${index + 1}`);

    const visible = visibleFileLines(lines);

    expect(visible).toHaveLength(OPEN_FILE_RENDER_BATCH_SIZE);
    expect(visible.at(-1)).toBe(`line ${OPEN_FILE_RENDER_BATCH_SIZE}`);
  });

  it("indexes only review attachments for the active file", () => {
    const active: AgentAttachment = {
      id: "active",
      name: "service.rs:12",
      path: "src/service.rs",
      kind: "review",
      lineStart: 12,
      comment: "Check this line",
    };
    const range: AgentAttachment = {
      id: "range",
      name: "service.rs:20",
      path: "src/service.rs",
      kind: "review",
      lineStart: 20,
      lineEnd: 24,
      comment: "Check this range",
    };
    const indexed = indexReviewAttachmentsByLine([
      active,
      range,
      { name: "other.rs:12", path: "src/other.rs", kind: "review", lineStart: 12 },
      { name: "service.rs", path: "src/service.rs", kind: "file" },
    ], "src/service.rs");

    expect([...indexed.keys()]).toEqual([12, 24]);
    expect(indexed.get(12)).toEqual([active]);
    expect(indexed.get(24)).toEqual([range]);
  });
});
