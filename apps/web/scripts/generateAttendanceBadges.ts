import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { attendanceBadgeReference, attendanceQrPayload } from "@code2create/domain";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";

const maximumBadgeBatchSize = 500;

export type BadgeSheetOptions = {
  count: number;
  eventLabel: string;
  outputPath: string;
};

export function parseBadgeSheetOptions(args: string[]): BadgeSheetOptions {
  let countText: string | undefined;
  let eventLabel = "Code2Create 7.0";
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--count" || argument === "--event-label" || argument === "--output") {
      if (!value) throw new Error(`${argument} needs a value.`);
      if (argument === "--count") countText = value;
      if (argument === "--event-label") eventLabel = value;
      if (argument === "--output") outputPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ""}`);
  }
  if (!countText || !/^[1-9][0-9]*$/u.test(countText)) {
    throw new Error("--count must be a positive whole number.");
  }
  const count = Number(countText);
  if (count > maximumBadgeBatchSize) {
    throw new Error(`One badge batch can contain at most ${maximumBadgeBatchSize} cards.`);
  }
  const normalizedEventLabel = eventLabel.trim();
  if (normalizedEventLabel.length === 0 || normalizedEventLabel.length > 80) {
    throw new Error("--event-label must contain 1 to 80 characters.");
  }
  if (!outputPath) throw new Error("--output is required.");
  return { count, eventLabel: normalizedEventLabel, outputPath: resolve(outputPath) };
}

export function createBadgeBearers(count: number) {
  const bearers = new Set<string>();
  const references = new Set<string>();
  while (bearers.size < count) {
    const bearer = randomBytes(32).toString("base64url");
    const reference = attendanceBadgeReference(bearer);
    if (!references.has(reference)) {
      bearers.add(bearer);
      references.add(reference);
    }
  }
  return [...bearers];
}

export function renderBadgeSheet(eventLabel: string, bearers: string[]) {
  const cards = bearers.map((bearer) => {
    const reference = attendanceBadgeReference(bearer);
    const qr = renderToStaticMarkup(
      createElement(QRCodeSVG, {
        bgColor: "#ffffff",
        fgColor: "#000000",
        level: "M",
        marginSize: 2,
        size: 188,
        value: attendanceQrPayload({ kind: "badge_qr", bearer }),
      }),
    );
    return `<article class="badge"><div class="event">${escapeHtml(eventLabel)}</div><div class="kind">External participant</div>${qr}<div class="reference">${reference}</div></article>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(eventLabel)} · external badges</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#111;color:#f5f5f5;font-family:Arial,sans-serif}.notice{max-width:920px;margin:24px auto;padding:0 16px;color:#aaa;font-size:13px}.sheet{display:grid;grid-template-columns:repeat(3,76mm);gap:6mm;justify-content:center;padding:8mm}.badge{width:76mm;height:104mm;background:#fff;color:#000;border:1px solid #bbb;border-radius:3mm;display:flex;flex-direction:column;align-items:center;justify-content:center;break-inside:avoid}.event{font-size:15pt;font-weight:700}.kind{margin:2mm 0 4mm;color:#555;font-size:9pt}.reference{margin-top:3mm;font:700 13pt ui-monospace,monospace;letter-spacing:.06em}@media print{@page{size:A4;margin:8mm}body{background:#fff}.notice{display:none}.sheet{grid-template-columns:repeat(2,76mm);gap:6mm;padding:0}}
  </style>
</head>
<body>
  <p class="notice">Sensitive print artifact. Keep unused badges with event operations and destroy discarded cards.</p>
  <main class="sheet">${cards.join("")}</main>
</body>
</html>`;
}

export async function writeBadgeSheet(options: BadgeSheetOptions) {
  const bearers = createBadgeBearers(options.count);
  const html = renderBadgeSheet(options.eventLabel, bearers);
  const file = await open(options.outputPath, "wx", 0o600);
  try {
    await file.writeFile(html, "utf8");
  } finally {
    await file.close();
  }
  return bearers.map(attendanceBadgeReference);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "pnpm badges:generate --count <1-500> --output <new-file.html> [--event-label <name>]",
    );
    return;
  }
  const options = parseBadgeSheetOptions(process.argv.slice(2));
  const references = await writeBadgeSheet(options);
  console.log(`Created ${references.length} external-participant badges at ${options.outputPath}.`);
  console.warn("Treat the HTML and every unused printed badge as a physical credential.");
}

const entryPath = process.argv[1];
if (entryPath && pathToFileURL(entryPath).href === import.meta.url) {
  await main();
}
