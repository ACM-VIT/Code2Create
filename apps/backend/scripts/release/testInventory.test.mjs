import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { join, relative, resolve } from "node:path";

const backendRoot = resolve(import.meta.dirname, "../..");
const packageManifest = JSON.parse(readFileSync(join(backendRoot, "package.json"), "utf8"));
const testCommands = Object.entries(packageManifest.scripts)
  .filter(([name]) => name === "test" || name.startsWith("test:"))
  .map(([, command]) => command)
  .join("\n");
const referencedTests = new Set(
  [...testCommands.matchAll(/(?:convex|scripts)\/[A-Za-z0-9_./-]+\.test\.(?:mjs|ts)/gu)].map(
    ([file]) => file,
  ),
);
const mainTestCommands = new Map();
const pendingScripts = ["test"];
while (pendingScripts.length > 0) {
  const name = pendingScripts.pop();
  if (mainTestCommands.has(name)) continue;
  const command = packageManifest.scripts[name];
  assert.equal(typeof command, "string", `Missing test script: ${name}`);
  mainTestCommands.set(name, command);
  for (const match of command.matchAll(/\bpnpm(?:\s+run)?\s+(test(?::[a-z0-9-]+)?)\b/giu)) {
    pendingScripts.push(match[1]);
  }
}
const mainTests = new Set(
  [...mainTestCommands.values()].flatMap((command) =>
    [...command.matchAll(/(?:convex|scripts)\/[A-Za-z0-9_./-]+\.test\.(?:mjs|ts)/gu)].map(
      ([file]) => file,
    ),
  ),
);
const testFiles = ["convex", "scripts"]
  .flatMap((directory) => testFilesBelow(join(backendRoot, directory)))
  // Posix separators: the commands these are matched against are written with
  // forward slashes, while `relative` follows the host and gives backslashes on
  // Windows.
  .map((file) => relative(backendRoot, file).replaceAll("\\", "/"))
  .toSorted();

test("every backend test file is owned by the main test command", () => {
  const unowned = testFiles.filter((file) => !mainTests.has(file));
  assert.deepEqual(unowned, []);
});

test("every backend test command references an existing file", () => {
  const missing = [...referencedTests]
    .filter((file) => !existsSync(join(backendRoot, file)))
    .toSorted((left, right) => left.localeCompare(right));
  assert.deepEqual(missing, []);
});

function testFilesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFilesBelow(path);
    return /\.test\.(?:mjs|ts)$/u.test(entry.name) ? [path] : [];
  });
}
