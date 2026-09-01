import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearSubmissionCelebration,
  consumeSubmissionCelebration,
  markSubmissionCelebration,
} from './submissionCelebration.ts'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key) {
      return values.get(key) ?? null
    },
    key(index) {
      return [...values.keys()][index] ?? null
    },
    removeItem(key) {
      values.delete(key)
    },
    setItem(key, value) {
      values.set(key, value)
    },
  }
}

function withSessionStorage(run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: memoryStorage(),
  })
  try {
    run()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous)
    else Reflect.deleteProperty(globalThis, 'sessionStorage')
  }
}

test('a marked submission celebration is consumed exactly once', () => {
  withSessionStorage(() => {
    markSubmissionCelebration()
    assert.equal(consumeSubmissionCelebration(), true)
    assert.equal(consumeSubmissionCelebration(), false)
  })
})

test('a definitively rejected submission clears its pending celebration', () => {
  withSessionStorage(() => {
    markSubmissionCelebration()
    clearSubmissionCelebration()
    assert.equal(consumeSubmissionCelebration(), false)
  })
})
