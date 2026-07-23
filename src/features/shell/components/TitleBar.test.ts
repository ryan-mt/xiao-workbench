import { describe, expect, it } from "vitest";

import { tabOverflowEdges } from "./TitleBar";

describe("tabOverflowEdges", () => {
  it("marks only the hidden edge as the tab strip moves", () => {
    expect(tabOverflowEdges({
      clientWidth: 320,
      scrollLeft: 0,
      scrollWidth: 720,
    })).toEqual({ left: false, right: true });

    expect(tabOverflowEdges({
      clientWidth: 320,
      scrollLeft: 160,
      scrollWidth: 720,
    })).toEqual({ left: true, right: true });

    expect(tabOverflowEdges({
      clientWidth: 320,
      scrollLeft: 400,
      scrollWidth: 720,
    })).toEqual({ left: true, right: false });
  });

  it("does not show fades when every tab fits", () => {
    expect(tabOverflowEdges({
      clientWidth: 720,
      scrollLeft: 0,
      scrollWidth: 720,
    })).toEqual({ left: false, right: false });
  });
});
