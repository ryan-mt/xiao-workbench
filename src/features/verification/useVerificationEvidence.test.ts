import type * as ReactModule from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  VerificationAttemptEvidence,
  VerificationEvidencePage,
} from "../../core/models/verification";

const hookState = vi.hoisted(() => ({
  stateCall: 0,
  refCall: 0,
  effectCall: 0,
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{
    dependencies: readonly unknown[] | undefined;
    cleanup?: () => void;
  }>,
}));

const bridgeState = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useEffect: (
      effect: () => void | (() => void),
      dependencies?: readonly unknown[],
    ) => {
      const index = hookState.effectCall++;
      const previous = hookState.effects[index];
      const changed = !previous || !dependencies || !previous.dependencies ||
        dependencies.length !== previous.dependencies.length ||
        dependencies.some((value, dependencyIndex) =>
          !Object.is(value, previous.dependencies?.[dependencyIndex])
        );
      if (!changed) return;
      previous?.cleanup?.();
      const cleanup = effect();
      hookState.effects[index] = {
        dependencies,
        cleanup: cleanup || undefined,
      };
    },
    useRef: (initializer: unknown) => {
      const index = hookState.refCall++;
      const ref = hookState.refs[index] ?? { current: initializer };
      hookState.refs[index] = ref;
      return ref;
    },
    useState: (initializer: unknown) => {
      const index = hookState.stateCall++;
      if (!(index in hookState.states)) {
        hookState.states[index] = typeof initializer === "function"
          ? (initializer as () => unknown)()
          : initializer;
      }
      const setter = (next: unknown) => {
        hookState.states[index] = typeof next === "function"
          ? (next as (current: unknown) => unknown)(hookState.states[index])
          : next;
      };
      return [hookState.states[index], setter];
    },
  };
});

vi.mock("../../core/bridges/tauri", () => ({
  nativeBridge: {
    listXiaoVerificationEvidence: bridgeState.list,
  },
}));

import {
  createVerificationEvidenceLoader,
  nextVerificationEvidenceLimit,
  useVerificationEvidence,
  verificationEvidenceHistoryLimit,
  verificationEvidencePageSize,
} from "./useVerificationEvidence";

const evidence = (id: string): VerificationAttemptEvidence => ({
  attempt: {
    id,
    runId: "run-1",
    requestKey: "request-1",
    attemptNumber: 1,
    trigger: "initial",
    contractSnapshot: {
      schemaVersion: 1,
      name: "Release checks",
      gates: [],
    },
    contractSnapshotSha256: "contract-sha256",
    expectedGateCount: 0,
    status: "running",
    diagnostic: null,
    startedAt: 1,
    finishedAt: null,
    updatedAt: 1,
    version: 1,
  },
  gates: [],
});

const page = (
  attempts: VerificationAttemptEvidence[],
  hasMore = false,
): VerificationEvidencePage => ({ attempts, hasMore });

const renderHook = (
  runId: string | null,
  refreshKey = "refresh",
  pollWhileVerifying = false,
) => {
  hookState.stateCall = 0;
  hookState.refCall = 0;
  hookState.effectCall = 0;
  return useVerificationEvidence(runId, refreshKey, pollWhileVerifying);
};

const flushPromises = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

beforeEach(() => {
  hookState.stateCall = 0;
  hookState.refCall = 0;
  hookState.effectCall = 0;
  hookState.states = [];
  hookState.refs = [];
  hookState.effects = [];
  bridgeState.list.mockReset();
});

afterEach(() => {
  for (const effect of hookState.effects) effect.cleanup?.();
  vi.useRealTimers();
});

describe("verification evidence loader", () => {
  it("loads 10 more attempts and caps evidence history at 20", () => {
    const expanded = nextVerificationEvidenceLimit(verificationEvidencePageSize);

    expect(expanded).toBe(verificationEvidenceHistoryLimit);
    expect(nextVerificationEvidenceLimit(expanded)).toBe(verificationEvidenceHistoryLimit);
  });

  it("refreshes durable evidence while verification remains active", async () => {
    vi.useFakeTimers();
    const initial = evidence("attempt-1");
    const first = page([initial]);
    const second = page([{
      ...initial,
      gates: [{
        result: {
          id: "gate-1",
          verificationAttemptId: initial.attempt.id,
          gateIndex: 0,
          gateType: "command",
          outcome: "passed",
          durationMs: 10,
          exitCode: 0,
          diagnostic: null,
          startedAt: 1,
          finishedAt: 11,
        },
        evidence: [],
      }],
    }]);
    const load = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const observed: VerificationEvidencePage[] = [];
    const loader = createVerificationEvidenceLoader({
      load,
      poll: true,
      pollIntervalMs: 25,
      onLoading: vi.fn(),
      onEvidence: (next) => observed.push(next),
      onError: vi.fn(),
    });

    await loader.refresh();
    expect(observed).toEqual([first]);

    await vi.advanceTimersByTimeAsync(25);
    expect(load).toHaveBeenCalledTimes(2);
    expect(observed).toEqual([first, second]);

    loader.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("deduplicates in-flight refreshes and ignores settlement after disposal", async () => {
    vi.useFakeTimers();
    let resolveLoad: ((value: VerificationEvidencePage) => void) | undefined;
    const load = vi.fn(() => new Promise<VerificationEvidencePage>((resolve) => {
      resolveLoad = resolve;
    }));
    const onEvidence = vi.fn();
    const onLoading = vi.fn();
    const loader = createVerificationEvidenceLoader({
      load,
      poll: true,
      pollIntervalMs: 25,
      onLoading,
      onEvidence,
      onError: vi.fn(),
    });

    const first = loader.refresh();
    const duplicate = loader.refresh();
    expect(duplicate).toBe(first);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);

    loader.dispose();
    resolveLoad?.(page([evidence("late-attempt")]));
    await first;
    await vi.advanceTimersByTimeAsync(100);

    expect(onEvidence).not.toHaveBeenCalled();
    expect(onLoading).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries a terminal failure by loading durable evidence again", async () => {
    const persisted = page([evidence("attempt-after-retry")]);
    const listEvidence = vi.fn()
      .mockRejectedValueOnce(new Error("durable evidence unavailable"))
      .mockResolvedValueOnce(persisted);
    const observed: VerificationEvidencePage[] = [];
    const errors: Array<string | null> = [];
    const loader = createVerificationEvidenceLoader({
      load: listEvidence,
      poll: false,
      onLoading: vi.fn(),
      onEvidence: (next) => observed.push(next),
      onError: (message) => errors.push(message),
    });

    await loader.refresh();
    expect(errors.at(-1)).toBe("durable evidence unavailable");
    expect(listEvidence).toHaveBeenCalledTimes(1);

    await loader.refresh();
    expect(listEvidence).toHaveBeenCalledTimes(2);
    expect(observed).toEqual([persisted]);

    loader.dispose();
  });
});

describe("useVerificationEvidence", () => {
  it("calls the bridge with 10 then 20 and retains a successful page across paging failure", async () => {
    const firstPage = page([evidence("attempt-10")], true);
    const expandedPage = page([
      evidence("attempt-20"),
      evidence("attempt-10"),
    ]);
    bridgeState.list
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error("paging unavailable"))
      .mockResolvedValueOnce(expandedPage);

    let view = renderHook("run-1");
    await flushPromises();
    view = renderHook("run-1");
    expect(bridgeState.list).toHaveBeenNthCalledWith(1, "run-1", 10);
    expect(view.attempts).toEqual(firstPage.attempts);
    expect(view.hasOlder).toBe(true);

    view.loadOlder();
    renderHook("run-1");
    await flushPromises();
    view = renderHook("run-1");
    expect(bridgeState.list).toHaveBeenNthCalledWith(2, "run-1", 20);
    expect(view.error).toBe("paging unavailable");
    expect(view.attempts).toEqual(firstPage.attempts);
    expect(view.hasOlder).toBe(true);

    view.loadOlder();
    renderHook("run-1");
    await flushPromises();
    view = renderHook("run-1");
    expect(bridgeState.list).toHaveBeenNthCalledWith(3, "run-1", 20);
    expect(view.error).toBeNull();
    expect(view.attempts).toEqual(expandedPage.attempts);
    expect(view.hasOlder).toBe(false);
  });

  it("does not let a stale same-run refresh overwrite a newer expanded page", async () => {
    const firstPage = page([evidence("attempt-10")], true);
    const expandedPage = page([
      evidence("attempt-20"),
      evidence("attempt-10"),
    ]);
    let resolveStale!: (value: VerificationEvidencePage) => void;
    const stalePage = new Promise<VerificationEvidencePage>((resolve) => {
      resolveStale = resolve;
    });
    bridgeState.list
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(stalePage)
      .mockResolvedValueOnce(expandedPage);

    renderHook("run-1");
    await flushPromises();
    let view = renderHook("run-1");
    const staleRefresh = view.refresh();
    await Promise.resolve();
    view.loadOlder();
    renderHook("run-1");
    await flushPromises();
    expect(renderHook("run-1").attempts).toEqual(expandedPage.attempts);

    resolveStale(page([evidence("stale-attempt")], true));
    await staleRefresh;
    view = renderHook("run-1");

    expect(bridgeState.list).toHaveBeenNthCalledWith(2, "run-1", 10);
    expect(bridgeState.list).toHaveBeenNthCalledWith(3, "run-1", 20);
    expect(view.attempts).toEqual(expandedPage.attempts);
    expect(view.hasOlder).toBe(false);
  });

  it("retains the last successful page when a same-run refresh fails", async () => {
    const successful = page([evidence("durable-attempt")], true);
    bridgeState.list
      .mockResolvedValueOnce(successful)
      .mockRejectedValueOnce(new Error("refresh unavailable"));

    renderHook("run-1");
    await flushPromises();
    let view = renderHook("run-1");
    await view.refresh();
    view = renderHook("run-1");

    expect(bridgeState.list).toHaveBeenNthCalledWith(2, "run-1", 10);
    expect(view.error).toBe("refresh unavailable");
    expect(view.attempts).toEqual(successful.attempts);
    expect(view.hasOlder).toBe(true);
  });

  it("hides same-component evidence immediately when the run changes", async () => {
    bridgeState.list
      .mockResolvedValueOnce(page([evidence("run-1-attempt")], true))
      .mockReturnValueOnce(new Promise<VerificationEvidencePage>(() => undefined));

    renderHook("run-1");
    await flushPromises();
    expect(renderHook("run-1").attempts).toHaveLength(1);

    const changed = renderHook("run-2");
    await Promise.resolve();
    expect(changed.attempts).toEqual([]);
    expect(changed.hasOlder).toBe(false);
    expect(bridgeState.list).toHaveBeenNthCalledWith(2, "run-2", 10);
  });
});
