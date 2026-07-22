import { describe, expect, it } from "vitest";

import { readAttentionDismissals, writeAttentionDismissals } from "./attentionDismissals";

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
};

describe("attention dismissals", () => {
  it("persists dismissed item ids per normalized workspace", () => {
    const storage = memoryStorage();

    writeAttentionDismissals("C:\\Projects\\Xiao", ["run:a"], storage);

    expect(readAttentionDismissals("c:/projects/xiao", storage)).toEqual(["run:a"]);
    expect(readAttentionDismissals("c:/projects/other", storage)).toEqual([]);
  });

  it("ignores invalid stored values", () => {
    const storage = memoryStorage();
    storage.setItem("xiao.attention-dismissals.v1:c:/projects/xiao", "{bad json");

    expect(readAttentionDismissals("C:/Projects/Xiao", storage)).toEqual([]);
  });
});
