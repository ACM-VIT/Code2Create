import { spawnSync } from "node:child_process";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const auditedSeverities = new Set(["moderate", "high", "critical"]);

verifyAuditReport(runAudit());
console.log("Production dependency audit passed with no moderate-or-higher advisory.");

function runAudit() {
  const result = spawnSync(
    "pnpm",
    ["audit", "--prod", "--audit-level=moderate", "--json"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    fail(`pnpm audit could not complete: ${result.stderr.trim()}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("pnpm audit did not return valid JSON.");
  }
}

function verifyAuditReport(report) {
  if (!report || typeof report !== "object" || !report.advisories) {
    fail("pnpm audit returned an unexpected report shape.");
  }

  for (const advisory of Object.values(report.advisories)) {
    if (!advisory || !auditedSeverities.has(advisory.severity)) continue;
    fail(
      `${advisory.severity} dependency advisory: ${advisory.github_advisory_id ?? advisory.id}.`,
    );
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
