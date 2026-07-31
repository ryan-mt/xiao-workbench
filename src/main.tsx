import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { APP_DISPLAY_NAME, APP_STAGE } from "./core/branding";
import { BootIntro } from "./features/shell/components/BootIntro";
import { normalizeTheme, resolveTheme } from "./features/settings/themeCatalog";
import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/global.css";

document.title = APP_DISPLAY_NAME;
document.documentElement.dataset.appStage = APP_STAGE;

// Match the operator's theme before the first painted frame so the boot
// sequence and desk share the same palette from cold start.
try {
  const stored = normalizeTheme(window.localStorage.getItem("xiao.appearance.theme"));
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = resolveTheme(stored, prefersDark);
  document.documentElement.dataset.theme = resolved.scheme;
  document.documentElement.dataset.palette = resolved.id;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved.metaColor);
} catch {
  // Theme hydration is best-effort; useTheme will reconcile after mount.
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BootIntro>
      <App />
    </BootIntro>
  </StrictMode>,
);
