import { useCallback, useEffect, useRef, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { nativeBridge } from "../../../core/bridges/tauri";
import type {
  AcceptanceContractDraft,
  AcceptanceContractPreset,
  AcceptanceContractVersionSummary,
  AcceptanceGate,
  CleanlinessAcceptanceGate,
  CommandAcceptanceGate,
  DiffScopeAcceptanceGate,
} from "../../../core/models/verification";

type AcceptanceContractEditorProps = {
  projectPath: string;
  taskId: string | null;
  value: AcceptanceContractDraft | null;
  disabled?: boolean;
  bufferResetRevision?: number;
  onReadyChange?: (ready: boolean) => void;
  onChange: (value: AcceptanceContractDraft | null) => void;
};

const emptyContract = (): AcceptanceContractDraft => ({
  name: "Acceptance checks",
  gates: [],
});

const emptyCommandGate = (): CommandAcceptanceGate => ({
  type: "command",
  executable: "",
  argv: [],
  timeoutMs: 120_000,
  expectedExitCodes: [0],
});

const emptyDiffScopeGate = (): DiffScopeAcceptanceGate => ({
  type: "diffScope",
  allowedPatterns: ["**/*"],
  deniedPatterns: [],
});

const emptyCleanlinessGate = (): CleanlinessAcceptanceGate => ({
  type: "cleanliness",
  allowStaged: true,
  allowUnstaged: true,
  allowUntracked: true,
});

const cloneGate = (gate: AcceptanceGate): AcceptanceGate => {
  switch (gate.type) {
    case "command":
      return { ...gate, argv: [...gate.argv], expectedExitCodes: [...gate.expectedExitCodes] };
    case "diffScope":
      return {
        ...gate,
        allowedPatterns: [...gate.allowedPatterns],
        deniedPatterns: [...gate.deniedPatterns],
      };
    case "cleanliness":
      return { ...gate };
  }
};

export const cloneContractDraft = (draft: AcceptanceContractDraft): AcceptanceContractDraft => ({
  name: draft.name,
  gates: draft.gates.map(cloneGate),
});

export const contractDraftFromVersion = (
  contract: AcceptanceContractVersionSummary | null,
): AcceptanceContractDraft | null => contract ? cloneContractDraft(contract) : null;

export const parseMultilineField = (value: string) => value
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

export const parseExitCodesField = (value: string): number[] | null => {
  if (!value.trim()) return [];

  const tokens = value.split(",").map((item) => item.trim());
  if (tokens.some((item) => !/^[+-]?\d+$/.test(item))) return null;

  const parsed = tokens.map(Number);
  return parsed.every(Number.isSafeInteger) ? parsed : null;
};

export type BufferedFieldState = {
  text: string;
  sourceFingerprint: string;
  scopeKey: string;
  dirty: boolean;
  invalid: boolean;
};

export const createBufferedFieldState = (
  text: string,
  sourceFingerprint: string,
  scopeKey: string,
): BufferedFieldState => ({
  text,
  sourceFingerprint,
  scopeKey,
  dirty: false,
  invalid: false,
});

export const reconcileBufferedFieldState = (
  state: BufferedFieldState,
  sourceText: string,
  sourceFingerprint: string,
  scopeKey: string,
): BufferedFieldState => state.sourceFingerprint === sourceFingerprint && state.scopeKey === scopeKey
  ? state
  : createBufferedFieldState(sourceText, sourceFingerprint, scopeKey);

export type BufferedFieldAction =
  | { type: "edit"; text: string; valid: boolean }
  | { type: "commit"; sourceFingerprint: string }
  | { type: "reject" };

export const transitionBufferedFieldState = (
  state: BufferedFieldState,
  action: BufferedFieldAction,
): BufferedFieldState => {
  switch (action.type) {
    case "edit":
      return { ...state, text: action.text, dirty: true, invalid: !action.valid };
    case "commit":
      return {
        ...state,
        sourceFingerprint: action.sourceFingerprint,
        dirty: false,
        invalid: false,
      };
    case "reject":
      return { ...state, dirty: true, invalid: true };
  }
};

export const isBufferedFieldReady = (state: BufferedFieldState) => (
  !state.dirty && !state.invalid
);

const useBufferedField = (
  sourceText: string,
  sourceFingerprint: string,
  scopeKey: string,
) => {
  const [stored, setStored] = useState(
    () => createBufferedFieldState(sourceText, sourceFingerprint, scopeKey),
  );
  const current = reconcileBufferedFieldState(
    stored,
    sourceText,
    sourceFingerprint,
    scopeKey,
  );

  useEffect(() => {
    setStored((state) => reconcileBufferedFieldState(
      state,
      sourceText,
      sourceFingerprint,
      scopeKey,
    ));
  }, [scopeKey, sourceFingerprint, sourceText]);

  return {
    text: current.text,
    invalid: current.invalid,
    ready: isBufferedFieldReady(current),
    edit: (text: string, valid = true) => setStored((state) => transitionBufferedFieldState(
      reconcileBufferedFieldState(
        state,
        sourceText,
        sourceFingerprint,
        scopeKey,
      ),
      { type: "edit", text, valid },
    )),
    commit: (nextFingerprint: string) => setStored((state) => transitionBufferedFieldState(
      reconcileBufferedFieldState(
        state,
        sourceText,
        sourceFingerprint,
        scopeKey,
      ),
      { type: "commit", sourceFingerprint: nextFingerprint },
    )),
    reject: () => setStored((state) => transitionBufferedFieldState(
      reconcileBufferedFieldState(
        state,
        sourceText,
        sourceFingerprint,
        scopeKey,
      ),
      { type: "reject" },
    )),
  };
};

const errorMessage = (reason: unknown) => {
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === "object" && "message" in reason) {
    return String(reason.message);
  }
  return String(reason);
};

const gateLabel = (gate: AcceptanceGate) => {
  switch (gate.type) {
    case "command": return "Command";
    case "diffScope": return "Diff scope";
    case "cleanliness": return "Cleanliness";
  }
};

const gateIcon = (gate: AcceptanceGate) => gate.type === "command"
  ? "command" as const
  : gate.type === "diffScope"
    ? "changes" as const
    : "check" as const;

type GateFieldsReadinessProps = {
  readinessKey: string;
  onReadinessChange: (key: string, ready: boolean) => void;
  onReadinessUnmount: (key: string) => void;
};

type CommandGateFieldsProps = GateFieldsReadinessProps & {
  gate: CommandAcceptanceGate;
  disabled: boolean;
  scopeKey: string;
  onChange: (gate: CommandAcceptanceGate) => void;
};

function CommandGateFields({
  gate,
  disabled,
  scopeKey,
  readinessKey,
  onChange,
  onReadinessChange,
  onReadinessUnmount,
}: CommandGateFieldsProps) {
  const argvFingerprint = JSON.stringify(gate.argv);
  const argv = useBufferedField(gate.argv.join("\n"), argvFingerprint, scopeKey);
  const exitCodesFingerprint = JSON.stringify(gate.expectedExitCodes);
  const exitCodes = useBufferedField(
    gate.expectedExitCodes.join(", "),
    exitCodesFingerprint,
    scopeKey,
  );
  const ready = argv.ready && exitCodes.ready;

  useEffect(() => {
    onReadinessChange(readinessKey, ready);
  }, [onReadinessChange, readinessKey, ready]);

  useEffect(() => () => {
    onReadinessUnmount(readinessKey);
  }, [onReadinessUnmount, readinessKey]);

  const commitArgv = () => {
    const parsed = parseMultilineField(argv.text);
    argv.commit(JSON.stringify(parsed));
    onChange({ ...gate, argv: parsed });
    onReadinessChange(readinessKey, exitCodes.ready);
  };

  const commitExitCodes = () => {
    const parsed = parseExitCodesField(exitCodes.text);
    if (!parsed) {
      exitCodes.reject();
      onReadinessChange(readinessKey, false);
      return;
    }
    exitCodes.commit(JSON.stringify(parsed));
    onChange({ ...gate, expectedExitCodes: parsed });
    onReadinessChange(readinessKey, argv.ready);
  };

  return (
    <div className="acceptance-gate__fields">
      <label>
        <span>Executable</span>
        <input
          value={gate.executable}
          disabled={disabled}
          spellCheck={false}
          placeholder="npm"
          onChange={(event) => onChange({ ...gate, executable: event.target.value })}
        />
      </label>
      <label>
        <span>Arguments <small>one per line</small></span>
        <textarea
          rows={3}
          value={argv.text}
          disabled={disabled}
          spellCheck={false}
          placeholder={"run\ncheck"}
          onChange={(event) => {
            onReadinessChange(readinessKey, false);
            argv.edit(event.target.value);
          }}
          onBlur={commitArgv}
        />
      </label>
      <div className="acceptance-gate__row">
        <label>
          <span>Timeout (ms)</span>
          <input
            type="number"
            min={1000}
            max={3_600_000}
            value={gate.timeoutMs}
            disabled={disabled}
            onChange={(event) => onChange({ ...gate, timeoutMs: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>Passing exit codes</span>
          <input
            value={exitCodes.text}
            disabled={disabled}
            inputMode="numeric"
            placeholder="0"
            aria-invalid={exitCodes.invalid || undefined}
            title={exitCodes.invalid ? "Enter whole numbers separated by commas." : undefined}
            onChange={(event) => {
              const text = event.target.value;
              onReadinessChange(readinessKey, false);
              exitCodes.edit(text, parseExitCodesField(text) !== null);
            }}
            onBlur={commitExitCodes}
          />
        </label>
      </div>
    </div>
  );
}

type DiffScopeGateFieldsProps = GateFieldsReadinessProps & {
  gate: DiffScopeAcceptanceGate;
  disabled: boolean;
  scopeKey: string;
  onChange: (gate: DiffScopeAcceptanceGate) => void;
};

function DiffScopeGateFields({
  gate,
  disabled,
  scopeKey,
  readinessKey,
  onChange,
  onReadinessChange,
  onReadinessUnmount,
}: DiffScopeGateFieldsProps) {
  const allowedFingerprint = JSON.stringify(gate.allowedPatterns);
  const allowed = useBufferedField(
    gate.allowedPatterns.join("\n"),
    allowedFingerprint,
    scopeKey,
  );
  const deniedFingerprint = JSON.stringify(gate.deniedPatterns);
  const denied = useBufferedField(
    gate.deniedPatterns.join("\n"),
    deniedFingerprint,
    scopeKey,
  );
  const ready = allowed.ready && denied.ready;

  useEffect(() => {
    onReadinessChange(readinessKey, ready);
  }, [onReadinessChange, readinessKey, ready]);

  useEffect(() => () => {
    onReadinessUnmount(readinessKey);
  }, [onReadinessUnmount, readinessKey]);

  const commitAllowed = () => {
    const parsed = parseMultilineField(allowed.text);
    allowed.commit(JSON.stringify(parsed));
    onChange({ ...gate, allowedPatterns: parsed });
    onReadinessChange(readinessKey, denied.ready);
  };

  const commitDenied = () => {
    const parsed = parseMultilineField(denied.text);
    denied.commit(JSON.stringify(parsed));
    onChange({ ...gate, deniedPatterns: parsed });
    onReadinessChange(readinessKey, allowed.ready);
  };

  return (
    <div className="acceptance-gate__fields">
      <label>
        <span>Allowed paths <small>one glob per line</small></span>
        <textarea
          rows={3}
          value={allowed.text}
          disabled={disabled}
          spellCheck={false}
          placeholder="src/**"
          onChange={(event) => {
            onReadinessChange(readinessKey, false);
            allowed.edit(event.target.value);
          }}
          onBlur={commitAllowed}
        />
      </label>
      <label>
        <span>Denied paths <small>one glob per line</small></span>
        <textarea
          rows={3}
          value={denied.text}
          disabled={disabled}
          spellCheck={false}
          placeholder=".env*"
          onChange={(event) => {
            onReadinessChange(readinessKey, false);
            denied.edit(event.target.value);
          }}
          onBlur={commitDenied}
        />
      </label>
    </div>
  );
}

export function AcceptanceContractEditor({
  projectPath,
  taskId,
  value,
  disabled = false,
  bufferResetRevision = 0,
  onReadyChange,
  onChange,
}: AcceptanceContractEditorProps) {
  const requestGeneration = useRef(0);
  const [presets, setPresets] = useState<AcceptanceContractPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);
  const unreadyFields = useRef(new Set<string>());
  const publishedReady = useRef(true);
  const onReadyChangeRef = useRef(onReadyChange);
  onReadyChangeRef.current = onReadyChange;

  const reportReadiness = useCallback((key: string, ready: boolean) => {
    if (ready) {
      unreadyFields.current.delete(key);
    } else {
      unreadyFields.current.add(key);
    }
    const nextReady = unreadyFields.current.size === 0;
    if (nextReady !== publishedReady.current) {
      publishedReady.current = nextReady;
      onReadyChangeRef.current?.(nextReady);
    }
  }, []);

  const unregisterReadiness = useCallback((key: string) => {
    unreadyFields.current.delete(key);
    const nextReady = unreadyFields.current.size === 0;
    if (nextReady !== publishedReady.current) {
      publishedReady.current = nextReady;
      onReadyChangeRef.current?.(nextReady);
    }
  }, []);

  useEffect(() => {
    requestGeneration.current += 1;
    setPresets([]);
    setPresetsLoading(false);
    setPresetError(null);
  }, [projectPath, taskId]);

  const discoverPresets = async () => {
    const generation = ++requestGeneration.current;
    setPresetsLoading(true);
    setPresetError(null);
    try {
      const discovered = await nativeBridge.discoverXiaoAcceptancePresets(projectPath, taskId);
      if (generation !== requestGeneration.current) return;
      setPresets(discovered);
    } catch (reason) {
      if (generation !== requestGeneration.current) return;
      setPresets([]);
      setPresetError(errorMessage(reason));
    } finally {
      if (generation === requestGeneration.current) setPresetsLoading(false);
    }
  };

  const updateGate = (index: number, gate: AcceptanceGate) => {
    if (!value) return;
    const gates = value.gates.map((current, currentIndex) => currentIndex === index ? gate : current);
    onChange({ ...value, gates });
  };

  const removeGate = (index: number) => {
    if (!value) return;
    onChange({ ...value, gates: value.gates.filter((_, currentIndex) => currentIndex !== index) });
  };

  const addGate = (gate: AcceptanceGate) => {
    const contract = value ?? emptyContract();
    onChange({ ...contract, gates: [...contract.gates, gate] });
  };
  const fieldScopeKey = `${projectPath}\u0000${taskId}\u0000${bufferResetRevision}`;

  return (
    <div className="acceptance-editor">
      <div className="acceptance-editor__heading">
        <div>
          <strong>Acceptance contract</strong>
          <small>Deterministic gates run after the agent finishes.</small>
        </div>
        <div className="acceptance-editor__heading-actions">
          <button
            className="button button--quiet"
            type="button"
            disabled={disabled || presetsLoading}
            onClick={() => void discoverPresets()}
          >
            <XiaoIcon className={presetsLoading ? "is-spinning" : undefined} name={presetsLoading ? "pending" : "refresh"} size={12} />
            {presetsLoading ? "Discovering" : "Package scripts"}
          </button>
          {value ? (
            <button className="button button--quiet" type="button" disabled={disabled} onClick={() => onChange(null)}>
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {presetError ? <p className="acceptance-editor__error" role="alert">{presetError}</p> : null}
      {presets.length ? (
        <div className="acceptance-presets" aria-label="Discovered package script presets">
          <span>Discovered scripts</span>
          <div>
            {presets.map((preset) => (
              <button
                type="button"
                key={`${preset.packageManager}:${preset.scriptName}`}
                disabled={disabled}
                onClick={() => onChange(cloneContractDraft(preset.draft))}
              >
                <XiaoIcon name="command" size={12} />
                <strong>{preset.scriptName}</strong>
                <small>{preset.packageManager}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!value ? (
        <div className="acceptance-editor__empty">
          <XiaoIcon name="check" size={20} />
          <div><strong>No acceptance contract</strong><small>The run will finish as Done without native verification.</small></div>
          <button className="button button--quiet" type="button" disabled={disabled} onClick={() => onChange(emptyContract())}>
            Add contract
          </button>
        </div>
      ) : (
        <>
          <label className="acceptance-editor__name">
            <span>Contract name</span>
            <input
              value={value.name}
              disabled={disabled}
              placeholder="Build and workspace policy"
              onChange={(event) => onChange({ ...value, name: event.target.value })}
            />
          </label>

          <div className="acceptance-gates">
            {value.gates.map((gate, index) => (
              <section className="acceptance-gate" key={`${fieldScopeKey}\u0000${gate.type}-${index}`}>
                <header>
                  <span><XiaoIcon name={gateIcon(gate)} size={13} /> Gate {index + 1}</span>
                  <strong>{gateLabel(gate)}</strong>
                  <button type="button" disabled={disabled} aria-label={`Remove ${gateLabel(gate)} gate`} onClick={() => removeGate(index)}>
                    <XiaoIcon name="close" size={12} />
                  </button>
                </header>

                {gate.type === "command" ? (
                  <CommandGateFields
                    gate={gate}
                    disabled={disabled}
                    scopeKey={fieldScopeKey}
                    readinessKey={`${fieldScopeKey}\u0000command-${index}`}
                    onReadinessChange={reportReadiness}
                    onReadinessUnmount={unregisterReadiness}
                    onChange={(next) => updateGate(index, next)}
                  />
                ) : null}

                {gate.type === "diffScope" ? (
                  <DiffScopeGateFields
                    gate={gate}
                    disabled={disabled}
                    scopeKey={fieldScopeKey}
                    readinessKey={`${fieldScopeKey}\u0000diffScope-${index}`}
                    onReadinessChange={reportReadiness}
                    onReadinessUnmount={unregisterReadiness}
                    onChange={(next) => updateGate(index, next)}
                  />
                ) : null}

                {gate.type === "cleanliness" ? (
                  <div className="acceptance-cleanliness">
                    {([
                      ["allowStaged", "Staged changes"],
                      ["allowUnstaged", "Unstaged changes"],
                      ["allowUntracked", "Untracked files"],
                    ] as const).map(([field, label]) => (
                      <label key={field}>
                        <input
                          type="checkbox"
                          checked={gate[field]}
                          disabled={disabled}
                          onChange={(event) => updateGate(index, { ...gate, [field]: event.target.checked })}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </section>
            ))}
          </div>

          {!value.gates.length ? (
            <p className="acceptance-editor__hint">Add at least one gate before saving.</p>
          ) : null}
          <div className="acceptance-editor__add" aria-label="Add acceptance gate">
            <button className="button button--quiet" type="button" disabled={disabled} onClick={() => addGate(emptyCommandGate())}>
              <XiaoIcon name="command" size={12} /> Command
            </button>
            <button className="button button--quiet" type="button" disabled={disabled} onClick={() => addGate(emptyDiffScopeGate())}>
              <XiaoIcon name="changes" size={12} /> Diff scope
            </button>
            <button className="button button--quiet" type="button" disabled={disabled} onClick={() => addGate(emptyCleanlinessGate())}>
              <XiaoIcon name="check" size={12} /> Cleanliness
            </button>
          </div>
        </>
      )}
    </div>
  );
}
