import { expect, test } from '@playwright/test'

import { readReleaseEnvironment } from '../src/environment.ts'

const environment = readReleaseEnvironment(process.env)

test('seeded participant opens the real portal session', async ({ page }) => {
  await page.goto('/')
  const surface = page.locator('[data-app-surface="participant"]')
  await expect(surface).toBeVisible()
  await expect(surface).toHaveAttribute('data-account-email', environment.participantAccountEmail)
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)
})
