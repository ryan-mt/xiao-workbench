import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  computeTicket03SourceFingerprint,
  isTicket03SourcePath,
  syncTicket03Certification,
} from "./sync-ticket03-certification.mjs";

const certification = {
  status: "passed",
  verifiedAt: "2026-07-28",
  baselineCommit: "fda6486233e0b2f07ecfea166e1a94533cb923c4",
  sourceFingerprint: `sha256:${"00".repeat(32)}`,
  evidence: "src/features/release-assurance/ticket03-verification.md",
  rowIds: [],
  gateIds: [],
};

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "xiao-certification-"));
  await mkdir(join(root, "src/features/release-assurance"), { recursive: true });
  await mkdir(join(root, "src-tauri"), { recursive: true });
  await writeFile(join(root, "src/example.ts"), 'export const version = "0.0.0-day07282026";\r\n');
  await writeFile(join(root, "src-tauri/tauri.conf.json"), '{\r\n  "version": "26.7.28"\r\n}\r\n');
  await writeFile(
    join(root, "src/features/release-assurance/ticket03-certification.json"),
    `${JSON.stringify(certification, null, 2)}\n`,
  );
  await writeFile(
    join(root, "src/features/release-assurance/ticket03-verification.md"),
    `Certified Ticket 03 source fingerprint:\n\`${certification.sourceFingerprint}\`.\n`,
  );
  return root;
}

test("normalizes dated versions and checkout line endings", async () => {
  const root = await createFixture();
  try {
    const first = await computeTicket03SourceFingerprint({ root: pathToFileURL(`${root}/`) });
    await writeFile(join(root, "src/example.ts"), 'export const version = "0.0.0-day01012030";\n');
    await writeFile(join(root, "src-tauri/tauri.conf.json"), '{\n  "version": "30.1.1"\n}\n');
    const second = await computeTicket03SourceFingerprint({ root: pathToFileURL(`${root}/`) });
    assert.equal(second, first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("matches the Rust source coverage boundaries", () => {
  assert.equal(isTicket03SourcePath("src/app/App.tsx"), true);
  assert.equal(isTicket03SourcePath("src-tauri/src/main.rs"), true);
  assert.equal(isTicket03SourcePath("scripts/sync-build-version.mjs"), true);
  assert.equal(isTicket03SourcePath("package.json"), true);
  assert.equal(isTicket03SourcePath(certification.evidence), false);
  assert.equal(
    isTicket03SourcePath("src/features/release-assurance/ticket03-certification.json"),
    false,
  );
  assert.equal(isTicket03SourcePath("docs/adr/0001-keep-xiao-codex-native.md"), false);
  assert.equal(isTicket03SourcePath("src-tauri/target/generated.rs"), false);
});

test("marks changed source pending without rewriting verified evidence", async () => {
  const root = await createFixture();
  try {
    const result = await syncTicket03Certification({ root: pathToFileURL(`${root}/`) });
    const document = JSON.parse(await readFile(
      join(root, "src/features/release-assurance/ticket03-certification.json"),
      "utf8",
    ));
    const evidence = await readFile(
      join(root, "src/features/release-assurance/ticket03-verification.md"),
      "utf8",
    );

    assert.equal(result.changed, true);
    assert.equal(document.status, "pending");
    assert.equal(document.verifiedAt, null);
    assert.equal(document.sourceFingerprint, result.fingerprint);
    assert.match(evidence, /sha256:0{64}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotes pending source only when explicitly certified", async () => {
  const root = await createFixture();
  try {
    await syncTicket03Certification({ root: pathToFileURL(`${root}/`) });
    const result = await syncTicket03Certification({
      root: pathToFileURL(`${root}/`),
      certify: true,
      verifiedAt: "2026-07-29",
    });
    const document = JSON.parse(await readFile(
      join(root, "src/features/release-assurance/ticket03-certification.json"),
      "utf8",
    ));
    const evidence = await readFile(
      join(root, "src/features/release-assurance/ticket03-verification.md"),
      "utf8",
    );

    assert.equal(document.status, "passed");
    assert.equal(document.verifiedAt, "2026-07-29");
    assert.equal(document.sourceFingerprint, result.fingerprint);
    assert.match(evidence, new RegExp(result.fingerprint));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check mode rejects a stale fingerprint without editing files", async () => {
  const root = await createFixture();
  try {
    await assert.rejects(
      syncTicket03Certification({ root: pathToFileURL(`${root}/`), check: true }),
      /Ticket 03 source fingerprint is stale/,
    );
    const unchanged = JSON.parse(await readFile(
      join(root, "src/features/release-assurance/ticket03-certification.json"),
      "utf8",
    ));
    assert.equal(unchanged.status, "passed");
    assert.equal(unchanged.sourceFingerprint, certification.sourceFingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
