import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /participant-(interactions|benefits)\.spec\.ts/u,
  outputDir: "../../outputs/playwright/interactions",
  forbidOnly: true,
  workers: 1,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:5194",
    contextOptions: { reducedMotion: "reduce" },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @code2create/web dev --host 127.0.0.1 --port 5194",
    url: "http://127.0.0.1:5194/src/dev/interactionFixtures.html",
    timeout: 60_000,
  },
});
