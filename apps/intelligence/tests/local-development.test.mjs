import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

import {
  localConvexEnvironment,
  localIntelligenceWorkerEnvironment,
} from '../../../scripts/local-development.mjs'

test('local intelligence uses one localhost-only signed service boundary', () => {
  assert.equal(localConvexEnvironment.C2C_DEPLOYMENT_ENVIRONMENT, 'development')
  assert.ok(localConvexEnvironment.BETTER_AUTH_SECRET.length >= 32)
  assert.equal(
    localConvexEnvironment.INTELLIGENCE_INGRESS_SECRET,
    localIntelligenceWorkerEnvironment.INTELLIGENCE_INGRESS_SECRET,
  )
  assert.equal(
    localConvexEnvironment.INTELLIGENCE_CALLBACK_SECRET,
    localIntelligenceWorkerEnvironment.INTELLIGENCE_CALLBACK_SECRET,
  )
  assert.equal(
    localConvexEnvironment.INTELLIGENCE_STREAM_SECRET,
    localIntelligenceWorkerEnvironment.INTELLIGENCE_STREAM_SECRET,
  )
  assert.equal(
    localConvexEnvironment.INTELLIGENCE_READ_SECRET,
    localIntelligenceWorkerEnvironment.INTELLIGENCE_READ_SECRET,
  )
  assert.ok(localConvexEnvironment.INTELLIGENCE_INGRESS_SECRET.length >= 32)
  assert.ok(localConvexEnvironment.INTELLIGENCE_CALLBACK_SECRET.length >= 32)
  assert.ok(localConvexEnvironment.INTELLIGENCE_READ_SECRET.length >= 32)
  assert.ok(localConvexEnvironment.INTELLIGENCE_STREAM_SECRET.length >= 32)
  assert.equal(
    new Set([
      localConvexEnvironment.INTELLIGENCE_INGRESS_SECRET,
      localConvexEnvironment.INTELLIGENCE_CALLBACK_SECRET,
      localConvexEnvironment.INTELLIGENCE_READ_SECRET,
      localConvexEnvironment.INTELLIGENCE_STREAM_SECRET,
    ]).size,
    4,
  )
  assert.equal(
    localIntelligenceWorkerEnvironment.OPS_ORIGIN,
    localConvexEnvironment.OPERATIONS_SITE_URL,
  )

  const workerUrl = new URL(localConvexEnvironment.INTELLIGENCE_WORKER_URL)
  assert.equal(workerUrl.origin, 'http://localhost:8791')

  const callbackUrl = new URL(
    localIntelligenceWorkerEnvironment.CONVEX_INTELLIGENCE_CALLBACK_URL,
  )
  assert.equal(callbackUrl.origin, 'http://127.0.0.1:3211')
  assert.equal(callbackUrl.pathname, '/intelligence/operations-briefs/callback')

  const readUrl = new URL(localIntelligenceWorkerEnvironment.CONVEX_INTELLIGENCE_READ_URL)
  assert.equal(readUrl.origin, 'http://127.0.0.1:3211')
  assert.equal(readUrl.pathname, '/intelligence/operations-reads')
  const recommendationUrl = new URL(
    localIntelligenceWorkerEnvironment.CONVEX_INTELLIGENCE_RECOMMENDATION_URL,
  )
  assert.equal(recommendationUrl.origin, 'http://127.0.0.1:3211')
  assert.equal(recommendationUrl.pathname, '/intelligence/operations-recommendations')
})

test('quick-tunnel development publishes the same Worker and operations origins', () => {
  const tunnelOrigins = {
    AUTH_SITE_URL: 'https://auth-code2create.trycloudflare.com',
    HANDBOOK_SITE_URL: 'https://handbook-code2create.trycloudflare.com',
    INTELLIGENCE_WORKER_URL: 'https://intelligence-code2create.trycloudflare.com',
    OPERATIONS_SITE_URL: 'https://operations-code2create.trycloudflare.com',
    PARTICIPANT_SITE_URL: 'https://participant-code2create.trycloudflare.com',
  }
  const moduleUrl = new URL('../../../scripts/local-development.mjs', import.meta.url).href
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const config = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify({ workerUrl: config.localConvexEnvironment.INTELLIGENCE_WORKER_URL, operationsOrigin: config.localIntelligenceWorkerEnvironment.OPS_ORIGIN }));`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...tunnelOrigins,
        LOCAL_TUNNEL_FIXTURES_ENABLED: 'true',
      },
    },
  )
  const configuration = JSON.parse(output)

  assert.deepEqual(configuration, {
    workerUrl: tunnelOrigins.INTELLIGENCE_WORKER_URL,
    operationsOrigin: tunnelOrigins.OPERATIONS_SITE_URL,
  })
})
