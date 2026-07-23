import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { ExplorationGroup } from "./ExplorationGroup";

const activeExploration: TimelineEntry = {
  id: "exploration",
  kind: "explore",
  title: "Explore files",
  status: "active",
  exploration: [{
    kind: "read",
    command: "Get-Content src/App.tsx",
    label: "src/App.tsx",
    path: "src/App.tsx",
  }],
};

describe("ExplorationGroup disclosure", () => {
  it("does not force an active group open when tool output expansion is disabled", () => {
    const markup = renderToStaticMarkup(
      <ExplorationGroup entries={[activeExploration]} index={0} expandByDefault={false} />,
    );

    expect(markup).not.toContain("<details open=\"\"");
  });

  it("opens the group when tool output expansion is enabled", () => {
    const markup = renderToStaticMarkup(
      <ExplorationGroup entries={[activeExploration]} index={0} expandByDefault />,
    );

    expect(markup).toContain("<details open=\"\"");
  });

  it("uses compact context language", () => {
    const markup = renderToStaticMarkup(
      <ExplorationGroup entries={[activeExploration]} index={0} expandByDefault={false} />,
    );

    expect(markup).toContain("context-tool-group");
    expect(markup).toContain("Gathering context");
    expect(markup).toContain("1 read");
    expect(markup).not.toContain("Exploring");
  });

  it("includes browser searches in the collapsed context summary", () => {
    const browserSearch: TimelineEntry = {
      id: "browser-search",
      kind: "result",
      title: "Searched: opencode v2 tool grouping",
      meta: "Browser tool",
      status: "success",
    };
    const markup = renderToStaticMarkup(
      <ExplorationGroup
        entries={[activeExploration, browserSearch]}
        index={0}
        expandByDefault={false}
      />,
    );

    expect(markup).toContain("1 read");
    expect(markup).toContain("1 search");
    expect(markup).toContain("opencode v2 tool grouping");
  });
});
