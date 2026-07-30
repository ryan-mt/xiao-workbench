import { useEffect, useRef, useState } from "react";

import { buildCompanionBrowserPairingUrl } from "./companionClient";
import type {
  CompanionAction,
  CompanionCommand,
  CompanionDevice,
  CompanionPairing,
  CompanionState,
  CompanionTargetScope,
} from "./companionContract";
import "./companion.css";

export type CompanionSurfaceProps = {
  state: CompanionState;
  createCommand: (
    action: CompanionAction,
    targetScope: CompanionTargetScope,
    expectedEntityVersion: number,
  ) => CompanionCommand;
  onCommand: (command: CompanionCommand) => void;
  onReconnect: () => void;
  onOpenAttention: (attentionId: string) => void;
  attentionTargetId?: string | null;
};

export type CompanionHostAuthorityPanelProps = {
  authority: "primary_host";
  devices: CompanionDevice[];
  pairing: CompanionPairing;
  onCreatePairing: () => void;
  onDismissPairing: () => void;
  onRotateSession: (deviceId: string, sessionId: string, expectedVersion: number) => void;
  onRevokeSession: (deviceId: string, sessionId: string, expectedVersion: number) => void;
  onRevokeDevice: (deviceId: string, expectedVersion: number) => void;
};

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const copyText = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through for WebViews where the Clipboard API exists but is permission-gated.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard write failed");
};

export function CompanionCredentialTransfer({
  credential,
  kind,
  expiresAt = null,
  onDismiss,
}: {
  credential: string;
  kind: "pairing" | "rotation";
  expiresAt?: number | null;
  onDismiss: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const title = kind === "pairing"
    ? "Single-use pairing bundle"
    : "Rotation credential — transfer it once";
  const noun = kind === "pairing" ? "pairing bundle" : "rotation credential";
  const copyLabel = kind === "pairing" ? "Copy phone link" : `Copy ${noun}`;

  useEffect(() => {
    setRevealed(false);
    setCopyState("idle");
  }, [credential]);

  return (
    <div className="companion__credential">
      <div className="companion__credential-heading">
        <div>
          <strong>{title}</strong>
          <small>
            {kind === "pairing"
              ? "Open this one-time link in the phone browser you want to connect."
              : "The connected device validates this credential against the pinned host."}
          </small>
          {expiresAt ? <small>Expires {dateTime.format(expiresAt)}</small> : null}
        </div>
        <span className="companion__row-actions">
          <button
            type="button"
            onClick={() => {
              setCopyState("idle");
              const copyValue = kind === "pairing"
                ? buildCompanionBrowserPairingUrl(credential)
                : credential;
              void copyText(copyValue)
                .then(() => setCopyState("copied"))
                .catch(() => setCopyState("failed"));
            }}
          >
            {copyLabel}
          </button>
          <button type="button" onClick={() => setRevealed((current) => !current)}>
            {revealed ? "Hide" : "Reveal"} {noun}
          </button>
          <button type="button" onClick={onDismiss}>Dismiss</button>
        </span>
      </div>
      <span className="companion__credential-status" aria-live="polite">
        {copyState === "copied"
          ? "Copied"
          : copyState === "failed"
            ? "Copy failed. Reveal the credential and copy it manually."
            : ""}
      </span>
      {revealed ? (
        <textarea
          aria-label={title}
          readOnly
          rows={5}
          value={credential}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : null}
    </div>
  );
}

const statusLabel = (state: CompanionState) => {
  if (state.connection === "live") return "Live";
  if (state.connection === "reconciling") return "Reconciling";
  return "Disconnected — stale";
};

const bounded = (value: string, maximum = 160) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
};

export function CompanionHostAuthorityPanel({
  authority,
  devices,
  pairing,
  onCreatePairing,
  onDismissPairing,
  onRotateSession,
  onRevokeSession,
  onRevokeDevice,
}: CompanionHostAuthorityPanelProps) {
  return (
    <section
      className="companion__section companion__devices"
      aria-labelledby="companion-devices"
      data-authority={authority}
    >
      <div className="companion__section-heading">
        <div>
          <h2 id="companion-devices">Devices and sessions</h2>
          <p>Primary-host administration. Owner pairing credentials are short-lived and single-use.</p>
        </div>
        <button
          type="button"
          className="companion__primary-action"
          onClick={onCreatePairing}
          disabled={pairing.status === "creating"}
        >
          {pairing.status === "creating" ? "Creating…" : "Create pairing bundle"}
        </button>
      </div>
      {pairing.status === "ready" && pairing.ownerCredential && pairing.expiresAt ? (
        <CompanionCredentialTransfer
          credential={pairing.ownerCredential}
          kind="pairing"
          expiresAt={pairing.expiresAt}
          onDismiss={onDismissPairing}
        />
      ) : null}
      {pairing.status === "expired" ? (
        <p className="companion__empty" role="status">
          The pairing bundle expired. Create a new one when the device is ready.
        </p>
      ) : null}
      {pairing.status === "failed" ? (
        <p className="companion__inline-error" role="alert">
          Pairing failed. {pairing.error} No session was created; request a new credential.
        </p>
      ) : null}
      {devices.length ? (
        <ul className="companion__device-list">
          {devices.map((device) => (
            <li key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <span>{device.revokedAt ? "Revoked" : "Authorized"} · {device.grants.join(", ")}</span>
              </div>
              {!device.revokedAt ? (
                <button
                  type="button"
                  className="companion__danger-action"
                  onClick={() => onRevokeDevice(device.id, device.version)}
                >
                  Revoke device
                </button>
              ) : null}
              <ul aria-label={`${device.name} sessions`}>
                {device.sessions.map((session) => (
                  <li key={session.id}>
                    <span>
                      Session {session.id} · {session.revokedAt ? "Revoked" : "Active"}
                    </span>
                    {!device.revokedAt && !session.revokedAt ? (
                      <span className="companion__row-actions">
                        <button
                          type="button"
                          onClick={() => onRotateSession(
                            device.id,
                            session.id,
                            session.version,
                          )}
                        >
                          Rotate
                        </button>
                        <button
                          type="button"
                          onClick={() => onRevokeSession(
                            device.id,
                            session.id,
                            session.version,
                          )}
                        >
                          Revoke
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : <p className="companion__empty">No paired devices.</p>}
    </section>
  );
}

export function CompanionSurface({
  state,
  createCommand,
  onCommand,
  onReconnect,
  onOpenAttention,
  attentionTargetId = null,
}: CompanionSurfaceProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [followUps, setFollowUps] = useState<Record<string, string>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [attentionLimit, setAttentionLimit] = useState(50);
  const [pendingAttentionId, setPendingAttentionId] = useState<string | null>(null);
  const commandFocusSignature = useRef("");
  const isWritable = state.connection === "live" && !state.stale;
  const activeProjectId = state.projection.projects.some(
    (project) => project.id === selectedProjectId,
  )
    ? selectedProjectId
    : state.projection.projects[0]?.id ?? null;
  const activeProjects = state.projection.projects.filter(
    (project) => project.id === activeProjectId,
  );
  const activeTasks = state.projection.tasks
    .filter((task) => task.projectId === activeProjectId)
    .slice(0, 100);
  const activeTaskIds = new Set(activeTasks.map((task) => task.id));
  const activeRuns = state.projection.runs
    .filter((run) =>
      run.projectId ? run.projectId === activeProjectId : activeTaskIds.has(run.taskId))
    .slice(0, 100);
  const activeRunIds = new Set(activeRuns.map((run) => run.id));
  const activeAttention = state.projection.attention
    .filter((item) => item.projectId === activeProjectId)
    .slice(0, attentionLimit);
  const commandStatuses = Object.values(state.commands);
  const latestFailure = [...commandStatuses].reverse().find(
    (command) => command.state === "rejected",
  );

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    const signature = Object.entries(state.commands)
      .map(([id, command]) => `${id}:${command.state}`)
      .sort()
      .join("|");
    if (commandFocusSignature.current && signature !== commandFocusSignature.current) {
      headingRef.current?.focus();
    }
    commandFocusSignature.current = signature;
  }, [state.commands]);

  const openAttention = (attentionId: string) => {
    const item = state.projection.attention.find((candidate) => candidate.id === attentionId);
    if (!item) return;
    const projectAttention = state.projection.attention.filter(
      (candidate) => candidate.projectId === item.projectId,
    );
    const index = projectAttention.findIndex((candidate) => candidate.id === attentionId);
    setSelectedProjectId(item.projectId);
    setAttentionLimit(Math.max(50, Math.ceil((index + 1) / 50) * 50));
    setPendingAttentionId(attentionId);
  };

  useEffect(() => {
    if (attentionTargetId) openAttention(attentionTargetId);
  }, [attentionTargetId, state.projection.attention]);

  useEffect(() => {
    if (!pendingAttentionId) return;
    const target = document.getElementById(`companion-attention-${pendingAttentionId}`);
    if (!target) return;
    target.focus();
    onOpenAttention(pendingAttentionId);
    setPendingAttentionId(null);
  }, [activeProjectId, attentionLimit, pendingAttentionId]);

  const send = (
    action: CompanionAction,
    targetScope: CompanionTargetScope,
    expectedVersion: number,
  ) => onCommand(createCommand(action, targetScope, expectedVersion));

  return (
    <main className="companion" aria-labelledby="companion-heading">
      <header className="companion__header">
        <div className="companion__header-copy">
          <span className="companion__eyebrow">Companion access</span>
          <h1 id="companion-heading" ref={headingRef} tabIndex={-1}>
            Xiao Companion
          </h1>
          <p>Monitor work and make bounded interventions. The primary host remains authoritative.</p>
        </div>
        <div className={`companion__connection is-${state.connection}`} role="status">
          <strong>{statusLabel(state)}</strong>
          <span>
            {state.capturedAt === null
              ? "No host snapshot"
              : `Host snapshot ${dateTime.format(state.capturedAt)}`}
          </span>
        </div>
      </header>

      <p className="companion__announcer" aria-live="polite" aria-atomic="true">
        {state.lastAnnouncement}
      </p>

      <nav className="companion__nav-jump" aria-label="Companion sections">
        <a href="#companion-projects">Projects</a>
        <a href="#companion-runs">Runs</a>
        <a href="#companion-attention">Attention</a>
        <a href="#companion-timeline">Timeline</a>
      </nav>

      {state.stale ? (
        <section className="companion__notice" aria-label="Stale Companion data">
          <div>
            <strong>{state.connection === "reconciling" ? "Reconciliation in progress" : "Cached data is stale"}</strong>
            <span>
              {state.connection === "reconciling"
                ? "Missed host updates must be reconciled before actions are available."
                : "Reconnect to the primary host before relying on this view or taking action."}
            </span>
          </div>
          {state.connection === "disconnected" ? (
            <button type="button" className="companion__primary-action" onClick={onReconnect}>Reconnect</button>
          ) : null}
        </section>
      ) : null}

      {latestFailure?.state === "rejected" ? (
        <section className="companion__error" role="alert" aria-label="Companion action error">
          <strong>{latestFailure.error.scope}</strong>
          <p>Durable effect: {latestFailure.error.durableEffect}</p>
          <p>Safe recovery: {latestFailure.error.recovery}</p>
        </section>
      ) : null}

      <div className="companion__layout">
        <section className="companion__section" aria-labelledby="companion-projects">
          <div className="companion__section-heading">
            <div>
              <h2 id="companion-projects">Projects and Tasks</h2>
              <p>Authorized summaries from the primary host.</p>
            </div>
          </div>
          {state.projection.projects.length ? (
            <label className="companion__project-picker">
              Project
              <select
                value={activeProjectId ?? ""}
                onChange={(event) => {
                  setSelectedProjectId(event.currentTarget.value);
                  setAttentionLimit(50);
                }}
              >
                {state.projection.projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          {state.projection.projects.length ? (
            <ul className="companion__summary-list">
              {activeProjects.map((project) => (
                <li key={project.id}>
                  <strong>{project.name}</strong>
                  <span>{project.taskCount} Tasks · {project.attentionCount} need attention</span>
                  <ul>
                    {activeTasks.map((task) => (
                      <li key={task.id}>
                        <div>
                          <strong>{task.title}</strong>
                          <span>{task.stage.replaceAll("_", " ")} · version {task.version}</span>
                        </div>
                        {task.outcomeAcceptancePermitted ? (
                          <button
                            type="button"
                            className="companion__primary-action"
                            disabled={!isWritable}
                            onClick={() => send(
                              { kind: "accept_outcome", taskId: task.id },
                              { projectId: project.id, taskId: task.id },
                              task.version,
                            )}
                          >
                            Accept outcome
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : <p className="companion__empty">No authorized Project summaries.</p>}
        </section>

        <section className="companion__section" aria-labelledby="companion-runs">
          <div className="companion__section-heading">
            <div>
              <h2 id="companion-runs">Runs</h2>
              <p>Run state, pending input, verification, and Observatory summaries.</p>
            </div>
          </div>
          <ul className="companion__run-list">
            {activeRuns.map((run) => {
              const verification = state.projection.verification.find((item) => item.runId === run.id);
              const observatory = state.projection.observatory.find((item) => item.runId === run.id);
              const pending = state.projection.pendingInputs.filter((item) => item.runId === run.id);
              const followUp = followUps[run.id] ?? "";
              return (
                <li key={run.id}>
                  <div className="companion__run-heading">
                    <div>
                      <strong>Run {run.id}</strong>
                      <span>{run.status} · {bounded(run.safeSummary)}</span>
                    </div>
                    <div className="companion__row-actions">
                      {run.canStop ? (
                        <button
                          type="button"
                          className="companion__danger-action"
                          disabled={!isWritable}
                          onClick={() => send(
                            { kind: "stop_run", runId: run.id },
                            { taskId: run.taskId, runId: run.id },
                            run.version,
                          )}
                        >
                          Stop
                        </button>
                      ) : null}
                      {run.canRetry ? (
                        <button
                          type="button"
                          disabled={!isWritable}
                          onClick={() => send(
                            { kind: "retry_run", runId: run.id },
                            { taskId: run.taskId, runId: run.id },
                            run.version,
                          )}
                        >
                          Retry
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <dl>
                    <div>
                      <dt>Verification</dt>
                      <dd>{verification ? `${verification.status}: ${bounded(verification.safeSummary)}` : "Not shared"}</dd>
                    </div>
                    <div>
                      <dt>Observatory</dt>
                      <dd>
                        {observatory
                          ? `${observatory.activeAgents} active, ${observatory.waitingAgents} waiting`
                          : "Not shared"}
                      </dd>
                    </div>
                  </dl>
                  {pending.map((input) => (
                    <fieldset key={input.id} disabled={!isWritable}>
                      <legend>{input.kind.replaceAll("_", " ")} · {bounded(input.safePrompt)}</legend>
                      <div className="companion__row-actions">
                        {input.options.map((option) => (
                          <button
                            type="button"
                            key={option.id}
                            disabled={!isWritable}
                            onClick={() => send(
                              {
                                kind: "resolve_pending_input",
                                pendingInputId: input.id,
                                inputKind: input.kind,
                                optionId: option.id,
                              },
                              {
                                taskId: run.taskId,
                                runId: run.id,
                                pendingInputId: input.id,
                              },
                              input.version,
                            )}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                  {run.canFollowUp ? (
                    <div className="companion__follow-up">
                      <label htmlFor={`follow-up-${run.id}`}>Bounded follow-up</label>
                      <textarea
                        id={`follow-up-${run.id}`}
                        maxLength={500}
                        value={followUp}
                        onChange={(event) => setFollowUps({
                          ...followUps,
                          [run.id]: event.currentTarget.value,
                        })}
                      />
                      <button
                        type="button"
                        className="companion__primary-action"
                        disabled={!isWritable || !followUp.trim()}
                        onClick={() => send(
                          { kind: "follow_up", runId: run.id, message: followUp.trim() },
                          { taskId: run.taskId, runId: run.id },
                          run.version,
                        )}
                      >
                        Send follow-up
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="companion__section" aria-labelledby="companion-attention">
          <div className="companion__section-heading">
            <div>
              <h2 id="companion-attention">Attention</h2>
              <p>Privacy-safe summaries deep-link to the canonical host item.</p>
            </div>
          </div>
          <ul className="companion__attention-list">
            {activeAttention.map((item) => (
              <li
                key={item.id}
                id={`companion-attention-${item.id}`}
                tabIndex={-1}
              >
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.kind} · {bounded(item.safeSummary)}</span>
                </div>
                <div className="companion__row-actions">
                  <button type="button" onClick={() => openAttention(item.id)}>
                    Open canonical item
                  </button>
                  {!item.acknowledged ? (
                    <button
                      type="button"
                      disabled={!isWritable}
                      onClick={() => send(
                        { kind: "acknowledge_attention", attentionId: item.id },
                        {
                          projectId: item.projectId,
                          taskId: item.taskId,
                          runId: item.runId ?? undefined,
                          attentionId: item.id,
                        },
                        item.version,
                      )}
                    >
                      Acknowledge
                    </button>
                  ) : <span>Acknowledged</span>}
                </div>
              </li>
            ))}
          </ul>
          {activeAttention.length < state.projection.attention.filter(
            (item) => item.projectId === activeProjectId,
          ).length ? (
            <button type="button" onClick={() => setAttentionLimit((value) => value + 50)}>
              Show 50 more Attention items
            </button>
          ) : null}
        </section>

        <section className="companion__section companion__timeline" aria-labelledby="companion-timeline">
          <div className="companion__section-heading">
            <div>
              <h2 id="companion-timeline">Safe timeline</h2>
              <p>Bounded summaries only; terminals, arbitrary files, and host settings are unavailable.</p>
            </div>
          </div>
          <ol>
            {state.projection.timeline.filter((entry) => activeRunIds.has(entry.runId)).slice(-200)
              .map((entry) => (
              <li key={entry.id}>
                <time dateTime={new Date(entry.occurredAt).toISOString()}>
                  {dateTime.format(entry.occurredAt)}
                </time>
                <div>
                  <strong>{entry.kind}</strong>
                  <span>{bounded(entry.safeSummary)}</span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
