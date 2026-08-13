import assert from 'node:assert/strict'
import test from 'node:test'

import { readLiveProviderConfiguration } from './providerEnvironment.ts'

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    C2C_PROVIDER_ENVIRONMENT: 'staging',
    C2C_PROVIDER_FIGMA_ACCESS_TOKEN: 'figma-secret',
    C2C_PROVIDER_FIGMA_FILE_KEY: 'FigmaFile123',
    C2C_PROVIDER_GITHUB_INSTALLATION_ID: '101',
    C2C_PROVIDER_GITHUB_OWNER: 'acm-vit',
    C2C_PROVIDER_GITHUB_REPOSITORY: 'code2create-provider-fixture',
    C2C_PROVIDER_GITHUB_REPOSITORY_ID: '202',
    C2C_PROVIDER_GITHUB_REQUIRED_TOPIC: 'code2create-7-0',
    C2C_PROVIDER_INTELLIGENCE_URL: 'https://intelligence-staging.example.test',
    GITHUB_APP_CLIENT_ID: 'client-id',
    GITHUB_APP_CLIENT_SECRET: 'client-secret',
    GITHUB_APP_ID: '303',
    GITHUB_APP_PRIVATE_KEY: 'private-key',
    OPENAI_API_KEY: 'openai-secret',
  }
}

test('live provider configuration accepts staging-only read targets', () => {
  const configuration = readLiveProviderConfiguration(validEnvironment())
  assert.equal(configuration.environment, 'staging')
  assert.equal(configuration.githubOwner, 'acm-vit')
  assert.equal(configuration.githubRequiredTopic, 'code2create-7-0')
  assert.equal(configuration.intelligenceUrl, 'https://intelligence-staging.example.test')
})

test('live provider configuration rejects production', () => {
  const environment = validEnvironment()
  environment.C2C_PROVIDER_ENVIRONMENT = 'production'
  assert.throws(() => readLiveProviderConfiguration(environment), /only against staging/)
})

test('live provider configuration rejects unsafe provider identifiers and URLs', () => {
  const repository = validEnvironment()
  repository.C2C_PROVIDER_GITHUB_REPOSITORY = 'owner/repository'
  assert.throws(() => readLiveProviderConfiguration(repository), /unsupported value/)

  const url = validEnvironment()
  url.C2C_PROVIDER_INTELLIGENCE_URL = 'https://intelligence-staging.example.test/health'
  assert.throws(() => readLiveProviderConfiguration(url), /HTTPS origin/)

  const topic = validEnvironment()
  topic.C2C_PROVIDER_GITHUB_REQUIRED_TOPIC = 'Code2Create 7.0'
  assert.throws(() => readLiveProviderConfiguration(topic), /unsupported value/)
})
