// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AttentionItem, AttentionSnapshot } from "../../core/models/xiao";

const bridge = vi.hoisted(() => ({
  acknowledgeXiaoAttentionItem: vi.fn(),
  listXiaoAttentionItems: vi.fn(),
}));

vi.mock("../../core/bridges/tauri", () => ({
  isTauriHost: () => true,
  nativeBridge: bridge,
}));

import { failedAttentionStatus, useAttentionCenter } from "./useAttentionCenter";

const item = (id: string): AttentionItem => ({
  id,
  projectPath: "C:\\projects\\xiao",
  projectName: "Xiao",
  taskId: "task-a",
  taskTitle: "Ship outcome supervision",
  taskStage: "ready_for_review",
  taskStageVersion: 3,
  runId: "run-a",
  kind: "review",
  priority: 1,
  title: "Outcome ready for review",
  safeSummary: "Verification passed.",
  sourceOccurrenceKey: "task-a:outcome:3",
  surface: "verification",
  createdAt: 1_700_000_000_000,
  resolvedAt: null,
  acknowledgedAt: null,
});

const snapshot = (
  items: AttentionItem[],
  status: AttentionSnapshot["status"] = "live",
): AttentionSnapshot => ({
  items,
  status,
  generatedAt: 1_700_000_000_100,
});

beforeEach(() => {
  bridge.acknowledgeXiaoAttentionItem.mockReset().mockResolvedValue(true);
  bridge.listXiaoAttentionItems.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("cross-project Attention hydration", () => {
  it("distinguishes unavailable initial state from stale retained items", () => {
    expect(failedAttentionStatus(false)).toBe("unavailable");
    expect(failedAttentionStatus(true)).toBe("stale");
  });

  it("hydrates the durable host snapshot", async () => {
    const review = item("review-a");
    bridge.listXiaoAttentionItems.mockResolvedValue(snapshot([review], "partial"));

    const { result } = renderHook(() => useAttentionCenter());

    await waitFor(() => expect(result.current.status).toBe("partial"));
    expect(result.current.items).toEqual([review]);
    expect(result.current.error).toBeNull();
    expect(bridge.listXiaoAttentionItems).toHaveBeenCalledTimes(1);
  });

  it("reports an unavailable initial host failure", async () => {
    bridge.listXiaoAttentionItems.mockRejectedValue(new Error("primary host offline"));

    const { result } = renderHook(() => useAttentionCenter());

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.items).toEqual([]);
    expect(result.current.error).toBe("primary host offline");
  });

  it("retains hydrated items as stale when a refresh fails", async () => {
    const review = item("review-a");
    bridge.listXiaoAttentionItems.mockResolvedValueOnce(snapshot([review]));
    const { result } = renderHook(() => useAttentionCenter());
    await waitFor(() => expect(result.current.status).toBe("live"));

    bridge.listXiaoAttentionItems.mockRejectedValueOnce(new Error("refresh failed"));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.status).toBe("stale");
    expect(result.current.items).toEqual([review]);
    expect(result.current.error).toBe("refresh failed");
  });

  it("acknowledges one occurrence durably and removes only that item", async () => {
    const acknowledged = item("review-a");
    const remaining = item("failure-b");
    bridge.listXiaoAttentionItems.mockResolvedValue(snapshot([acknowledged, remaining]));
    const { result } = renderHook(() => useAttentionCenter());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    await act(async () => {
      await result.current.acknowledge(acknowledged.id);
    });

    expect(bridge.acknowledgeXiaoAttentionItem).toHaveBeenCalledWith(acknowledged.id);
    expect(result.current.items).toEqual([remaining]);
  });
});
