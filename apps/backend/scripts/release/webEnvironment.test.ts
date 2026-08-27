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
    VITE_POSTHOG_PROJECT_TOKEN: 'phc_publicprojecttoken',
    VITE_POSTHOG_HOST: 'https://eu.i.posthog.com',
    POSTHOG_CLI_HOST: 'https://eu.posthog.com',
    POSTHOG_CLI_PROJECT_ID: '169929',
    POSTHOG_CLI_API_KEY: 'secret-token',
  }
}

test('accepts a complete participant release build', () => {
  const environment = validBuildEnvironment()
  assert.doesNotThrow(() => validateWebReleaseEnvironment('participant', 'build', environment))
})

test('rejects a deployment-environment mismatch', () => {
  const environment = validBuildEnvironment()
  environment.VITE_DEPLOYMENT_ENVIRONMENT = 'production'
  assert.throws(
    () => validateWebReleaseEnvironment('operations', 'build', environment),
    /VITE_DEPLOYMENT_ENVIRONMENT must match CLOUDFLARE_ENV/u,
  )
})

test('requires PostHog upload configuration for participant and operations releases', () => {
  const environment = validBuildEnvironment()
  environment.POSTHOG_CLI_API_KEY = undefined
  assert.throws(
    () => validateWebReleaseEnvironment('participant', 'build', environment),
    /Set POSTHOG_CLI_API_KEY/u,
  )
})

test('delegates deployment authentication to Wrangler', () => {
  const environment = validBuildEnvironment()
  assert.doesNotThrow(() => validateWebReleaseEnvironment('operations', 'deploy', environment))
})
