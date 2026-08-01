import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const VERIFY_GATES = Object.freeze([
  ["npm", ["run", "version:test"]],
  ["npm", ["run", "version:check"]],
  ["npm", ["run", "check"]],
  ["npm", ["test", "--", "--run"]],
  ["cargo", ["fmt", "--all", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"]],
  ["cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"]],
  ["cargo", ["check", "--manifest-path", "src-tauri/Cargo.toml"]],
  ["npm", ["run", "lint", "--prefix", "website-xiao"]],
  ["npm", ["run", "typecheck", "--prefix", "website-xiao"]],
  ["npm", ["run", "build", "--prefix", "website-xiao"]],
  ["npm", ["audit", "--json"]],
  ["node", ["scripts/verify-website-audit.mjs"]],
  ["npm", ["run", "build"]],
  ["git", ["diff", "--check"]],
  ["git", ["diff", "--cached", "--check"]],
]);

function formatCommand(command, args) {
  return `${command} ${args.join(" ")}`;
}

function assertValidReleaseDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("XIAO_RELEASE_DATE must be a valid YYYY-MM-DD UTC date.");
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("XIAO_RELEASE_DATE must be a valid YYYY-MM-DD UTC date.");
  }
  return date;
}

export function releaseDateFromPackageVersion(version) {
  const match = /^0\.0\.0-day(\d{2})(\d{2})(\d{4})$/.exec(version);
  if (!match) {
    throw new Error("Root package.json version must exactly match 0.0.0-dayMMDDYYYY.");
  }
  const [, month, day, year] = match;
  return assertValidReleaseDate(`${year}-${month}-${day}`);
}

function verifyEnvironment(cwd, env) {
  if (Object.hasOwn(env, "XIAO_RELEASE_DATE")) {
    return { ...env, XIAO_RELEASE_DATE: assertValidReleaseDate(env.XIAO_RELEASE_DATE) };
  }
  const packageJson = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
  return {
    ...env,
    XIAO_RELEASE_DATE: releaseDateFromPackageVersion(packageJson.version),
  };
}

function spawnCommand(command, args, { spawn, cwd, env }) {
  const usesWindowsNpmShim = process.platform === "win32" && command === "npm";
  return spawn(
    usesWindowsNpmShim ? (env.ComSpec ?? process.env.ComSpec ?? "cmd.exe") : command,
    usesWindowsNpmShim
      ? ["/d", "/s", "/c", `npm ${args.join(" ")}`]
      : args,
    {
      cwd,
      env,
      stdio: "inherit",
    },
  );
}

/**
 * Sequential verification runner. Stops at the first non-zero status and
 * returns that status. Injectable `spawn` keeps unit tests free of real gates.
 */
export function runVerify({
  gates = VERIFY_GATES,
  spawn = spawnSync,
  cwd = process.cwd(),
  env = process.env,
  write = (text) => process.stdout.write(text),
} = {}) {
  const gateEnv = verifyEnvironment(cwd, env);
  for (const [command, args] of gates) {
    write(`\n[verify] ${formatCommand(command, args)}\n`);
    const result = spawnCommand(command, args, { spawn, cwd, env: gateEnv });
    if (result.error) {
      write(`[verify] failed to start: ${result.error.message}\n`);
      return 1;
    }
    const status = result.status ?? 1;
    if (status !== 0) {
      write(`[verify] failed (${status}): ${formatCommand(command, args)}\n`);
      return status;
    }
  }
  write("\n[verify] all gates passed\n");
  return 0;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exit(runVerify());
}
