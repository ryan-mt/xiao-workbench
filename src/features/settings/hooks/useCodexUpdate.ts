import { useCallback, useEffect, useRef, useState } from "react";

import { isTauriHost, nativeBridge } from "../../../core/bridges/tauri";
import type { CodexUpdateResult, CodexUpdateStatus } from "../../../core/models/workspace";

const notifiedVersionStorageKey = "xiao.codex-update.notified";

const notifyAvailableUpdate = (status: CodexUpdateStatus) => {
  if (!status.updateAvailable || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    if (window.localStorage.getItem(notifiedVersionStorageKey) === status.latestVersion) return;
    window.localStorage.setItem(notifiedVersionStorageKey, status.latestVersion);
  } catch {
    // The in-app update indicator remains available when storage is blocked.
  }
  new Notification("Codex update available", {
    body: `${status.currentVersion} -> ${status.latestVersion}. Update from Xiao when no task is running.`,
  });
};

export function useCodexUpdate() {
  const [status, setStatus] = useState<CodexUpdateStatus | null>(null);
  const [result, setResult] = useState<CodexUpdateResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = useRef(false);

  const check = useCallback(async () => {
    if (!isTauriHost()) return null;
    setChecking(true);
    setError(null);
    try {
      const nextStatus = await nativeBridge.checkCodexUpdate();
      setStatus(nextStatus);
      notifyAvailableUpdate(nextStatus);
      return nextStatus;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  const install = useCallback(async () => {
    if (!status?.updateAvailable || !status.canUpdate || updating) return null;
    setUpdating(true);
    setError(null);
    setResult(null);
    try {
      const nextResult = await nativeBridge.updateCodexCli();
      setResult(nextResult);
      setStatus((current) => current ? {
        ...current,
        currentVersion: nextResult.version,
        updateAvailable: nextResult.version !== current.latestVersion,
      } : current);
      await check();
      return nextResult;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      setUpdating(false);
    }
  }, [check, status, updating]);

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    void check();
  }, [check]);

  return { status, result, checking, updating, error, check, install };
}
