import { useCallback, useEffect, useRef, useState } from "react";

import { companionReducer, buildCompanionCommand, initialCompanionState } from "./companionContract";
import type { CompanionCommand, CompanionState } from "./companionContract";
import {
  executeCompanionCommand,
  pairCompanionDevice,
  reconcileCompanion,
  type CompanionNotificationCursor,
  type CompanionSessionReference,
} from "./companionClient";
import { CompanionHostPage } from "./CompanionHostPage";
import { CompanionPairingForm } from "./CompanionPairingForm";
import { CompanionSurface } from "./CompanionSurface";
import { nativeCompanionClient } from "./nativeCompanionClient";
import "./companion.css";

const SESSION_KEY = "xiao.companion.session.v1";
const CACHE_KEY = "xiao.companion.cache.v1";
const DEVICE_KEY = "xiao.companion.device.v1";

const loadSession = (): CompanionSessionReference | null => {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as Partial<
      CompanionSessionReference
    > | null;
    if (
      !value
      || typeof value.referenceId !== "string"
      || typeof value.sessionId !== "string"
      || typeof value.deviceId !== "string"
      || typeof value.endpoint !== "string"
      || typeof value.certificateFingerprint !== "string"
      || typeof value.generation !== "number"
    ) return null;
    return {
      referenceId: value.referenceId,
      sessionId: value.sessionId,
      deviceId: value.deviceId,
      generation: value.generation,
      endpoint: value.endpoint,
      certificateFingerprint: value.certificateFingerprint,
    };
  } catch {
    return null;
  }
};

const loadCache = (): CompanionState => {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as CompanionState | null;
    if (!value || !value.projection || typeof value.commands !== "object") {
      return initialCompanionState();
    }
    return companionReducer(value, { type: "disconnected" });
  } catch {
    return initialCompanionState();
  }
};

const deviceId = () => {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(DEVICE_KEY, created);
  return created;
};

export function CompanionPage() {
  const [mode, setMode] = useState<"host" | "client">("host");
  const [session, setSession] = useState<CompanionSessionReference | null>(loadSession);
  const [state, setState] = useState<CompanionState>(loadCache);
  const [pairing, setPairing] = useState(false);
  const [rotationCode, setRotationCode] = useState("");
  const [installingRotation, setInstallingRotation] = useState(false);
  const [attentionTargetId, setAttentionTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  const reconciling = useRef(false);
  const commandInFlight = useRef(false);
  const notificationCursor = useRef<CompanionNotificationCursor | null>(null);

  useEffect(() => {
    notificationCursor.current = null;
  }, [session?.referenceId]);

  const publish = useCallback((next: CompanionState) => {
    stateRef.current = next;
    setState(next);
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  }, []);

  const reconcile = useCallback(async (target = session) => {
    if (!target || reconciling.current || commandInFlight.current) return;
    reconciling.current = true;
    try {
      const next = await reconcileCompanion(
        stateRef.current,
        target,
        nativeCompanionClient,
        publish,
      );
      publish(next);
      setError(null);
    } catch (reason) {
      publish(companionReducer(stateRef.current, { type: "disconnected" }));
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      reconciling.current = false;
    }
  }, [publish, session]);

  useEffect(() => {
    if (mode !== "client" || !session) return;
    void reconcile(session);
    const timer = window.setInterval(() => void reconcile(session), 2_000);
    return () => window.clearInterval(timer);
  }, [mode, reconcile, session]);

  useEffect(() => {
    if (mode !== "client" || !session || state.connection !== "live") return;
    let cancelled = false;
    let pollInFlight = false;
    const poll = async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const page = await nativeCompanionClient.pollNotifications(
          session,
          notificationCursor.current,
        );
        if (cancelled) return;
        notificationCursor.current = page.nextCursor;
        for (const item of page.notifications) {
          if (item.deepLink !== `xiao://attention/${item.attentionId}`) continue;
          if ("Notification" in window && Notification.permission === "granted") {
            const notice = new Notification(item.title, { body: item.body, tag: item.attentionId });
            notice.onclick = () => {
              window.focus();
              setAttentionTargetId(item.attentionId);
              notice.close();
            };
          }
        }
      } catch {
        // Reconciliation is the authoritative connection signal; notifications remain optional.
      } finally {
        pollInFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [mode, session, state.connection]);

  const execute = async (command: CompanionCommand) => {
    if (!session) return;
    if (commandInFlight.current) {
      setError(
        "Another Companion action is still awaiting the primary host. Wait for it to finish before trying again.",
      );
      return;
    }
    commandInFlight.current = true;
    let acknowledged = false;
    try {
      await executeCompanionCommand(
        stateRef.current,
        session,
        command,
        nativeCompanionClient,
        publish,
      );
      acknowledged = true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      commandInFlight.current = false;
    }
    if (acknowledged) await reconcile(session);
  };

  return (
    <div className="companion-shell">
      <nav className="companion__mode" aria-label="Companion mode">
        <button type="button" aria-pressed={mode === "host"} onClick={() => setMode("host")}>
          Primary host
        </button>
        <button type="button" aria-pressed={mode === "client"} onClick={() => setMode("client")}>
          Connected device
        </button>
      </nav>
      {mode === "host" ? <CompanionHostPage /> : session ? (
        <>
          <div className="companion__client-controls">
            <span>Paired with {session.endpoint}</span>
            <label>
              Rotation code
              <input
                type="password"
                autoComplete="off"
                value={rotationCode}
                onChange={(event) => setRotationCode(event.currentTarget.value)}
              />
            </label>
            <div className="companion__client-actions">
              <button
                type="button"
                className="companion__primary-action"
                disabled={!rotationCode.trim() || installingRotation}
                onClick={() => {
                  setInstallingRotation(true);
                  setError(null);
                  void nativeCompanionClient.installRotation(session, rotationCode).then((next) => {
                    localStorage.setItem(SESSION_KEY, JSON.stringify(next));
                    setSession(next);
                    setRotationCode("");
                    publish(companionReducer(stateRef.current, { type: "disconnected" }));
                  }).catch((reason) => {
                    setError(reason instanceof Error ? reason.message : String(reason));
                  }).finally(() => setInstallingRotation(false));
                }}
              >
                {installingRotation ? "Installing…" : "Install rotated credential"}
              </button>
              <button
                type="button"
                className="companion__danger-action"
                onClick={async () => {
                  setError(null);
                  try {
                    await nativeCompanionClient.delete(session);
                    localStorage.removeItem(SESSION_KEY);
                    setSession(null);
                    publish(initialCompanionState());
                  } catch (reason) {
                    setError(
                      `The credential may still remain in the native keyring. Retry forgetting this host. ${
                        reason instanceof Error ? reason.message : String(reason)
                      }`,
                    );
                  }
                }}
              >
                Forget this host
              </button>
            </div>
          </div>
          {error ? <p className="companion__client-error" role="alert">{error}</p> : null}
          <CompanionSurface
            state={state}
            createCommand={(action, targetScope, expectedVersion) => {
              const commandId = crypto.randomUUID();
              return buildCompanionCommand(
                {
                  deviceId: session.deviceId,
                  commandId,
                  idempotencyKey: `${session.deviceId}:${commandId}`,
                  auditTimestamp: Date.now(),
                },
                expectedVersion,
                targetScope,
                action,
              );
            }}
            onCommand={(command) => void execute(command)}
            onReconnect={() => void reconcile(session)}
            attentionTargetId={attentionTargetId}
            onOpenAttention={() => setAttentionTargetId(null)}
          />
        </>
      ) : (
        <main className="companion">
          <CompanionPairingForm
            busy={pairing}
            error={error}
            onPair={({ pairingCode, deviceName }) => {
              setPairing(true);
              setError(null);
              void pairCompanionDevice(
                { pairingCode, deviceId: deviceId(), deviceName },
                nativeCompanionClient,
              ).then((paired) => {
                localStorage.setItem(SESSION_KEY, JSON.stringify(paired));
                setSession(paired);
              }).catch((reason) => {
                setError(reason instanceof Error ? reason.message : String(reason));
              }).finally(() => setPairing(false));
            }}
          />
        </main>
      )}
    </div>
  );
}
