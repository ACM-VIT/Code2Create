import assert from 'node:assert/strict'
import test from 'node:test'

import { noveltyRequestDelayMs, noveltyRetryDelayMs } from './noveltyPreview.ts'

test('starts a live novelty check no more than 400ms after typing stops', () => {
  assert.equal(noveltyRequestDelayMs({ configuredDebounceMs: 800, retryAt: null }), 400)
  assert.equal(noveltyRequestDelayMs({ configuredDebounceMs: 250, retryAt: null }), 250)
})

test('backs off failed checks without giving up permanently', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(noveltyRetryDelayMs),
    [400, 800, 1_600, 3_200, 5_000, 5_000],
  )
  assert.equal(noveltyRequestDelayMs({
    configuredDebounceMs: 800,
    retryAt: 12_000,
    now: 10_500,
  }), 1_500)
})
