import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { AttentionHydrationStatus } from "../../agent/hooks/useAgentRuntime";
import type { AppPage } from "../shell.types";
import { Sidebar, sidebarAttentionTriggerId } from "./Sidebar";

const workspace: WorkspaceSnapshot = {
  name: "Xiao",
  path: "C:/workspace/xiao",
  execution: {
    projectPath: "C:/workspace/xiao",
    executionRoot: "C:/workspace/xiao",
    environment: {
      id: "windows",
      kind: "windows",
      label: "Windows",
      availability: "available",
    },
    workspaceMode: "local",
    managedWorktree: null,
    isolationAvailable: true,
    isolationUnavailableReason: null,
  },
  files: [],
  git: null,
};

const noop = () => undefined;

const renderSidebar = (
  attentionCount: number,
  activePage: AppPage = "tasks",
  attentionHydrationStatus: AttentionHydrationStatus = "ready",
) =>
  renderToStaticMarkup(
    <Sidebar
      activePage={activePage}
      projects={[]}
      activeProjectPath={workspace.path}
      tasks={[]}
      activeTaskId=""
      workspace={workspace}
      workingTaskIds={[]}
      account={null}
      profile={{ name: "Xiao User", avatarDataUrl: null }}
      canOpenProjects={false}
      attentionCount={attentionCount}
      attentionHydrationStatus={attentionHydrationStatus}
      onOpenMenu={noop}
      onNewTask={noop}
      onOpenAttention={noop}
      onOpenProfile={noop}
      onOpenSettings={noop}
      onOpenTasks={noop}
      onAddProject={noop}
      onSelectProject={noop}
      onSelectTask={noop}
      onToggleTaskPinned={noop}
      onSetTaskArchived={noop}
      onRenameTask={noop}
      onMarkTaskUnread={noop}
      onContinueInNewTask={noop}
      onToggleProjectPinned={noop}
      onOpenProject={noop}
      onRenameProject={noop}
      onArchiveProjectTasks={noop}
      onRemoveProject={noop}
    />,
  );

describe("Sidebar attention trigger", () => {
  it("keeps a labeled trigger without a zero badge", () => {
    const markup = renderSidebar(0);

    expect(markup).toContain(`id="${sidebarAttentionTriggerId}"`);
    expect(markup).toContain('aria-label="Attention, 0 items"');
    expect(markup).not.toContain("sidebar__attention-badge");
  });

  it("labels a loading count as available without showing a zero badge", () => {
    const markup = renderSidebar(0, "tasks", "loading");

    expect(markup).toContain('aria-label="Attention, loading, 0 available"');
    expect(markup).not.toContain("sidebar__attention-badge");
  });

  it("labels a partial positive count as available while retaining its badge", () => {
    const markup = renderSidebar(7, "tasks", "partial");

    expect(markup).toContain('aria-label="Attention, partial, 7 available"');
    expect(markup).toContain('class="sidebar__attention-badge"');
    expect(markup).toContain(">7</span>");
  });

  it("shows a normal positive count with a full accessible label", () => {
    const markup = renderSidebar(7);

    expect(markup).toContain('aria-label="Attention, 7 items"');
    expect(markup).toContain('class="sidebar__attention-badge"');
    expect(markup).toContain(">7</span>");
  });

  it("uses singular accessible wording", () => {
    expect(renderSidebar(1)).toContain('aria-label="Attention, 1 item"');
  });

  it("bounds large visual badges while preserving the full accessible count", () => {
    const markup = renderSidebar(120);

    expect(markup).toContain('aria-label="Attention, 120 items"');
    expect(markup).toContain(">99+</span>");
  });

  it("marks the attention page active and current", () => {
    const markup = renderSidebar(4, "attention");

    expect(markup).toMatch(
      /id="sidebar-attention-trigger"[^>]*class="sidebar__footer-action sidebar__utility-attention is-active"[^>]*aria-current="page"/,
    );
  });

  it("renders a content-first workspace index without the old task rail", () => {
    const markup = renderSidebar(0);

    expect(markup).not.toContain('class="sidebar__rail"');
    expect(markup).toContain(">New task</span>");
    expect(markup).toContain(">Find anything</span>");
    expect(markup).toContain(">Projects</span>");
    expect(markup).not.toContain(">Tasks</span>");
    expect(markup).toContain(">Attention</span>");
    expect(markup).toContain(">Settings</span>");
    expect(markup).toContain(">Xiao User</strong>");
  });
});
