import { useCallback, useEffect, useRef, useState } from "react";

import { nativeBridge } from "../../core/bridges/tauri";
import type { VerificationEvidencePage } from "../../core/models/verification";

const errorMessage = (reason: unknown) => {
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === "object" && "message" in reason) return String(reason.message);
  return String(reason);
};

export const verificationEvidencePollIntervalMs = 750;
export const verificationEvidencePageSize = 10;
export const verificationEvidenceHistoryLimit = 20;

export const nextVerificationEvidenceLimit = (current: number) =>
  Math.min(
    verificationEvidenceHistoryLimit,
    current + verificationEvidencePageSize,
  );

type VerificationEvidenceLoaderOptions = {
  load: () => Promise<VerificationEvidencePage>;
  poll: boolean;
  pollIntervalMs?: number;
  onLoading: (loading: boolean) => void;
  onEvidence: (page: VerificationEvidencePage) => void;
  onError: (message: string | null) => void;
};

export function createVerificationEvidenceLoader({
  load,
  poll,
  pollIntervalMs = verificationEvidencePollIntervalMs,
  onLoading,
  onEvidence,
  onError,
}: VerificationEvidenceLoaderOptions) {
  let disposed = false;
  let timer: Parameters<typeof clearTimeout>[0] | null = null;
  let inFlight: Promise<void> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleNext = () => {
    if (disposed || !poll) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, pollIntervalMs);
  };

  const refresh = () => {
    clearTimer();
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;

    onLoading(true);
    onError(null);
    const request = Promise.resolve()
      .then(load)
      .then((next) => {
        if (!disposed) onEvidence(next);
      })
      .catch((reason: unknown) => {
        if (!disposed) onError(errorMessage(reason));
      })
      .finally(() => {
        if (inFlight === request) inFlight = null;
        if (!disposed) {
          onLoading(false);
          scheduleNext();
        }
      });
    inFlight = request;
    return request;
  };

  return {
    refresh,
    dispose: () => {
      disposed = true;
      clearTimer();
    },
  };
}

export function useVerificationEvidence(
  runId: string | null,
  refreshKey: string,
  pollWhileVerifying = false,
) {
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const [evidence, setEvidence] = useState<{
    runId: string | null;
    page: VerificationEvidencePage;
  }>({ runId, page: { attempts: [], hasMore: false } });
  const [pagination, setPagination] = useState({
    runId,
    limit: verificationEvidencePageSize,
    revision: 0,
  });
  const limit = pagination.runId === runId
    ? pagination.limit
    : verificationEvidencePageSize;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPagination({ runId, limit: verificationEvidencePageSize, revision: 0 });
    setEvidence({ runId, page: { attempts: [], hasMore: false } });
  }, [runId]);

  useEffect(() => {
    if (!runId) {
      setLoading(false);
      setError(null);
      refreshRef.current = () => Promise.resolve();
      return;
    }

    const loader = createVerificationEvidenceLoader({
      load: () => nativeBridge.listXiaoVerificationEvidence(runId, limit),
      poll: pollWhileVerifying,
      onLoading: setLoading,
      onEvidence: (page) => setEvidence({ runId, page }),
      onError: setError,
    });
    refreshRef.current = loader.refresh;
    void loader.refresh();
    return () => {
      loader.dispose();
      if (refreshRef.current === loader.refresh) {
        refreshRef.current = () => Promise.resolve();
      }
    };
  }, [limit, pagination.revision, pollWhileVerifying, refreshKey, runId]);

  const refresh = useCallback(() => refreshRef.current(), []);
  const loadOlder = useCallback(() => {
    if (!runId) return;
    setPagination((current) => ({
      runId,
      limit: nextVerificationEvidenceLimit(
        current.runId === runId ? current.limit : verificationEvidencePageSize,
      ),
      revision: current.revision + 1,
    }));
  }, [runId]);
  const page = evidence.runId === runId
    ? evidence.page
    : { attempts: [], hasMore: false };

  return {
    attempts: page.attempts,
    loading,
    error,
    refresh,
    hasOlder: page.hasMore,
    loadOlder,
  };
}
