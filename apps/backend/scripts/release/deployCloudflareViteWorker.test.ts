import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cloudflareDeployArguments,
  cloudflareWorkerName,
} from './deployCloudflareViteWorker.ts'

test('uses a separate staging Worker name', () => {
  assert.equal(
    cloudflareWorkerName('code2create-intelligence', { CLOUDFLARE_ENV: 'staging' }),
    'code2create-intelligence-staging',
  )
})

test('uses the base Worker name only for production', () => {
  assert.equal(
    cloudflareWorkerName('code2create-intelligence', { CLOUDFLARE_ENV: 'production' }),
    'code2create-intelligence',
  )
})

test('builds an explicit Wrangler deployment command', () => {
  assert.deepEqual(
    cloudflareDeployArguments('code2create-operations', {
      CLOUDFLARE_ENV: 'staging',
      VITE_RELEASE_ID: 'release-42',
    }),
    [
      'exec',
      'wrangler',
      'deploy',
      '--name',
      'code2create-operations-staging',
      '--strict',
      '--message',
      'release-42',
    ],
  )
})

test('rejects an unset environment instead of falling back to production', () => {
  assert.throws(
    () => cloudflareWorkerName('code2create-handbook', {}),
    /Set CLOUDFLARE_ENV/u,
  )
})
