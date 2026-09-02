import assert from 'node:assert/strict'
import test from 'node:test'

import { authProviderState } from './auth-state.ts'

test('loads while the initial session is unresolved', () => {
  assert.deepEqual(authProviderState(true, false, null), {
    isAuthenticated: false,
    isLoading: true,
  })
})

test('keeps an authenticated app mounted during a background session check', () => {
  assert.deepEqual(authProviderState(true, false, true), {
    isAuthenticated: true,
    isLoading: false,
  })
})

test('keeps the sign-in screen mounted during a background session check', () => {
  assert.deepEqual(authProviderState(true, false, false), {
    isAuthenticated: false,
    isLoading: false,
  })
})

test('uses the current session as soon as the check settles', () => {
  assert.deepEqual(authProviderState(false, false, true), {
    isAuthenticated: false,
    isLoading: false,
  })
  assert.deepEqual(authProviderState(false, true, false), {
    isAuthenticated: true,
    isLoading: false,
  })
})
