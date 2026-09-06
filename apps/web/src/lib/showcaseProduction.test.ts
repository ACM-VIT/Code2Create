import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const sourceRoot = new URL("../", import.meta.url);

test("fictional showcase projects are confined to the development gallery", async () => {
  const paths = await readdir(sourceRoot, { recursive: true });
  for (const path of paths) {
    if (path.startsWith("dev/") || !/\.(ts|tsx)$/.test(path) || path.endsWith(".test.ts")) continue;
    const source = await readFile(new URL(path, sourceRoot), "utf8");
    assert.doesNotMatch(source, /showcaseSamples/, `${path} must not import or render showcase fixtures`);
  }
  const fixtures = await readFile(new URL("dev/screenFixtures.tsx", sourceRoot), "utf8");
  assert.match(fixtures, /from "\.\/showcaseSamples"/, "development previews retain their fixtures");
});

test("the participant showcase stays empty until a published-project feed exists", async () => {
  const participantApp = await readFile(new URL("ParticipantApp.tsx", sourceRoot), "utf8");
  const showcaseRoute = participantApp.match(/if \(location\.pathname === "\/showcase"\) \{[\s\S]*?<\/Suspense>/)?.[0];
  assert.ok(showcaseRoute, "the live showcase route exists");
  assert.match(showcaseRoute, /projects=\{\[\]\}/, "do not substitute fixtures or private submissions for published projects");
  const screen = await readFile(new URL("screens/ShowcaseScreen.tsx", sourceRoot), "utf8");
  assert.match(screen, /No projects have been published to the showcase yet\./);
  assert.doesNotMatch(screen, /once submissions close|desk opens the showcase/);
});
