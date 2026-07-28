import type { AgentAttachment } from "../../../core/models/agent";
import { workspacePathComparisonKey } from "../../../core/workspacePath";

const storageKey = "xiao.composer-attachment-recovery.v1";
const storageVersion = 1;

export type ComposerAttachmentRecoveryMap = Record<string, AgentAttachment[]>;

export type ComposerAttachmentRecoveryFailure = {
  operation: "get" | "set" | "remove";
  message: string;
};

export type ComposerAttachmentRecoveryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ComposerAttachmentRecoveryFailure };

type AttachmentRecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const storageFailure = (
  operation: ComposerAttachmentRecoveryFailure["operation"],
  reason: unknown,
): ComposerAttachmentRecoveryResult<never> => ({
  ok: false,
  error: {
    operation,
    message: reason && typeof reason === "object" && "message" in reason &&
      typeof reason.message === "string"
      ? reason.message
      : String(reason),
  },
});

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
): ComposerAttachmentRecoveryResult<ComposerAttachmentRecoveryMap> => {
  let serialized: string | null;
  try {
    serialized = (storage ?? window.localStorage).getItem(storageKey);
  } catch (reason) {
    return storageFailure("get", reason);
  }

  try {
    const parsed = JSON.parse(serialized ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: true, value: {} };
    }
    const stored = parsed as { version?: unknown; byTask?: unknown };
    if (
      stored.version !== storageVersion ||
      !stored.byTask ||
      typeof stored.byTask !== "object" ||
      Array.isArray(stored.byTask)
    ) return { ok: true, value: {} };

    return {
      ok: true,
      value: Object.fromEntries(
        Object.entries(stored.byTask).filter(
          (entry): entry is [string, AgentAttachment[]] =>
            Array.isArray(entry[1]) && entry[1].length > 0 && entry[1].every(isAttachment),
        ),
      ),
    };
  } catch {
    return { ok: true, value: {} };
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
): ComposerAttachmentRecoveryResult<ComposerAttachmentRecoveryMap> => {
  let target: AttachmentRecoveryStorage;
  try {
    target = storage ?? window.localStorage;
  } catch (reason) {
    return storageFailure("get", reason);
  }
  const recovered = readComposerAttachmentRecoveries(target);
  if (!recovered.ok) return recovered;
  const current = recovered.value;
  const key = recoveryTaskKey(workspacePath, taskId);
  const next = { ...current };
  const durableAttachments = attachments.filter(
    (attachment) => !attachment.url?.startsWith("data:"),
  );
  if (durableAttachments.length) next[key] = durableAttachments;
  else delete next[key];

  if (Object.keys(next).length) {
    try {
      target.setItem(storageKey, JSON.stringify({ version: storageVersion, byTask: next }));
    } catch (reason) {
      return storageFailure("set", reason);
    }
  } else {
    try {
      target.removeItem(storageKey);
    } catch (reason) {
      return storageFailure("remove", reason);
    }
  }
  return { ok: true, value: next };
};
