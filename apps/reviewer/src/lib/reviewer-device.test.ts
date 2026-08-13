/* eslint-disable import/first -- native storage and randomness are mocked before loading the module. */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const secureStore = vi.hoisted(() => {
  const values = new Map<string, string>()
  return {
    values,
    getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      values.set(key, value)
    }),
  }
})

const crypto = vi.hoisted(() => {
  let nextId = 1
  return {
    reset() {
      nextId = 1
    },
    randomUUID: vi.fn(() => {
      const suffix = String(nextId).padStart(12, '0')
      nextId += 1
      return `00000000-0000-4000-8000-${suffix}`
    }),
  }
})

vi.mock('expo-secure-store', () => ({
  getItemAsync: secureStore.getItemAsync,
  setItemAsync: secureStore.setItemAsync,
}))

vi.mock('expo-crypto', () => ({ randomUUID: crypto.randomUUID }))

import {
  clearReviewerRegistration,
  createReviewerDevice,
  loadReviewerDevice,
  prepareReviewerRegistration,
} from './reviewer-device'

describe('reviewer device registration attempts', () => {
  beforeEach(() => {
    secureStore.values.clear()
    secureStore.getItemAsync.mockClear()
    secureStore.setItemAsync.mockClear()
    crypto.reset()
    crypto.randomUUID.mockClear()
  })

  test('persists and retries the entire first registration command', async () => {
    const device = await createReviewerDevice('code2create-7', 'android')
    const first = await prepareReviewerRegistration('code2create-7', device, {
      appBuild: 41,
      cameraReady: false,
      encryptedDraftReady: true,
      expectedVersion: 3,
    })

    const afterRestart = await loadReviewerDevice('code2create-7')
    expect(afterRestart).not.toBeNull()
    if (!afterRestart) throw new Error('The device record was not persisted.')
    const retry = await prepareReviewerRegistration('code2create-7', afterRestart, {
      appBuild: 42,
      cameraReady: true,
      encryptedDraftReady: true,
      expectedVersion: 4,
      push: {
        token: 'new-token',
        provider: 'fcm',
        environment: 'production',
      },
    })

    expect(retry.attempt).toEqual(first.attempt)
    expect(retry.attempt).toMatchObject({
      appBuild: 41,
      cameraReady: false,
      expectedVersion: 3,
    })

    const cleared = await clearReviewerRegistration(
      'code2create-7',
      retry.record,
      retry.attempt.clientOperationId,
    )
    const next = await prepareReviewerRegistration('code2create-7', cleared, {
      appBuild: 42,
      cameraReady: true,
      encryptedDraftReady: true,
      expectedVersion: 4,
    })
    expect(next.attempt.clientOperationId).not.toBe(first.attempt.clientOperationId)
    expect(next.attempt.appBuild).toBe(42)
  })

  test('rejects an obsolete device record instead of upgrading it', async () => {
    secureStore.values.set(
      'code2create.reviewer.code2create-7',
      JSON.stringify({
        version: 1,
        installationId: '00000000-0000-4000-8000-000000000001',
        deviceName: 'Reviewer 0001',
        platform: 'android',
      }),
    )

    await expect(loadReviewerDevice('code2create-7')).rejects.toThrow(
      'The reviewer setup stored on this phone is invalid.',
    )
    expect(secureStore.setItemAsync).not.toHaveBeenCalled()
  })
})
