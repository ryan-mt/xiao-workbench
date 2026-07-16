import { useCallback, useMemo, useState } from "react";

import type {
  CodexUsageDay,
  CodexUsageSnapshot,
  TokenUsageBreakdown,
} from "../../../core/models/agent";

type ThreadUsage = {
  usage: TokenUsageBreakdown;
  updatedAt: number;
};

type UsageStore = {
  schemaVersion: 1;
  days: Record<string, TokenUsageBreakdown>;
  threads: Record<string, ThreadUsage>;
};

const storageKey = "xiao.codex-usage.v1";
const fields: Array<keyof TokenUsageBreakdown> = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
];
const zeroUsage = (): TokenUsageBreakdown => ({
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
});

const isUsage = (value: unknown): value is TokenUsageBreakdown => {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return fields.every((field) => typeof usage[field] === "number" && usage[field] >= 0);
};

const emptyStore = (): UsageStore => ({ schemaVersion: 1, days: {}, threads: {} });

const readStore = (): UsageStore => {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return emptyStore();
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.schemaVersion !== 1 || !value.days || !value.threads) return emptyStore();
    const days = Object.fromEntries(
      Object.entries(value.days as Record<string, unknown>).filter(([, usage]) => isUsage(usage)),
    ) as Record<string, TokenUsageBreakdown>;
    const threads = Object.fromEntries(
      Object.entries(value.threads as Record<string, unknown>).flatMap(([id, entry]) => {
        if (!entry || typeof entry !== "object") return [];
        const thread = entry as Record<string, unknown>;
        return isUsage(thread.usage) && typeof thread.updatedAt === "number"
          ? [[id, { usage: thread.usage, updatedAt: thread.updatedAt }]]
          : [];
      }),
    ) as Record<string, ThreadUsage>;
    return { schemaVersion: 1, days, threads };
  } catch {
    return emptyStore();
  }
};

const writeStore = (store: UsageStore) => {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(store));
  } catch {
    // Usage remains available for the current session when storage is unavailable.
  }
};

const localDateKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const shiftDate = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const calculateStreaks = (days: CodexUsageDay[]) => {
  const active = new Set(days.filter((day) => day.totalTokens > 0).map((day) => day.date));
  let cursor = new Date();
  if (!active.has(localDateKey(cursor))) cursor = shiftDate(cursor, -1);
  let currentStreak = 0;
  while (active.has(localDateKey(cursor))) {
    currentStreak += 1;
    cursor = shiftDate(cursor, -1);
  }

  let longestStreak = 0;
  let run = 0;
  let previous: Date | null = null;
  for (const key of [...active].sort()) {
    const date = new Date(`${key}T12:00:00`);
    run = previous && localDateKey(shiftDate(previous, 1)) === key ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = date;
  }
  return { currentStreak, longestStreak, activeDays: active.size };
};

const snapshotFromStore = (store: UsageStore): CodexUsageSnapshot => {
  const days = Object.entries(store.days)
    .map(([date, usage]) => ({ date, ...usage }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const totals = days.reduce<TokenUsageBreakdown>((sum, day) => {
    for (const field of fields) sum[field] += day[field];
    return sum;
  }, zeroUsage());
  return { days, totals, ...calculateStreaks(days) };
};

export function useCodexUsage() {
  const [store, setStore] = useState<UsageStore>(readStore);
  const usage = useMemo(() => snapshotFromStore(store), [store]);

  const recordUsage = useCallback((threadId: string, total: TokenUsageBreakdown) => {
    setStore((current) => {
      const previous = current.threads[threadId]?.usage ?? zeroUsage();
      const delta = zeroUsage();
      for (const field of fields) delta[field] = Math.max(0, total[field] - previous[field]);
      if (delta.totalTokens === 0 && fields.every((field) => delta[field] === 0)) return current;

      const date = localDateKey();
      const day = { ...(current.days[date] ?? zeroUsage()) };
      for (const field of fields) day[field] += delta[field];
      const threadEntries = Object.entries({
        ...current.threads,
        [threadId]: { usage: total, updatedAt: Date.now() },
      })
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .slice(0, 500);
      const next: UsageStore = {
        schemaVersion: 1,
        days: { ...current.days, [date]: day },
        threads: Object.fromEntries(threadEntries),
      };
      writeStore(next);
      return next;
    });
  }, []);

  return { usage, recordUsage };
}
