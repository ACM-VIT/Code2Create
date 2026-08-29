import assert from 'node:assert/strict'
import test from 'node:test'

import { automaticChunkReloadIsAvailable, isChunkLoadFailure } from './browserRecovery.ts'

test('recognizes browser and Vite lazy-module failures', () => {
  const failures = [
    new TypeError('Failed to fetch dynamically imported module: https://event.test/assets/Queue.js'),
    new Error('Importing a module script failed.'),
    new Error('Loading chunk admission failed.'),
    new Error('ChunkLoadError: Loading chunk 42 failed'),
    new Error('Unable to preload CSS for /assets/ops.css'),
  ]

  for (const failure of failures) assert.equal(isChunkLoadFailure(failure), true)
})

test('does not misclassify ordinary application failures as network failures', () => {
  assert.equal(isChunkLoadFailure(new TypeError('Cannot read properties of undefined')), false)
  assert.equal(isChunkLoadFailure({ message: 'Failed to fetch dynamically imported module' }), false)
  assert.equal(isChunkLoadFailure(null), false)
})

test('allows only one automatic reload per URL inside the guard window', () => {
  const now = 10_000_000
  const href = 'https://event.test/ops/admissions'
  const recent = JSON.stringify({ href, attemptedAt: now - 500 })
  const stale = JSON.stringify({ href, attemptedAt: now - 30_000 })
  const anotherPage = JSON.stringify({ href: 'https://event.test/ops', attemptedAt: now - 500 })

  assert.equal(automaticChunkReloadIsAvailable(null, href, now), true)
  assert.equal(automaticChunkReloadIsAvailable(recent, href, now), false)
  assert.equal(automaticChunkReloadIsAvailable(stale, href, now), true)
  assert.equal(automaticChunkReloadIsAvailable(anotherPage, href, now), true)
  assert.equal(automaticChunkReloadIsAvailable('not-json', href, now), true)
})
