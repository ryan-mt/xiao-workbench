import { useEffect, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AcceptanceContractDraft } from "../../../core/models/verification";
import { AcceptanceContractEditor } from "../../focus-rail/components/AcceptanceContractEditor";

type DefinitionOfDonePanelProps = {
  projectPath: string;
  taskId: string | null;
  value: AcceptanceContractDraft | null;
  disabled: boolean;
  onReadyChange: (ready: boolean) => void;
  onChange: (value: AcceptanceContractDraft | null) => void;
};

export const definitionOfDoneIsComplete = (value: AcceptanceContractDraft | null) => (
  value === null || (
    Boolean(value.name.trim()) &&
    value.gates.length > 0 &&
    value.gates.every((gate) => gate.type !== "command" || Boolean(gate.executable.trim()))
  )
);

export const definitionOfDoneSummary = (value: AcceptanceContractDraft | null) => {
  if (!value) return "No checks — this run will finish as Done";
  if (!value.gates.length) return "Add at least one check or clear the contract";
  return `${value.gates.length} ${value.gates.length === 1 ? "check" : "checks"} — completion will be verified`;
};

export function DefinitionOfDonePanel({
  projectPath,
  taskId,
  value,
  disabled,
  onReadyChange,
  onChange,
}: DefinitionOfDonePanelProps) {
  const [open, setOpen] = useState(false);
  const [editorReady, setEditorReady] = useState(true);
  const ready = editorReady && definitionOfDoneIsComplete(value);

  useEffect(() => onReadyChange(ready), [onReadyChange, ready]);

  return (
    <section className={`definition-of-done ${value ? "is-configured" : ""} ${ready ? "" : "is-incomplete"}`.trim()}>
      <button
        className="definition-of-done__toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="definition-of-done__icon"><XiaoIcon name="check" size={15} /></span>
        <span className="definition-of-done__copy">
          <strong>Definition of Done</strong>
          <small>{definitionOfDoneSummary(value)}</small>
        </span>
        <XiaoIcon className={open ? "is-open" : undefined} name="caret" size={13} />
      </button>
      <div className="definition-of-done__editor" hidden={!open}>
        <AcceptanceContractEditor
          projectPath={projectPath}
          taskId={taskId}
          value={value}
          disabled={disabled}
          onReadyChange={setEditorReady}
          onChange={onChange}
        />
        {!ready ? (
          <p className="definition-of-done__error" role="alert">
            Name the contract, add at least one check, and provide an executable for every command check.
          </p>
        ) : null}
      </div>
    </section>
  );
}
