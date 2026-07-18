import { describe, expect, it } from "vitest";

import type { AgentAttachment } from "../../../core/models/agent";
import {
  composerAttachmentRecovery,
  readComposerAttachmentRecoveries,
  storeComposerAttachmentRecovery,
} from "./attachmentRecovery";

const attachment = (path: string): AgentAttachment => ({
  name: path,
  path,
  kind: "file",
});

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};

describe("composer attachment undo recovery storage", () => {
  it("serializes recoveries across reload with normalized workspace and same-ID isolation", () => {
    const storage = memoryStorage();
    const taskId = "shared-task";
    const first = attachment("A.txt");
    const second = attachment("B.txt");

    storeComposerAttachmentRecovery("C:\\Projects\\A\\", taskId, [first], storage);
    storeComposerAttachmentRecovery("D:/Projects/B", taskId, [second], storage);

    const reloaded = readComposerAttachmentRecoveries(storage);
    expect(composerAttachmentRecovery(reloaded, "c:/projects/a", taskId)).toEqual([first]);
    expect(composerAttachmentRecovery(reloaded, "D:\\PROJECTS\\B\\", taskId)).toEqual([second]);
    expect(composerAttachmentRecovery(reloaded, "C:/projects/a", "other-task")).toEqual([]);
  });

  it("removes an empty recovery without disturbing another task and clears storage when empty", () => {
    const storage = memoryStorage();
    const first = attachment("A.txt");
    const second = attachment("B.txt");

    storeComposerAttachmentRecovery("C:/A", "task-a", [first], storage);
    storeComposerAttachmentRecovery("C:/A", "task-b", [second], storage);
    storeComposerAttachmentRecovery("C:/A", "task-a", [], storage);

    let reloaded = readComposerAttachmentRecoveries(storage);
    expect(composerAttachmentRecovery(reloaded, "C:/A", "task-a")).toEqual([]);
    expect(composerAttachmentRecovery(reloaded, "C:/A", "task-b")).toEqual([second]);

    storeComposerAttachmentRecovery("C:/A", "task-b", [], storage);
    reloaded = readComposerAttachmentRecoveries(storage);
    expect(reloaded).toEqual({});
  });
});
