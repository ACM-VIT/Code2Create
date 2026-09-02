import assert from 'node:assert/strict'
import test from 'node:test'

import {
  accessTokenExpiresAt,
  accessTokenNeedsRefresh,
  fetchAccessTokenUntilSettled,
  isRetryableAccessTokenStatus,
  type AccessTokenAttempt,
} from './access-token.ts'

function tokenWithPayload(payload: object) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

test('reads JWT expiry and refreshes only inside the resume leeway', () => {
  const expiresAt = accessTokenExpiresAt(tokenWithPayload({ exp: 1_800_000_000 }))
  assert.equal(expiresAt, 1_800_000_000_000)
  assert.equal(accessTokenNeedsRefresh(expiresAt, 1_799_999_939_999), false)
  assert.equal(accessTokenNeedsRefresh(expiresAt, 1_799_999_940_000), true)
  assert.equal(accessTokenNeedsRefresh(null, 1_799_999_940_000), false)
  assert.equal(accessTokenExpiresAt('not-a-jwt'), null)
})

test('retries interrupted and temporary token requests without signing out', async () => {
  const attempts: Array<AccessTokenAttempt | Error> = [
    new Error('Safari suspended the request'),
    { token: null, status: 503 },
    { token: 'signed-token', status: 200 },
  ]
  const delays: number[] = []
  const token = await fetchAccessTokenUntilSettled({
    request: async () => {
      const attempt = attempts.shift()
      if (attempt instanceof Error) throw attempt
      if (!attempt) throw new Error('The test made too many token requests.')
      return attempt
    },
    isActive: () => true,
    wait: async (delayMs) => {
      delays.push(delayMs)
    },
  })

  assert.equal(token, 'signed-token')
  assert.deepEqual(delays, [250, 500])
})

test('returns null immediately when the server rejects the session', async () => {
  let waits = 0
  const token = await fetchAccessTokenUntilSettled({
    request: async () => ({ token: null, status: 401 }),
    isActive: () => true,
    wait: async () => {
      waits += 1
    },
  })

  assert.equal(token, null)
  assert.equal(waits, 0)
})

test('stops retrying when its auth context is replaced', async () => {
  let active = true
  const token = await fetchAccessTokenUntilSettled({
    request: async () => ({ token: null, status: 0 }),
    isActive: () => active,
    wait: async () => {
      active = false
    },
  })

  assert.equal(token, null)
})

test('only transport, throttling, and server statuses are retryable', () => {
  assert.equal(isRetryableAccessTokenStatus(null), true)
  assert.equal(isRetryableAccessTokenStatus(0), true)
  assert.equal(isRetryableAccessTokenStatus(408), true)
  assert.equal(isRetryableAccessTokenStatus(429), true)
  assert.equal(isRetryableAccessTokenStatus(503), true)
  assert.equal(isRetryableAccessTokenStatus(400), false)
  assert.equal(isRetryableAccessTokenStatus(401), false)
  assert.equal(isRetryableAccessTokenStatus(403), false)
})
