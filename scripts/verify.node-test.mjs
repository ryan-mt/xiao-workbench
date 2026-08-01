import assert from "node:assert/strict";
import test from "node:test";

import { VERIFY_GATES, releaseDateFromPackageVersion, runVerify } from "./verify.mjs";

test("exposes the exact full-gate command order", () => {
  assert.deepEqual(
    VERIFY_GATES.map(([command, args]) => [command, ...args]),
    [
      ["npm", "run", "version:test"],
      ["npm", "run", "version:check"],
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

test("derives a fixed release date from the checked-in package version across midnight", () => {
  const RealDate = globalThis.Date;
  let now = "2026-07-31T23:59:59.999Z";
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [now] : args));
    }

    static now() {
      return new RealDate(now).valueOf();
    }
  };

  try {
    const beforeMidnight = releaseDateFromPackageVersion("0.0.0-day07312026");
    now = "2026-08-01T00:00:00.000Z";
    const afterMidnight = releaseDateFromPackageVersion("0.0.0-day07312026");

    assert.equal(beforeMidnight, "2026-07-31");
    assert.equal(afterMidnight, beforeMidnight);
  } finally {
    globalThis.Date = RealDate;
  }
});

test("rejects malformed and impossible package version dates", () => {
  for (const version of [
    "0.0.0-day7312026",
    "0.0.0-day02302026",
    "1.0.0-day07312026",
    "0.0.0-day07312026-extra",
  ]) {
    assert.throws(() => releaseDateFromPackageVersion(version));
  }
});

test("passes the package-derived date to every gate including the final npm build", () => {
  const environments = [];
  const status = runVerify({
    gates: [
      ["node", ["first-gate"]],
      ["npm", ["run", "build"]],
    ],
    env: { TEST_ENV: "preserved" },
    spawn: (_command, _args, options) => {
      environments.push(options.env);
      return { status: 0 };
    },
    write: () => {},
  });

  assert.equal(status, 0);
  assert.deepEqual(
    environments.map(({ XIAO_RELEASE_DATE, TEST_ENV }) => ({ XIAO_RELEASE_DATE, TEST_ENV })),
    [
      { XIAO_RELEASE_DATE: "2026-07-31", TEST_ENV: "preserved" },
      { XIAO_RELEASE_DATE: "2026-07-31", TEST_ENV: "preserved" },
    ],
  );
});

test("uses a valid explicit release date override and rejects invalid overrides", () => {
  const environments = [];
  assert.equal(runVerify({
    gates: [["node", ["gate"]]],
    env: { XIAO_RELEASE_DATE: "2026-08-01" },
    spawn: (_command, _args, options) => {
      environments.push(options.env);
      return { status: 0 };
    },
    write: () => {},
  }), 0);
  assert.equal(environments[0].XIAO_RELEASE_DATE, "2026-08-01");

  assert.throws(
    () => runVerify({ gates: [], env: { XIAO_RELEASE_DATE: "2026-02-30" }, write: () => {} }),
    /XIAO_RELEASE_DATE must be a valid YYYY-MM-DD UTC date/,
  );
});
