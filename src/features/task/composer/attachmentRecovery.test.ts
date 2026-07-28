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

const recoveryValue = (result: ReturnType<typeof readComposerAttachmentRecoveries>) => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("composer attachment undo recovery storage", () => {
  it("serializes recoveries across reload with normalized workspace and same-ID isolation", () => {
    const storage = memoryStorage();
    const taskId = "shared-task";
    const first = attachment("A.txt");
    const second = attachment("B.txt");

    storeComposerAttachmentRecovery("C:\\Projects\\A\\", taskId, [first], storage);
    storeComposerAttachmentRecovery("D:/Projects/B", taskId, [second], storage);

    const reloaded = recoveryValue(readComposerAttachmentRecoveries(storage));
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

    let reloaded = recoveryValue(readComposerAttachmentRecoveries(storage));
    expect(composerAttachmentRecovery(reloaded, "C:/A", "task-a")).toEqual([]);
    expect(composerAttachmentRecovery(reloaded, "C:/A", "task-b")).toEqual([second]);

    storeComposerAttachmentRecovery("C:/A", "task-b", [], storage);
    reloaded = recoveryValue(readComposerAttachmentRecoveries(storage));
    expect(reloaded).toEqual({});
  });

  it("does not share recoveries between case-distinct POSIX workspaces", () => {
    const storage = memoryStorage();
    const taskId = "shared-task";
    const upper = attachment("Upper.txt");
    const lower = attachment("Lower.txt");

    storeComposerAttachmentRecovery("/work/Project", taskId, [upper], storage);
    storeComposerAttachmentRecovery("/work/project", taskId, [lower], storage);

    const reloaded = recoveryValue(readComposerAttachmentRecoveries(storage));
    expect(composerAttachmentRecovery(reloaded, "/work/Project", taskId)).toEqual([upper]);
    expect(composerAttachmentRecovery(reloaded, "/work/project", taskId)).toEqual([lower]);
  });

  it("returns a typed failure when quota prevents durable recovery", () => {
    const storage = {
      ...memoryStorage(),
      setItem: () => { throw new DOMException("quota exceeded", "QuotaExceededError"); },
    };

    const result = storeComposerAttachmentRecovery(
      "C:/A",
      "task-a",
      [attachment("A.txt")],
      storage,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        operation: "set",
        message: "quota exceeded",
      },
    });
  });

  it("returns a typed failure when durable recovery cannot be read", () => {
    const storage = {
      ...memoryStorage(),
      getItem: () => { throw new Error("storage denied"); },
    };

    expect(readComposerAttachmentRecoveries(storage)).toEqual({
      ok: false,
      error: {
        operation: "get",
        message: "storage denied",
      },
    });
  });

  it("reports failed removal and leaves the durable recovery intact", () => {
    const backing = memoryStorage();
    storeComposerAttachmentRecovery("C:/A", "task-a", [attachment("A.txt")], backing);
    const storage = {
      ...backing,
      removeItem: () => { throw new Error("remove blocked"); },
    };

    expect(storeComposerAttachmentRecovery("C:/A", "task-a", [], storage)).toEqual({
      ok: false,
      error: {
        operation: "remove",
        message: "remove blocked",
      },
    });
    expect(composerAttachmentRecovery(
      recoveryValue(readComposerAttachmentRecoveries(backing)),
      "C:/A",
      "task-a",
    )).toEqual([attachment("A.txt")]);
  });

  it("never writes pasted-image data URLs to durable recovery", () => {
    const storage = memoryStorage();
    const pastedImage: AgentAttachment = {
      name: "pasted.png",
      path: "clipboard:image-a",
      kind: "image",
      url: "data:image/png;base64,private-pixels",
    };

    const result = storeComposerAttachmentRecovery("C:/A", "task-a", [pastedImage], storage);

    expect(result).toEqual({ ok: true, value: {} });
    expect(recoveryValue(readComposerAttachmentRecoveries(storage))).toEqual({});
  });
});
