import { describe, expect, it } from "vitest";

import { formatAppDisplayName, resolveAppStage } from "./branding";

describe("Xiao build branding", () => {
  it("maps Vite development mode to local release development", () => {
    expect(resolveAppStage("development")).toBe("dev");
  });

  it("maps the explicit beta mode to beta", () => {
    expect(resolveAppStage("beta")).toBe("beta");
  });

  it("treats production and other build modes as official", () => {
    expect(resolveAppStage("production")).toBe("official");
    expect(resolveAppStage("test")).toBe("official");
  });

  it("adds a stage suffix only when the build is not official", () => {
    expect(formatAppDisplayName("Xiao Workbench", "official")).toBe("Xiao Workbench");
    expect(formatAppDisplayName("Xiao Workbench", "beta")).toBe("Xiao Workbench (Beta)");
    expect(formatAppDisplayName("Xiao Workbench", "dev")).toBe("Xiao Workbench (Dev)");
  });
});
