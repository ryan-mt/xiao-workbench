import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { isTauriHost, nativeBridge } from "../../../core/bridges/tauri";
import type { SystemInfo, WorkspaceSnapshot } from "../../../core/models/workspace";

const browserSystem: SystemInfo = {
  platform: "Browser preview",
  shell: "Native bridge unavailable",
  codexVersion: null,
};

const browserWorkspace: WorkspaceSnapshot = {
  name: "Browser preview",
  path: "Native workspace unavailable",
  files: [],
  git: null,
};

export function useWorkspace(path?: string) {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(browserWorkspace);
  const [system, setSystem] = useState<SystemInfo>(browserSystem);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshId = useRef(0);
  const requestedPath = useRef(path);

  useLayoutEffect(() => {
    requestedPath.current = path;
  }, [path]);

  const refresh = useCallback(async () => {
    if (requestedPath.current !== path) return;
    const requestId = ++refreshId.current;
    const isCurrentRequest = () =>
      requestId === refreshId.current && requestedPath.current === path;
    if (!isTauriHost()) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [nextWorkspace, nextSystem] = await Promise.all([
        nativeBridge.getWorkspace(path),
        nativeBridge.getSystemInfo(),
      ]);
      if (!isCurrentRequest()) return;
      setWorkspace(nextWorkspace);
      setSystem(nextSystem);
    } catch (reason) {
      if (!isCurrentRequest()) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadDirectory = useCallback(
    (relativePath: string) => {
      if (!isTauriHost()) {
        return Promise.reject(new Error("File browsing requires the native Xiao app."));
      }
      return nativeBridge.listWorkspaceFiles(workspace.path, relativePath);
    },
    [workspace.path],
  );

  return { workspace, system, loading, error, refresh, loadDirectory };
}
