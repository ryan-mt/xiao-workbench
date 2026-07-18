export type CommandAcceptanceGate = {
  type: "command";
  executable: string;
  argv: string[];
  timeoutMs: number;
  expectedExitCodes: number[];
};

export type DiffScopeAcceptanceGate = {
  type: "diffScope";
  allowedPatterns: string[];
  deniedPatterns: string[];
};

export type CleanlinessAcceptanceGate = {
  type: "cleanliness";
  allowStaged: boolean;
  allowUnstaged: boolean;
  allowUntracked: boolean;
};

export type AcceptanceGate =
  | CommandAcceptanceGate
  | DiffScopeAcceptanceGate
  | CleanlinessAcceptanceGate;

export type AcceptanceContractDraft = {
  name: string;
  gates: AcceptanceGate[];
};

export type AcceptanceContractSnapshot = AcceptanceContractDraft & {
  schemaVersion: number;
};

export type AcceptanceContractVersionSummary = {
  versionId: string;
  contractId: string;
  version: number;
  schema: number;
  name: string;
  gates: AcceptanceGate[];
  hash: string;
  createdAt: number;
  updatedAt: number;
};

export type SaveTaskAcceptanceContractRequest = {
  projectPath: string;
  taskId: string;
  expectedCurrentVersionId: string | null;
  contract: AcceptanceContractDraft | null;
};

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type AcceptanceContractPreset = {
  scriptName: string;
  packageManager: PackageManager;
  draft: AcceptanceContractDraft;
};

export type AcceptancePresetDiscoveryErrorCode =
  | "executionContext"
  | "manifestRead"
  | "manifestTooLarge"
  | "malformedManifest"
  | "unsupportedPackageManager"
  | "packageManagerUnavailable";

export type AcceptancePresetDiscoveryError = {
  code: AcceptancePresetDiscoveryErrorCode;
  message: string;
};

export type VerificationBaselineState =
  | "notRequired"
  | "pending"
  | "ready"
  | "unavailable";
export type VerificationGateType = "command" | "diffScope" | "cleanliness";
export type VerificationGateOutcome = "passed" | "failed" | "blocked" | "cancelled";
export type VerificationAttemptTrigger = "initial" | "rerun";
export type VerificationAttemptStatus =
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "interrupted";
export type ArtifactRetentionClass = "runEvidence" | "verificationBaseline";
export type EvidenceRedactionState = "safe" | "bestEffort";

export type VerificationAttemptRecord = {
  id: string;
  runId: string;
  requestKey: string;
  attemptNumber: number;
  trigger: VerificationAttemptTrigger;
  contractSnapshot: AcceptanceContractSnapshot;
  contractSnapshotSha256: string;
  expectedGateCount: number;
  status: VerificationAttemptStatus;
  diagnostic: string | null;
  startedAt: number;
  finishedAt: number | null;
  updatedAt: number;
  version: number;
};

export type GateResultRecord = {
  id: string;
  verificationAttemptId: string;
  gateIndex: number;
  gateType: VerificationGateType;
  outcome: VerificationGateOutcome;
  durationMs: number;
  exitCode: number | null;
  diagnostic: string | null;
  startedAt: number;
  finishedAt: number;
};

export type EvidenceRecord = {
  id: string;
  runId: string;
  verificationAttemptId: string | null;
  gateResultId: string | null;
  evidenceType: string;
  summary: unknown;
  artifactId: string | null;
  redactionState: EvidenceRedactionState;
  createdAt: number;
};

export type VerificationArtifactSummary = {
  id: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  retentionClass: ArtifactRetentionClass;
  createdAt: number;
};

export type VerificationEvidenceItem = {
  evidence: EvidenceRecord;
  artifact: VerificationArtifactSummary | null;
};

export type VerificationGateEvidence = {
  result: GateResultRecord;
  evidence: VerificationEvidenceItem[];
};

export type VerificationAttemptEvidence = {
  attempt: VerificationAttemptRecord;
  gates: VerificationGateEvidence[];
};

export type VerificationEvidencePage = {
  attempts: VerificationAttemptEvidence[];
  hasMore: boolean;
};
