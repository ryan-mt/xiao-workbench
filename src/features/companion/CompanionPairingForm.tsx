import { useEffect, useRef, useState, type FormEvent } from "react";

import { parseCompanionPairingBundle } from "./companionClient";

export type CompanionPairingFormProps = {
  busy: boolean;
  error: string | null;
  onPair: (values: {
    pairingCode: string;
    deviceName: string;
  }) => void;
};

export function CompanionPairingForm({
  busy,
  error,
  onPair,
}: CompanionPairingFormProps) {
  const pairingCodeRef = useRef<HTMLTextAreaElement>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const shownError = validationError ?? error;

  useEffect(() => {
    if (error) pairingCodeRef.current?.focus();
  }, [error]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      parseCompanionPairingBundle(pairingCode);
      if (!deviceName.trim()) throw new Error("Device name is required.");
      setValidationError(null);
      onPair({
        pairingCode: pairingCode.trim(),
        deviceName: deviceName.trim(),
      });
      setPairingCode("");
    } catch (reason) {
      setValidationError(reason instanceof Error ? reason.message : String(reason));
      pairingCodeRef.current?.focus();
    }
  };

  return (
    <section className="companion__section companion__pair-device" aria-labelledby="pair-device">
      <div className="companion__section-heading">
        <div>
          <h2 id="pair-device">Pair with a primary host</h2>
          <p>The installed Xiao app connects over certificate-pinned HTTPS.</p>
        </div>
      </div>
      {shownError ? (
        <p className="companion__inline-error" role="alert">
          Pairing may have created a host session before local credential storage failed.
          {" "}{shownError} Inspect and revoke this device on the primary host, then request a
          new single-use pairing bundle.
        </p>
      ) : null}
      <form className="companion__pair-form" onSubmit={submit}>
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
      </form>
    </section>
  );
}
