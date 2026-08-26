import { expect, type Page, type TestInfo } from '@playwright/test'

export const participantUrl = process.env.C2C_PARTICIPANT_URL ?? 'http://localhost:5180'
export const operationsUrl = process.env.C2C_OPERATIONS_URL ?? 'http://localhost:5181'
export const handbookUrl = process.env.C2C_HANDBOOK_URL ?? 'http://localhost:5182'

export async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
}

export async function saveViewport(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) })
}

export async function signInLocalSupreme(page: Page) {
  await page.goto(operationsUrl)
  await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible()
  await page.getByRole('button', { name: 'Use local Supreme account' }).click()
  const surface = page.locator('[data-app-surface="operations"]')
  await expect(surface).toBeVisible()
  await expect(surface).toHaveAttribute('data-account-email', 'supreme@example.test')
  return new URL(page.url()).origin
}

export async function signInLocalParticipant(
  page: Page,
  participantClass: 'vit' | 'external' = 'vit',
) {
  await page.goto(participantUrl)
  const participantTypeButton = participantClass === 'vit'
    ? page.getByRole('button', { name: /VIT student/ })
    : page.getByRole('button', { name: /External participant/ })
  await participantTypeButton.click()
  await page.getByRole('button', { name: 'Use local test account' }).click()
  const surface = page.locator('[data-app-surface="participant"]')
  await expect(surface).toBeVisible()
  await expect(surface).toHaveAttribute(
    'data-account-email',
    participantClass === 'vit' ? 'aarav.menon@vitstudent.ac.in' : 'maya.shah@example.test',
  )
  return new URL(page.url()).origin
}
