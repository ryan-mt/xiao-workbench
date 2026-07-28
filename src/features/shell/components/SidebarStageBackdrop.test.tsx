import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarStageBackdrop } from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it("renders the Nightly sky for beta builds", () => {
    const markup = renderToStaticMarkup(<SidebarStageBackdrop variant="beta" />);

    expect(markup).toContain("sidebar-stage-backdrop--beta");
    expect(markup).toContain("sidebar-stage-backdrop__clouds");
    expect(markup).not.toContain("sidebar-stage-backdrop__blueprint");
  });

  it("renders the blue blueprint for release snapshots", () => {
    const markup = renderToStaticMarkup(<SidebarStageBackdrop variant="release" />);

    expect(markup).toContain("sidebar-stage-backdrop--release");
    expect(markup).toContain("sidebar-stage-backdrop__blueprint");
    expect(markup).not.toContain("sidebar-stage-backdrop__clouds");
  });

  it("renders the blue blueprint for hot-reload development", () => {
    const markup = renderToStaticMarkup(<SidebarStageBackdrop variant="dev" />);

    expect(markup).toContain("sidebar-stage-backdrop--dev");
    expect(markup).toContain("sidebar-stage-backdrop__blueprint");
    expect(markup).not.toContain("sidebar-stage-backdrop__clouds");
  });

  it("keeps production builds monochrome without stage artwork", () => {
    expect(renderToStaticMarkup(<SidebarStageBackdrop variant="production" />)).toBe("");
  });
});
