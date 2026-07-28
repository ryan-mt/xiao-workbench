import { useEffect, useRef, useState } from "react";

import { isTauriHost, nativeBridge } from "../../core/bridges/tauri";
import type {
  CompanionSession,
} from "../../core/models/companion";
import {
  evaluateReleaseAssurance,
  RELEASE_ASSURANCE_MANIFEST,
} from "../release-assurance/releaseAssurance";
import type { CompanionDevice, CompanionPairing } from "./companionContract";
import {
  CompanionCredentialTransfer,
  CompanionHostAuthorityPanel,
} from "./CompanionSurface";

const releaseReport = evaluateReleaseAssurance(RELEASE_ASSURANCE_MANIFEST);

const readableGrant = (grant: string) =>
  grant.split("_").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");

export const groupCompanionDevices = (
  sessions: readonly CompanionSession[],
): CompanionDevice[] => {
  const grouped = new Map<string, CompanionSession[]>();
  for (const session of sessions) {
    grouped.set(session.deviceId, [...(grouped.get(session.deviceId) ?? []), session]);
  }
  return [...grouped.entries()].map(([deviceId, deviceSessions]) => {
    const activeSessions = deviceSessions.filter((session) => session.revokedAt === null);
    return {
      id: deviceId,
      name: deviceSessions[0]?.deviceName ?? deviceId,
      version: Math.max(...deviceSessions.map((session) => session.generation)),
      createdAt: Math.min(...deviceSessions.map((session) => session.createdAt * 1_000)),
      lastSeenAt: Math.max(...deviceSessions.map((session) => session.lastSeenAt * 1_000)),
      grants: [...new Set(activeSessions.flatMap((session) => session.grants))].map(readableGrant),
      revokedAt: activeSessions.length
        ? null
        : Math.max(...deviceSessions.map((session) => (session.revokedAt ?? 0) * 1_000)),
      sessions: deviceSessions.map((session) => ({
        id: session.sessionId,
        version: session.generation,
        createdAt: session.createdAt * 1_000,
        lastSeenAt: session.lastSeenAt * 1_000,
        rotatedAt: session.rotatedAt === null ? null : session.rotatedAt * 1_000,
        revokedAt: session.revokedAt === null ? null : session.revokedAt * 1_000,
      })),
    };
  });
};

export function CompanionHostPage() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const restoreAuthorityFocus = useRef(false);
  const [sessions, setSessions] = useState<CompanionSession[]>([]);
  const [pairing, setPairing] = useState<CompanionPairing>({
    status: "idle",
    ownerCredential: null,
    expiresAt: null,
    error: null,
  });
  const [rotationCode, setRotationCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!isTauriHost()) return;
    try {
      setSessions(await nativeBridge.listCompanionSessions());
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!restoreAuthorityFocus.current) return;
    restoreAuthorityFocus.current = false;
    headingRef.current?.focus();
  }, [sessions]);

  useEffect(() => {
    if (pairing.status !== "ready" || pairing.expiresAt === null) return;
    const expire = () => setPairing({
      status: "expired",
      ownerCredential: null,
      expiresAt: null,
      error: null,
    });
    const remaining = pairing.expiresAt - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    const timer = window.setTimeout(expire, remaining);
    return () => window.clearTimeout(timer);
  }, [pairing.expiresAt, pairing.status]);

  const currentSession = (sessionId: string, expectedVersion: number) => {
    const session = sessions.find((item) => item.sessionId === sessionId);
    if (!session || session.generation !== expectedVersion) {
      setError("The Companion session changed. Reload its current primary-host state and try again.");
      return null;
    }
    return session;
  };

  return (
    <main className="companion" aria-labelledby="companion-host-heading">
      <header className="companion__header">
        <div>
          <span className="companion__eyebrow">Primary-host authority</span>
          <h1 id="companion-host-heading" ref={headingRef} tabIndex={-1}>Companion access</h1>
          <p>Pair, inspect, rotate, and revoke bounded Companion sessions.</p>
        </div>
        <div className="companion__connection is-live" role="status">
          <strong>{releaseReport.passes ? "Release evidence passing" : "Release evidence blocked"}</strong>
          <span>{releaseReport.rowResults.filter((row) => row.passes).length} of 26 baseline dispositions</span>
        </div>
      </header>

      {error ? (
        <section className="companion__error" role="alert">
          <strong>Companion host state</strong>
          <p>Durable effect: no unacknowledged host change is reported as successful.</p>
          <p>Safe recovery: {error}</p>
        </section>
      ) : null}

      {rotationCode ? (
        <CompanionCredentialTransfer
          credential={rotationCode}
          kind="rotation"
          onDismiss={() => setRotationCode(null)}
        />
      ) : null}

      <CompanionHostAuthorityPanel
        authority="primary_host"
        devices={groupCompanionDevices(sessions)}
        pairing={pairing}
        onCreatePairing={() => {
          setPairing((current) => ({ ...current, status: "creating", error: null }));
          void nativeBridge.issueCompanionPairingBundle().then((bundle) => {
            setPairing({
              status: "ready",
              ownerCredential: JSON.stringify(bundle),
              expiresAt: bundle.expiresAt,
              error: null,
            });
          }).catch((reason) => {
            setPairing({
              status: "failed",
              ownerCredential: null,
              expiresAt: null,
              error: reason instanceof Error ? reason.message : String(reason),
            });
          });
        }}
        onDismissPairing={() => setPairing({
          status: "idle",
          ownerCredential: null,
          expiresAt: null,
          error: null,
        })}
        onRotateSession={(deviceId, sessionId, expectedVersion) => {
          const session = currentSession(sessionId, expectedVersion);
          if (!session || session.deviceId !== deviceId) return;
          restoreAuthorityFocus.current = true;
          void nativeBridge.rotateCompanionSession(sessionId).then((result) => {
            setRotationCode(JSON.stringify(result.credential));
            void refresh();
          }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
        }}
        onRevokeSession={(deviceId, sessionId, expectedVersion) => {
          const session = currentSession(sessionId, expectedVersion);
          if (!session || session.deviceId !== deviceId) return;
          restoreAuthorityFocus.current = true;
          void nativeBridge.revokeCompanionSession(sessionId).then(() => {
            void refresh();
          }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
        }}
        onRevokeDevice={(deviceId, expectedVersion) => {
          const deviceSessions = sessions.filter(
            (session) => session.deviceId === deviceId && session.revokedAt === null,
          );
          if (
            !deviceSessions.length
            || Math.max(...deviceSessions.map((session) => session.generation)) !== expectedVersion
          ) {
            setError("The Companion device changed. Reload its current primary-host state and try again.");
            return;
          }
          restoreAuthorityFocus.current = true;
          void nativeBridge.revokeCompanionDevice(deviceId).then(() => {
            void refresh();
          }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
        }}
      />
    </main>
  );
}
