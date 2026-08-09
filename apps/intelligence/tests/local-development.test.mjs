import assert from 'node:assert/strict'
import test from 'node:test'

import {
  localConvexEnvironment,
  localIntelligenceWorkerEnvironment,
} from '../../../scripts/local-development.mjs'

test('local intelligence uses one localhost-only signed service boundary', () => {
  assert.equal(
    localConvexEnvironment.INTELLIGENCE_INGRESS_SECRET,
    localIntelligenceWorkerEnvironment.INTELLIGENCE_INGRESS_SECRET,
  )
  assert.equal(
    localConvexEnvironment.INTELLIGENCE_CALLBACK_SECRET,
    localIntelligenceWorkerEnvironment.INTELLIGENCE_CALLBACK_SECRET,
  )
  assert.ok(localConvexEnvironment.INTELLIGENCE_INGRESS_SECRET.length >= 32)
  assert.ok(localConvexEnvironment.INTELLIGENCE_CALLBACK_SECRET.length >= 32)

  const workerUrl = new URL(localConvexEnvironment.INTELLIGENCE_WORKER_URL)
  assert.equal(workerUrl.origin, 'http://localhost:8791')

  const callbackUrl = new URL(
    localIntelligenceWorkerEnvironment.CONVEX_INTELLIGENCE_CALLBACK_URL,
  )
  assert.equal(callbackUrl.origin, 'http://127.0.0.1:3211')
  assert.equal(callbackUrl.pathname, '/intelligence/operations-briefs/callback')
})
