import { useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type {
  AgentAccountUsage,
  AgentRuntimeState,
  CodexUsageSnapshot,
} from "../../../core/models/agent";
import {
  profileInitials,
  type LocalUserProfile,
} from "../hooks/useLocalProfile";
import "../styles/profile.css";

type ProfilePageProps = {
  accountUsage: AgentAccountUsage | null;
  profile: LocalUserProfile;
  runtime: AgentRuntimeState;
  usage: CodexUsageSnapshot;
  onClose: () => void;
  onSaveProfile: (profile: LocalUserProfile) => void;
};

const fullNumber = new Intl.NumberFormat();
const compactNumber = (value: number) => {
  const units = [
    { threshold: 1_000_000_000_000, suffix: "T" },
    { threshold: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, suffix: "M" },
    { threshold: 1_000, suffix: "K" },
  ];
  const unit = units.find(({ threshold }) => Math.abs(value) >= threshold);
  if (!unit) return fullNumber.format(value);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value / unit.threshold)}${unit.suffix}`;
};
const compactDuration = (seconds: number | null | undefined) => {
  if (!seconds) return "--";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h ${minutes}m`;
};
const monthLabel = new Intl.DateTimeFormat(undefined, { month: "short" });
const dayLabel = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const avatarSize = 256;

const createAvatar = (file: File) =>
  new Promise<string>((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Choose an image file."));
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      reject(new Error("Choose an image smaller than 15 MB."));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Xiao could not read that image."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Xiao could not open that image."));
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = avatarSize;
        canvas.height = avatarSize;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("Xiao could not prepare that image."));
          return;
        }
        const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
        const sourceX = (image.naturalWidth - sourceSize) / 2;
        const sourceY = (image.naturalHeight - sourceSize) / 2;
        context.drawImage(
          image,
          sourceX,
          sourceY,
          sourceSize,
          sourceSize,
          0,
          0,
          avatarSize,
          avatarSize,
        );
        resolve(canvas.toDataURL("image/webp", 0.86));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });

const localDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const contributionDays = (usage: CodexUsageSnapshot) => {
  const totals = new Map(usage.days.map((day) => [day.date, day.totalTokens]));
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  const days = Array.from({ length: 365 }, (_, index) => {
    const date = new Date(start);
    date.setDate(date.getDate() + index);
    return { date, key: localDateKey(date), tokens: totals.get(localDateKey(date)) ?? 0 };
  });
  const max = Math.max(0, ...days.map((day) => day.tokens));
  return days.map((day) => ({
    ...day,
    level: day.tokens === 0 || max === 0 ? 0 : Math.max(1, Math.ceil((day.tokens / max) * 4)),
  }));
};

export function ProfilePage({
  accountUsage,
  profile,
  runtime,
  usage,
  onClose,
  onSaveProfile,
}: ProfilePageProps) {
  const [editing, setEditing] = useState(!profile.name);
  const [draftName, setDraftName] = useState(profile.name);
  const [draftAvatar, setDraftAvatar] = useState(profile.avatarDataUrl);
  const [profileError, setProfileError] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const initials = profileInitials(profile.name);
  const accountDays = accountUsage?.dailyUsageBuckets.map((bucket) => ({
    date: bucket.startDate.slice(0, 10),
    totalTokens: bucket.tokens,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  }));
  const activityUsage: CodexUsageSnapshot = accountUsage
    ? {
        days: accountDays ?? [],
        totals: {
          ...usage.totals,
          totalTokens:
            accountUsage.lifetimeTokens ??
            accountDays?.reduce((sum, day) => sum + day.totalTokens, 0) ??
            usage.totals.totalTokens,
        },
        activeDays: accountDays?.filter((day) => day.totalTokens > 0).length ?? 0,
        currentStreak: accountUsage.currentStreakDays ?? 0,
        longestStreak: accountUsage.longestStreakDays ?? 0,
      }
    : usage;
  const days = contributionDays(activityUsage);
  const leadingPlaceholders = days[0]?.date.getDay() ?? 0;
  const calendarCells = [
    ...Array.from({ length: leadingPlaceholders }, () => null),
    ...days,
  ];
  const monthLabels = days.filter(
    (day, index) => day.date.getDate() <= 7 && (index + leadingPlaceholders) % 7 === 0,
  );
  const connected = runtime.phase === "ready" || runtime.phase === "working";
  const peakDailyTokens =
    accountUsage?.peakDailyTokens ?? Math.max(0, ...activityUsage.days.map((day) => day.totalTokens));
  const tokenRows = [
    {
      id: "input",
      label: "Input",
      description: "Prompts and attached context",
      value: usage.totals.inputTokens,
    },
    {
      id: "cached",
      label: "Cached input",
      description: "Context reused by Codex",
      value: usage.totals.cachedInputTokens,
    },
    {
      id: "output",
      label: "Output",
      description: "Responses and tool results",
      value: usage.totals.outputTokens,
    },
    {
      id: "reasoning",
      label: "Reasoning",
      description: "Internal reasoning output",
      value: usage.totals.reasoningOutputTokens,
    },
  ];
  const maxTokenRow = Math.max(1, ...tokenRows.map((row) => row.value));

  const openEditor = () => {
    setDraftName(profile.name);
    setDraftAvatar(profile.avatarDataUrl);
    setProfileError(null);
    setEditing(true);
  };

  const closeEditor = () => {
    if (!profile.name) {
      onClose();
      return;
    }
    setEditing(false);
  };

  const chooseAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      setDraftAvatar(await createAvatar(file));
      setProfileError(null);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Xiao could not use that image.");
    }
  };

  const saveProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = draftName.trim();
    if (!name) {
      setProfileError("Enter the name you want Xiao to use.");
      return;
    }
    onSaveProfile({ name, avatarDataUrl: draftAvatar });
    setEditing(false);
  };

  return (
    <section className="profile-page">
      <div className="profile-shell">
        <header className="profile-toolbar">
          <div>
            <span className="profile-eyebrow">Local account</span>
            <h1>Profile &amp; usage</h1>
            <p>Identity and Codex activity stored by Xiao on this device.</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close profile">
            <XiaoIcon name="close" size={14} />
          </button>
        </header>

        <div className="profile-layout">
          <aside className="profile-sidebar" aria-label="Local profile">
            <div className="profile-identity">
              <button className="profile-avatar" type="button" onClick={openEditor} aria-label="Edit profile">
                {profile.avatarDataUrl ? (
                  <img src={profile.avatarDataUrl} alt="" />
                ) : initials ? (
                  initials
                ) : (
                  <XiaoIcon name="user" size={24} />
                )}
              </button>
              <div>
                <span className="profile-eyebrow">Local identity</span>
                <h2>{profile.name || "Set up your profile"}</h2>
                <p>
                  {profile.name
                    ? "Used across Xiao tasks"
                    : "Add the name and photo Xiao should use"}
                </p>
              </div>
            </div>

            <button className="profile-edit-button" type="button" onClick={openEditor}>
              <XiaoIcon name="edit" size={14} />
              <span>Edit local profile</span>
            </button>

            <dl className="profile-facts">
              <div>
                <dt>Codex</dt>
                <dd className={connected ? "is-connected" : ""}>
                  <i /> {connected ? "Connected" : "Reconnecting"}
                </dd>
              </div>
              <div>
                <dt>Profile data</dt>
                <dd>On this device</dd>
              </div>
              <div>
                <dt>Runtime</dt>
                <dd>{runtime.phase}</dd>
              </div>
            </dl>

            <p className="profile-privacy-note">
              Xiao keeps your display name and photo local. Usage values come from Codex events.
            </p>
          </aside>

          <main className="profile-main">
            <section className="profile-section profile-activity" aria-labelledby="profile-activity-title">
              <header className="profile-section-heading">
                <div>
                  <h2 id="profile-activity-title">Activity</h2>
                  <p>Codex usage in your local timezone.</p>
                </div>
                <span>Last 365 days</span>
              </header>

              <dl className="profile-summary-grid">
                <div className="profile-summary-grid__primary">
                  <dt>Lifetime tokens</dt>
                  <dd title={fullNumber.format(activityUsage.totals.totalTokens)}>
                    {compactNumber(activityUsage.totals.totalTokens)}
                  </dd>
                  <small>{fullNumber.format(activityUsage.totals.totalTokens)} reported</small>
                </div>
                <div>
                  <dt>Current streak</dt>
                  <dd>{activityUsage.currentStreak}<small> days</small></dd>
                </div>
                <div>
                  <dt>Active days</dt>
                  <dd>{activityUsage.activeDays}</dd>
                </div>
                <div>
                  <dt>Longest streak</dt>
                  <dd>{activityUsage.longestStreak}<small> days</small></dd>
                </div>
                <div>
                  <dt>Peak day</dt>
                  <dd title={fullNumber.format(peakDailyTokens)}>{compactNumber(peakDailyTokens)}</dd>
                </div>
                <div>
                  <dt>Longest turn</dt>
                  <dd>{compactDuration(accountUsage?.longestRunningTurnSec)}</dd>
                </div>
              </dl>

              <div className="profile-heatmap">
                <div className="contribution-months" aria-hidden="true">
                  {monthLabels.map((day) => <span key={day.key}>{monthLabel.format(day.date)}</span>)}
                </div>
                <div className="profile-heatmap__plot">
                  <div className="profile-heatmap__weekdays" aria-hidden="true">
                    <span>M</span>
                    <span>W</span>
                    <span>F</span>
                  </div>
                  <div className="contribution-grid" aria-label="Token activity over the last year">
                    {calendarCells.map((day, index) => day ? (
                      <span
                        className={`contribution-day level-${day.level}`}
                        data-date={day.key}
                        key={day.key}
                        title={`${dayLabel.format(day.date)}: ${fullNumber.format(day.tokens)} tokens`}
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="contribution-day contribution-day--placeholder"
                        key={`placeholder-${index}`}
                      />
                    ))}
                  </div>
                </div>
                <footer className="profile-heatmap__legend">
                  <span>Less</span>
                  {[0, 1, 2, 3, 4].map((level) => <i className={`level-${level}`} key={level} />)}
                  <span>More</span>
                </footer>
              </div>
            </section>

            <section className="profile-section profile-ledger" aria-labelledby="profile-ledger-title">
              <header className="profile-section-heading">
                <div>
                  <h2 id="profile-ledger-title">Token breakdown</h2>
                  <p>Observed usage emitted during Xiao tasks.</p>
                </div>
                <strong title={fullNumber.format(usage.totals.totalTokens)}>
                  {compactNumber(usage.totals.totalTokens)} total
                </strong>
              </header>

              <div className="profile-token-rows">
                {tokenRows.map((row) => (
                  <div className={`profile-token-row profile-token-row--${row.id}`} key={row.id}>
                    <div>
                      <strong>{row.label}</strong>
                      <span>{row.description}</span>
                    </div>
                    <div className="profile-token-meter" aria-hidden="true">
                      <i
                        style={{
                          width: `${row.value ? Math.max(3, (row.value / maxTokenRow) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <strong title={fullNumber.format(row.value)}>{compactNumber(row.value)}</strong>
                  </div>
                ))}
              </div>

              <footer className="profile-ledger__note">
                <XiaoIcon name="result" size={15} />
                <p>
                  Source: <code>thread/tokenUsage/updated</code>. Xiao stores emitted deltas and
                  does not estimate tokens from text.
                </p>
              </footer>
            </section>
          </main>
        </div>
      </div>

      {editing ? (
        <div className="profile-modal" role="presentation">
          <form
            className="profile-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-editor-title"
            onSubmit={saveProfile}
          >
            <header>
              <span className="profile-eyebrow">Personalize Xiao</span>
              <h2 id="profile-editor-title">{profile.name ? "Edit profile" : "Create your profile"}</h2>
              <p>Your name and photo stay on this device.</p>
            </header>

            <div className="profile-avatar-editor">
              <button
                className={`profile-avatar-picker ${draftAvatar ? "has-image" : ""}`}
                type="button"
                aria-label="Choose profile photo"
                onClick={() => avatarInputRef.current?.click()}
              >
                {draftAvatar ? (
                  <img src={draftAvatar} alt="Profile preview" />
                ) : draftName.trim() ? (
                  profileInitials(draftName)
                ) : (
                  <XiaoIcon name="user" size={25} />
                )}
                <span><XiaoIcon name="edit" size={12} /></span>
              </button>
              <div>
                <strong>Profile photo</strong>
                <p>Choose a clear square image. Xiao will crop it automatically.</p>
                <div className="profile-avatar-actions">
                  <button type="button" onClick={() => avatarInputRef.current?.click()}>
                    {draftAvatar ? "Change photo" : "Choose photo"}
                  </button>
                  {draftAvatar ? (
                    <button type="button" onClick={() => setDraftAvatar(null)}>Remove</button>
                  ) : null}
                </div>
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => void chooseAvatar(event)}
              />
            </div>

            <label className="profile-name-field">
              <span>Display name</span>
              <input
                autoFocus
                maxLength={40}
                placeholder="How should Xiao call you?"
                value={draftName}
                onChange={(event) => {
                  setDraftName(event.target.value);
                  setProfileError(null);
                }}
              />
            </label>
            {profileError ? <p className="profile-editor__error" role="alert">{profileError}</p> : null}

            <footer>
              <button className="profile-editor__cancel" type="button" onClick={closeEditor}>
                {profile.name ? "Cancel" : "Not now"}
              </button>
              <button className="profile-editor__save" type="submit">Save profile</button>
            </footer>
          </form>
        </div>
      ) : null}
    </section>
  );
}
