import { describe, expect, it } from "vitest";

import {
  evaluateReleaseAssurance,
  FROZEN_BASELINE_ROWS,
  RELEASE_ASSURANCE_MANIFEST,
  REQUIRED_TICKET_03_GATES,
  TICKET_03_CERTIFICATION,
  T3_CODE_BASELINE,
  TICKET_03_RELEASE_GATE,
  type ReleaseAssuranceManifest,
} from "./releaseAssurance";

const testEvidence = [{ kind: "test" as const, reference: "artifacts/ticket-03/results.xml" }];

const withRows = (
  rows: ReleaseAssuranceManifest["rows"],
): ReleaseAssuranceManifest => ({ ...RELEASE_ASSURANCE_MANIFEST, rows });

const fullyEvidencedManifest = (): ReleaseAssuranceManifest => ({
  ...RELEASE_ASSURANCE_MANIFEST,
  rows: RELEASE_ASSURANCE_MANIFEST.rows.map((row) => ({
    ...row,
    verification: { status: "passed", testEvidence },
  })),
  releaseGates: RELEASE_ASSURANCE_MANIFEST.releaseGates.map((gate) => ({
    ...gate,
    status: "passed",
    testEvidence,
  })),
});

describe("Ticket 03 release assurance", () => {
  it("pins the final capability gate to the frozen T3 Code baseline", () => {
    expect(T3_CODE_BASELINE).toEqual({
      product: "T3 Code",
      version: "0.0.28",
      commit: "fda6486233e0b2f07ecfea166e1a94533cb923c4",
    });
    expect(TICKET_03_RELEASE_GATE).toEqual({
      ticket: "03",
      capabilityId: "companion-release-assurance",
      capabilityVersion: 1,
      prerequisiteCapabilityId: "outcome-supervision-loop",
      prerequisiteCapabilityVersion: 1,
      enableOnlyWhenDispositionSuitePasses: true,
    });
  });

  it("preserves exactly the 26 frozen rows and dispositions", () => {
    expect(FROZEN_BASELINE_ROWS.map(({ id, disposition }) => [id, disposition])).toEqual([
      ["codex-runtime", "matches"],
      ["multiple-codex-accounts", "matches"],
      ["non-codex-providers", "intentionally_excludes"],
      ["projects-and-task-history", "exceeds"],
      ["task-lifecycle", "exceeds"],
      ["branches-and-worktrees", "exceeds"],
      ["task-timeline", "matches"],
      ["files-and-diffs", "matches"],
      ["in-app-editor", "intentionally_excludes"],
      ["terminals", "matches"],
      ["task-preview", "exceeds"],
      ["commands-and-keybindings", "matches"],
      ["checkpoints", "exceeds"],
      ["github-publication", "matches"],
      ["non-github-forges", "intentionally_excludes"],
      ["project-script-launcher", "intentionally_excludes"],
      ["operational-customization", "matches"],
      ["updates", "matches"],
      ["remote-execution-environments", "intentionally_excludes"],
      ["multi-device-access", "matches"],
      ["offline-and-reconnect", "matches"],
      ["scheduling", "exceeds"],
      ["acceptance-and-verification", "exceeds"],
      ["cross-project-supervision", "exceeds"],
      ["observatory", "exceeds"],
      ["task-handoff", "exceeds"],
    ]);
    expect(RELEASE_ASSURANCE_MANIFEST.rows.map(({ id }) => id)).toEqual(
      FROZEN_BASELINE_ROWS.map(({ id }) => id),
    );
  });

  it("retains source evidence and reflects the current certification status", () => {
    expect(TICKET_03_CERTIFICATION.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(TICKET_03_CERTIFICATION.rowIds).toEqual(FROZEN_BASELINE_ROWS.map(({ id }) => id));
    expect(TICKET_03_CERTIFICATION.gateIds).toEqual(REQUIRED_TICKET_03_GATES);
    expect(RELEASE_ASSURANCE_MANIFEST.rows).toHaveLength(26);
    expect(RELEASE_ASSURANCE_MANIFEST.rows.every(
      ({ evidence }) => evidence.some(({ kind }) => kind === "baseline") && evidence.length >= 2,
    )).toBe(true);

    if (TICKET_03_CERTIFICATION.status === "pending") {
      expect(RELEASE_ASSURANCE_MANIFEST.rows.every(
        ({ verification }) => verification.status === "failed",
      )).toBe(true);
      expect(evaluateReleaseAssurance(RELEASE_ASSURANCE_MANIFEST).passes).toBe(false);
      return;
    }

    expect(TICKET_03_CERTIFICATION.status).toBe("passed");
    expect(RELEASE_ASSURANCE_MANIFEST.rows.every(
      ({ verification }) =>
        verification.status === "passed"
        && verification.testEvidence.some(({ kind, reference }) =>
          kind === "test" && reference === "src/features/release-assurance/ticket03-verification.md"),
    )).toBe(true);

    const report = evaluateReleaseAssurance(RELEASE_ASSURANCE_MANIFEST);
    expect(report.passes).toBe(true);
    expect(report.rowResults.every(({ passes }) => passes)).toBe(true);
  });

  it("fails coverage when a frozen row is missing, duplicated, unexpected, or altered", () => {
    const [first, ...withoutFirst] = RELEASE_ASSURANCE_MANIFEST.rows;
    expect(evaluateReleaseAssurance(withRows(withoutFirst)).issues)
      .toContainEqual(expect.objectContaining({ code: "missing_row", rowId: first.id }));
    expect(evaluateReleaseAssurance(withRows([...RELEASE_ASSURANCE_MANIFEST.rows, first])).issues)
      .toContainEqual(expect.objectContaining({ code: "duplicate_row", rowId: first.id }));

    const altered = { ...first, workflow: `${first.workflow} (altered)` };
    expect(evaluateReleaseAssurance(withRows([altered, ...RELEASE_ASSURANCE_MANIFEST.rows.slice(1)])).issues)
      .toContainEqual(expect.objectContaining({ code: "row_mismatch", rowId: first.id }));

    const unexpected = { ...first, id: "invented-baseline-row" };
    expect(evaluateReleaseAssurance(withRows([...RELEASE_ASSURANCE_MANIFEST.rows, unexpected])).issues)
      .toContainEqual(expect.objectContaining({ code: "unexpected_row", rowId: unexpected.id }));
  });

  it("requires source evidence and explicit test evidence for a passing verification", () => {
    const manifest = fullyEvidencedManifest();
    const first = manifest.rows[0];
    const withoutSource = { ...first, evidence: first.evidence.filter(({ kind }) => kind !== "baseline") };
    expect(evaluateReleaseAssurance(withRows([withoutSource, ...manifest.rows.slice(1)])).issues)
      .toContainEqual(expect.objectContaining({ code: "missing_evidence", rowId: first.id }));

    const withoutTest = {
      ...first,
      verification: { status: "passed" as const, testEvidence: [] },
    };
    expect(evaluateReleaseAssurance({ ...manifest, rows: [withoutTest, ...manifest.rows.slice(1)] }).issues)
      .toContainEqual(expect.objectContaining({ code: "missing_test_evidence", rowId: first.id }));
  });

  it("validates all intentional exclusions against the product promise and dependencies", () => {
    const excluded = RELEASE_ASSURANCE_MANIFEST.rows.filter(
      ({ disposition }) => disposition === "intentionally_excludes",
    );
    expect(excluded.map(({ id }) => id)).toEqual([
      "non-codex-providers",
      "in-app-editor",
      "non-github-forges",
      "project-script-launcher",
      "remote-execution-environments",
    ]);

    for (const row of excluded) {
      const invalid = {
        ...row,
        exclusion: { ...row.exclusion!, adjacentXiaoWorkflowDependencies: ["dependent workflow"] },
      };
      const rows = RELEASE_ASSURANCE_MANIFEST.rows.map((candidate) => candidate.id === row.id ? invalid : candidate);
      expect(evaluateReleaseAssurance(withRows(rows)).issues)
        .toContainEqual(expect.objectContaining({ code: "invalid_exclusion", rowId: row.id }));
    }
  });

  it("blocks readiness until every row and required Ticket 03 gate is evidenced as passing", () => {
    const manifest = fullyEvidencedManifest();
    expect(REQUIRED_TICKET_03_GATES).toHaveLength(8);
    expect(evaluateReleaseAssurance(manifest).passes).toBe(true);

    const blockedRow = {
      ...manifest.rows[0],
      verification: { status: "failed" as const, testEvidence },
    };
    expect(evaluateReleaseAssurance({ ...manifest, rows: [blockedRow, ...manifest.rows.slice(1)] }).passes)
      .toBe(false);

    const blockedGate = {
      ...manifest.releaseGates[0],
      status: "pending" as const,
      testEvidence: [],
    };
    const blocked = evaluateReleaseAssurance({
      ...manifest,
      releaseGates: [blockedGate, ...manifest.releaseGates.slice(1)],
    });
    expect(blocked.passes).toBe(false);
    expect(blocked.issues).toContainEqual(expect.objectContaining({ code: "release_gate_not_passed" }));
  });
});
