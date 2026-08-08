import assert from 'node:assert/strict'
import test from 'node:test'

import { readBrowserFixtureConfiguration } from './browserFixtureEnvironment.ts'

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    C2C_E2E_ENVIRONMENT: 'staging',
    C2C_EVENT_SLUG: 'code2create-7',
    C2C_OPERATIONS_ACCOUNT_EMAIL: 'operations@example.com',
    C2C_PARTICIPANT_ACCOUNT_EMAIL: 'participant@example.com',
    CONVEX_DEPLOY_KEY: 'staging-deploy-key',
  }
}

test('reads one exact staging browser fixture', () => {
  assert.deepEqual(readBrowserFixtureConfiguration(validEnvironment()), {
    eventSlug: 'code2create-7',
    operationsAccountEmail: 'operations@example.com',
    participantAccountEmail: 'participant@example.com',
  })
})

test('rejects a production target', () => {
  const environment = validEnvironment()
  environment.C2C_E2E_ENVIRONMENT = 'production'
  assert.throws(
    () => readBrowserFixtureConfiguration(environment),
    /only against staging/u,
  )
})

test('requires the deployment-scoped Convex key', () => {
  const environment = validEnvironment()
  delete environment.CONVEX_DEPLOY_KEY
  assert.throws(
    () => readBrowserFixtureConfiguration(environment),
    /CONVEX_DEPLOY_KEY is required/u,
  )
})

test('requires different participant and operations accounts', () => {
  const environment = validEnvironment()
  environment.C2C_OPERATIONS_ACCOUNT_EMAIL = 'PARTICIPANT@example.com'
  assert.throws(
    () => readBrowserFixtureConfiguration(environment),
    /must be different/u,
  )
})
