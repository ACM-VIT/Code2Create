import { expect, test } from '@playwright/test'

import { readReleaseEnvironment } from '../src/environment.ts'

const environment = readReleaseEnvironment(process.env)

test('seeded operator opens the scoped operations workspace', async ({ page }) => {
  await page.goto('/')
  const surface = page.locator('[data-app-surface="operations"]')
  await expect(surface).toBeVisible()
  await expect(surface).toHaveAttribute('data-account-email', environment.operationsAccountEmail)
  await expect(page.getByRole('navigation', { name: 'Operations' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Test run' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
})
