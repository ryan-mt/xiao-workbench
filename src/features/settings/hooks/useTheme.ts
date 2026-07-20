import { useLayoutEffect, useState } from "react";

import { normalizeTheme, resolveTheme, type Theme } from "../themeCatalog";

export type { Theme } from "../themeCatalog";

const STORAGE_KEY = "xiao.appearance.theme";

const readStoredTheme = (): Theme => {
  try {
    return normalizeTheme(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return "system";
  }
};

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = resolveTheme(theme, media.matches);
      document.documentElement.dataset.theme = resolved.scheme;
      document.documentElement.dataset.palette = resolved.id;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", resolved.metaColor);
    };
    apply();
    media.addEventListener("change", apply);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Keep the selected theme for this session when storage is unavailable.
    }
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  return { theme, setTheme };
}
