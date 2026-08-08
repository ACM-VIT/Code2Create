import OpenAI from 'openai'
import { z } from 'zod'

import { GitHubOctokit, githubApp, safeGitHubId } from '../../convex/lib/githubClient.ts'
import {
  readLiveProviderConfiguration,
  type LiveProviderConfiguration,
} from './providerEnvironment.ts'

const requiredGitHubTopic = 'code2create-7-0'
const nativeEmbeddingDimensions = 1_536
const maximumFigmaResponseBytes = 5 * 1_024 * 1_024

type ProviderCheckResult = {
  check: 'figma' | 'github' | 'intelligence' | 'openai'
  latencyMs: number
  result: string
}

const figmaFileSchema = z.object({
  document: z.object({
    children: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })),
    id: z.string(),
    name: z.string(),
    type: z.literal('DOCUMENT'),
  }),
  lastModified: z.iso.datetime(),
  name: z.string().min(1),
  version: z.string().min(1),
})

const intelligenceHealthSchema = z.object({ ok: z.literal(true) }).strict()

function elapsed(startedAt: number) {
  return Math.max(0, Date.now() - startedAt)
}

async function checkOpenAi(
  configuration: LiveProviderConfiguration,
): Promise<ProviderCheckResult> {
  const startedAt = Date.now()
  const client = new OpenAI({
    apiKey: configuration.openAiApiKey,
    maxRetries: 0,
    timeout: 15_000,
  })
  const response = await client.embeddings.create({
    input: 'Synthetic Code2Create staging provider verification.',
    model: 'text-embedding-3-small',
  })
  const embedding = response.data[0]?.embedding
  if (
    response.data.length !== 1 ||
    !embedding ||
    embedding.length !== nativeEmbeddingDimensions ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error('OpenAI returned an invalid native-width embedding.')
  }
  return {
    check: 'openai',
    latencyMs: elapsed(startedAt),
    result: `${nativeEmbeddingDimensions} finite dimensions`,
  }
}

async function checkGitHub(
  configuration: LiveProviderConfiguration,
): Promise<ProviderCheckResult> {
  const startedAt = Date.now()
  const application = githubApp({
    appId: configuration.githubAppId,
    clientId: configuration.githubAppClientId,
    clientSecret: configuration.githubAppClientSecret,
    privateKey: configuration.githubAppPrivateKey,
  })
  const repositoryId = safeGitHubId(configuration.githubRepositoryId, 'Repository ID')
  const installationId = safeGitHubId(
    configuration.githubInstallationId,
    'Installation ID',
  )
  const access = await application.octokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
    permissions: { contents: 'read', metadata: 'read' },
    repository_ids: [repositoryId],
    request: { signal: AbortSignal.timeout(20_000) },
  })
  const client = new GitHubOctokit({ auth: access.data.token })
  const [repository, topics] = await Promise.all([
    client.rest.repos.get({
      owner: configuration.githubOwner,
      repo: configuration.githubRepository,
      request: { signal: AbortSignal.timeout(20_000) },
    }),
    client.rest.repos.getAllTopics({
      owner: configuration.githubOwner,
      repo: configuration.githubRepository,
      request: { signal: AbortSignal.timeout(20_000) },
    }),
  ])
  if (repository.data.id !== repositoryId) {
    throw new Error('GitHub returned a different repository than the configured fixture.')
  }
  if (!topics.data.names.includes(requiredGitHubTopic)) {
    throw new Error(`The staging GitHub fixture is missing ${requiredGitHubTopic}.`)
  }
  return {
    check: 'github',
    latencyMs: elapsed(startedAt),
    result: 'installation, repository, and required topic verified',
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number) {
  const declaredBytes = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
    throw new Error('Figma returned an oversized release-check response.')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
    throw new Error('Figma returned an oversized release-check response.')
  }
  return text
}

async function checkFigma(
  configuration: LiveProviderConfiguration,
): Promise<ProviderCheckResult> {
  const startedAt = Date.now()
  const endpoint = new URL(
    `/v1/files/${encodeURIComponent(configuration.figmaFileKey)}`,
    'https://api.figma.com',
  )
  endpoint.searchParams.set('depth', '1')
  const response = await fetch(endpoint, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${configuration.figmaAccessToken}`,
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    throw new Error(`Figma release check failed with HTTP ${response.status}.`)
  }
  let json: unknown
  try {
    json = JSON.parse(await readBoundedResponse(response, maximumFigmaResponseBytes))
  } catch (error) {
    if (error instanceof Error && error.message.includes('oversized')) throw error
    throw new Error('Figma returned invalid JSON for the release fixture.')
  }
  const file = figmaFileSchema.parse(json)
  return {
    check: 'figma',
    latencyMs: elapsed(startedAt),
    result: `${file.document.children.length} top-level pages visible`,
  }
}

async function checkIntelligence(
  configuration: LiveProviderConfiguration,
): Promise<ProviderCheckResult> {
  const startedAt = Date.now()
  const response = await fetch(new URL('/health', configuration.intelligenceUrl), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`Intelligence Worker health check failed with HTTP ${response.status}.`)
  }
  let json: unknown
  try {
    json = JSON.parse(await response.text())
  } catch {
    throw new Error('Intelligence Worker returned invalid health JSON.')
  }
  intelligenceHealthSchema.parse(json)
  return {
    check: 'intelligence',
    latencyMs: elapsed(startedAt),
    result: 'healthy',
  }
}

export async function runLiveProviderChecks(configuration: LiveProviderConfiguration) {
  return Promise.all([
    checkOpenAi(configuration),
    checkGitHub(configuration),
    checkFigma(configuration),
    checkIntelligence(configuration),
  ])
}

function safeFailureMessage(error: unknown) {
  return error instanceof Error ? error.message : 'A provider check failed without an error message.'
}

try {
  const configuration = readLiveProviderConfiguration(process.env)
  const checks = await runLiveProviderChecks(configuration)
  process.stdout.write(`${JSON.stringify({ environment: 'staging', checks }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${safeFailureMessage(error)}\n`)
  process.exitCode = 1
}
