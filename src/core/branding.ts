export type AppStage = "production" | "release" | "beta" | "dev";

const APP_BASE_NAME = "Xiao Workbench";

export function resolveAppStage(mode: string, configuredStage?: string): AppStage {
  if (
    configuredStage === "production" ||
    configuredStage === "release" ||
    configuredStage === "beta" ||
    configuredStage === "dev"
  ) {
    return configuredStage;
  }
  if (mode === "beta") return "beta";
  if (mode === "development") return "dev";
  return "production";
}

export function formatAppDisplayName(baseName: string, stage: AppStage): string {
  if (stage === "production" || stage === "release") return baseName;
  const label = stage === "beta" ? "Beta" : "Dev";
  return `${baseName} (${label})`;
}

export const APP_STAGE = resolveAppStage(
  import.meta.env.MODE,
  import.meta.env.VITE_XIAO_APP_STAGE,
);
export const APP_DISPLAY_NAME = formatAppDisplayName(APP_BASE_NAME, APP_STAGE);
