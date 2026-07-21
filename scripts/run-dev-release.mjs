import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriCli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const executableName = process.platform === "win32"
  ? "xiao-workbench.exe"
  : "xiao-workbench";
const releaseExecutable = join(
  root,
  "src-tauri",
  "target",
  "release",
  executableName,
);

if (!existsSync(tauriCli)) {
  throw new Error("Tauri CLI is missing. Run `npm install` first.");
}

const build = spawnSync(
  process.execPath,
  [
    tauriCli,
    "build",
    "--config",
    "src-tauri/tauri.beta.conf.json",
    "--no-bundle",
  ],
  { cwd: root, stdio: "inherit" },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
if (!existsSync(releaseExecutable)) {
  throw new Error(`Release executable was not created at ${releaseExecutable}.`);
}

const snapshotDirectory = mkdtempSync(join(tmpdir(), "xiao-workbench-dev-"));
const snapshotExecutable = join(snapshotDirectory, basename(releaseExecutable));
copyFileSync(releaseExecutable, snapshotExecutable);
if (process.platform !== "win32") chmodSync(snapshotExecutable, 0o755);

process.stdout.write(
  "\nLaunching a fixed Xiao Workbench Beta release snapshot.\n" +
  "Source edits will not refresh this window. Close the app to end this command.\n\n",
);

try {
  const app = spawnSync(snapshotExecutable, [], {
    cwd: root,
    stdio: "inherit",
  });
  if (app.error) throw app.error;
  process.exitCode = app.status ?? 0;
} finally {
  rmSync(snapshotDirectory, { recursive: true, force: true });
}
