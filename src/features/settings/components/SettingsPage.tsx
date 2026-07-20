import { useMemo, useState } from "react";

import { XiaoIcon, type XiaoIconName } from "../../../components/icons/XiaoIcon";
import type {
  AgentAccountSummary,
  AgentModelSummary,
  AgentRuntimeState,
} from "../../../core/models/agent";
import type { CodexUpdateResult, CodexUpdateStatus, SystemInfo } from "../../../core/models/workspace";
import type { AppPreferences } from "../hooks/useAppPreferences";
import type { Theme } from "../hooks/useTheme";
import { themePresets } from "../themeCatalog";
import "../styles/settings.css";

export type ArchivedTaskItem = {
  taskId: string;
  title: string;
  updatedAt: number;
  projectPath: string;
  projectName: string;
};

type SettingsSection = "agent" | "archived" | "general" | "models" | "runtime" | "shortcuts";

type SettingsPageProps = {
  theme: Theme;
  preferences: AppPreferences;
  models: AgentModelSummary[];
  account: AgentAccountSummary | null;
  runtime: AgentRuntimeState;
  system: SystemInfo;
  codexUpdate: CodexUpdateStatus | null;
  codexUpdateResult: CodexUpdateResult | null;
  codexUpdateChecking: boolean;
  codexUpdating: boolean;
  codexUpdateError: string | null;
  archivedTasks: ArchivedTaskItem[];
  archivedTasksLoading: boolean;
  archivedTasksError: string | null;
  onThemeChange: (theme: Theme) => void;
  onPreferencesChange: (patch: Partial<AppPreferences>) => void;
  onRestoreArchivedTask: (item: ArchivedTaskItem) => void;
  onReloadArchivedTasks: () => void;
  onReconnect: () => void;
  onCheckCodexUpdate: () => void;
  onUpdateCodex: () => void;
  onClose: () => void;
};

const sections: Array<{
  id: SettingsSection;
  label: string;
  icon: XiaoIconName;
  eyebrow: string;
  description: string;
}> = [
  {
    id: "general",
    label: "General",
    icon: "settings",
    eyebrow: "Workspace",
    description: "Tune the interface without adding noise to the workbench.",
  },
  {
    id: "agent",
    label: "Agent feed",
    icon: "approach",
    eyebrow: "Conversation",
    description: "Choose what Xiao surfaces while Codex works.",
  },
  {
    id: "models",
    label: "Models",
    icon: "cpu",
    eyebrow: "OpenAI",
    description: "Keep the composer model list focused on what you use.",
  },
  {
    id: "runtime",
    label: "Runtime",
    icon: "runtime",
    eyebrow: "System",
    description: "Inspect the local Codex connection and installation.",
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: "command",
    eyebrow: "Keyboard",
    description: "A compact reference for Xiao's active commands.",
  },
  {
    id: "archived",
    label: "Archive",
    icon: "archive",
    eyebrow: "Data",
    description: "Restore work that was moved out of the active workspace.",
  },
];

const shortcuts = [
  { action: "New task", keys: ["Ctrl", "N"] },
  { action: "Search and commands", keys: ["Ctrl", "K"] },
  { action: "Open runtime", keys: ["Ctrl", "`"] },
  { action: "Send prompt", keys: ["Enter"] },
  { action: "New line in prompt", keys: ["Shift", "Enter"] },
  { action: "Browse prompt history", keys: ["↑", "↓"] },
  { action: "Paste image", keys: ["Ctrl", "V"] },
  { action: "Send line comment", keys: ["Ctrl", "Enter"] },
];

const archivedTaskDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const runtimeLabel = (phase: AgentRuntimeState["phase"]) => {
  if (phase === "ready") return "Connected";
  if (phase === "working") return "Working";
  if (phase === "starting") return "Connecting";
  if (phase === "error") return "Needs attention";
  return "Offline";
};

const runtimeTitle = (phase: AgentRuntimeState["phase"]) => {
  if (phase === "ready") return "Codex is ready";
  if (phase === "working") return "Codex is working";
  if (phase === "starting") return "Codex is connecting";
  if (phase === "error") return "Codex needs attention";
  return "Codex is offline";
};

const runtimeDescription = (runtime: AgentRuntimeState) => {
  if (runtime.error) return runtime.error;
  if (runtime.phase === "ready") return "The local agent runtime is available for tasks.";
  if (runtime.phase === "working") return "The local agent runtime is processing a task.";
  if (runtime.phase === "starting") return "Starting the local agent runtime.";
  return "Reconnect to make the local agent runtime available.";
};

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      className={`settings-toggle ${checked ? "is-on" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row__copy">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  );
}

function SettingsGroup({
  title,
  description,
  meta,
  className = "",
  children,
}: {
  title: string;
  description?: string;
  meta?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`settings-group ${className}`.trim()}>
      <header className="settings-group__header">
        <div>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        {meta ? <small>{meta}</small> : null}
      </header>
      {children}
    </section>
  );
}

function SectionHeader({
  section,
  meta,
}: {
  section: (typeof sections)[number];
  meta: string;
}) {
  return (
    <header className="settings-section__header">
      <div>
        <span>{section.eyebrow}</span>
        <h2 id={`${section.id}-heading`}>{section.label}</h2>
        <p>{section.description}</p>
      </div>
      <small>{meta}</small>
    </header>
  );
}

export function SettingsPage({
  theme,
  preferences,
  models,
  account,
  runtime,
  system,
  codexUpdate,
  codexUpdateResult,
  codexUpdateChecking,
  codexUpdating,
  codexUpdateError,
  archivedTasks,
  archivedTasksLoading,
  archivedTasksError,
  onThemeChange,
  onPreferencesChange,
  onRestoreArchivedTask,
  onReloadArchivedTasks,
  onReconnect,
  onCheckCodexUpdate,
  onUpdateCodex,
  onClose,
}: SettingsPageProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const [modelQuery, setModelQuery] = useState("");
  const sortedArchivedTasks = [...archivedTasks].sort((a, b) => b.updatedAt - a.updatedAt);
  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    return models.filter((model) =>
      !query || `${model.displayName} ${model.model} ${model.description}`.toLowerCase().includes(query)
    );
  }, [modelQuery, models]);
  const notificationsSupported = typeof window !== "undefined" && "Notification" in window;
  const notificationPermission = notificationsSupported ? Notification.permission : "unsupported";
  const activeSectionDefinition = sections.find((section) => section.id === activeSection) ?? sections[0];
  const selectedTheme = themePresets.find((preset) => preset.id === theme) ?? themePresets[0];

  const updateNotification = (
    key: "notifyApprovals" | "notifyCompletions" | "notifyErrors",
    checked: boolean,
  ) => {
    onPreferencesChange({ [key]: checked });
    if (checked && notificationsSupported && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  };

  const toggleModel = (model: string) => {
    const hiddenModels = preferences.hiddenModels.includes(model)
      ? preferences.hiddenModels.filter((item) => item !== model)
      : [...preferences.hiddenModels, model];
    onPreferencesChange({ hiddenModels });
  };

  const sectionMeta = activeSection === "general"
    ? selectedTheme.label
    : activeSection === "models"
      ? `${visibleModels.length} shown`
      : activeSection === "runtime"
        ? runtimeLabel(runtime.phase)
        : activeSection === "shortcuts"
          ? `${shortcuts.length} commands`
          : activeSection === "archived"
            ? `${archivedTasks.length} tasks`
            : notificationPermission;

  return (
    <section className="settings-page">
      <header className="settings-header">
        <div className="settings-header__identity">
          <span className="settings-header__mark"><XiaoIcon name="settings" size={15} /></span>
          <div>
            <h1>Settings</h1>
            <p>Local preferences for your Xiao workspace.</p>
          </div>
        </div>
        <div className="settings-header__actions">
          <div className={`settings-runtime-status is-${runtime.phase}`} role="status">
            <i />
            <span>{runtimeLabel(runtime.phase)}</span>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close settings">
            <XiaoIcon name="close" size={14} />
          </button>
        </div>
      </header>

      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav__track">
          {sections.map((section) => (
            <button
              type="button"
              className={activeSection === section.id ? "is-active" : undefined}
              aria-current={activeSection === section.id ? "page" : undefined}
              aria-controls={`settings-panel-${section.id}`}
              key={section.id}
              onClick={() => setActiveSection(section.id)}
            >
              <XiaoIcon name={section.icon} size={14} />
              <span>{section.label}</span>
              {section.id === "archived" && archivedTasks.length > 0
                ? <small>{archivedTasks.length}</small>
                : null}
            </button>
          ))}
        </div>
      </nav>

      <div className="settings-content">
        <div className="settings-content__inner">
          <section
            className={`settings-section settings-section--${activeSection}`}
            id={`settings-panel-${activeSection}`}
            aria-labelledby={`${activeSection}-heading`}
          >
            <SectionHeader section={activeSectionDefinition} meta={sectionMeta} />

            {activeSection === "general" && (
              <div className="settings-stack">
                <SettingsGroup
                  className="settings-group--themes"
                  title="Theme"
                  description="Color, contrast, and surface character. Changes apply immediately."
                  meta={`${themePresets.length} presets`}
                >
                  <fieldset className="theme-grid">
                    <legend className="settings-sr-only">Theme</legend>
                    {themePresets.map((option) => (
                      <label
                        className={theme === option.id ? "theme-preset is-selected" : "theme-preset"}
                        key={option.id}
                      >
                        <input
                          checked={theme === option.id}
                          name="theme"
                          type="radio"
                          value={option.id}
                          onChange={() => onThemeChange(option.id)}
                        />
                        <span className="theme-preset__swatch" aria-hidden="true">
                          {option.swatches.map((swatch) => (
                            <i key={swatch} style={{ backgroundColor: swatch }} />
                          ))}
                        </span>
                        <span className="theme-preset__copy">
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </span>
                        <span className="theme-preset__check" aria-hidden="true">
                          {theme === option.id ? <XiaoIcon name="check" size={12} strokeWidth={2.2} /> : null}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                </SettingsGroup>

                <div className="settings-grid settings-grid--two">
                  <SettingsGroup title="Appearance" description="Small choices that shape a new task.">
                    <div className="settings-list">
                      <SettingRow
                        title="Start screen mark"
                        description="Choose the symbol above the new-task composer."
                      >
                        <div className="settings-choice" role="group" aria-label="Start screen mark">
                          <button
                            type="button"
                            className={preferences.launchBrand === "logo" ? "is-selected" : undefined}
                            aria-pressed={preferences.launchBrand === "logo"}
                            onClick={() => onPreferencesChange({ launchBrand: "logo" })}
                          >
                            Logo
                          </button>
                          <button
                            type="button"
                            className={preferences.launchBrand === "wordmark" ? "is-selected" : undefined}
                            aria-pressed={preferences.launchBrand === "wordmark"}
                            onClick={() => onPreferencesChange({ launchBrand: "wordmark" })}
                          >
                            XIAO
                          </button>
                        </div>
                      </SettingRow>
                    </div>
                  </SettingsGroup>

                  <SettingsGroup title="Behavior" description="Keep the workspace calm or information-dense.">
                    <div className="settings-list">
                      <SettingRow
                        title="Focused new tasks"
                        description="Collapse side panels for a blank task."
                      >
                        <Toggle
                          label="Focused new tasks"
                          checked={preferences.focusNewTasks}
                          onChange={(focusNewTasks) => onPreferencesChange({ focusNewTasks })}
                        />
                      </SettingRow>
                      <SettingRow
                        title="Wrap long code"
                        description="Wrap previews instead of horizontal scrolling."
                      >
                        <Toggle
                          label="Wrap long code"
                          checked={preferences.wrapCode}
                          onChange={(wrapCode) => onPreferencesChange({ wrapCode })}
                        />
                      </SettingRow>
                    </div>
                  </SettingsGroup>
                </div>
              </div>
            )}

            {activeSection === "agent" && (
              <div className="settings-grid settings-grid--two">
                <SettingsGroup title="Timeline" description="Control the detail level of the live feed.">
                  <div className="settings-list">
                    <SettingRow
                      title="Reasoning summaries"
                      description="Show summaries Codex explicitly publishes."
                    >
                      <Toggle
                        label="Reasoning summaries"
                        checked={preferences.showReasoningSummaries}
                        onChange={(showReasoningSummaries) => onPreferencesChange({ showReasoningSummaries })}
                      />
                    </SettingRow>
                    <SettingRow
                      title="Expand tool output"
                      description="Open command and patch details by default."
                    >
                      <Toggle
                        label="Expand tool output"
                        checked={preferences.expandToolOutput}
                        onChange={(expandToolOutput) => onPreferencesChange({ expandToolOutput })}
                      />
                    </SettingRow>
                  </div>
                </SettingsGroup>

                <SettingsGroup
                  title="Desktop notifications"
                  description="Signal only when a task needs your attention."
                  meta={notificationPermission}
                >
                  <div className="settings-list">
                    <SettingRow title="Task completed" description="Background or scheduled work finished.">
                      <Toggle
                        label="Task completed notifications"
                        checked={preferences.notifyCompletions}
                        onChange={(checked) => updateNotification("notifyCompletions", checked)}
                      />
                    </SettingRow>
                    <SettingRow title="Input requested" description="Xiao paused for permission or a decision.">
                      <Toggle
                        label="Input request notifications"
                        checked={preferences.notifyApprovals}
                        onChange={(checked) => updateNotification("notifyApprovals", checked)}
                      />
                    </SettingRow>
                    <SettingRow title="Runtime errors" description="Codex disconnected or a routine failed.">
                      <Toggle
                        label="Runtime error notifications"
                        checked={preferences.notifyErrors}
                        onChange={(checked) => updateNotification("notifyErrors", checked)}
                      />
                    </SettingRow>
                  </div>
                </SettingsGroup>
              </div>
            )}

            {activeSection === "models" && (
              <div className="settings-stack">
                <label className="settings-search">
                  <XiaoIcon name="search" size={15} />
                  <input
                    type="search"
                    value={modelQuery}
                    placeholder="Search models"
                    onChange={(event) => setModelQuery(event.target.value)}
                  />
                  {modelQuery ? (
                    <button type="button" aria-label="Clear model search" onClick={() => setModelQuery("")}>
                      <XiaoIcon name="close" size={12} />
                    </button>
                  ) : null}
                </label>
                <div className="model-settings-list">
                  {visibleModels.map((model) => {
                    const visible = !preferences.hiddenModels.includes(model.model);
                    return (
                      <article key={model.id}>
                        <span className="model-settings-list__icon">◎</span>
                        <div>
                          <strong>
                            {model.displayName}
                            {model.isDefault ? <small>Default</small> : null}
                          </strong>
                          <p>{model.description || model.model}</p>
                          <code>
                            {model.model}
                            {model.contextWindow
                              ? ` · ${new Intl.NumberFormat().format(model.contextWindow)} context`
                              : ""}
                          </code>
                        </div>
                        <Toggle
                          label={`Show ${model.displayName}`}
                          checked={visible}
                          onChange={() => toggleModel(model.model)}
                        />
                      </article>
                    );
                  })}
                  {!visibleModels.length ? (
                    <div className="settings-empty">
                      <strong>No matching models</strong>
                      <p>Try a different name or model ID.</p>
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            {activeSection === "runtime" && (
              <div className="settings-stack">
                <div className={`runtime-card is-${runtime.phase}`}>
                  <div>
                    <span className="runtime-card__pulse"><i /></span>
                    <div>
                      <strong>{runtimeTitle(runtime.phase)}</strong>
                      <p>{runtimeDescription(runtime)}</p>
                    </div>
                  </div>
                  <button
                    className="button button--quiet"
                    type="button"
                    disabled={codexUpdating || runtime.phase === "starting" || runtime.phase === "working"}
                    onClick={onReconnect}
                  >
                    <XiaoIcon name="refresh" size={13} />
                    Reconnect
                  </button>
                </div>

                <div className="runtime-grid">
                  <div><span>Account</span><strong>{account?.authenticated ? account.email ?? "Authenticated" : "Not authenticated"}</strong><small>{account?.planType ?? account?.authMode ?? "Codex CLI"}</small></div>
                  <div><span>Codex</span><strong>{system.codexVersion ?? "Detecting"}</strong><small>{runtime.eventsSeen.toLocaleString()} events observed</small></div>
                  <div><span>Platform</span><strong>{system.platform}</strong><small>Native Xiao host</small></div>
                  <div><span>Shell</span><strong>{system.shell}</strong><small>Workspace commands</small></div>
                </div>

                <div className={`codex-update-card ${codexUpdate?.updateAvailable ? "is-available" : ""}`}>
                  <span className="codex-update-card__icon">
                    <XiaoIcon
                      className={codexUpdateChecking || codexUpdating ? "is-spinning" : undefined}
                      name={codexUpdateChecking || codexUpdating ? "pending" : "refresh"}
                      size={16}
                    />
                  </span>
                  <div className="codex-update-card__copy">
                    <strong>
                      {codexUpdating
                        ? "Updating Codex"
                        : codexUpdateChecking && !codexUpdate
                          ? "Checking for updates"
                          : codexUpdateError
                            ? "Update check unavailable"
                            : codexUpdate?.updateAvailable
                              ? `Codex ${codexUpdate.latestVersion} is available`
                              : codexUpdate
                                ? "Codex is up to date"
                                : "Codex update status"}
                    </strong>
                    <p>
                      {codexUpdateError
                        ?? (codexUpdate?.updateAvailable
                          ? `Installed ${codexUpdate.currentVersion} via ${codexUpdate.installationSource}. ${codexUpdate.canUpdate ? `Xiao will use ${codexUpdate.updateMethod}.` : "Use the original installer to update."}`
                          : codexUpdate
                            ? `${codexUpdate.currentVersion} is the latest published release.`
                            : "Xiao checks the official Codex npm release when the native app starts.")}
                    </p>
                    {codexUpdateResult
                      ? <small>Updated {codexUpdateResult.previousVersion} to {codexUpdateResult.version}.</small>
                      : null}
                  </div>
                  <div className="codex-update-card__actions">
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={codexUpdateChecking || codexUpdating}
                      onClick={onCheckCodexUpdate}
                    >
                      Check
                    </button>
                    {codexUpdate?.updateAvailable && codexUpdate.canUpdate ? (
                      <button
                        className="button button--primary"
                        type="button"
                        disabled={codexUpdating || runtime.phase === "working" || runtime.phase === "starting"}
                        onClick={onUpdateCodex}
                      >
                        {codexUpdating ? "Updating" : "Update Codex"}
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="settings-note">
                  <XiaoIcon name="target" size={15} />
                  <p>Provider and server controls stay hidden because this build uses one real local Codex runtime.</p>
                </div>
              </div>
            )}

            {activeSection === "shortcuts" && (
              <div className="shortcut-grid">
                {shortcuts.map((shortcut) => (
                  <div key={shortcut.action}>
                    <strong>{shortcut.action}</strong>
                    <span>{shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}</span>
                  </div>
                ))}
              </div>
            )}

            {activeSection === "archived" && (
              archivedTasksLoading ? (
                <div className="archived-tasks-state" role="status">
                  <XiaoIcon className="is-spinning" name="refresh" size={18} />
                  <p>Loading archived tasks…</p>
                </div>
              ) : archivedTasksError ? (
                <div className="archived-tasks-state" role="alert">
                  <XiaoIcon name="archive" size={19} />
                  <strong>Couldn't load archived tasks</strong>
                  <p>{archivedTasksError}</p>
                  <button type="button" onClick={onReloadArchivedTasks}>
                    <XiaoIcon name="refresh" size={14} />
                    Retry
                  </button>
                </div>
              ) : sortedArchivedTasks.length === 0 ? (
                <div className="archived-tasks-state">
                  <XiaoIcon name="archive" size={19} />
                  <strong>No archived tasks</strong>
                  <p>Tasks you archive will appear here.</p>
                </div>
              ) : (
                <ul className="archived-task-list">
                  {sortedArchivedTasks.map((item) => (
                    <li key={`${item.projectPath}:${item.taskId}`}>
                      <div className="archived-task-list__copy">
                        <h3>{item.title}</h3>
                        <p>
                          <span title={item.projectPath}>{item.projectName}</span>
                          <span aria-hidden="true">·</span>
                          <time dateTime={new Date(item.updatedAt).toISOString()}>
                            {archivedTaskDate.format(item.updatedAt)}
                          </time>
                        </p>
                      </div>
                      <button type="button" onClick={() => onRestoreArchivedTask(item)}>Restore</button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
