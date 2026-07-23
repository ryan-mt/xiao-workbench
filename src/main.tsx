import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { APP_DISPLAY_NAME, APP_STAGE } from "./core/branding";
import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/global.css";

document.title = APP_DISPLAY_NAME;
document.documentElement.dataset.appStage = APP_STAGE;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
