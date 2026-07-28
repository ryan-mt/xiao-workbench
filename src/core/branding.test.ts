import { describe, expect, it } from "vitest";

import { formatAppDisplayName, resolveAppStage } from "./branding";

describe("Xiao build branding", () => {
  it("keeps hot-reload development separate from beta", () => {
    expect(resolveAppStage("development")).toBe("dev");
  });

  it("maps the explicit beta mode to beta", () => {
    expect(resolveAppStage("beta")).toBe("beta");
  });

  it("uses an explicit release stage for fixed release snapshots", () => {
    expect(resolveAppStage("production", "release")).toBe("release");
  });

  it("keeps production and other build modes monochrome", () => {
    expect(resolveAppStage("production")).toBe("production");
    expect(resolveAppStage("test")).toBe("production");
  });

  it("adds a suffix only to non-release development builds", () => {
    expect(formatAppDisplayName("Xiao Workbench", "production")).toBe("Xiao Workbench");
    expect(formatAppDisplayName("Xiao Workbench", "release")).toBe("Xiao Workbench");
    expect(formatAppDisplayName("Xiao Workbench", "beta")).toBe("Xiao Workbench (Beta)");
    expect(formatAppDisplayName("Xiao Workbench", "dev")).toBe("Xiao Workbench (Dev)");
  });
});
