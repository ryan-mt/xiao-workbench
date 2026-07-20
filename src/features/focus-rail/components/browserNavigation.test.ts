import { describe, expect, it } from "vitest";

import {
  BROWSER_HOME_URL,
  shouldHandleBrowserNavigationRequest,
  toBrowserUrl,
} from "./browserNavigation";

describe("browser navigation request ordering", () => {
  it("accepts only the first request or a strictly newer request", () => {
    expect(shouldHandleBrowserNavigationRequest(null, 1)).toBe(true);
    expect(shouldHandleBrowserNavigationRequest(4, 5)).toBe(true);
    expect(shouldHandleBrowserNavigationRequest(4, 4)).toBe(false);
    expect(shouldHandleBrowserNavigationRequest(4, 3)).toBe(false);
  });
});

describe("toBrowserUrl", () => {
  it("uses Google for an empty address", () => {
    expect(toBrowserUrl("   ")).toBe(BROWSER_HOME_URL);
  });

  it("keeps supported URLs", () => {
    expect(toBrowserUrl("https://example.com/docs?q=x")).toBe("https://example.com/docs?q=x");
  });

  it("keeps Xiao's scoped workspace preview addresses", () => {
    expect(toBrowserUrl("xiao-preview://018f47a2-a9b3-7c11-8c52-cc14251c6789/index.html"))
      .toBe("xiao-preview://018f47a2-a9b3-7c11-8c52-cc14251c6789/index.html");
  });

  it("adds a scheme to domains and local development hosts", () => {
    expect(toBrowserUrl("youtube.com")).toBe("https://youtube.com/");
    expect(toBrowserUrl("localhost:1420/settings")).toBe("http://localhost:1420/settings");
  });

  it("turns plain text and unsupported schemes into Google searches", () => {
    expect(toBrowserUrl("tauri child webview")).toBe(
      "https://www.google.com/search?q=tauri%20child%20webview",
    );
    expect(toBrowserUrl("javascript:alert(1)")).toBe(
      "https://www.google.com/search?q=javascript%3Aalert(1)",
    );
  });

  it("searches malformed hosts instead of throwing while adding a scheme", () => {
    expect(toBrowserUrl("999.999.999.999")).toBe(
      "https://www.google.com/search?q=999.999.999.999",
    );
    expect(toBrowserUrl("example.com:99999")).toBe(
      "https://www.google.com/search?q=example.com%3A99999",
    );
  });
});
