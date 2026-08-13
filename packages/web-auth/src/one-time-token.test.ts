import assert from 'node:assert/strict'
import test from 'node:test'

import {
  abandonAuthTransfer,
  completeAuthTransfer,
  selectTransferCredential,
  type TransferCredential,
} from './one-time-token.ts'

test('a fresh one-time token supersedes an older stored transfer', () => {
  assert.deepEqual(selectTransferCredential('stored-session', 'consumed-ott'), {
    kind: 'one-time-token',
    value: 'consumed-ott',
  })
})

test('a rejected one-time token remains available for retry', async () => {
  const events: string[] = []
  await assert.rejects(() => completeAuthTransfer({ kind: 'one-time-token', value: 'ott' }, {
    verifyOneTimeToken: async () => {
      events.push('verify')
      throw new Error('rejected')
    },
    storeSessionToken: () => events.push('store'),
    establishSession: async () => { events.push('establish') },
    clearSessionToken: () => events.push('clear-storage'),
    removeOneTimeToken: () => events.push('clear-url'),
  }), /rejected/)
  assert.deepEqual(events, ['verify'])
})

test('a verified session token survives establishment failure and is used on retry', async () => {
  let storedToken: string | null = null
  let establishAttempts = 0
  const oneTimeCredential: TransferCredential = { kind: 'one-time-token', value: 'ott' }
  const operations = {
    verifyOneTimeToken: async () => 'verified-session',
    storeSessionToken: (token: string) => { storedToken = token },
    establishSession: async () => {
      establishAttempts += 1
      if (establishAttempts === 1) throw new Error('network lost')
    },
    clearSessionToken: () => { storedToken = null },
    removeOneTimeToken: () => undefined,
  }

  await assert.rejects(() => completeAuthTransfer(oneTimeCredential, operations), /network lost/)
  assert.equal(storedToken, 'verified-session')

  const retryCredential = selectTransferCredential(storedToken, null)
  assert.deepEqual(retryCredential, { kind: 'session-token', value: 'verified-session' })
  if (!retryCredential) throw new Error('Expected a retry credential.')
  await completeAuthTransfer(retryCredential, operations)
  assert.equal(establishAttempts, 2)
  assert.equal(storedToken, null)
})

test('verification consumes the one-time token before session establishment', async () => {
  const events: string[] = []
  await completeAuthTransfer({ kind: 'one-time-token', value: 'ott' }, {
    verifyOneTimeToken: async () => {
      events.push('verify')
      return 'session'
    },
    storeSessionToken: () => events.push('store'),
    establishSession: async () => { events.push('establish') },
    clearSessionToken: () => events.push('clear-storage'),
    removeOneTimeToken: () => events.push('clear-url'),
  })
  assert.deepEqual(events, ['verify', 'store', 'clear-url', 'establish', 'clear-storage'])
})

test('a verified one-time token is removed even when session establishment fails', async () => {
  const events: string[] = []
  await assert.rejects(() => completeAuthTransfer({ kind: 'one-time-token', value: 'ott-b' }, {
    verifyOneTimeToken: async () => 'session-b',
    storeSessionToken: () => events.push('store-b'),
    establishSession: async () => {
      events.push('establish-b')
      throw new Error('network lost')
    },
    clearSessionToken: () => events.push('clear-storage'),
    removeOneTimeToken: () => events.push('clear-url-b'),
  }), /network lost/)
  assert.deepEqual(events, ['store-b', 'clear-url-b', 'establish-b'])
})

test('starting sign-in again abandons both retained credentials and returns to idle', () => {
  const events: string[] = []
  const state = abandonAuthTransfer({
    clearSessionToken: () => events.push('clear-storage'),
    removeOneTimeToken: () => events.push('clear-url'),
  })
  assert.equal(state, 'idle')
  assert.deepEqual(events, ['clear-storage', 'clear-url'])
})
