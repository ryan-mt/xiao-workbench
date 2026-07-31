import assert from "node:assert/strict";
import test from "node:test";

import { VERIFY_GATES, runVerify } from "./verify.mjs";

test("exposes the exact full-gate command order", () => {
  assert.deepEqual(
    VERIFY_GATES.map(([command, args]) => [command, ...args]),
    [
      ["npm", "run", "version:test"],
      ["npm", "run", "version:check"],
      ["npm", "run", "certification:test"],
      ["npm", "run", "certification:check"],
      ["npm", "run", "check"],
      ["npm", "test", "--", "--run"],
      ["cargo", "fmt", "--all", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"],
      ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml"],
      ["cargo", "check", "--manifest-path", "src-tauri/Cargo.toml"],
      ["npm", "run", "lint", "--prefix", "website-xiao"],
      ["npm", "run", "typecheck", "--prefix", "website-xiao"],
      ["npm", "run", "build", "--prefix", "website-xiao"],
      ["npm", "audit", "--json"],
      ["node", "scripts/verify-website-audit.mjs"],
      ["npm", "run", "build"],
      ["git", "diff", "--check"],
      ["git", "diff", "--cached", "--check"],
    ],
  );
});

test("stops at the first failure and propagates its status", () => {
  const started = [];
  const status = runVerify({
    gates: [
      ["node", ["gate-a"]],
      ["node", ["gate-b"]],
      ["node", ["gate-c"]],
    ],
    spawn: (_command, args) => {
      const label = args.join(" ");
      started.push(label);
      if (label.includes("gate-b")) {
        return { status: 17 };
      }
      return { status: 0 };
    },
    write: () => {},
  });

  assert.equal(status, 17);
  assert.deepEqual(started, ["gate-a", "gate-b"]);
});

test("returns zero only when every gate succeeds", () => {
  const started = [];
  const status = runVerify({
    gates: [
      ["node", ["one"]],
      ["node", ["two"]],
    ],
    spawn: (_command, args) => {
      started.push(args.join(" "));
      return { status: 0 };
    },
    write: () => {},
  });
  assert.equal(status, 0);
  assert.deepEqual(started, ["one", "two"]);
});
