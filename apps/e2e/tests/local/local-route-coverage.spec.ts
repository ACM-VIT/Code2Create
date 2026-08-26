import { expect, test, type Page } from '@playwright/test'

import {
  expectNoHorizontalOverflow,
  signInLocalParticipant,
  signInLocalSupreme,
} from './support.ts'

const operationsRoutes = [
  '/',
  '/intelligence',
  '/rehearsal',
  '/support',
  '/admissions',
  '/configuration',
  '/configuration/intake',
  '/configuration/novelty',
  '/configuration/participants',
  '/configuration/admissions',
  '/configuration/communications',
  '/configuration/integrations',
  '/configuration/intelligence',
  '/configuration/phases',
  '/configuration/checkpoints',
  '/attendance',
  '/floor',
  '/floor-setup',
  '/emergency-pack',
  '/synesthesia',
  '/attendance-setup',
  '/reviews',
  '/scores',
  '/checkpoints',
  '/review-setup',
  '/integrations',
  '/access',
  '/access/bundles',
  '/access/roster',
] as const

const participantRoutes = ['/', '/integrations', '/music', '/support'] as const

test('Supreme account can open every operations workspace', async ({ page }) => {
  test.setTimeout(240_000)
  const pageErrors = collectPageErrors(page)
  const origin = await signInLocalSupreme(page)

  for (const route of operationsRoutes) {
    await test.step(route, async () => {
      await page.goto(`${origin}${route}`)
      await expect(page.locator('[data-app-surface="operations"]')).toBeVisible()
      await expect(page.locator('main.workspace h1').first()).toBeVisible()
      expect(new URL(page.url()).pathname).toBe(route)
      await expectNoHorizontalOverflow(page)
      expect(pageErrors.splice(0)).toEqual([])
    })
  }
})

test('Supreme account can open seeded operations records', async ({ page }) => {
  test.setTimeout(120_000)
  const pageErrors = collectPageErrors(page)
  const origin = await signInLocalSupreme(page)
  const detailCollections = [
    { listPath: '/admissions', link: 'a.queue-row[href^="/admissions/"]' },
    { listPath: '/attendance', link: 'a[href^="/attendance/"]' },
    { listPath: '/reviews', link: 'a[href^="/reviews/"]' },
    { listPath: '/scores', link: 'a[href^="/scores/"]' },
    { listPath: '/access', link: 'a.access-row[href^="/access/"]' },
  ] as const

  for (const collection of detailCollections) {
    await test.step(collection.listPath, async () => {
      await page.goto(`${origin}${collection.listPath}`)
      const link = page.locator(collection.link).first()
      await expect(link).toBeVisible()
      const path = await link.getAttribute('href')
      expect(path).not.toBeNull()
      if (path === null) return
      await page.goto(`${origin}${path}`)
      await expect(page.locator('[data-app-surface="operations"]')).toBeVisible()
      await expect(page.locator('main.workspace h1').first()).toBeVisible()
      expect(new URL(page.url()).pathname).toBe(path)
      await expectNoHorizontalOverflow(page)
      expect(pageErrors.splice(0)).toEqual([])
    })
  }
})

test('confirmed participant can use every portal destination on a phone', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 390, height: 844 })
  const pageErrors = collectPageErrors(page)
  const origin = await signInLocalParticipant(page)

  for (const route of participantRoutes) {
    await test.step(route, async () => {
      await page.goto(`${origin}${route}`)
      await expect(page.locator('[data-app-surface="participant"]')).toBeVisible()
      await expect(page.locator('main h1').first()).toBeVisible()
      expect(new URL(page.url()).pathname).toBe(route)
      await expectNoHorizontalOverflow(page)
      expect(pageErrors.splice(0)).toEqual([])
    })
  }
})

function collectPageErrors(page: Page) {
  const messages: string[] = []
  page.on('pageerror', (error) => messages.push(error.message))
  return messages
}
