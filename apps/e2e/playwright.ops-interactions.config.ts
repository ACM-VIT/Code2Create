import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /operations-interactions\.spec\.ts/u,
  outputDir: "../../outputs/playwright/ops-interactions",
  forbidOnly: true,
  workers: 1,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:5195",
    contextOptions: { reducedMotion: "reduce" },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @code2create/ops dev --host 127.0.0.1 --port 5195",
    url: "http://127.0.0.1:5195/src/dev/synesthesiaDecisions.html",
    timeout: 60_000,
  },
});
