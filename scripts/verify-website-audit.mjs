import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Temporary stable-Next residual advisories. When stable Next ships a clean
 * tree, this allowlist may be empty and the script still passes.
 */
export const STABLE_NEXT_RESIDUAL_ADVISORY_IDS = Object.freeze([
  "GHSA-qx2v-qp2m-jg93",
  "GHSA-6g55-p6wh-862q",
  "GHSA-r28c-9q8g-f849",
  "GHSA-f88m-g3jw-g9cj",
]);

const residualSet = new Set(STABLE_NEXT_RESIDUAL_ADVISORY_IDS);

function runNpmAuditJson({ spawn = spawnSync, prefix = "website-xiao" } = {}) {
  const usesWindowsCommandShim = process.platform === "win32";
  const args = ["audit", "--prefix", prefix, "--json"];
  const result = spawn(
    usesWindowsCommandShim ? (process.env.ComSpec ?? "cmd.exe") : "npm",
    usesWindowsCommandShim
      ? ["/d", "/s", "/c", `npm ${args.join(" ")}`]
      : args,
    { encoding: "utf8" },
  );
  if (result.error) {
    throw result.error;
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function collectConcreteAdvisories(audit) {
  const byId = new Map();

  const consider = (entry) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    let id = entry.github_advisory_id || entry.id || null;
    if (typeof id !== "string" || !id.startsWith("GHSA-")) {
      const url = typeof entry.url === "string" ? entry.url : "";
      const match = url.match(/GHSA-[a-z0-9-]+/i);
      id = match ? match[0] : null;
    }
    if (typeof id !== "string" || !id.startsWith("GHSA-")) {
      return;
    }
    const severity = String(entry.severity ?? "").toLowerCase();
    byId.set(id, {
      id,
      severity,
      title: entry.title ?? entry.overview ?? id,
      module: entry.module_name ?? entry.name ?? null,
    });
  };

  if (audit.vulnerabilities && typeof audit.vulnerabilities === "object") {
    for (const entry of Object.values(audit.vulnerabilities)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      if (Array.isArray(entry.via)) {
        for (const via of entry.via) {
          if (typeof via === "object" && via !== null) {
            consider(via);
          }
        }
      }
      consider(entry);
    }
  }

  if (audit.advisories && typeof audit.advisories === "object") {
    for (const entry of Object.values(audit.advisories)) {
      consider(entry);
    }
  }

  return [...byId.values()];
}

export function evaluateWebsiteAudit(audit, {
  allowlist = STABLE_NEXT_RESIDUAL_ADVISORY_IDS,
} = {}) {
  if (!audit || typeof audit !== "object") {
    return {
      ok: false,
      code: "malformed",
      message: "Website npm audit produced malformed JSON.",
    };
  }

  const allowed = new Set(allowlist);
  const advisories = collectConcreteAdvisories(audit);

  const critical = advisories.filter((item) => item.severity === "critical");
  if (critical.length > 0) {
    return {
      ok: false,
      code: "critical",
      message:
        `Website audit reports critical advisories: ${
          critical.map((item) => item.id).join(", ")
        }`,
      advisories,
    };
  }

  const unknown = advisories.filter((item) => !allowed.has(item.id));
  if (unknown.length > 0) {
    return {
      ok: false,
      code: "unknown",
      message:
        `Website audit reports unexpected advisories: ${
          unknown.map((item) => `${item.id}(${item.severity || "unknown"})`).join(", ")
        }`,
      advisories,
    };
  }

  if (advisories.length === 0) {
    return {
      ok: true,
      code: "clean",
      message: "Website npm audit is clean.",
      advisories,
    };
  }

  return {
    ok: true,
    code: "residuals",
    message:
      "Website npm audit contains only the documented stable-Next residual "
      + `advisories (${advisories.map((item) => item.id).join(", ")}). `
      + "No stable Next release currently resolves PostCSS/Sharp residuals.",
    advisories,
  };
}

export function verifyWebsiteAudit({
  spawn = spawnSync,
  prefix = "website-xiao",
  write = (text) => process.stdout.write(text),
} = {}) {
  const { status, stdout, stderr } = runNpmAuditJson({ spawn, prefix });
  let audit;
  try {
    audit = JSON.parse(stdout);
  } catch {
    write(
      `Website audit JSON could not be parsed (npm exit ${status}).\n`
      + `${stderr || stdout || ""}\n`,
    );
    return 1;
  }

  // npm audit exits 1 when vulnerabilities exist; that is expected for residual
  // advisories. Reject only unexpected statuses outside 0/1.
  if (status !== 0 && status !== 1) {
    write(
      `Website npm audit failed with unexpected status ${status}.\n`
      + `${stderr || ""}\n`,
    );
    return status;
  }

  const result = evaluateWebsiteAudit(audit);
  write(`${result.message}\n`);
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exit(verifyWebsiteAudit());
}
