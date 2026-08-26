import { expect, test } from '@playwright/test'

import {
  expectNoHorizontalOverflow,
  handbookUrl,
  participantUrl,
  saveViewport,
  signInLocalParticipant,
  signInLocalSupreme,
} from './support.ts'

test('participant entry makes the identity choice explicit', async ({ page }, testInfo) => {
  await page.goto(participantUrl)

  await expect(page.getByRole('heading', { name: 'Hello.' })).toBeVisible()
  await expect(page.getByText('Which describes you?', { exact: true })).toBeVisible()
  const googleButton = page.getByRole('button', { name: 'Continue with Google' })
  const localButton = page.getByRole('button', { name: 'Use local test account' })
  await expect(googleButton).toBeDisabled()
  await expect(localButton).toBeDisabled()

  await page.getByRole('button', { name: /VIT student/ }).click()
  await expect(googleButton).toBeEnabled()
  await expect(localButton).toBeEnabled()
  await expect(page.getByText('Google sign-in is unavailable right now.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /VIT student/ })).toHaveClass(/selected/)
  await expectNoHorizontalOverflow(page)
  await saveViewport(page, testInfo, 'participant-entry-desktop')
})

test('VIT participant opens the confirmed team workspace', async ({ page }, testInfo) => {
  await signInLocalParticipant(page)

  const surface = page.locator('[data-app-surface="participant"]')
  await expect(surface).toBeVisible()
  await expect(surface).toHaveAttribute('data-account-email', 'aarav.menon@vitstudent.ac.in')
  await expect(page.getByRole('heading', { name: 'You’re confirmed.' })).toBeVisible()
  await expect(page.locator('.submitted-team-access > summary > strong')).toHaveText('Pothole Patrol')
  await expect(page.getByRole('heading', { name: 'Event details' })).toBeVisible()
  await expect(page.getByText('VIT ID', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Waiting to be mapped' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Final judging round' })).toBeVisible()

  await expectNoHorizontalOverflow(page)
  await saveViewport(page, testInfo, 'participant-confirmed-desktop')
})

test('external participant workspace fits a phone viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signInLocalParticipant(page, 'external')

  const surface = page.locator('[data-app-surface="participant"]')
  await expect(surface).toBeVisible()
  await expect(surface).toHaveAttribute('data-account-email', 'maya.shah@example.test')
  await expect(page.locator('.submitted-team-access > summary > strong')).toHaveText('Calm Hours')
  await expect(page.getByText('Event badge', { exact: true })).toBeVisible()
  await expect(page.getByText('Review in progress', { exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await saveViewport(page, testInfo, 'participant-external-mobile')
})

test('operator overview leads with the next step and three priorities', async ({ page }, testInfo) => {
  await signInLocalSupreme(page)

  const surface = page.locator('[data-app-surface="operations"]')
  await expect(surface).toBeVisible()
  await expect(surface).toHaveAttribute('data-account-email', 'supreme@example.test')
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  const currentWork = page.getByRole('region', { name: 'Now' })
  await expect(currentWork).toBeVisible()
  await expect(currentWork.locator('article')).toHaveCount(3)
  await expect(page.getByRole('heading', { name: 'System checks' })).toHaveCount(0)
  await expect(page.getByText('Operations brief', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /A judging round is still active/ })).toHaveAttribute(
    'href',
    '/reviews',
  )
  await expect(page.getByRole('button', { name: 'Pick up' }).first()).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Operations' })).toBeVisible()
  await saveViewport(page, testInfo, 'operations-overview-desktop')

  await page.getByRole('link', { name: 'View event monitor' }).click()
  await expect(page).toHaveURL(/\/event-monitor$/)
  await expect(page.getByRole('heading', { name: 'Event monitor' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'System checks' })).toBeVisible()

  await page.getByRole('link', { name: 'Check-in' }).click()
  await expect(page).toHaveURL(/\/attendance$/)
  await expect(page.getByRole('heading', { name: 'Check-in' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await saveViewport(page, testInfo, 'operations-check-in-desktop')
})

test('handbook opens, searches, and navigates between source documents', async ({ page }, testInfo) => {
  await page.goto(handbookUrl)
  await expect(page.getByText('Internal handbook', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Use local Supreme account' }).click()

  await expect(page.locator('[data-app-surface="handbook"]')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Handbook documents' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Code2Create 7.0' })).toBeVisible()

  const search = page.getByRole('searchbox', { name: 'Search' })
  await search.fill('admission recommendation')
  await expect(page.locator('.search-results button').first()).toBeVisible()
  await search.fill('')
  await page.getByRole('link', { name: '01 Product brief' }).click()
  await expect(page.getByRole('heading', { name: 'Product brief' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await saveViewport(page, testInfo, 'handbook-product-brief-desktop')
})

test('local intelligence Worker reports ready', async ({ request }) => {
  const intelligence = await request.get('http://localhost:8791/health')
  expect(intelligence.ok()).toBe(true)
  await expect(intelligence.json()).resolves.toEqual({ ok: true })
})

test('local updates Worker reports ready', async ({ request }) => {
  const updates = await request.get('http://localhost:8792/health')
  expect(updates.ok()).toBe(true)
  await expect(updates.json()).resolves.toEqual({
    service: 'code2create-updates',
    channel: 'staging',
  })
})

test('local email Worker reports ready', async ({ request }) => {
  const email = await request.get('http://localhost:8793/health')
  expect(email.ok()).toBe(true)
  await expect(email.json()).resolves.toEqual({
    service: 'code2create-email',
    ok: true,
  })
})

test('local voice Worker reports ready', async ({ request }) => {
  const voice = await request.get('http://localhost:8794/health')
  expect(voice.ok()).toBe(true)
  await expect(voice.json()).resolves.toEqual({
    service: 'code2create-voice',
    ok: true,
    telephonyConfigured: false,
    speechProvider: 'twilio-say',
  })
})
