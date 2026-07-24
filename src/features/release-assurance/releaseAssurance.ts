export const T3_CODE_BASELINE = {
  product: "T3 Code",
  version: "0.0.28",
  commit: "fda6486233e0b2f07ecfea166e1a94533cb923c4",
} as const;

export const TICKET_03_RELEASE_GATE = {
  ticket: "03",
  capabilityId: "companion-release-assurance",
  capabilityVersion: 1,
  prerequisiteCapabilityId: "outcome-supervision-loop",
  prerequisiteCapabilityVersion: 1,
  enableOnlyWhenDispositionSuitePasses: true,
} as const;

export type CapabilityDisposition = "matches" | "exceeds" | "intentionally_excludes";
export type VerificationStatus = "passed" | "failed" | "pending";
export type EvidenceKind = "baseline" | "implementation" | "policy" | "test";

export interface AssuranceEvidence {
  kind: EvidenceKind;
  reference: string;
}

export interface ExclusionJustification {
  outsideProductPromise: boolean;
  adjacentXiaoWorkflowDependencies: readonly string[];
  rationale: string;
}

export interface CapabilityDispositionRow {
  id: string;
  workflow: string;
  disposition: CapabilityDisposition;
  workRequired: string;
  // Source evidence explains the frozen disposition; it does not certify runtime behavior.
  evidence: readonly AssuranceEvidence[];
  verification: {
    status: VerificationStatus;
    testEvidence: readonly AssuranceEvidence[];
  };
  exclusion?: ExclusionJustification;
}

export const REQUIRED_TICKET_03_GATES = [
  "companion-security",
  "companion-idempotency",
  "companion-reconnect-and-crash",
  "migration",
  "performance",
  "accessibility",
  "baseline-disposition",
  "typecheck-frontend-rust-production-build",
] as const;

export type Ticket03GateId = typeof REQUIRED_TICKET_03_GATES[number];

export interface Ticket03GateResult {
  id: Ticket03GateId;
  status: VerificationStatus;
  testEvidence: readonly AssuranceEvidence[];
}

export interface ReleaseAssuranceManifest {
  baseline: typeof T3_CODE_BASELINE;
  gate: typeof TICKET_03_RELEASE_GATE;
  rows: readonly CapabilityDispositionRow[];
  releaseGates: readonly Ticket03GateResult[];
}

interface FrozenBaselineRow {
  id: string;
  workflow: string;
  disposition: CapabilityDisposition;
  workRequired: string;
}

// Transcribed verbatim from the frozen capability-disposition table in Ticket 03's parent spec.
export const FROZEN_BASELINE_ROWS: readonly FrozenBaselineRow[] = [
  {
    id: "codex-runtime",
    workflow: "Codex installation, authentication, model selection, reasoning, runtime modes, streaming, and approvals",
    disposition: "matches",
    workRequired: "Harden protocol capability detection and preserve the existing Codex-native workbench",
  },
  {
    id: "multiple-codex-accounts",
    workflow: "Multiple Codex accounts or instances",
    disposition: "matches",
    workRequired: "Add durable Codex profiles and compatible continuation rules",
  },
  {
    id: "non-codex-providers",
    workflow: "Claude, Cursor, OpenCode, Grok, or provider plug-ins",
    disposition: "intentionally_excludes",
    workRequired: "Preserve ADR-0001 and remove provider-agnostic vocabulary from product contracts",
  },
  {
    id: "projects-and-task-history",
    workflow: "Projects, concurrent threads, pinning, renaming, archiving, and history",
    disposition: "exceeds",
    workRequired: "Use durable Tasks and Runs; add Project Groups and finish global search/navigation",
  },
  {
    id: "task-lifecycle",
    workflow: "Thread as the main lifecycle unit",
    disposition: "exceeds",
    workRequired: "Keep Task intent and Task stage independent of internal Codex thread bindings",
  },
  {
    id: "branches-and-worktrees",
    workflow: "Branch and worktree selection",
    disposition: "exceeds",
    workRequired: "Make Xiao-managed Task worktrees the safe default and retain guarded cleanup",
  },
  {
    id: "task-timeline",
    workflow: "Streaming timeline, tool logs, plans, attachments, skills, and pending input",
    disposition: "matches",
    workRequired: "Keep existing behavior at one ordered Task Workbench seam",
  },
  {
    id: "files-and-diffs",
    workflow: "Files, diffs, selected review context, and changed-file summaries",
    disposition: "matches",
    workRequired: "Add source-revision-aware review context and complete Task workspace scoping",
  },
  {
    id: "in-app-editor",
    workflow: "General in-app file editor",
    disposition: "intentionally_excludes",
    workRequired: "Keep preview, selection, comments, and external-editor handoff",
  },
  {
    id: "terminals",
    workflow: "Multiple integrated terminal sessions and shortcuts",
    disposition: "matches",
    workRequired: "Extend the native Task terminal from one surface to multiple sessions",
  },
  {
    id: "task-preview",
    workflow: "Browser preview, annotations, local server discovery, and agent automation",
    disposition: "exceeds",
    workRequired: "Replace general browsing semantics with Task Preview authority and isolation",
  },
  {
    id: "commands-and-keybindings",
    workflow: "Command palette and configurable contextual keybindings",
    disposition: "matches",
    workRequired: "Back commands with stable identifiers and persisted conflict-checked bindings",
  },
  {
    id: "checkpoints",
    workflow: "Git checkpoints, per-turn diffs, and revert",
    disposition: "exceeds",
    workRequired: "Connect existing time travel to Run safety, Observatory, and Task stage",
  },
  {
    id: "github-publication",
    workflow: "GitHub pull-request publication and checks",
    disposition: "matches",
    workRequired: "Make publication durable and connect merge or acceptance to Task completion",
  },
  {
    id: "non-github-forges",
    workflow: "GitLab, Bitbucket, and Azure DevOps managed API workflows",
    disposition: "intentionally_excludes",
    workRequired: "Retain generic Git remote support; do not add provider-specific control planes",
  },
  {
    id: "project-script-launcher",
    workflow: "Project script launcher",
    disposition: "intentionally_excludes",
    workRequired: "Use Task terminal commands and versioned Acceptance Contract verification instead",
  },
  {
    id: "operational-customization",
    workflow: "Custom themes, panel layout, model visibility, and defaults",
    disposition: "matches",
    workRequired: "Treat them as operational customization, not extension capabilities",
  },
  {
    id: "updates",
    workflow: "Desktop auto-update and Codex update diagnostics",
    disposition: "matches",
    workRequired: "Keep existing Xiao and Codex update recovery visible and scoped",
  },
  {
    id: "remote-execution-environments",
    workflow: "Remote server environments launched through LAN, tunnels, Tailscale, or SSH",
    disposition: "intentionally_excludes",
    workRequired: "Keep the primary Xiao host authoritative; do not create a distributed runtime",
  },
  {
    id: "multi-device-access",
    workflow: "Desktop, hosted web, and native mobile access to agent work",
    disposition: "matches",
    workRequired: "Deliver responsive Companion access for the supervision workflow; native mobile IDE parity is not required",
  },
  {
    id: "offline-and-reconnect",
    workflow: "Cross-environment offline cache and reconnect",
    disposition: "matches",
    workRequired: "Add explicit stale state, ordered reconnect, and host-acknowledged writes for Companion access",
  },
  {
    id: "scheduling",
    workflow: "Scheduling agent work",
    disposition: "exceeds",
    workRequired: "Retain durable Routines under saved execution and verification policy",
  },
  {
    id: "acceptance-and-verification",
    workflow: "Acceptance criteria and durable verification evidence",
    disposition: "exceeds",
    workRequired: "Connect existing contracts and evidence to Task review stages and attention",
  },
  {
    id: "cross-project-supervision",
    workflow: "Cross-Project supervision",
    disposition: "exceeds",
    workRequired: "Make Attention Center canonical, durable, cross-Project, and notification-backed",
  },
  {
    id: "observatory",
    workflow: "Agent hierarchy, waiting state, resource inspection, and recovery",
    disposition: "exceeds",
    workRequired: "Retain and integrate the Observatory with attention and Task outcomes",
  },
  {
    id: "task-handoff",
    workflow: "Task handoff with integrity and idempotent import",
    disposition: "exceeds",
    workRequired: "Retain existing handoff foundation and enforce schema and authority boundaries",
  },
] as const;

const t3Source = (path: string): AssuranceEvidence => ({
  kind: "baseline",
  reference: `https://github.com/pingdotgg/t3code/blob/${T3_CODE_BASELINE.commit}/${path}`,
});

const xiaoSource = (reference: string): AssuranceEvidence => ({
  kind: reference.endsWith(".test.ts") || reference.endsWith(".test.tsx") ? "test" : "implementation",
  reference,
});

const policy = (section: string): AssuranceEvidence => ({
  kind: "policy",
  reference: `.scratch/xiao-best-codex-control-plane/spec.md#${section}`,
});

const exclusion = (rationale: string): ExclusionJustification => ({
  outsideProductPromise: true,
  adjacentXiaoWorkflowDependencies: [],
  rationale,
});

const certificationPassed =
  ticket03Certification.status === "passed"
  && ticket03Certification.baselineCommit === T3_CODE_BASELINE.commit
  && /^sha256:[a-f0-9]{64}$/.test(ticket03Certification.sourceFingerprint)
  && ticket03Certification.rowIds.length === FROZEN_BASELINE_ROWS.length
  && ticket03Certification.rowIds.every(
    (id, index) => id === FROZEN_BASELINE_ROWS[index]?.id,
  )
  && ticket03Certification.gateIds.length === REQUIRED_TICKET_03_GATES.length
  && ticket03Certification.gateIds.every(
    (id, index) => id === REQUIRED_TICKET_03_GATES[index],
  );

export const TICKET_03_CERTIFICATION = ticket03Certification;

const ticket03VerificationEvidence: readonly AssuranceEvidence[] = [{
  kind: "test",
  reference: ticket03Certification.evidence,
}];

const evidenceById: Readonly<Record<string, readonly AssuranceEvidence[]>> = {
  "codex-runtime": [
    t3Source("docs/getting-started/quick-start.md"),
    xiaoSource("src-tauri/src/agent/protocol.rs"),
  ],
  "multiple-codex-accounts": [
    t3Source("docs/providers/codex.md"),
    xiaoSource("src/features/settings/components/SettingsPage.tsx"),
  ],
  "non-codex-providers": [
    t3Source("README.md"),
    policy("out-of-scope"),
  ],
  "projects-and-task-history": [
    t3Source("docs/reference/encyclopedia.md"),
    xiaoSource("src/app/controlModelJourney.test.tsx"),
  ],
  "task-lifecycle": [
    t3Source("packages/contracts/src/orchestration.ts"),
    xiaoSource("src/core/models/xiao.ts"),
  ],
  "branches-and-worktrees": [
    t3Source("docs/reference/encyclopedia.md"),
    xiaoSource("src-tauri/src/execution/service.rs"),
  ],
  "task-timeline": [
    t3Source("apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts"),
    xiaoSource("src/features/task/timeline/TaskTimeline.render.test.tsx"),
  ],
  "files-and-diffs": [
    t3Source("packages/contracts/src/filesystem.ts"),
    xiaoSource("src/features/task/workspace/TaskWorkspace.test.ts"),
  ],
  "in-app-editor": [
    t3Source("apps/web/src/diffFileActions.ts"),
    policy("out-of-scope"),
  ],
  terminals: [
    t3Source("packages/contracts/src/terminal.ts"),
    xiaoSource("src/features/focus-rail/components/terminalSessions.test.ts"),
  ],
  "task-preview": [
    t3Source("packages/contracts/src/preview.ts"),
    xiaoSource("src/features/focus-rail/components/taskPreview.test.ts"),
  ],
  "commands-and-keybindings": [
    t3Source("docs/user/keybindings.md"),
    xiaoSource("src/features/command-menu/commandBindings.test.ts"),
  ],
  checkpoints: [
    t3Source("apps/server/src/orchestration/Services/CheckpointReactor.ts"),
    xiaoSource("src-tauri/src/time_travel/commands.rs"),
  ],
  "github-publication": [
    t3Source("docs/integrations/source-control-providers.md"),
    xiaoSource("src-tauri/src/git/service.rs"),
  ],
  "non-github-forges": [
    t3Source("docs/integrations/source-control-providers.md"),
    policy("out-of-scope"),
  ],
  "project-script-launcher": [
    t3Source("apps/server/src/orchestration/decider.projectScripts.test.ts"),
    policy("out-of-scope"),
  ],
  "operational-customization": [
    t3Source("apps/web/src/routes/settings.keybindings.tsx"),
    xiaoSource("src/features/settings/themeCatalog.test.ts"),
  ],
  updates: [
    t3Source("apps/desktop/src/updates/DesktopUpdates.ts"),
    xiaoSource("src-tauri/src/system/service.rs"),
  ],
  "remote-execution-environments": [
    t3Source("docs/user/remote-access.md"),
    policy("out-of-scope"),
  ],
  "multi-device-access": [
    t3Source("docs/user/remote-access.md"),
    xiaoSource("src/features/companion/companionContract.ts"),
  ],
  "offline-and-reconnect": [
    t3Source("apps/web/src/orchestrationRecovery.ts"),
    xiaoSource("src/features/companion/companionContract.ts"),
  ],
  scheduling: [
    t3Source("apps/server/src/orchestration/decider.projectScripts.test.ts"),
    xiaoSource("src-tauri/src/routines/service.rs"),
  ],
  "acceptance-and-verification": [
    t3Source("apps/server/src/checkpointing/CheckpointStore.ts"),
    xiaoSource("src-tauri/src/verification/service.rs"),
  ],
  "cross-project-supervision": [
    t3Source("packages/contracts/src/orchestration.ts"),
    xiaoSource("src/features/attention/attentionProjection.test.ts"),
  ],
  observatory: [
    t3Source("apps/server/src/orchestration/projector.ts"),
    xiaoSource("src/features/observatory/observatoryProjection.test.ts"),
  ],
  "task-handoff": [
    t3Source("packages/contracts/src/orchestration.ts"),
    xiaoSource("src-tauri/src/handoff/service.rs"),
  ],
};

const exclusionsById: Readonly<Record<string, ExclusionJustification>> = {
  "non-codex-providers": exclusion("Xiao is Codex-native and promises no provider plug-in surface."),
  "in-app-editor": exclusion("Xiao promises inspection and review context, not a general-purpose editor."),
  "non-github-forges": exclusion("Generic Git remains supported without managed non-GitHub forge APIs."),
  "project-script-launcher": exclusion("Task terminals, Routines, and Acceptance Contracts own command execution."),
  "remote-execution-environments": exclusion("The primary Xiao host remains the sole runtime and policy authority."),
};

export const RELEASE_ASSURANCE_MANIFEST: ReleaseAssuranceManifest = {
  baseline: T3_CODE_BASELINE,
  gate: TICKET_03_RELEASE_GATE,
  rows: FROZEN_BASELINE_ROWS.map((row) => ({
    ...row,
    evidence: evidenceById[row.id] ?? [],
    verification: {
      status: certificationPassed ? "passed" : "failed",
      testEvidence: ticket03VerificationEvidence,
    },
    ...(exclusionsById[row.id] ? { exclusion: exclusionsById[row.id] } : {}),
  })),
  releaseGates: REQUIRED_TICKET_03_GATES.map((id) => ({
    id,
    status: certificationPassed ? "passed" : "failed",
    testEvidence: ticket03VerificationEvidence,
  })),
};

export interface AssuranceIssue {
  code:
    | "baseline_mismatch"
    | "gate_mismatch"
    | "missing_row"
    | "duplicate_row"
    | "unexpected_row"
    | "row_mismatch"
    | "missing_evidence"
    | "missing_test_evidence"
    | "invalid_exclusion"
    | "verification_not_passed"
    | "missing_release_gate"
    | "duplicate_release_gate"
    | "unexpected_release_gate"
    | "release_gate_not_passed";
  rowId?: string;
  message: string;
}

export interface ReleaseAssuranceReport {
  passes: boolean;
  issues: readonly AssuranceIssue[];
  rowResults: readonly { id: string; passes: boolean }[];
}

export const evaluateReleaseAssurance = (
  manifest: ReleaseAssuranceManifest,
): ReleaseAssuranceReport => {
  const issues: AssuranceIssue[] = [];
  const expectedById = new Map(FROZEN_BASELINE_ROWS.map((row) => [row.id, row]));
  const actualById = new Map<string, CapabilityDispositionRow[]>();

  if (
    manifest.baseline.product !== T3_CODE_BASELINE.product
    || manifest.baseline.version !== T3_CODE_BASELINE.version
    || manifest.baseline.commit !== T3_CODE_BASELINE.commit
  ) {
    issues.push({ code: "baseline_mismatch", message: "Release evidence is not pinned to T3 Code v0.0.28." });
  }

  if (
    manifest.gate.ticket !== TICKET_03_RELEASE_GATE.ticket
    || manifest.gate.capabilityId !== TICKET_03_RELEASE_GATE.capabilityId
    || manifest.gate.capabilityVersion !== TICKET_03_RELEASE_GATE.capabilityVersion
    || manifest.gate.prerequisiteCapabilityId !== TICKET_03_RELEASE_GATE.prerequisiteCapabilityId
    || manifest.gate.prerequisiteCapabilityVersion !== TICKET_03_RELEASE_GATE.prerequisiteCapabilityVersion
    || !manifest.gate.enableOnlyWhenDispositionSuitePasses
  ) {
    issues.push({ code: "gate_mismatch", message: "Ticket 03 capability gating metadata is invalid." });
  }

  for (const row of manifest.rows) {
    const duplicates = actualById.get(row.id) ?? [];
    duplicates.push(row);
    actualById.set(row.id, duplicates);
  }

  for (const expected of FROZEN_BASELINE_ROWS) {
    const rows = actualById.get(expected.id) ?? [];
    if (rows.length === 0) {
      issues.push({ code: "missing_row", rowId: expected.id, message: `Missing frozen row: ${expected.id}.` });
      continue;
    }
    if (rows.length > 1) {
      issues.push({ code: "duplicate_row", rowId: expected.id, message: `Duplicate frozen row: ${expected.id}.` });
    }

    const row = rows[0];
    if (
      row.workflow !== expected.workflow
      || row.disposition !== expected.disposition
      || row.workRequired !== expected.workRequired
    ) {
      issues.push({ code: "row_mismatch", rowId: row.id, message: `Frozen row changed: ${row.id}.` });
    }
    const evidenceKinds = new Set(row.evidence.map((item) => item.kind));
    if (row.evidence.some((item) => item.reference.trim().length === 0)
      || !evidenceKinds.has("baseline")
      || (!evidenceKinds.has("implementation") && !evidenceKinds.has("test") && !evidenceKinds.has("policy"))) {
      issues.push({ code: "missing_evidence", rowId: row.id, message: `Row lacks baseline and Xiao evidence: ${row.id}.` });
    }
    if (
      row.disposition === "intentionally_excludes"
      && (
        !row.exclusion?.outsideProductPromise
        || row.exclusion.adjacentXiaoWorkflowDependencies.length > 0
        || row.exclusion.rationale.trim().length === 0
        || !evidenceKinds.has("policy")
      )
    ) {
      issues.push({ code: "invalid_exclusion", rowId: row.id, message: `Invalid intentional exclusion: ${row.id}.` });
    }
    const validTestEvidence = row.verification.testEvidence.filter(
      (item) => item.kind === "test" && item.reference.trim().length > 0,
    );
    if (row.verification.status === "passed" && validTestEvidence.length === 0) {
      issues.push({ code: "missing_test_evidence", rowId: row.id, message: `Passed row lacks test evidence: ${row.id}.` });
    }
    if (row.verification.status !== "passed") {
      issues.push({
        code: "verification_not_passed",
        rowId: row.id,
        message: `Runtime verification is ${row.verification.status}: ${row.id}.`,
      });
    }
  }

  for (const row of manifest.rows) {
    if (!expectedById.has(row.id)) {
      issues.push({ code: "unexpected_row", rowId: row.id, message: `Unexpected baseline row: ${row.id}.` });
    }
  }

  const requiredGateIds = new Set<string>(REQUIRED_TICKET_03_GATES);
  const actualGates = new Map<string, Ticket03GateResult[]>();
  for (const gate of manifest.releaseGates) {
    const duplicates = actualGates.get(gate.id) ?? [];
    duplicates.push(gate);
    actualGates.set(gate.id, duplicates);
  }
  for (const id of REQUIRED_TICKET_03_GATES) {
    const gates = actualGates.get(id) ?? [];
    if (gates.length === 0) {
      issues.push({ code: "missing_release_gate", message: `Missing Ticket 03 release gate: ${id}.` });
      continue;
    }
    if (gates.length > 1) {
      issues.push({ code: "duplicate_release_gate", message: `Duplicate Ticket 03 release gate: ${id}.` });
    }
    const gate = gates[0];
    const hasTestEvidence = gate.testEvidence.some(
      (item) => item.kind === "test" && item.reference.trim().length > 0,
    );
    if (gate.status !== "passed" || !hasTestEvidence) {
      issues.push({ code: "release_gate_not_passed", message: `Ticket 03 release gate is not evidenced as passing: ${id}.` });
    }
  }
  for (const gate of manifest.releaseGates) {
    if (!requiredGateIds.has(gate.id)) {
      issues.push({ code: "unexpected_release_gate", message: `Unexpected Ticket 03 release gate: ${gate.id}.` });
    }
  }

  const failingIds = new Set(issues.flatMap((issue) => issue.rowId ? [issue.rowId] : []));
  return {
    passes: issues.length === 0,
    issues,
    rowResults: FROZEN_BASELINE_ROWS.map(({ id }) => ({ id, passes: !failingIds.has(id) })),
  };
};
import ticket03Certification from "./ticket03-certification.json";
