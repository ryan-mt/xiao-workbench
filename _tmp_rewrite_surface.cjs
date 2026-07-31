const fs = require("fs");
const path = require("path");

const surfacePath = path.join("src/features/companion/CompanionSurface.tsx");
let surface = fs.readFileSync(surfacePath, "utf8");

const oldHostPanel = `export function CompanionHostAuthorityPanel({
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
              <ul aria-label={\`\${device.name} sessions\`}>
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
}`;

// Handle both proper ellipsis and mojibake variants in source
const hostPanelPatterns = [
  oldHostPanel,
  oldHostPanel.replaceAll("Creating…", "Creating…").replaceAll("·", "·"),
];

// Read raw and find function by markers
const startMarker = "export function CompanionHostAuthorityPanel({";
const endMarker = "export function CompanionSurface({";
const start = surface.indexOf(startMarker);
const end = surface.indexOf(endMarker);
if (start < 0 || end < 0) {
  console.error("markers not found", { start, end });
  process.exit(1);
}

const newHostPanel = `export function CompanionHostAuthorityPanel({
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
          {devices.map((device) => {
            const activeSessions = device.sessions.filter((session) => session.revokedAt === null).length;
            const mark = device.name
              .split(/\\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((part) => part[0]?.toUpperCase() ?? "")
              .join("") || "?";
            return (
              <li key={device.id} className="companion__device">
                <div className="companion__device-head">
                  <div className="companion__device-identity">
                    <span className="companion__device-mark" aria-hidden="true">{mark}</span>
                    <div className="companion__device-copy">
                      <div className="companion__device-title">
                        <strong>{device.name}</strong>
                        <span className={\`companion__pill \${device.revokedAt ? "is-revoked" : "is-ok"}\`}>
                          {device.revokedAt ? "Revoked" : "Authorized"}
                        </span>
                      </div>
                      <span className="companion__device-meta">
                        {device.grants.length
                          ? \`\${device.grants.length} grant\${device.grants.length === 1 ? "" : "s"}\`
                          : "No active grants"}
                        {" · "}
                        {activeSessions} active session{activeSessions === 1 ? "" : "s"}
                      </span>
                    </div>
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
                </div>
                {device.grants.length ? (
                  <ul className="companion__grant-list" aria-label={\`\${device.name} grants\`}>
                    {device.grants.map((grant) => (
                      <li key={grant}>{grant}</li>
                    ))}
                  </ul>
                ) : null}
                {/* Keep a single text node path for older host summaries that joined grants inline. */}
                <span className="companion__sr-only">
                  {device.revokedAt ? "Revoked" : "Authorized"} · {device.grants.join(", ")}
                </span>
                <ul className="companion__session-list" aria-label={\`\${device.name} sessions\`}>
                  {device.sessions.map((session) => (
                    <li key={session.id} className="companion__session">
                      <div className="companion__session-copy">
                        <span className="companion__session-id">
                          Session {session.id}
                        </span>
                        <span className={\`companion__pill companion__pill--quiet \${session.revokedAt ? "is-revoked" : "is-ok"}\`}>
                          {session.revokedAt ? "Revoked" : "Active"}
                        </span>
                        <span className="companion__sr-only">
                          {" "}· {session.revokedAt ? "Revoked" : "Active"}
                        </span>
                      </div>
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
            );
          })}
        </ul>
      ) : <p className="companion__empty">No paired devices.</p>}
    </section>
  );
}

`;

// Fix the session text - tests look for "Session session-1 · Active" as one text node
// Using sr-only split might break getByText regex. Keep one visible text node.

const newHostPanelFixed = `export function CompanionHostAuthorityPanel({
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
          {devices.map((device) => {
            const activeSessions = device.sessions.filter((session) => session.revokedAt === null).length;
            const mark = device.name
              .split(/\\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((part) => part[0]?.toUpperCase() ?? "")
              .join("") || "?";
            return (
              <li key={device.id} className="companion__device">
                <div className="companion__device-head">
                  <div className="companion__device-identity">
                    <span className="companion__device-mark" aria-hidden="true">{mark}</span>
                    <div className="companion__device-copy">
                      <div className="companion__device-title">
                        <strong>{device.name}</strong>
                        <span className={\`companion__pill \${device.revokedAt ? "is-revoked" : "is-ok"}\`}>
                          {device.revokedAt ? "Revoked" : "Authorized"}
                        </span>
                      </div>
                      <span className="companion__device-meta">
                        {activeSessions} active session{activeSessions === 1 ? "" : "s"}
                        {device.grants.length
                          ? \` · \${device.grants.length} grant\${device.grants.length === 1 ? "" : "s"}\`
                          : ""}
                      </span>
                    </div>
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
                </div>
                {device.grants.length ? (
                  <ul className="companion__grant-list" aria-label={\`\${device.name} grants\`}>
                    {device.grants.map((grant) => (
                      <li key={grant}>{grant}</li>
                    ))}
                  </ul>
                ) : null}
                <ul className="companion__session-list" aria-label={\`\${device.name} sessions\`}>
                  {device.sessions.map((session) => (
                    <li key={session.id} className="companion__session">
                      <span className="companion__session-label">
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
            );
          })}
        </ul>
      ) : <p className="companion__empty">No paired devices.</p>}
    </section>
  );
}

`;

surface = surface.slice(0, start) + newHostPanelFixed + surface.slice(end);
fs.writeFileSync(surfacePath, surface, "utf8");
console.log("Updated CompanionHostAuthorityPanel");

// Update credential transfer structure slightly
const oldCredStart = surface.indexOf("return (\n    <div className=\"companion__credential\">");
const oldCredEnd = surface.indexOf("export function CompanionHostAuthorityPanel");
if (oldCredStart < 0) {
  console.error("credential block not found");
  process.exit(1);
}
// leave credential mostly same - CSS will polish

// Update CompanionSurface header connection badge classes stay
console.log("surface length", surface.length);
