import { spawnSync } from "node:child_process";

import {
  isTicket03SourcePath,
  syncTicket03Certification,
} from "./sync-ticket03-certification.mjs";

const certificationPaths = [
  "src/features/release-assurance/ticket03-certification.json",
  "src/features/release-assurance/ticket03-verification.md",
];

function run(command, args) {
  process.stdout.write(`\n[Ticket 03] ${command} ${args.join(" ")}\n`);
  const usesWindowsCommandShim = process.platform === "win32" && command === "npm";
  const result = spawnSync(
    usesWindowsCommandShim ? (process.env.ComSpec ?? "cmd.exe") : command,
    usesWindowsCommandShim
      ? ["/d", "/s", "/c", `npm ${args.join(" ")}`]
      : args,
    { stdio: "inherit" },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function gitLines(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
}

function sourcePaths(paths) {
  return paths.filter(isTicket03SourcePath);
}

function assertStagedSourceMatchesWorktree() {
  const unstaged = sourcePaths([
    ...gitLines(["diff", "--name-only", "--diff-filter=ACMR"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ]);
  if (unstaged.length > 0) {
    throw new Error(
      "Ticket 03 cannot certify a commit while source changes are unstaged:\n"
      + unstaged.map((path) => `- ${path}`).join("\n"),
    );
  }
}

for (const name of gitLines(["rev-parse", "--local-env-vars"])) {
  delete process.env[name];
}

const stagedSource = sourcePaths(
  gitLines(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]),
);
if (stagedSource.length === 0) {
  process.stdout.write("[Ticket 03] No certified source is staged; release gates skipped.\n");
  process.exit(0);
}

assertStagedSourceMatchesWorktree();
await syncTicket03Certification();

const gates = [
  ["npm", ["run", "version:test"]],
  ["npm", ["run", "version:check"]],
  ["npm", ["run", "certification:test"]],
  ["npm", ["run", "check"]],
  ["npm", ["test"]],
  ["cargo", ["fmt", "--all", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"]],
  ["cargo", [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--",
    "--test-threads=1",
  ]],
  ["cargo", ["check", "--manifest-path", "src-tauri/Cargo.toml"]],
  ["cargo", ["build", "--manifest-path", "src-tauri/Cargo.toml"]],
  ["npm", ["run", "build"]],
];
for (const [command, args] of gates) {
  run(command, args);
}

assertStagedSourceMatchesWorktree();
run("git", ["diff", "--check"]);
run("git", ["diff", "--cached", "--check"]);

const certification = await syncTicket03Certification({ certify: true });
run("npm", ["run", "certification:check"]);
run("cargo", ["check", "--manifest-path", "src-tauri/Cargo.toml"]);
run("cargo", ["build", "--manifest-path", "src-tauri/Cargo.toml"]);
run("npm", ["run", "build"]);
run("git", ["add", "--", ...certificationPaths]);

process.stdout.write(
  `\n[Ticket 03] Certified ${certification.fingerprint} after all release gates passed.\n`,
);
