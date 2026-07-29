// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexThreadSummary, TimelineEntry } from "../../../core/models/agent";
import type { XiaoProjectSummary } from "../../../core/models/xiao";
import type { WorkbenchTask } from "../../task/task.types";
import { SidebarInbox } from "./SidebarInbox";

const now = new Date(2026, 6, 25, 12, 0, 0).getTime();

const projects: XiaoProjectSummary[] = [
  {
    path: "D:/Project Archive",
    name: "Project Archive",
    updatedAt: now,
  },
];

const task = (
  id: string,
  createdAt: number,
  overrides: Partial<WorkbenchTask> = {},
): WorkbenchTask => ({
  id,
  title: id,
  meta: "Now",
  group: "Recent",
  archived: false,
  pinned: false,
  unread: false,
  createdAt,
  updatedAt: createdAt,
  stage: "draft",
  stageVersion: 0,
  codexProfileId: null,
  workbenchState: {},
  draftText: "",
  followUps: [],
  model: null,
  reasoningEffort: null,
  threadId: null,
  threadBinding: null,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  goal: null,
  acceptanceContract: null,
  timeline: [],
  timelineLoaded: true,
  timelineComplete: true,
  timelineStart: 0,
  timelineEntryCount: 0,
  plan: null,
  executionEnvironmentId: null,
  workspaceMode: "local",
  managedWorktreeId: null,
  ...overrides,
});

const thread = (
  id: string,
  createdAt: number,
  overrides: Partial<CodexThreadSummary> = {},
): CodexThreadSummary => ({
  id,
  title: id,
  preview: `Private prompt text for ${id}`,
  cwd: "D:/Project Archive/xiao-workbench",
  createdAt,
  updatedAt: createdAt,
  archived: false,
  status: "ready",
  ...overrides,
});

const callbacks = () => ({
  onNewTask: vi.fn(),
  onAddProject: vi.fn(),
  onSelectProject: vi.fn(),
  onSelectTask: vi.fn(),
  onSelectCodexThread: vi.fn(),
  onTaskContextMenu: vi.fn(),
  onCodexContextMenu: vi.fn(),
});

type RenderOptions = {
  tasks?: WorkbenchTask[];
  threads?: CodexThreadSummary[];
  activeTaskId?: string;
  workingTaskIds?: string[];
  projectList?: XiaoProjectSummary[];
  codexHistoryError?: string | null;
};

const renderInbox = ({
  tasks = [],
  threads = [],
  activeTaskId = "",
  workingTaskIds = [],
  projectList = projects,
  codexHistoryError = null,
}: RenderOptions = {}) => {
  const handlers = callbacks();
  const view = render(
    <SidebarInbox
      projects={projectList}
      activeProjectPath="D:/Project Archive"
      tasks={tasks}
      codexThreads={threads}
      activeTaskId={activeTaskId}
      workingTaskIds={workingTaskIds}
      now={now}
      codexHistoryError={codexHistoryError}
      {...handlers}
    />,
  );
  return { ...view, handlers };
};

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    } satisfies Storage,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SidebarInbox ordering", () => {
  it("orders rows by real activity time", () => {
    renderInbox({
      tasks: [
        task("Older creation, newer activity", now - 20_000, {
          updatedAt: now,
        }),
        task("Newer creation, older activity", now - 10_000, {
          updatedAt: now - 9_000,
        }),
      ],
    });

    const buttons = screen.getAllByRole("button", { name: /^Open / });
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Open Older creation, newer activity",
      "Open Newer creation, older activity",
    ]);
  });

  it("does not reorder a row when selection changes", () => {
    const first = task("First", now - 1_000);
    const second = task("Second", now - 2_000);
    const { rerender, handlers } = renderInbox({
      tasks: [first, second],
      activeTaskId: "",
    });

    rerender(
      <SidebarInbox
        projects={projects}
        activeProjectPath="D:/Project Archive"
        tasks={[first, second]}
        codexThreads={[]}
        activeTaskId="Second"
        workingTaskIds={[]}
        now={now}
        codexHistoryError={null}
        {...handlers}
      />,
    );

    const buttons = screen.getAllByRole("button", { name: /^Open / });
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Open First");
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Open Second");
    expect(buttons[1]?.closest("article")?.classList.contains("is-selected")).toBe(true);
  });

  it("keeps a live working row in its chronological position", () => {
    renderInbox({
      tasks: [
        task("Newest", now - 1_000),
        task("Working but older", now - 3_000),
      ],
      workingTaskIds: ["Working but older"],
    });

    const buttons = screen.getAllByRole("button", { name: /^Open / });
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Open Newest");
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Open Working but older");
    expect(screen.getByText("Working")).not.toBeNull();
    expect(buttons[1]?.closest("article")?.classList.contains("is-working")).toBe(true);
  });

  it("orders chats by real activity rather than creation time", () => {
    renderInbox({
      tasks: [
        task("Created later", now - 1_000, { updatedAt: now - 5_000 }),
        task("Updated later", now - 10_000, { updatedAt: now - 500 }),
      ],
    });

    const buttons = screen.getAllByRole("button", { name: /^Open / });
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Open Updated later");
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Open Created later");
  });

  it("shows one concise done state for a completed Xiao task", () => {
    renderInbox({
      tasks: [task("Finished", now, { stage: "completed" })],
    });

    expect(screen.getAllByText("Done")).toHaveLength(1);
  });
});

describe("SidebarInbox settlement", () => {
  it("moves a settled task out of the inbox and into the bottom shelf", () => {
    renderInbox({ tasks: [task("Finish me", now)] });

    fireEvent.click(screen.getByRole("button", { name: "Settle Finish me" }));

    expect(screen.getByText("Inbox clear")).not.toBeNull();
    expect(screen.getByText("Settled")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Open Finish me" })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Restore Finish me to inbox" }),
    ).not.toBeNull();
  });

  it("restores a settled task to its original chronological place", () => {
    renderInbox({
      tasks: [
        task("Newest", now),
        task("Restorable", now - 1_000),
        task("Oldest", now - 2_000),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Settle Restorable" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Restorable to inbox" }));

    const buttons = screen.getAllByRole("button", { name: /^Open / });
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Open Newest",
      "Open Restorable",
      "Open Oldest",
    ]);
  });

  it("persists settlement independently of task archive state", () => {
    const { unmount } = renderInbox({ tasks: [task("Persistent", now)] });
    fireEvent.click(screen.getByRole("button", { name: "Settle Persistent" }));
    expect(window.localStorage.getItem("xiao.sidebar-settled.v1")).toContain(
      "task:Persistent",
    );
    unmount();

    renderInbox({ tasks: [task("Persistent", now)] });
    expect(
      screen.getByRole("button", { name: "Restore Persistent to inbox" }),
    ).not.toBeNull();
  });
});

describe("SidebarInbox Codex history", () => {
  it("renders project Codex chats directly in the inbox", () => {
    renderInbox({ threads: [thread("Imported chat", now)] });

    expect(
      screen.getByRole("button", { name: "Open Imported chat" }),
    ).not.toBeNull();
    expect(screen.getAllByText("Project Archive")).toHaveLength(2);
  });

  it("keeps unmatched chats behind one labeled Other Codex chats shelf", () => {
    renderInbox({
      threads: [
        thread("Outside", now, {
          cwd: "C:/unregistered/private-repo",
        }),
      ],
    });

    const shelf = screen.getByRole("button", { name: /Other Codex chats/ });
    expect(shelf.querySelectorAll("svg")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Open Outside" })).toBeNull();

    fireEvent.click(shelf);
    const row = screen.getByRole("button", { name: "Open Outside" });
    expect(row).not.toBeNull();
    expect(row.querySelector("svg")).toBeNull();
  });

  it("does not confuse a registered project named Other Codex chats with the unmatched shelf", () => {
    renderInbox({
      projectList: [{
        path: "D:/named-other",
        name: "Other Codex chats",
        updatedAt: now,
      }],
      threads: [thread("Registered chat", now, { cwd: "D:/named-other/repo" })],
    });

    expect(screen.getByRole("button", { name: "Open Registered chat" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Other Codex chats, \d+ chats/ })).toBeNull();
  });

  it("does not leak the chat preview or cwd through native title tooltips", () => {
    renderInbox({
      threads: [
        thread("Safe title", now, {
          preview: "A very long private prompt that must never become a tooltip",
          cwd: "D:/Project Archive/secret-name",
        }),
      ],
    });

    const row = screen.getByRole("button", { name: "Open Safe title" });
    expect(row.getAttribute("title")).toBeNull();
    expect(document.querySelector("[title*='private prompt']")).toBeNull();
    expect(document.querySelector("[title*='secret-name']")).toBeNull();
  });

  it("forwards a standalone Codex row context menu", () => {
    const imported = thread("Context chat", now);
    const { handlers } = renderInbox({ threads: [imported] });

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open Context chat" }), {
      clientX: 40,
      clientY: 80,
    });

    expect(handlers.onCodexContextMenu).toHaveBeenCalledTimes(1);
    expect(handlers.onCodexContextMenu.mock.calls[0]?.[1]).toBe(imported.id);
  });

  it("shows imported working and waiting states without selecting the row", () => {
    renderInbox({
      threads: [
        thread("Live", now, { status: "working" }),
        thread("Question", now - 1, { status: "waiting" }),
      ],
    });

    expect(screen.getByText("Working")).not.toBeNull();
    expect(screen.getByText("Needs input")).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Open Live" })
        .closest("article")
        ?.classList.contains("is-working"),
    ).toBe(true);
  });
});

describe("SidebarInbox change pills", () => {
  it("shows the most recent Xiao file-change counts without selecting it", () => {
    const oldChange: TimelineEntry = {
      id: "old",
      kind: "change",
      title: "old",
      files: [{ path: "old.ts", additions: 100, deletions: 90 }],
    };
    const latestChange: TimelineEntry = {
      id: "latest",
      kind: "change",
      title: "latest",
      files: [
        { path: "one.ts", additions: 8, deletions: 3 },
        { path: "two.ts", additions: 5, deletions: 2 },
      ],
    };
    renderInbox({
      tasks: [
        task("Changed task", now, {
          timeline: [oldChange, latestChange],
          timelineEntryCount: 2,
        }),
      ],
    });

    const row = screen.getByRole("button", { name: "Open Changed task" });
    expect(within(row).getByText("+13")).not.toBeNull();
    expect(within(row).getByText("−5")).not.toBeNull();
    expect(within(row).queryByText("+100")).toBeNull();
  });

  it("shows background-hydrated imported diff counts", () => {
    renderInbox({
      threads: [
        thread("Hydrated", now, {
          additions: 21,
          deletions: 4,
        }),
      ],
    });

    const row = screen.getByRole("button", { name: "Open Hydrated" });
    expect(within(row).getByText("+21")).not.toBeNull();
    expect(within(row).getByText("−4")).not.toBeNull();
  });
});

describe("SidebarInbox controls", () => {
  it("shows six inbox rows until the user asks for more", () => {
    renderInbox({
      tasks: Array.from({ length: 9 }, (_, index) =>
        task(`Thread ${index + 1}`, now - index)),
    });

    expect(screen.getAllByRole("button", { name: /^Open Thread/ })).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Show 3 more chats" }));
    expect(screen.getAllByRole("button", { name: /^Open Thread/ })).toHaveLength(9);
    expect(screen.queryByRole("button", { name: /Show .* more chats/ })).toBeNull();
  });

  it("opens tasks and Codex threads through separate handlers", () => {
    const imported = thread("Codex item", now - 1);
    const { handlers } = renderInbox({
      tasks: [task("Xiao item", now)],
      threads: [imported],
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Xiao item" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Codex item" }));

    expect(handlers.onSelectTask).toHaveBeenCalledWith("Xiao item");
    expect(handlers.onSelectCodexThread).toHaveBeenCalledWith(imported);
  });

  it("uses project scope without a redundant Codex filter chip", () => {
    renderInbox({
      tasks: [task("Xiao item", now)],
      threads: [
        thread("Codex item", now - 1),
        thread("Outside", now - 2, { cwd: "C:/outside" }),
      ],
    });

    expect(screen.queryByRole("button", { name: "Codex" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Project Archive" }));

    expect(screen.getByRole("button", { name: "Open Xiao item" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Open Codex item" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open Outside" })).toBeNull();
  });

  it("invokes New and Add project controls", () => {
    const { handlers } = renderInbox();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    expect(handlers.onNewTask).toHaveBeenCalledTimes(1);
    expect(handlers.onAddProject).toHaveBeenCalledTimes(1);
  });

  it("renders a calm local error without replacing cached rows", () => {
    renderInbox({
      tasks: [task("Cached row", now)],
      codexHistoryError: "Could not refresh Codex history.",
    });

    expect(screen.getByRole("button", { name: "Open Cached row" })).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Could not refresh Codex history.");
  });
});
