import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = new URL("../", import.meta.url);
const certificationRelativePath =
  "src/features/release-assurance/ticket03-certification.json";
const evidenceRelativePath =
  "src/features/release-assurance/ticket03-verification.md";
const rootFiles = new Set([
  "README.md",
  "index.html",
  "package-lock.json",
  "package.json",
  "tsconfig.app.json",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
]);
const excludedDirectories = new Set([
  ".git",
  ".hermes",
  ".next",
  ".pi",
  ".scratch",
  ".vite",
  "coverage",
  "dist",
  "docs",
  "gen",
  "node_modules",
  "plans",
  "target",
]);
const releaseSourceExtensions = new Set([
  "c",
  "cc",
  "cpp",
  "css",
  "h",
  "html",
  "js",
  "json",
  "jsx",
  "lock",
  "mjs",
  "rs",
  "scss",
  "toml",
  "ts",
  "tsx",
  "vue",
  "yaml",
  "yml",
]);

const excludedSourceFile = (relativePath) =>
  relativePath === certificationRelativePath || relativePath === evidenceRelativePath;

export const isTicket03SourcePath = (relativePath) =>
  !relativePath.split("/").some((component) => excludedDirectories.has(component))
  && (
    (
      relativePath.startsWith("public/")
      || relativePath.startsWith("scripts/")
      || relativePath.startsWith("src/")
      || relativePath.startsWith("src-tauri/")
    )
    && !excludedSourceFile(relativePath)
    || rootFiles.has(relativePath)
  );

const releaseSourceCandidate = (relativePath) => {
  const filename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const separator = filename.lastIndexOf(".");
  return separator >= 0 && releaseSourceExtensions.has(filename.slice(separator + 1));
};

const normalizeBuildVersion = (relativePath, source) => {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    return source;
  }
  text = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/0\.0\.0-day\d{8}/g, "0.0.0-dayBUILD_DATE");
  if (
    relativePath === "src-tauri/tauri.conf.json"
    || relativePath === "src-tauri/tauri.beta.conf.json"
  ) {
    const lines = text.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    text = lines
      .map((line) =>
        line.trimStart().startsWith('"version":')
          ? '  "version": "BUILD_VERSION",'
          : line)
      .join("\n");
  }
  return Buffer.from(text);
};

async function ticket03SourceManifest(root) {
  const rootPath = fileURLToPath(root);
  const files = [];

  async function collect(directoryPath, relativeDirectory = "") {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const path = resolve(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (!relativePath.split("/").some((component) => excludedDirectories.has(component))) {
          await collect(path, relativePath);
        }
      } else if (entry.isFile()) {
        if (isTicket03SourcePath(relativePath)) {
          files.push({ path, relativePath });
        } else if (releaseSourceCandidate(relativePath) && !excludedSourceFile(relativePath)) {
          throw new Error(
            `Release source lies outside Ticket 03 fingerprint coverage: ${relativePath}`,
          );
        }
      }
    }
  }

  await collect(rootPath);
  return files;
}

export async function computeTicket03SourceFingerprint({ root = defaultRoot, trace } = {}) {
  const digest = createHash("sha256");
  for (const { path, relativePath } of await ticket03SourceManifest(root)) {
    digest.update(relativePath);
    digest.update(Buffer.from([0]));
    digest.update(normalizeBuildVersion(relativePath, await readFile(path)));
    digest.update(Buffer.from([0]));
    trace?.(relativePath, `sha256:${digest.copy().digest("hex")}`);
  }
  return `sha256:${digest.digest("hex")}`;
}

export async function syncTicket03Certification({
  root = defaultRoot,
  check = false,
  certify = false,
  verifiedAt = new Date().toISOString().slice(0, 10),
} = {}) {
  const certificationUrl = new URL(certificationRelativePath, root);
  const evidenceUrl = new URL(evidenceRelativePath, root);
  const source = await readFile(certificationUrl, "utf8");
  const document = JSON.parse(source);
  const fingerprint = await computeTicket03SourceFingerprint({ root });
  const fingerprintChanged = document.sourceFingerprint !== fingerprint;

  if (check && (fingerprintChanged || document.status !== "passed")) {
    throw new Error(
      `Ticket 03 source fingerprint is stale or pending: ${document.sourceFingerprint} -> ${fingerprint}`,
    );
  }

  if (fingerprintChanged) {
    document.status = "pending";
    document.verifiedAt = null;
    document.sourceFingerprint = fingerprint;
  }
  if (certify) {
    document.status = "passed";
    document.verifiedAt = verifiedAt;
    document.sourceFingerprint = fingerprint;
  }

  const updated = `${JSON.stringify(document, null, 2)}\n`;
  const certificationChanged = updated !== source;
  if (!check && certificationChanged) {
    await writeFile(certificationUrl, updated, "utf8");
  }

  let evidenceChanged = false;
  if (certify) {
    const evidence = await readFile(evidenceUrl, "utf8");
    const updatedEvidence = evidence
      .replace(/Verified on \d{4}-\d{2}-\d{2}/, `Verified on ${verifiedAt}`)
      .replace(/sha256:[a-f0-9]{64}/, fingerprint);
    if (!updatedEvidence.includes(fingerprint)) {
      throw new Error("Ticket 03 verification evidence has no source fingerprint field.");
    }
    evidenceChanged = evidence !== updatedEvidence;
    if (evidenceChanged) {
      await writeFile(evidenceUrl, updatedEvidence, "utf8");
    }
  }

  return {
    fingerprint,
    changed: certificationChanged || evidenceChanged,
    status: document.status,
  };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  if (process.argv.includes("--print")) {
    process.stdout.write(`${await computeTicket03SourceFingerprint()}\n`);
  } else {
    const result = await syncTicket03Certification({
      check: process.argv.includes("--check"),
    });
    process.stdout.write(`Ticket 03 ${result.status}: ${result.fingerprint}\n`);
  }
}
