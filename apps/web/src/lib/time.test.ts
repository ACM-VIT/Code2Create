import assert from 'node:assert/strict'
import test from 'node:test'

import { queueWaitName } from './time.ts'

const now = 1_000_000

test('ages a queue window without presenting it as an appointment', () => {
  assert.equal(
    queueWaitName({ earliestAt: now, latestAt: now + 10 * 60_000 }, now),
    'Within 10 min',
  )
  assert.equal(
    queueWaitName(
      { earliestAt: now + 14 * 60_000, latestAt: now + 29 * 60_000 },
      now + 6 * 60_000,
    ),
    'About 5–25 min',
  )
  assert.equal(
    queueWaitName({ earliestAt: now - 10 * 60_000, latestAt: now }, now),
    'Taking longer than estimated',
  )
})
