import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseBadgeSheetOptions,
  renderBadgeSheet,
  writeBadgeSheet,
} from "./generateAttendanceBadges.ts";

test("a rendered badge exposes its reference but not its bearer as text", () => {
  const bearer = Buffer.alloc(32, 17).toString("base64url");
  const html = renderBadgeSheet("Code2Create 7.0", [bearer]);

  assert.match(html, /C2C-ERER-ERER/u);
  assert.doesNotMatch(html, new RegExp(bearer, "u"));
  assert.match(html, /<svg/u);
});

test("the CLI options are bounded and resolve the output path", () => {
  const options = parseBadgeSheetOptions([
    "--count",
    "12",
    "--output",
    "badges.html",
    "--event-label",
    "C2C rehearsal",
  ]);
  assert.equal(options.count, 12);
  assert.equal(options.eventLabel, "C2C rehearsal");
  assert.match(options.outputPath, /badges\.html$/u);
  assert.throws(
    () => parseBadgeSheetOptions(["--count", "501", "--output", "badges.html"]),
    /at most 500/u,
  );
});

test("writing a badge sheet never overwrites an existing artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c2c-badges-"));
  const outputPath = join(directory, "badges.html");
  try {
    const references = await writeBadgeSheet({
      count: 2,
      eventLabel: "Code2Create 7.0",
      outputPath,
    });
    assert.equal(references.length, 2);
    assert.match(await readFile(outputPath, "utf8"), /External participant/u);
    await assert.rejects(
      writeBadgeSheet({ count: 1, eventLabel: "Code2Create 7.0", outputPath }),
      /EEXIST/u,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
