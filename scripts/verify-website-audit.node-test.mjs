import assert from "node:assert/strict";
import test from "node:test";

import {
  STABLE_NEXT_RESIDUAL_ADVISORY_IDS,
  evaluateWebsiteAudit,
  verifyWebsiteAudit,
} from "./verify-website-audit.mjs";

function residualAudit() {
  // Mirrors current npm audit --json shape: GHSA lives in via[].url.
  return {
    vulnerabilities: {
      postcss: {
        name: "postcss",
        severity: "high",
        via: [
          {
            source: 1,
            name: "postcss",
            dependency: "postcss",
            title: "PostCSS line return",
            severity: "moderate",
            url: "https://github.com/advisories/GHSA-qx2v-qp2m-jg93",
          },
          {
            source: 2,
            name: "postcss",
            dependency: "postcss",
            title: "PostCSS parsing",
            severity: "high",
            url: "https://github.com/advisories/GHSA-6g55-p6wh-862q",
          },
          {
            source: 3,
            name: "postcss",
            dependency: "postcss",
            title: "PostCSS",
            severity: "high",
            url: "https://github.com/advisories/GHSA-r28c-9q8g-f849",
          },
        ],
      },
      sharp: {
        name: "sharp",
        severity: "high",
        via: [
          {
            source: 4,
            name: "sharp",
            dependency: "sharp",
            title: "Sharp",
            severity: "high",
            url: "https://github.com/advisories/GHSA-f88m-g3jw-g9cj",
          },
        ],
      },
    },
  };
}

test("passes a clean audit", () => {
  const result = evaluateWebsiteAudit({ vulnerabilities: {} });
  assert.equal(result.ok, true);
  assert.equal(result.code, "clean");
});

test("passes the exact four residual GHSA IDs", () => {
  const result = evaluateWebsiteAudit(residualAudit());
  assert.equal(result.ok, true);
  assert.equal(result.code, "residuals");
  assert.deepEqual(
    result.advisories.map((item) => item.id).sort(),
    [...STABLE_NEXT_RESIDUAL_ADVISORY_IDS].sort(),
  );
});

test("fails on an unknown advisory of any severity", () => {
  const audit = residualAudit();
  audit.vulnerabilities.lodash = {
    name: "lodash",
    severity: "moderate",
    via: [
      {
        source: 5,
        name: "lodash",
        title: "Prototype pollution",
        severity: "moderate",
        github_advisory_id: "GHSA-unknown-test-id01",
      },
    ],
  };
  const result = evaluateWebsiteAudit(audit);
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown");
  assert.match(result.message, /GHSA-unknown-test-id01/);
});

test("fails on any critical advisory", () => {
  const result = evaluateWebsiteAudit({
    vulnerabilities: {
      evil: {
        name: "evil",
        severity: "critical",
        via: [
          {
            source: 9,
            name: "evil",
            severity: "critical",
            github_advisory_id: "GHSA-crit-test-id0001",
          },
        ],
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "critical");
});

test("fails on malformed audit JSON at the runner boundary", () => {
  const lines = [];
  const status = verifyWebsiteAudit({
    spawn: () => ({ status: 1, stdout: "not-json", stderr: "" }),
    write: (text) => lines.push(text),
  });
  assert.equal(status, 1);
  assert.match(lines.join(""), /could not be parsed/i);
});

test("accepts npm exit 1 when residuals are allowlisted", () => {
  const lines = [];
  const status = verifyWebsiteAudit({
    spawn: () => ({
      status: 1,
      stdout: JSON.stringify(residualAudit()),
      stderr: "",
    }),
    write: (text) => lines.push(text),
  });
  assert.equal(status, 0);
  assert.match(lines.join(""), /residual/i);
});
