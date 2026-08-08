import { defineConfig, devices } from '@playwright/test'

import { readReleaseEnvironment } from './src/environment.ts'

const environment = readReleaseEnvironment(process.env)

export default defineConfig({
  testDir: './tests',
  outputDir: '../../outputs/playwright/test-results',
  fullyParallel: false,
  forbidOnly: true,
  retries: 1,
  workers: 1,
  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: '../../outputs/playwright/report' }],
  ],
  expect: { timeout: 10_000 },
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'release setup',
      testMatch: /release\.setup\.ts/,
    },
    {
      name: 'participant public',
      testMatch: /participant-public\.spec\.ts/,
      dependencies: ['release setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: environment.participantUrl,
        storageState: { cookies: [], origins: [] },
      },
    },
    {
      name: 'participant authenticated',
      testMatch: /participant-authenticated\.spec\.ts/,
      dependencies: ['release setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: environment.participantUrl,
        storageState: environment.participantStorageStatePath,
      },
    },
    {
      name: 'operations public',
      testMatch: /operations-public\.spec\.ts/,
      dependencies: ['release setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: environment.operationsUrl,
        storageState: { cookies: [], origins: [] },
      },
    },
    {
      name: 'operations authenticated',
      testMatch: /operations-authenticated\.spec\.ts/,
      dependencies: ['release setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: environment.operationsUrl,
        storageState: environment.operationsStorageStatePath,
      },
    },
  ],
})
