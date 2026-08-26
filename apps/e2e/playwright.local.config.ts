import { defineConfig, devices } from '@playwright/test'

const useSystemChrome = process.env.C2C_E2E_USE_SYSTEM_CHROME === 'true'

export default defineConfig({
  testDir: './tests/local',
  outputDir: '../../outputs/playwright/local-results',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: '../../outputs/playwright/local-report' }],
  ],
  expect: { timeout: 15_000 },
  use: {
    ...devices['Desktop Chrome'],
    ...(useSystemChrome ? { channel: 'chrome' } : {}),
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: useSystemChrome ? 'off' : 'retain-on-failure',
  },
})
