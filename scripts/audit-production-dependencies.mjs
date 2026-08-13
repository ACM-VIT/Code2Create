import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
// Metro's file-path API requires 1.x; this reviewed patch bounds its parser loops.
const imageSizeVersion = "1.2.1";
const imageSizePatchHash =
  "88db54df965f42c392e30832afc1a41eaa57e91fd537ca65b9e6e188ee830c6d";
const allowedImageSizeAdvisories = new Set([
  "GHSA-5p2g-fcmc-qvqq",
  "GHSA-w3rx-r6r6-pgpr",
]);
const auditedSeverities = new Set(["moderate", "high", "critical"]);

await verifyImageSizePatch();
verifyAuditReport(runAudit());

console.log("Production dependency audit passed with the reviewed image-size patch.");

async function verifyImageSizePatch() {
  const patchPath = path.join(workspaceRoot, "patches", "image-size@1.2.1.patch");
  const workspaceManifest = readFileSync(
    path.join(workspaceRoot, "pnpm-workspace.yaml"),
    "utf8",
  );
  const lockfile = readFileSync(path.join(workspaceRoot, "pnpm-lock.yaml"), "utf8");
  const patchHash = createHash("sha256").update(readFileSync(patchPath)).digest("hex");

  if (patchHash !== imageSizePatchHash) {
    fail("The reviewed image-size patch checksum changed.");
  }
  if (
    !workspaceManifest.includes(
      "image-size@1.2.1: patches/image-size@1.2.1.patch",
    )
  ) {
    fail("pnpm-workspace.yaml does not register the reviewed image-size patch.");
  }
  if (!lockfile.includes(`image-size@${imageSizeVersion}: ${imageSizePatchHash}`)) {
    fail("pnpm-lock.yaml does not contain the reviewed image-size patch checksum.");
  }

  const pnpmStorePath = path.join(workspaceRoot, "node_modules", ".pnpm");
  const pnpmPackageDirectories = await readdir(pnpmStorePath);
  const packageDirectoryName = pnpmPackageDirectories.find(
    (entry) =>
      entry ===
      `image-size@${imageSizeVersion}_patch_hash=${imageSizePatchHash}`,
  );
  if (!packageDirectoryName) {
    fail("The installed image-size package is not the reviewed patched artifact.");
  }

  const packageRoot = path.join(
    pnpmStorePath,
    packageDirectoryName,
    "node_modules",
    "image-size",
  );
  const expectedPackageRoot = realpathSync(packageRoot);
  const metroPackageDirectories = pnpmPackageDirectories.filter((entry) =>
    entry.startsWith("metro@"),
  );
  if (metroPackageDirectories.length === 0) {
    fail("The production Metro dependency path is missing.");
  }
  for (const metroDirectory of metroPackageDirectories) {
    const installedImageSizeRoot = realpathSync(
      path.join(pnpmStorePath, metroDirectory, "node_modules", "image-size"),
    );
    if (installedImageSizeRoot !== expectedPackageRoot) {
      fail("Metro does not resolve image-size to the reviewed patched artifact.");
    }
  }
  const packageManifest = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  if (packageManifest.version !== imageSizeVersion) {
    fail(`Expected image-size ${imageSizeVersion}, found ${packageManifest.version}.`);
  }

  verifyMetroPathInput(packageRoot);
  runParserRegression(packageRoot, "heif", heifRegressionSource());
  runParserRegression(packageRoot, "jxl", jxlRegressionSource());
  runParserRegression(packageRoot, "icns", icnsRegressionSource());
}

function verifyMetroPathInput(packageRoot) {
  const requireFromReviewer = createRequire(
    path.join(workspaceRoot, "apps", "reviewer", "package.json"),
  );
  const imageSize = createRequire(path.join(packageRoot, "package.json"))(packageRoot);
  const assetPath = requireFromReviewer.resolve("expo-router/assets/unmatched.png");
  const dimensions = imageSize(assetPath);
  if (
    !dimensions ||
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    fail("Metro's file-path image-size contract is not working.");
  }
}

function runParserRegression(packageRoot, format, source) {
  const moduleUrl = pathToFileURL(
    path.join(packageRoot, "dist", "types", `${format}.js`),
  ).href;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", source(moduleUrl)],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: 1_500,
    },
  );

  if (result.error || result.status !== 0) {
    fail(
      `${format.toUpperCase()} image-size regression failed or exceeded its timeout.`,
    );
  }
}

function heifRegressionSource() {
  return (moduleUrl) => `
    const { HEIF } = (await import(${JSON.stringify(moduleUrl)})).default;
    const input = new Uint8Array(64);
    const view = new DataView(input.buffer);
    const encoder = new TextEncoder();
    const box = (offset, size, name) => {
      view.setUint32(offset, size);
      input.set(encoder.encode(name), offset + 4);
    };
    box(0, 64, "meta");
    box(12, 52, "iprp");
    box(20, 44, "ipco");
    box(28, 0, "skip");
    box(36, 24, "ispe");
    view.setUint32(48, 320);
    view.setUint32(52, 180);
    HEIF.calculate(input);
  `;
}

function jxlRegressionSource() {
  return (moduleUrl) => `
    const { JXL } = (await import(${JSON.stringify(moduleUrl)})).default;
    const input = new Uint8Array(16);
    input.set(new TextEncoder().encode("jxlp"), 4);
    try {
      JXL.calculate(input);
    } catch {}
  `;
}

function icnsRegressionSource() {
  return (moduleUrl) => `
    const { ICNS } = (await import(${JSON.stringify(moduleUrl)})).default;
    const input = Uint8Array.from([
      0x69, 0x63, 0x6e, 0x73,
      0x00, 0x00, 0x00, 0x10,
      0x69, 0x73, 0x33, 0x32,
      0x00, 0x00, 0x00, 0x00,
    ]);
    ICNS.calculate(input);
  `;
}

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

  const seenAllowedAdvisories = new Set();
  for (const advisory of Object.values(report.advisories)) {
    if (!advisory || !auditedSeverities.has(advisory.severity)) {
      continue;
    }

    if (!allowedImageSizeAdvisories.has(advisory.github_advisory_id)) {
      fail(
        `Unreviewed ${advisory.severity} advisory: ${advisory.github_advisory_id ?? advisory.id}.`,
      );
    }
    if (advisory.module_name !== "image-size") {
      fail(`${advisory.github_advisory_id} no longer applies to image-size.`);
    }
    if (!Array.isArray(advisory.findings) || advisory.findings.length === 0) {
      fail(`${advisory.github_advisory_id} has no auditable findings.`);
    }

    for (const finding of advisory.findings) {
      if (
        finding.version !== imageSizeVersion ||
        finding.dev !== false ||
        !Array.isArray(finding.paths) ||
        finding.paths.length === 0 ||
        finding.paths.some(
          (dependencyPath) =>
            typeof dependencyPath !== "string" ||
            !dependencyPath.endsWith(">metro>image-size"),
        )
      ) {
        fail(`${advisory.github_advisory_id} has an unreviewed version or path.`);
      }
    }

    seenAllowedAdvisories.add(advisory.github_advisory_id);
  }

  for (const advisoryId of allowedImageSizeAdvisories) {
    if (!seenAllowedAdvisories.has(advisoryId)) {
      fail(`${advisoryId} is missing; reassess and remove its local patch exception.`);
    }
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
