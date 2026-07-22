import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import {
  compactCommandAttempts,
  isEnvironmentBlockedCommand,
} from "./commandPresentation";

const command = (
  id: string,
  value: string,
  status: TimelineEntry["status"],
  body?: string,
): TimelineEntry => ({
  id,
  kind: "command",
  title: id,
  command: value,
  status,
  body,
  meta: "C:/workspace",
});

describe("compactCommandAttempts", () => {
  it("collapses retries and keeps the active attempt as the current presentation", () => {
    const failed = command("failed", "npm test", "error", "First failure");
    const active = command("active", "npm test", "active");
    const attempts = compactCommandAttempts([failed, active]);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ entry: active, attempts: 2 });
    expect(attempts[0].entryIds).toEqual(["failed", "active"]);
  });

  it("uses the latest settled retry and does not merge commands from another cwd", () => {
    const failed = command("failed", "npm run check", "error");
    const passed = command("passed", "npm run check", "success");
    const elsewhere = { ...passed, id: "elsewhere", meta: "C:/other" };

    const attempts = compactCommandAttempts([failed, passed, elsewhere]);

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ entry: passed, attempts: 2 });
    expect(attempts[1]).toMatchObject({ entry: elsewhere, attempts: 1 });
  });

  it("treats cargo fmt as recovery for a failed cargo fmt check", () => {
    const failedCheck = command(
      "failed-check",
      "powershell.exe -Command 'cargo fmt --check --manifest-path src-tauri/Cargo.toml'",
      "error",
    );
    const formatted = command(
      "formatted",
      "powershell.exe -Command 'cargo fmt --manifest-path src-tauri/Cargo.toml'",
      "success",
    );

    const attempts = compactCommandAttempts([failedCheck, formatted]);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ entry: formatted, attempts: 2 });
  });
});

describe("isEnvironmentBlockedCommand", () => {
  it("recognizes permission failures", () => {
    expect(isEnvironmentBlockedCommand(command(
      "sandbox",
      "npm test",
      "error",
      "Error: spawn EPERM\n    at ChildProcess.spawn",
    ))).toBe(true);
  });

  it("keeps unavailable tools and dependencies as command errors", () => {
    expect(isEnvironmentBlockedCommand(command(
      "lsp",
      "xiao_lsp diagnostics",
      "error",
      "typescript-language-server was not found. Install it in the workspace or on PATH.",
    ))).toBe(false);
    expect(isEnvironmentBlockedCommand(command(
      "deps",
      "npm run check",
      "error",
      [
        "Cannot find module 'react'",
        "Cannot find module 'vitest'",
        "Cannot find module 'react/jsx-runtime'",
      ].join("\n"),
    ))).toBe(false);
  });

  it("keeps product and single-import failures as real command errors", () => {
    expect(isEnvironmentBlockedCommand(command(
      "assertion",
      "npm test",
      "error",
      "AssertionError: expected 1 to equal 2",
    ))).toBe(false);
    expect(isEnvironmentBlockedCommand(command(
      "source",
      "npm run check",
      "error",
      "Cannot find module './missing-local-file'",
    ))).toBe(false);
  });
});
