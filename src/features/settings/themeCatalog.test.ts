import { describe, expect, it } from "vitest";

import { normalizeTheme, resolveTheme, themePresets } from "./themeCatalog";

describe("theme catalog", () => {
  it("keeps preset ids unique and includes the new palettes", () => {
    const ids = themePresets.map((preset) => preset.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["system", "light", "dark", "moss", "dusk", "ember"]);
  });

  it("falls back safely when a stored theme is unknown", () => {
    expect(normalizeTheme("dusk")).toBe("dusk");
    expect(normalizeTheme("removed-theme")).toBe("system");
    expect(normalizeTheme(null)).toBe("system");
  });

  it("resolves system mode and preserves explicit palette schemes", () => {
    expect(resolveTheme("system", false)).toMatchObject({ id: "light", scheme: "light" });
    expect(resolveTheme("system", true)).toMatchObject({ id: "dark", scheme: "dark" });
    expect(resolveTheme("moss", true)).toMatchObject({ id: "moss", scheme: "light" });
    expect(resolveTheme("dusk", false)).toMatchObject({ id: "dusk", scheme: "dark" });
    expect(resolveTheme("ember", false)).toMatchObject({ id: "ember", scheme: "dark" });
  });
});
