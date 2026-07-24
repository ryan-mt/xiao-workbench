import { useCallback, useEffect, useRef, useState } from "react";

import { isTauriHost, nativeBridge } from "../../core/bridges/tauri";
import type { AttentionItem } from "../../core/models/xiao";

export type AttentionHydrationStatus =
  | "loading"
  | "live"
  | "partial"
  | "stale"
  | "unavailable";

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
    if (!isTauriHost()) {
      setItems((current) => current.filter((item) => item.id !== itemId));
      return;
    }
    await nativeBridge.acknowledgeXiaoAttentionItem(itemId);
    refreshGenerationRef.current += 1;
    setItems((current) => current.filter((item) => item.id !== itemId));
  }, []);

  return { items, status, error, refresh, acknowledge };
}
