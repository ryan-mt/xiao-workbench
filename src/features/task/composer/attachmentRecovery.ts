import type { AgentAttachment } from "../../../core/models/agent";
import { workspacePathComparisonKey } from "../../../core/workspacePath";

const storageKey = "xiao.composer-attachment-recovery.v1";
const storageVersion = 1;

export type ComposerAttachmentRecoveryMap = Record<string, AgentAttachment[]>;

type AttachmentRecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const recoveryTaskKey = (workspacePath: string, taskId: string) =>
  `${workspacePathComparisonKey(workspacePath)}\u0000${taskId}`;

const isAttachment = (value: unknown): value is AgentAttachment => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attachment = value as Partial<AgentAttachment>;
  return (
    typeof attachment.name === "string" &&
    typeof attachment.path === "string" &&
    (attachment.kind === "directory" ||
      attachment.kind === "file" ||
      attachment.kind === "image" ||
      attachment.kind === "review")
  );
};

export const readComposerAttachmentRecoveries = (
  storage?: AttachmentRecoveryStorage,
): ComposerAttachmentRecoveryMap => {
  try {
    const parsed = JSON.parse(
      (storage ?? window.localStorage).getItem(storageKey) ?? "null",
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const stored = parsed as { version?: unknown; byTask?: unknown };
    if (
      stored.version !== storageVersion ||
      !stored.byTask ||
      typeof stored.byTask !== "object" ||
      Array.isArray(stored.byTask)
    ) return {};

    return Object.fromEntries(
      Object.entries(stored.byTask).filter(
        (entry): entry is [string, AgentAttachment[]] =>
          Array.isArray(entry[1]) && entry[1].length > 0 && entry[1].every(isAttachment),
      ),
    );
  } catch {
    return {};
  }
};

export const composerAttachmentRecovery = (
  current: ComposerAttachmentRecoveryMap,
  workspacePath: string,
  taskId: string,
) => current[recoveryTaskKey(workspacePath, taskId)] ?? [];

export const storeComposerAttachmentRecovery = (
  workspacePath: string,
  taskId: string,
  attachments: AgentAttachment[],
  storage?: AttachmentRecoveryStorage,
): ComposerAttachmentRecoveryMap => {
  let target: AttachmentRecoveryStorage;
  try {
    target = storage ?? window.localStorage;
  } catch {
    return {};
  }
  const current = readComposerAttachmentRecoveries(target);
  const key = recoveryTaskKey(workspacePath, taskId);
  const next = { ...current };
  if (attachments.length) next[key] = attachments;
  else delete next[key];

  try {
    if (Object.keys(next).length) {
      target.setItem(storageKey, JSON.stringify({ version: storageVersion, byTask: next }));
    } else {
      target.removeItem(storageKey);
    }
  } catch {
    // Undo recovery remains available for this mount when local storage is unavailable.
  }
  return next;
};
