import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeStorageState } from './storage-state.ts'

function encode(value: object) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

test('storage-state decoder accepts the Playwright top-level shape', () => {
  const state = decodeStorageState(
    encode({
      cookies: [{ name: 'session', value: 'redacted', domain: '.example.test', path: '/' }],
      origins: [],
    }),
    'Participant',
  )
  assert.equal(state.cookies.length, 1)
})

test('storage-state decoder rejects empty, malformed, or expanded payloads', () => {
  assert.throws(() => decodeStorageState('', 'Participant'), /valid base64/)
  assert.throws(() => decodeStorageState(encode({ cookies: [], origins: [] }), 'Participant'), /at least one cookie/)
  assert.throws(
    () => decodeStorageState(encode({ cookies: [{}], origins: [], secret: 'unexpected' }), 'Participant'),
    /unsupported top-level field/,
  )
})
