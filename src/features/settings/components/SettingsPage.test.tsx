import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentRuntimeState } from "../../../core/models/agent";
import type { AppPreferences } from "../hooks/useAppPreferences";
import type { Theme } from "../hooks/useTheme";
import { SettingsPage } from "./SettingsPage";

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
  taskId: null,
  threadId: null,
  turnId: null,
  turnStartedAt: null,
  error: null,
  eventsSeen: 17,
};

const renderSettings = (theme: Theme) => renderToStaticMarkup(
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
    onThemeChange={noop}
    onPreferencesChange={noop}
    onRestoreArchivedTask={noop}
    onReloadArchivedTasks={noop}
    onReconnect={noop}
    onCheckCodexUpdate={noop}
    onUpdateCodex={noop}
    onClose={noop}
  />,
);

describe("SettingsPage", () => {
  it("uses a grouped settings sidebar and a focused content pane", () => {
    const markup = renderSettings("system");

    expect(markup).toContain('class="settings-sidebar"');
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

  it("keeps the runtime and close controls accessible", () => {
    const markup = renderSettings("dark");

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Connected");
    expect(markup).toContain('aria-label="Close settings"');
  });
});
