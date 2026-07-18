import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const now = new Date();
const month = String(now.getMonth() + 1).padStart(2, "0");
const day = String(now.getDate()).padStart(2, "0");
const year = String(now.getFullYear());
const version = `0.0.0-day${month}${day}${year}`;
const versionPattern = /0\.0\.0-?day\d{8}/g;
const files = [
  "README.md",
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
];

const updates = await Promise.all(
  files.map(async (relativePath) => {
    const path = new URL(relativePath, root);
    const source = await readFile(path, "utf8");
    if (!versionPattern.test(source)) {
      throw new Error(`${relativePath} does not contain a Xiao dated version.`);
    }
    versionPattern.lastIndex = 0;
    return { path, source, updated: source.replace(versionPattern, version) };
  }),
);

for (const { path, source, updated } of updates) {
  if (updated !== source) {
    await writeFile(path, updated, "utf8");
  }
}

process.stdout.write(`${version}\n`);
