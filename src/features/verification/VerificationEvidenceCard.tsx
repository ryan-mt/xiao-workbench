import { useEffect, useRef, useState } from "react";

import { XiaoIcon } from "../../components/icons/XiaoIcon";
import { nativeBridge } from "../../core/bridges/tauri";
import type { RunSnapshot } from "../../core/models/run";
import type {
  VerificationAttemptEvidence,
  VerificationGateEvidence,
} from "../../core/models/verification";
import { runPresentation } from "./runPresentation";
import { useVerificationEvidence } from "./useVerificationEvidence";
import "./verification.css";

type VerificationEvidenceCardProps = {
  run: RunSnapshot;
  compact?: boolean;
  onReviewChanges?: () => void;
  onFixFailures?: (prompt: string) => Promise<boolean>;
  fixFailuresDisabled?: boolean;
};

export type ArtifactView =
  | { status: "loading" }
  | { status: "ready"; value: unknown }
  | { status: "error"; message: string };

export type VerificationActionToken = {
  runId: string;
  generation: number;
};

export type VerificationActionScope = {
  setRunId: (runId: string) => void;
  start: () => VerificationActionToken;
  isCurrent: (token: VerificationActionToken) => boolean;
};

export const createVerificationActionScope = (runId: string): VerificationActionScope => {
  let currentRunId = runId;
  let generation = 0;

  return {
    setRunId(nextRunId: string) {
      if (nextRunId === currentRunId) return;
      currentRunId = nextRunId;
      generation += 1;
    },
    start(): VerificationActionToken {
      generation += 1;
      return { runId: currentRunId, generation };
    },
    isCurrent(token: VerificationActionToken) {
      return token.runId === currentRunId && token.generation === generation;
    },
  };
};

const errorMessage = (reason: unknown) => {
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === "object" && "message" in reason) return String(reason.message);
  return String(reason);
};

const readable = (value: string) => value.replaceAll("_", " ");

const formatDuration = (durationMs: number) => {
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`;
};

const verificationTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

const formatJson = (value: unknown) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Evidence could not be displayed.";
  }
};

type ArtifactLoaderOptions = {
  getView: () => ArtifactView | undefined;
  setView: (view: ArtifactView) => void;
  read: () => Promise<unknown>;
};

export async function loadVerificationArtifact({
  getView,
  setView,
  read,
}: ArtifactLoaderOptions) {
  const current = getView();
  if (current?.status === "loading" || current?.status === "ready") return;

  setView({ status: "loading" });
  try {
    setView({ status: "ready", value: await read() });
  } catch (reason) {
    setView({ status: "error", message: errorMessage(reason) });
  }
}

export const canRerunVerification = (
  run: Pick<RunSnapshot, "acceptanceContractSnapshot" | "agentOutcome" | "status">,
) => Boolean(
  run.acceptanceContractSnapshot &&
  run.agentOutcome === "completed" &&
  (run.status === "needs_attention" || run.status === "interrupted"),
);

const gateLabel = (gate: VerificationGateEvidence) => {
  switch (gate.result.gateType) {
    case "command": return "Command";
    case "diffScope": return "Diff scope";
    case "cleanliness": return "Cleanliness";
  }
};

export const canFixVerificationFailures = (
  run: Pick<
    RunSnapshot,
    "acceptanceContractSnapshot" | "agentOutcome" | "status" | "verificationOutcome"
  >,
) => Boolean(
  run.acceptanceContractSnapshot &&
  run.agentOutcome === "completed" &&
  run.status === "needs_attention" &&
  run.verificationOutcome === "failed",
);

const fixEvidenceSummary = (value: unknown) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Evidence summary could not be serialized.";
  }
};

export const buildVerificationFixPrompt = (
  run: Pick<RunSnapshot, "id">,
  evidence?: VerificationAttemptEvidence,
) => {
  const attempt = evidence?.attempt;
  const failedGates = evidence?.gates.filter((gate) => gate.result.outcome === "failed") ?? [];
  const lines = [
    `Fix the failures from Xiao verification${attempt ? ` attempt ${attempt.attemptNumber}` : ""} and verify again.`,
    "Address the root causes in the current task changes, make only the necessary edits, and finish the turn so Xiao reruns the configured acceptance contract.",
    `Source run: ${run.id}`,
  ];

  if (attempt) lines.push(`Contract: ${attempt.contractSnapshot.name}`);
  if (attempt?.diagnostic) lines.push(`Attempt diagnostic: ${attempt.diagnostic}`);
  failedGates.forEach((gate) => {
    const exitCode = gate.result.exitCode === null ? "" : `, exit ${gate.result.exitCode}`;
    lines.push(`Failed ${gateLabel(gate)} gate ${gate.result.gateIndex + 1}${exitCode}: ${gate.result.diagnostic ?? "No diagnostic was recorded."}`);
    gate.evidence.forEach(({ evidence: item }) => {
      lines.push(`Evidence (${readable(item.evidenceType)}): ${fixEvidenceSummary(item.summary)}`);
    });
  });

  return lines.join("\n");
};

export async function startVerificationFix(
  run: Pick<RunSnapshot, "id">,
  evidence: VerificationAttemptEvidence | undefined,
  submit: (prompt: string) => Promise<boolean>,
) {
  if (!await submit(buildVerificationFixPrompt(run, evidence))) {
    throw new Error("Could not start a run to fix the verification failures.");
  }
}

const statusIcon = (run: RunSnapshot) => {
  const presentation = runPresentation(run);
  if (presentation.kind === "verified") return "check" as const;
  if (presentation.kind === "working") return "pending" as const;
  if (presentation.kind === "attention" || presentation.kind === "failed") return "approval" as const;
  return "result" as const;
};

export function VerificationEvidenceCard({
  run,
  compact = false,
  onReviewChanges,
  onFixFailures,
  fixFailuresDisabled = false,
}: VerificationEvidenceCardProps) {
  const mounted = useRef(true);
  const [localRun, setLocalRun] = useState(run);
  const currentRun = localRun.id === run.id && localRun.version > run.version ? localRun : run;
  const actionScopeRef = useRef<VerificationActionScope | null>(null);
  if (!actionScopeRef.current) actionScopeRef.current = createVerificationActionScope(currentRun.id);
  const actionScope = actionScopeRef.current;
  actionScope.setRunId(currentRun.id);
  const [busyActionState, setBusyActionState] = useState<{
    action: "cancel" | "fix" | "rerun";
    token: VerificationActionToken;
  } | null>(null);
  const [actionErrorState, setActionErrorState] = useState<{
    message: string;
    token: VerificationActionToken;
  } | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactView>>({});
  const artifactsRef = useRef<Record<string, ArtifactView>>({});
  const artifactGeneration = useRef(0);
  const busyAction = busyActionState && actionScope.isCurrent(busyActionState.token)
    ? busyActionState.action
    : null;
  const actionError = actionErrorState && actionScope.isCurrent(actionErrorState.token)
    ? actionErrorState.message
    : null;
  const presentation = runPresentation(currentRun);
  const relevant = Boolean(
    currentRun.acceptanceContractSnapshot ||
    currentRun.latestVerificationAttemptId ||
    currentRun.status === "verifying" ||
    currentRun.verificationOutcome !== "not_requested",
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (run.id !== localRun.id || run.version >= localRun.version) setLocalRun(run);
  }, [localRun.id, localRun.version, run]);

  useEffect(() => {
    setBusyActionState(null);
    setActionErrorState(null);
  }, [currentRun.id]);

  useEffect(() => {
    artifactGeneration.current += 1;
    artifactsRef.current = {};
    setArtifacts({});
  }, [currentRun.id, currentRun.latestVerificationAttemptId]);

  const refreshKey = [
    currentRun.latestVerificationAttemptId,
    currentRun.status,
    currentRun.verificationOutcome,
  ].join(":");
  const {
    attempts,
    loading,
    error: evidenceError,
    refresh: refreshEvidence,
    hasOlder,
    loadOlder,
  } = useVerificationEvidence(
    relevant ? currentRun.id : null,
    refreshKey,
    currentRun.status === "verifying",
  );
  const error = actionError;

  if (!relevant) return null;

  const mutateRun = async (action: "cancel" | "rerun") => {
    const token = actionScope.start();
    setBusyActionState({ action, token });
    setActionErrorState(null);
    try {
      const next = action === "cancel"
        ? await nativeBridge.cancelXiaoRun(token.runId)
        : await nativeBridge.rerunXiaoVerification(token.runId, crypto.randomUUID());
      if (!mounted.current || !actionScope.isCurrent(token)) return;
      setLocalRun(next);
      setBusyActionState(null);
    } catch (reason) {
      if (!mounted.current || !actionScope.isCurrent(token)) return;
      setActionErrorState({ message: errorMessage(reason), token });
      setBusyActionState(null);
    }
  };

  const openArtifact = async (artifactId: string) => {
    const generation = artifactGeneration.current;
    await loadVerificationArtifact({
      getView: () => artifactsRef.current[artifactId],
      setView: (view) => {
        if (!mounted.current || generation !== artifactGeneration.current) return;
        const next = { ...artifactsRef.current, [artifactId]: view };
        artifactsRef.current = next;
        setArtifacts(next);
      },
      read: () => nativeBridge.readXiaoVerificationArtifact(currentRun.id, artifactId),
    });
  };

  const canRerun = canRerunVerification(currentRun);
  const canFix = Boolean(onFixFailures) && canFixVerificationFailures(currentRun);

  const fixFailures = async () => {
    if (!onFixFailures) return;
    const token = actionScope.start();
    setBusyActionState({ action: "fix", token });
    setActionErrorState(null);
    try {
      await startVerificationFix(currentRun, attempts[0], onFixFailures);
    } catch (reason) {
      if (!mounted.current || !actionScope.isCurrent(token)) return;
      setActionErrorState({ message: errorMessage(reason), token });
      setBusyActionState(null);
    }
  };

  return (
    <article className={`verification-card verification-card--${presentation.kind} ${compact ? "verification-card--compact" : ""}`}>
      <header className="verification-card__header">
        <span className="verification-card__mark">
          <XiaoIcon className={presentation.kind === "working" ? "is-spinning" : undefined} name={statusIcon(currentRun)} size={15} />
        </span>
        <div>
          <strong>{presentation.label}</strong>
          <small>{presentation.description}</small>
        </div>
        <div className="verification-card__actions">
          {onReviewChanges ? (
            <button className="button button--quiet" type="button" onClick={onReviewChanges}>
              <XiaoIcon name="changes" size={12} /> Changes
            </button>
          ) : null}
          {currentRun.status === "verifying" ? (
            <button className="button button--quiet" type="button" disabled={Boolean(busyAction)} onClick={() => void mutateRun("cancel")}>
              {busyAction === "cancel" ? <XiaoIcon className="is-spinning" name="pending" size={12} /> : null}
              Cancel
            </button>
          ) : null}
          {canRerun ? (
            <button className="button button--quiet" type="button" disabled={Boolean(busyAction)} onClick={() => void mutateRun("rerun")}>
              <XiaoIcon className={busyAction === "rerun" ? "is-spinning" : undefined} name={busyAction === "rerun" ? "pending" : "refresh"} size={12} />
              Rerun gates
            </button>
          ) : null}
          {canFix ? (
            <button className="button button--primary" type="button" disabled={Boolean(busyAction) || fixFailuresDisabled || (loading && !attempts.length)} onClick={() => void fixFailures()}>
              <XiaoIcon className={busyAction === "fix" ? "is-spinning" : undefined} name={busyAction === "fix" ? "pending" : "refresh"} size={12} />
              {busyAction === "fix" ? "Starting fix" : "Fix failures and verify again"}
            </button>
          ) : null}
        </div>
      </header>

      {currentRun.verificationBaselineState === "unavailable" ? (
        <p className="verification-card__diagnostic" role="alert">
          {currentRun.verificationBaselineDiagnostic ?? "The verification baseline is unavailable."}
        </p>
      ) : null}
      {error ? <p className="verification-card__diagnostic" role="alert">{error}</p> : null}
      {evidenceError ? (
        <div className="verification-card__diagnostic" role="alert">
          <span>{evidenceError}</span>{" "}
          <button className="button button--quiet" type="button" disabled={loading} onClick={() => void refreshEvidence()}>
            <XiaoIcon className={loading ? "is-spinning" : undefined} name={loading ? "pending" : "refresh"} size={12} />
            Retry loading evidence
          </button>
        </div>
      ) : null}

      <div className="verification-attempts" aria-busy={loading}>
        {loading && !attempts.length ? (
          <div className="verification-card__loading"><XiaoIcon className="is-spinning" name="pending" size={13} /> Loading durable evidence</div>
        ) : null}
        {!loading && !attempts.length && !evidenceError ? (
          <p className="verification-card__empty">No persisted verification attempt is available yet.</p>
        ) : null}
        {attempts.map((attemptEvidence, attemptIndex) => {
          const { attempt, gates } = attemptEvidence;
          return (
            <details className="verification-attempt" key={attempt.id} open={attemptIndex === 0}>
              <summary>
                <span>Attempt {attempt.attemptNumber}</span>
                <strong className={`verification-outcome verification-outcome--${attempt.status}`}>{readable(attempt.status)}</strong>
                <small>{verificationTimeFormatter.format(attempt.finishedAt ?? attempt.startedAt)}</small>
                <XiaoIcon name="caret" size={12} />
              </summary>
              <div className="verification-attempt__body">
                <div className="verification-attempt__meta">
                  <span>{attempt.trigger === "rerun" ? "Verification-only rerun" : "Initial verification"}</span>
                  <span>{gates.length}/{attempt.expectedGateCount} gates persisted</span>
                  <span>Contract: {attempt.contractSnapshot.name}</span>
                </div>
                {attempt.diagnostic ? <p className="verification-card__diagnostic">{attempt.diagnostic}</p> : null}
                <ol className="verification-gates">
                  {gates.map((gate) => (
                    <li className={`verification-gate-result verification-gate-result--${gate.result.outcome}`} key={gate.result.id}>
                      <details>
                        <summary>
                          <span className="verification-gate-result__index">{gate.result.gateIndex + 1}</span>
                          <strong>{gateLabel(gate)}</strong>
                          <small>{formatDuration(gate.result.durationMs)}{gate.result.exitCode === null ? "" : ` · exit ${gate.result.exitCode}`}</small>
                          <b>{readable(gate.result.outcome)}</b>
                          <XiaoIcon name="caret" size={11} />
                        </summary>
                        <div className="verification-gate-result__body">
                          {gate.result.diagnostic ? <p className="verification-card__diagnostic">{gate.result.diagnostic}</p> : null}
                          {gate.evidence.map(({ evidence, artifact }) => {
                            const artifactView = artifact ? artifacts[artifact.id] : undefined;
                            return (
                              <div className="verification-evidence" key={evidence.id}>
                                <div className="verification-evidence__meta">
                                  <span>{readable(evidence.evidenceType)}</span>
                                  <small>{evidence.redactionState === "bestEffort" ? "Best-effort redaction" : "Safe evidence"}</small>
                                </div>
                                <pre>{formatJson(evidence.summary)}</pre>
                                {artifact ? (
                                  <div className="verification-artifact">
                                    <button className="button button--quiet" type="button" disabled={artifactView?.status === "loading"} onClick={() => void openArtifact(artifact.id)}>
                                      <XiaoIcon className={artifactView?.status === "loading" ? "is-spinning" : undefined} name={artifactView?.status === "loading" ? "pending" : "file"} size={12} />
                                      {artifactView?.status === "ready" ? "Artifact loaded" : `Open artifact · ${artifact.byteLength.toLocaleString()} B`}
                                    </button>
                                    {artifactView?.status === "ready" ? <pre>{formatJson(artifactView.value)}</pre> : null}
                                    {artifactView?.status === "error" ? <p className="verification-card__diagnostic">{artifactView.message}</p> : null}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    </li>
                  ))}
                </ol>
              </div>
            </details>
          );
        })}
        {hasOlder ? (
          <button className="button button--quiet" type="button" disabled={loading} onClick={loadOlder}>
            {loading ? <XiaoIcon className="is-spinning" name="pending" size={12} /> : null}
            Load older attempts
          </button>
        ) : null}
      </div>
    </article>
  );
}
