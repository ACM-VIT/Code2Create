import assert from 'node:assert/strict'
import test from 'node:test'
import { ConvexError } from 'convex/values'

import { readableError } from './errors.ts'

test('reads only trusted Convex application payloads as application errors', () => {
  assert.equal(readableError(new ConvexError('Try this command again.')), 'Try this command again.')
  assert.equal(
    readableError(new ConvexError({ code: 'STALE', message: 'Refresh and try again.' })),
    'Refresh and try again.',
  )
  assert.equal(
    readableError({ data: { code: 'FAKE', message: 'Do not expose me.' } }),
    'Something went wrong. Try again.',
  )
})

test('keeps ordinary Error messages and falls back for untyped thrown values', () => {
  assert.equal(readableError(new Error('The network is unavailable.')), 'The network is unavailable.')
  assert.equal(readableError({ message: 'Do not expose me.' }), 'Something went wrong. Try again.')
})
