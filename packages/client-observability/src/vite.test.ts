import assert from 'node:assert/strict'
import test from 'node:test'

import { sentryViteBuild } from './vite.ts'

test('production reporting cannot ship without source-map upload credentials', () => {
  assert.throws(
    () => sentryViteBuild({
      VITE_SENTRY_DSN: 'https://public@example.ingest.sentry.io/42',
      VITE_DEPLOYMENT_ENVIRONMENT: 'production',
      VITE_RELEASE_ID: 'release-42',
    }),
    /SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT/u,
  )
})
