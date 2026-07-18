import { useEffect, useRef, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { isTauriHost, nativeBridge } from "../../../core/bridges/tauri";
import type {
  AcceptanceContractDraft,
  AcceptanceContractVersionSummary,
} from "../../../core/models/verification";
import {
  AcceptanceContractEditor,
  contractDraftFromVersion,
} from "./AcceptanceContractEditor";

export type SavedAcceptanceContract = {
  projectPath: string;
  taskId: string;
  contract: AcceptanceContractVersionSummary | null;
};

type VerificationPanelProps = {
  projectPath: string;
  taskId: string;
  contract: AcceptanceContractVersionSummary | null;
  onSaved: (saved: SavedAcceptanceContract) => void;
};

type AcceptanceContractSaveReadiness = {
  nativeAvailable: boolean;
  saving: boolean;
  editorReady: boolean;
  hasDraftOrContract: boolean;
};

export const canSaveAcceptanceContract = ({
  nativeAvailable,
  saving,
  editorReady,
  hasDraftOrContract,
}: AcceptanceContractSaveReadiness) => (
  nativeAvailable && !saving && editorReady && hasDraftOrContract
);

const errorMessage = (reason: unknown) => {
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === "object" && "message" in reason) return String(reason.message);
  return String(reason);
};

export function VerificationPanel({
  projectPath,
  taskId,
  contract,
  onSaved,
}: VerificationPanelProps) {
  const mounted = useRef(true);
  const identity = `${projectPath}\u0000${taskId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [draft, setDraft] = useState<AcceptanceContractDraft | null>(() => contractDraftFromVersion(contract));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(true);
  const [bufferResetRevision, setBufferResetRevision] = useState(0);
  const nativeAvailable = isTauriHost();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setDraft(contractDraftFromVersion(contract));
    setEditorReady(true);
    setBufferResetRevision((revision) => revision + 1);
    setError(null);
    setConfirmation(null);
  }, [contract, projectPath, taskId]);

  const saveAllowed = canSaveAcceptanceContract({
    nativeAvailable,
    saving,
    editorReady,
    hasDraftOrContract: Boolean(draft || contract),
  });

  const save = async () => {
    if (!saveAllowed) return;
    const origin = { projectPath, taskId };
    const originIdentity = identity;
    setSaving(true);
    setError(null);
    setConfirmation(null);
    try {
      const saved = await nativeBridge.saveXiaoTaskAcceptanceContract({
        projectPath,
        taskId,
        expectedCurrentVersionId: contract?.versionId ?? null,
        contract: draft,
      });
      onSaved({ ...origin, contract: saved });
      if (!mounted.current || currentIdentity.current !== originIdentity) return;
      setDraft(contractDraftFromVersion(saved));
      setEditorReady(true);
      setBufferResetRevision((revision) => revision + 1);
      setConfirmation(saved
        ? `Saved immutable version ${saved.version}. New runs will snapshot it.`
        : "Acceptance contract removed. New runs will finish without verification.");
    } catch (reason) {
      if (mounted.current && currentIdentity.current === originIdentity) {
        setError(errorMessage(reason));
      }
    } finally {
      if (mounted.current && currentIdentity.current === originIdentity) setSaving(false);
    }
  };

  return (
    <section className="rail-section verification-panel">
      <header className="rail-section__header">
        <div><span>Run policy</span><h2>Acceptance</h2></div>
        <XiaoIcon name="check" size={20} />
      </header>
      <p className="rail-section__summary">
        Define native gates for this task. Every run snapshots the exact saved version before work starts.
      </p>

      {!nativeAvailable ? <div className="rail-error">Acceptance contracts require the Xiao desktop app.</div> : null}
      {contract ? (
        <div className="acceptance-version" aria-label={`Current contract version ${contract.version}`}>
          <span><XiaoIcon name="check" size={12} /> Current</span>
          <strong>{contract.name}</strong>
          <small>v{contract.version} · {contract.gates.length} {contract.gates.length === 1 ? "gate" : "gates"} · {contract.hash.slice(0, 8)}</small>
        </div>
      ) : null}

      <AcceptanceContractEditor
        projectPath={projectPath}
        taskId={taskId}
        value={draft}
        disabled={!nativeAvailable || saving}
        bufferResetRevision={bufferResetRevision}
        onReadyChange={setEditorReady}
        onChange={(next) => {
          setDraft(next);
          setError(null);
          setConfirmation(null);
        }}
      />

      {error ? <p className="acceptance-editor__error" role="alert">{error}</p> : null}
      {confirmation ? <p className="acceptance-editor__confirmation" role="status">{confirmation}</p> : null}
      <div className="acceptance-panel__actions">
        <button
          className="button button--quiet"
          type="button"
          disabled={saving}
          onClick={() => {
            setDraft(contractDraftFromVersion(contract));
            setEditorReady(true);
            setBufferResetRevision((revision) => revision + 1);
            setError(null);
            setConfirmation(null);
          }}
        >
          Reset
        </button>
        <button
          className="button button--primary"
          type="button"
          disabled={!saveAllowed}
          onClick={() => void save()}
        >
          {saving ? <XiaoIcon className="is-spinning" name="pending" size={13} /> : <XiaoIcon name="check" size={13} />}
          {draft ? "Save contract" : contract ? "Remove contract" : "Save contract"}
        </button>
      </div>
    </section>
  );
}
