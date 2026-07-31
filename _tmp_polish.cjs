const fs = require("fs");

// Fix mojibake in CompanionSurface host panel and related files
for (const file of [
  "src/features/companion/CompanionSurface.tsx",
  "src/features/companion/CompanionPage.tsx",
  "src/features/companion/CompanionPairingForm.tsx",
  "src/features/companion/CompanionHostPage.tsx",
]) {
  let text = fs.readFileSync(file, "utf8");
  const before = text;
  // common mojibake sequences from UTF-8 read as latin1 then re-encoded
  text = text
    .replaceAll("â€¦", "…")
    .replaceAll("Â·", "·")
    .replaceAll("â€”", "—")
    .replaceAll("â€“", "–")
    .replaceAll("â€™", "'")
    .replaceAll("â€œ", '"')
    .replaceAll("â€\u009d", '"');
  if (text !== before) {
    fs.writeFileSync(file, text, "utf8");
    console.log("fixed encoding", file);
  } else {
    console.log("no mojibake", file);
  }
}

// Soft structure polish on host page header + mode switch + pairing form
let host = fs.readFileSync("src/features/companion/CompanionHostPage.tsx", "utf8");
host = host.replace(
  `<header className="companion__header">
        <div className="companion__header-copy">
          <span className="companion__eyebrow">Primary-host authority</span>
          <h1 id="companion-host-heading" ref={headingRef} tabIndex={-1}>Companion access</h1>
          <p>Pair, inspect, rotate, and revoke bounded Companion sessions.</p>
        </div>
        <div className="companion__connection is-live" role="status">
          <strong>{releaseReport.passes ? "Release evidence passing" : "Release evidence blocked"}</strong>
          <span>{releaseReport.rowResults.filter((row) => row.passes).length} of 26 baseline dispositions</span>
        </div>
      </header>`,
  `<header className="companion__header">
        <div className="companion__header-copy">
          <span className="companion__eyebrow">Primary-host authority</span>
          <h1 id="companion-host-heading" ref={headingRef} tabIndex={-1}>Companion access</h1>
          <p>Pair, inspect, rotate, and revoke bounded Companion sessions.</p>
        </div>
        <div className="companion__connection is-live" role="status">
          <span className="companion__connection-dot" aria-hidden="true" />
          <div className="companion__connection-copy">
            <strong>{releaseReport.passes ? "Release evidence passing" : "Release evidence blocked"}</strong>
            <span>{releaseReport.rowResults.filter((row) => row.passes).length} of 26 baseline dispositions</span>
          </div>
        </div>
      </header>`
);
fs.writeFileSync("src/features/companion/CompanionHostPage.tsx", host, "utf8");
console.log("host header updated");

let page = fs.readFileSync("src/features/companion/CompanionPage.tsx", "utf8");
page = page.replace(
  `<nav className="companion__mode" aria-label="Companion mode">
        <button type="button" aria-pressed={mode === "host"} onClick={() => setMode("host")}>
          Primary host
        </button>
        <button type="button" aria-pressed={mode === "client"} onClick={() => setMode("client")}>
          Connected device
        </button>
      </nav>`,
  `<nav className="companion__mode" aria-label="Companion mode">
        <div className="companion__mode-track">
          <button type="button" aria-pressed={mode === "host"} onClick={() => setMode("host")}>
            Primary host
          </button>
          <button type="button" aria-pressed={mode === "client"} onClick={() => setMode("client")}>
            Connected device
          </button>
        </div>
      </nav>`
);

page = page.replace(
  `<div className="companion__client-controls">
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
            <div className="companion__client-actions">`,
  `<div className="companion__client-controls">
            <div className="companion__client-meta">
              <span className="companion__client-label">Paired host</span>
              <span>Paired with {session.endpoint}</span>
            </div>
            <label>
              Rotation code
              <input
                type="password"
                autoComplete="off"
                value={rotationCode}
                onChange={(event) => setRotationCode(event.currentTarget.value)}
              />
            </label>
            <div className="companion__client-actions">`
);
fs.writeFileSync("src/features/companion/CompanionPage.tsx", page, "utf8");
console.log("page chrome updated");

// CompanionSurface client header connection
let surface = fs.readFileSync("src/features/companion/CompanionSurface.tsx", "utf8");
surface = surface.replace(
  `<div className={\`companion__connection is-\${state.connection}\`} role="status">
          <strong>{statusLabel(state)}</strong>
          <span>
            {state.capturedAt === null
              ? "No host snapshot"
              : \`Host snapshot \${dateTime.format(state.capturedAt)}\`}
          </span>
        </div>`,
  `<div className={\`companion__connection is-\${state.connection}\`} role="status">
          <span className="companion__connection-dot" aria-hidden="true" />
          <div className="companion__connection-copy">
            <strong>{statusLabel(state)}</strong>
            <span>
              {state.capturedAt === null
                ? "No host snapshot"
                : \`Host snapshot \${dateTime.format(state.capturedAt)}\`}
            </span>
          </div>
        </div>`
);

// credential transfer - add class for secondary buttons
surface = surface.replace(
  `<div className="companion__credential">
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
      </div>`,
  `<div className="companion__credential">
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
            className="companion__primary-action"
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
      </div>`
);
fs.writeFileSync("src/features/companion/CompanionSurface.tsx", surface, "utf8");
console.log("surface header/credential updated");

// Pairing form: wrap fields for denser layout without changing labels
let pairing = fs.readFileSync("src/features/companion/CompanionPairingForm.tsx", "utf8");
pairing = pairing.replace(
  `<form onSubmit={submit}>
        <label htmlFor="companion-pairing-code">Primary host pairing bundle</label>
        <textarea
          ref={pairingCodeRef}
          id="companion-pairing-code"
          autoComplete="off"
          value={pairingCode}
          onChange={(event) => setPairingCode(event.currentTarget.value)}
          disabled={busy}
          aria-describedby="companion-pairing-code-help"
        />
        <small id="companion-pairing-code-help">
          This single-use bundle fixes the HTTPS address, TLS server name, and certificate trust.
        </small>
        <label htmlFor="companion-device-name">Device name</label>
        <input
          id="companion-device-name"
          value={deviceName}
          onChange={(event) => setDeviceName(event.currentTarget.value)}
          disabled={busy}
          maxLength={80}
        />
        <button type="submit" disabled={busy}>
          {busy ? "Pairing…" : "Pair device"}
        </button>
      </form>`,
  `<form className="companion__pair-form" onSubmit={submit}>
        <div className="companion__field">
          <label htmlFor="companion-pairing-code">Primary host pairing bundle</label>
          <textarea
            ref={pairingCodeRef}
            id="companion-pairing-code"
            autoComplete="off"
            value={pairingCode}
            onChange={(event) => setPairingCode(event.currentTarget.value)}
            disabled={busy}
            aria-describedby="companion-pairing-code-help"
            rows={6}
            spellCheck={false}
          />
          <small id="companion-pairing-code-help">
            This single-use bundle fixes the HTTPS address, TLS server name, and certificate trust.
          </small>
        </div>
        <div className="companion__field">
          <label htmlFor="companion-device-name">Device name</label>
          <input
            id="companion-device-name"
            value={deviceName}
            onChange={(event) => setDeviceName(event.currentTarget.value)}
            disabled={busy}
            maxLength={80}
            placeholder="Operator phone"
          />
        </div>
        <button type="submit" className="companion__primary-action" disabled={busy}>
          {busy ? "Pairing…" : "Pair device"}
        </button>
      </form>`
);
fs.writeFileSync("src/features/companion/CompanionPairingForm.tsx", pairing, "utf8");
console.log("pairing form updated");
