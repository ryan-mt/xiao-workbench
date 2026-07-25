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
];

const renderSettings = (
  theme: Theme,
  activeSection: "general" | "runtime" = "general",
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
    codexProfiles={codexProfiles}
    selectedCodexProfileId="default"
    codexProfileSelectionDisabled={false}
    onThemeChange={noop}
    onPreferencesChange={noop}
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

  it("keeps Codex profile selection in Settings", () => {
    const markup = renderSettings("system", "runtime");

    expect(markup).toContain('aria-label="Codex profile for the current Task"');
    expect(markup).toContain("Default Codex");
    expect(markup).toContain("Review profile");
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
