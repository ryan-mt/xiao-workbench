import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentRuntimeState } from "../../../core/models/agent";
import type { CodexProfile } from "../../../core/models/xiao";
import type { AppPreferences } from "../hooks/useAppPreferences";
import type { Theme } from "../hooks/useTheme";
import { canSelectCodexProfile, SettingsPage } from "./SettingsPage";
import { DEFAULT_COMMAND_BINDINGS } from "../../command-menu/commandBindings";

const noop = () => undefined;

const preferences: AppPreferences = {
  importCodexHistory: false,
  sidebarV2: true,
  showReasoningSummaries: true,
  expandToolOutput: false,
  focusNewTasks: true,
  fastMode: false,
  launchBrand: "logo",
  wrapCode: false,
  notifyCompletions: true,
  notifyErrors: true,
  notifyApprovals: true,
  hiddenModels: [],
  shortcutBindings: { ...DEFAULT_COMMAND_BINDINGS },
  taskRunDefaults: {
    model: null,
    reasoningEffort: null,
    mode: "default",
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
  },
};

const runtime: AgentRuntimeState = {
  phase: "ready",
  profileId: null,
  taskId: null,
  threadId: null,
  turnId: null,
  turnStartedAt: null,
  error: null,
  eventsSeen: 17,
};

const codexProfiles: CodexProfile[] = [
  {
    id: "default",
    displayName: "Default Codex",
    codexHome: null,
    authenticationHome: null,
    environment: {},
    availability: "available",
    authenticatedIdentity: null,
    models: [],
    capabilities: {},
    usage: null,
    rateLimits: null,
    diagnostic: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "review",
    displayName: "Review profile",
    codexHome: null,
    authenticationHome: null,
    environment: {},
    availability: "available",
    authenticatedIdentity: null,
    models: [],
    capabilities: {},
    usage: null,
    rateLimits: null,
    diagnostic: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "grok",
    displayName: "Grok 4.5 (xAI)",
    codexHome: "C:\\Xiao\\grok",
    authenticationHome: null,
    environment: {
      XIAO_MODEL_PROVIDER: "xai",
    },
    availability: "unauthenticated",
    authenticatedIdentity: null,
    models: [],
    capabilities: { providerId: "xai" },
    usage: null,
    rateLimits: null,
    diagnostic: "Connect this profile to xAI with device sign-in.",
    version: 0,
    createdAt: 1,
    updatedAt: 1,
  },
];

const renderSettings = (
  theme: Theme,
  activeSection: "archived" | "general" | "runtime" | "shortcuts" = "general",
) => renderToStaticMarkup(
  <SettingsPage
    theme={theme}
    preferences={preferences}
    models={[]}
    account={null}
    runtime={runtime}
    system={{ platform: "windows", shell: "powershell", codexVersion: "1.0.0" }}
    codexUpdate={null}
    codexUpdateResult={null}
    codexUpdateChecking={false}
    codexUpdating={false}
    codexUpdateError={null}
    archivedTasks={[]}
    archivedTasksLoading={false}
    archivedTasksError={null}
    archiveAllChatsBusy={false}
    archiveAllChatsDisabled={false}
    archiveAllChatsError={null}
    codexProfiles={codexProfiles}
    selectedCodexProfileId="default"
    codexProfileSelectionDisabled={false}
    onThemeChange={noop}
    onPreferencesChange={noop}
    onArchiveAllChats={noop}
    onRestoreArchivedTask={noop}
    onReloadArchivedTasks={noop}
    onReconnect={noop}
    onCheckCodexUpdate={noop}
    onUpdateCodex={noop}
    onCodexProfileChange={noop}
    onClose={noop}
    activeSection={activeSection}
  />,
);

describe("SettingsPage", () => {
  it("uses a grouped settings sidebar and a focused content pane", () => {
    const markup = renderSettings("system");

    expect(markup).toContain('class="settings-sidebar app-sidebar"');
    expect(markup).toContain('class="settings-nav"');
    expect(markup).toContain('class="settings-main"');
    expect(markup).toContain('aria-label="Settings sections"');
    expect(markup).toContain('class="settings-nav__label">Xiao</span>');
    expect(markup).toContain('class="settings-nav__label">Codex</span>');
    expect(markup).toContain("Agent feed");
    expect(markup).toContain("Shortcuts");
    expect(markup).not.toContain("settings-header__mark");
  });

  it("renders the selected theme in an accessible custom listbox trigger", () => {
    const markup = renderSettings("moss");

    expect(markup).toContain('aria-label="Theme"');
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Moss");
    expect(markup).toContain('class="settings-theme-select__swatch"');
    expect(markup).not.toContain("<select");
  });

  it("keeps back and close controls accessible", () => {
    const markup = renderSettings("dark");

    expect(markup).toContain("Back to workspace");
    expect(markup).toContain('aria-label="Close settings"');
  });

  it("offers one bulk action to archive chats across projects", () => {
    const markup = renderSettings("system", "archived");

    expect(markup).toContain("Archive all chats");
    expect(markup).toContain("Move every chat from every project into this archive.");
    expect(markup).toContain(">Archive all</button>");
  });

  it("keeps Codex profile selection in Settings", () => {
    const markup = renderSettings("system", "runtime");

    expect(markup).toContain('aria-label="Codex profile for the current Task"');
    expect(markup).toContain("Default Codex");
    expect(markup).toContain("Review profile");
  });

  it("offers native xAI device sign-in without another runtime", () => {
    const markup = renderSettings("system", "runtime");

    expect(markup).toContain("Grok 4.5 (xAI)");
    expect(markup).toContain("Connect xAI");
    expect(markup).toContain("Sign in with Grok");
    expect(markup).toContain("not another agent runtime");
  });

  it("renders editable shortcuts as labeled keyboard controls", () => {
    const markup = renderSettings("system", "shortcuts");

    expect(markup).toContain('class="shortcut-row"');
    expect(markup).toContain('<label class="shortcut-row__copy" for="shortcut-task.create">');
    expect(markup).toContain('id="shortcut-task.create"');
    expect(markup).toContain('class="shortcut-input"');
    expect(markup).toContain('autoComplete="off"');
    expect(markup).toContain('class="button button--quiet shortcut-actions__reset"');
  });

  it("disables Task profile changes while task state has a storage error", () => {
    expect(canSelectCodexProfile({
      taskArchived: false,
      taskStateLoading: false,
      taskStateError: "Could not save Task state.",
      environmentBusy: false,
      runtimeBusy: false,
      profileCount: 2,
    })).toBe(false);
  });
});
