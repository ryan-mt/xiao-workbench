import assert from "node:assert/strict";
import test from "node:test";

import { computeBuildVersions } from "./sync-build-version.mjs";

test("uses the UTC calendar date instead of the host timezone", () => {
  assert.deepEqual(
    computeBuildVersions({ now: new Date("2026-07-28T00:30:00.000Z") }),
    {
      version: "0.0.0-day07282026",
      officialVersion: "26.7.28",
      releaseDate: "2026-07-28",
    },
  );
});

test("accepts a validated deterministic release date override", () => {
  assert.deepEqual(
    computeBuildVersions({ releaseDate: "2026-07-28", now: new Date("2030-01-01T00:00:00Z") }),
    {
      version: "0.0.0-day07282026",
      officialVersion: "26.7.28",
      releaseDate: "2026-07-28",
    },
  );
});

test("rejects malformed or impossible release date overrides", () => {
  for (const releaseDate of ["2026-7-28", "2026-02-30", "not-a-date"]) {
    assert.throws(
      () => computeBuildVersions({ releaseDate }),
      /XIAO_RELEASE_DATE must be a valid YYYY-MM-DD UTC date/,
    );
  }
});
