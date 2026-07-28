import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultRoot = new URL("../", import.meta.url);
const versionPattern = /0\.0\.0-?day\d{8}/g;
const files = [
  "README.md",
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

export function computeBuildVersions({ releaseDate, now = new Date() } = {}) {
  const date = releaseDate ?? now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("XIAO_RELEASE_DATE must be a valid YYYY-MM-DD UTC date.");
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("XIAO_RELEASE_DATE must be a valid YYYY-MM-DD UTC date.");
  }

  const [year, month, day] = date.split("-");
  return {
    version: `0.0.0-day${month}${day}${year}`,
    officialVersion: `${year.slice(-2)}.${Number(month)}.${Number(day)}`,
    releaseDate: date,
  };
}

export async function syncBuildVersions({
  root = defaultRoot,
  releaseDate = process.env.XIAO_RELEASE_DATE,
  check = false,
  now,
} = {}) {
  const { version, officialVersion } = computeBuildVersions({ releaseDate, now });
  const updates = await Promise.all(
    files.map(async (relativePath) => {
      const path = new URL(relativePath, root);
      const source = await readFile(path, "utf8");
      versionPattern.lastIndex = 0;
      if (!versionPattern.test(source)) {
        throw new Error(`${relativePath} does not contain a Xiao dated version.`);
      }
      versionPattern.lastIndex = 0;
      return { relativePath, path, source, updated: source.replace(versionPattern, version) };
    }),
  );

  const tauriConfigPath = new URL("src-tauri/tauri.conf.json", root);
  const tauriConfig = await readFile(tauriConfigPath, "utf8");
  const tauriVersionPattern = /("version"\s*:\s*")\d+\.\d+\.\d+(")/;
  if (!tauriVersionPattern.test(tauriConfig)) {
    throw new Error("src-tauri/tauri.conf.json does not contain an Official version.");
  }
  updates.push({
    relativePath: "src-tauri/tauri.conf.json",
    path: tauriConfigPath,
    source: tauriConfig,
    updated: tauriConfig.replace(tauriVersionPattern, `$1${officialVersion}$2`),
  });

  const changed = updates.filter(({ source, updated }) => updated !== source);
  if (check && changed.length > 0) {
    throw new Error(`Build versions are stale: ${changed.map(({ relativePath }) => relativePath).join(", ")}`);
  }
  if (!check) {
    await Promise.all(changed.map(({ path, updated }) => writeFile(path, updated, "utf8")));
  }

  return { version, officialVersion, changed: changed.map(({ relativePath }) => relativePath) };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const result = await syncBuildVersions({ check: process.argv.includes("--check") });
  process.stdout.write(`${result.version} (Official ${result.officialVersion})\n`);
}
