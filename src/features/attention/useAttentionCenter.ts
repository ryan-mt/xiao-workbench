import { useCallback, useEffect, useRef, useState } from "react";

import { isTauriHost, nativeBridge } from "../../core/bridges/tauri";
import type { AttentionItem } from "../../core/models/xiao";

export type AttentionHydrationStatus =
  | "loading"
  | "live"
  | "partial"
  | "stale"
  | "unavailable";

export type AttentionActionError = {
  itemId: string;
  message: string;
};

const REFRESH_INTERVAL_MS = 5_000;

export const failedAttentionStatus = (
  hasItems: boolean,
): Extract<AttentionHydrationStatus, "stale" | "unavailable"> =>
  hasItems ? "stale" : "unavailable";

export function useAttentionCenter(enabled = true) {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [status, setStatus] = useState<AttentionHydrationStatus>(
    isTauriHost() ? "loading" : "live",
  );
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<AttentionActionError | null>(null);
  const [acknowledgingItemIds, setAcknowledgingItemIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const itemsRef = useRef(items);
  const refreshGenerationRef = useRef(0);
  itemsRef.current = items;

  const refresh = useCallback(async () => {
    if (!enabled || !isTauriHost()) {
      setStatus("live");
      return;
    }
    const generation = ++refreshGenerationRef.current;
    try {
      const snapshot = await nativeBridge.listXiaoAttentionItems();
      if (generation !== refreshGenerationRef.current) return;
      setItems(snapshot.items);
      setStatus(snapshot.status);
      setError(null);
    } catch (reason) {
      if (generation !== refreshGenerationRef.current) return;
      setStatus(failedAttentionStatus(itemsRef.current.length > 0));
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      refreshGenerationRef.current += 1;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, refresh]);

  const acknowledge = useCallback(async (itemId: string) => {
    setActionError((current) => current?.itemId === itemId ? null : current);
    if (!isTauriHost()) {
      setItems((current) => current.filter((item) => item.id !== itemId));
      return;
    }
    setAcknowledgingItemIds((current) => new Set(current).add(itemId));
    try {
      await nativeBridge.acknowledgeXiaoAttentionItem(itemId);
      refreshGenerationRef.current += 1;
      setItems((current) => current.filter((item) => item.id !== itemId));
    } catch (reason) {
      setActionError({
        itemId,
        message: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setAcknowledgingItemIds((current) => {
        if (!current.has(itemId)) return current;
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
    }
  }, []);

  return {
    items,
    status,
    error,
    actionError,
    acknowledgingItemIds,
    refresh,
    acknowledge,
  };
}
