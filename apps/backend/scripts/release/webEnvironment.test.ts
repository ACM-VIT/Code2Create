import assert from 'node:assert/strict'
import test from 'node:test'

import { validateWebReleaseEnvironment } from './webEnvironment.ts'

function validBuildEnvironment(): Record<string, string | undefined> {
  return {
    CLOUDFLARE_ENV: 'staging',
    VITE_CONVEX_URL: 'https://example.convex.cloud',
    VITE_CONVEX_SITE_URL: 'https://example.convex.site',
    VITE_DEPLOYMENT_ENVIRONMENT: 'staging',
    VITE_EVENT_SLUG: 'code2create-7',
    VITE_RELEASE_ID: 'release-42',
    VITE_SENTRY_DSN: 'https://public@example.ingest.sentry.io/42',
    SENTRY_ORG: 'code2create',
    SENTRY_PROJECT: 'participant',
    SENTRY_AUTH_TOKEN: 'secret-token',
  }
}

test('accepts complete participant and handbook release builds', () => {
  const environment = validBuildEnvironment()
  assert.doesNotThrow(() => validateWebReleaseEnvironment('participant', 'build', environment))

  environment.VITE_SENTRY_DSN = undefined
  environment.SENTRY_ORG = undefined
  environment.SENTRY_PROJECT = undefined
  environment.SENTRY_AUTH_TOKEN = undefined
  assert.doesNotThrow(() => validateWebReleaseEnvironment('handbook', 'build', environment))
})

test('rejects a deployment-environment mismatch', () => {
  const environment = validBuildEnvironment()
  environment.VITE_DEPLOYMENT_ENVIRONMENT = 'production'
  assert.throws(
    () => validateWebReleaseEnvironment('operations', 'build', environment),
    /VITE_DEPLOYMENT_ENVIRONMENT must match CLOUDFLARE_ENV/u,
  )
})

test('requires Sentry upload configuration for participant and operations releases', () => {
  const environment = validBuildEnvironment()
  environment.SENTRY_AUTH_TOKEN = undefined
  assert.throws(
    () => validateWebReleaseEnvironment('participant', 'build', environment),
    /Set SENTRY_AUTH_TOKEN/u,
  )
})

test('delegates deployment authentication to Wrangler', () => {
  const environment = validBuildEnvironment()
  assert.doesNotThrow(() => validateWebReleaseEnvironment('handbook', 'deploy', environment))
})
