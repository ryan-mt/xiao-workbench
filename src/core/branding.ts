export type AppStage = "official" | "beta" | "dev";

const APP_BASE_NAME = "Xiao Workbench";

export function resolveAppStage(mode: string): AppStage {
  if (mode === "beta") return "beta";
  if (mode === "development") return "dev";
  return "official";
}

export function formatAppDisplayName(baseName: string, stage: AppStage): string {
  if (stage === "official") return baseName;
  const label = stage === "beta" ? "Beta" : "Dev";
  return `${baseName} (${label})`;
}

export const APP_STAGE = resolveAppStage(import.meta.env.MODE);
export const APP_DISPLAY_NAME = formatAppDisplayName(APP_BASE_NAME, APP_STAGE);
