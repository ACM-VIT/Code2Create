import { expect, test } from '@playwright/test'

test('participant portal offers the two Google entry choices', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Hello.' })).toBeVisible()
  await expect(page.getByText('VIT Student', { exact: true })).toBeVisible()
  await expect(page.getByText('External participant', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
})
