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
  execution: {
    projectPath: "Native workspace unavailable",
    executionRoot: "Native workspace unavailable",
    environment: {
      id: "browser-preview",
      kind: "windows",
      label: "Browser preview",
      availability: "unavailable",
    },
    workspaceMode: "local",
    managedWorktree: null,
    isolationAvailable: false,
    isolationUnavailableReason: "Managed worktrees require the native Xiao app.",
  },
  files: [],
  git: null,
};

type WorkspaceRequestIdentity = {
  projectPath: string | undefined;
  taskId: string | null | undefined;
};

type LoadedWorkspace = {
  snapshot: WorkspaceSnapshot;
  identity: WorkspaceRequestIdentity | null;
};

export function useWorkspace(path?: string, taskId?: string | null) {
  const [loadedWorkspace, setLoadedWorkspace] = useState<LoadedWorkspace>({
    snapshot: browserWorkspace,
    identity: null,
  });
  const loadedWorkspaceRef = useRef(loadedWorkspace);
  loadedWorkspaceRef.current = loadedWorkspace;
  const [system, setSystem] = useState<SystemInfo>(browserSystem);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef(error);
  errorRef.current = error;
  const refreshId = useRef(0);
  const requestedPath = useRef(path);
  const requestedTaskId = useRef(taskId);

  useLayoutEffect(() => {
    requestedPath.current = path;
    requestedTaskId.current = taskId;
  }, [path, taskId]);

  const refresh = useCallback(async () => {
    if (requestedPath.current !== path || requestedTaskId.current !== taskId) return;
    const requestId = ++refreshId.current;
    const isCurrentRequest = () =>
      requestId === refreshId.current &&
      requestedPath.current === path &&
      requestedTaskId.current === taskId;
    if (!isTauriHost()) {
      setLoadedWorkspace({
        snapshot: browserWorkspace,
        identity: { projectPath: path, taskId },
      });
      setRefreshing(false);
      return;
    }

    const loadedIdentity = loadedWorkspaceRef.current.identity;
    if (
      loadedIdentity === null ||
      loadedIdentity.projectPath !== path ||
      loadedIdentity.taskId !== taskId ||
      errorRef.current !== null
    ) {
      setRefreshing(true);
    }
    setError(null);

    try {
      void nativeBridge.getSystemInfo().then((nextSystem) => {
        if (isCurrentRequest()) setSystem(nextSystem);
      }).catch(() => {
        // System metadata is optional; a failed CLI probe must not block the workspace.
      });
      const nextWorkspace = await nativeBridge.getWorkspace(path, taskId);
      if (!isCurrentRequest()) return;
      setLoadedWorkspace({
        snapshot: nextWorkspace,
        identity: { projectPath: path, taskId },
      });
    } catch (reason) {
      if (!isCurrentRequest()) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (isCurrentRequest()) setRefreshing(false);
    }
  }, [path, taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const workspace = loadedWorkspace.snapshot;
  const identityStale =
    loadedWorkspace.identity === null ||
    loadedWorkspace.identity.projectPath !== path ||
    loadedWorkspace.identity.taskId !== taskId;
  const loading = refreshing || identityStale;
  const actionable = !loading && error === null;

  const loadDirectory = useCallback(
    (relativePath: string) => {
      if (!isTauriHost()) {
        return Promise.reject(new Error("File browsing requires the native Xiao app."));
      }
      return nativeBridge.listWorkspaceFiles(workspace.path, taskId ?? null, relativePath);
    },
    [taskId, workspace.path],
  );

  return {
    workspace,
    system,
    loading,
    error,
    refresh,
    loadDirectory,
    loadedProjectPath: loadedWorkspace.identity?.projectPath,
    loadedTaskId: loadedWorkspace.identity?.taskId,
    identityStale,
    actionable,
  };
}
