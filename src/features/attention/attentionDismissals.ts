import { workspacePathComparisonKey } from "../../core/workspacePath";

const storagePrefix = "xiao.attention-dismissals.v1:";

type AttentionDismissalStorage = Pick<Storage, "getItem" | "setItem">;

const storageKey = (workspacePath: string) =>
  `${storagePrefix}${workspacePathComparisonKey(workspacePath)}`;

export const readAttentionDismissals = (
  workspacePath: string,
  storage: AttentionDismissalStorage = window.localStorage,
): string[] => {
  try {
    const stored = JSON.parse(storage.getItem(storageKey(workspacePath)) ?? "[]") as unknown;
    return Array.isArray(stored)
      ? stored.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

export const writeAttentionDismissals = (
  workspacePath: string,
  itemIds: string[],
  storage: AttentionDismissalStorage = window.localStorage,
) => {
  try {
    storage.setItem(storageKey(workspacePath), JSON.stringify(itemIds));
  } catch {
    // Dismissing still works for the current session when storage is unavailable.
  }
};
