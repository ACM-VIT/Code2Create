import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'

// Explicit process values override the repository environment file.
const rootEnvironmentPath = new URL('../.env.local', import.meta.url)
if (existsSync(rootEnvironmentPath)) loadEnvFile(rootEnvironmentPath)

const intelligenceIngressSecret = 'code2create-local-intelligence-ingress-2026-v1'
const intelligenceCallbackSecret = 'code2create-local-intelligence-callback-2026-v1'
// Read and callback channels use separate secrets to limit credential exposure.
const intelligenceReadSecret = 'code2create-local-intelligence-read-2026-v1'
const intelligenceStreamSecret = 'code2create-local-intelligence-stream-2026-v1'
const localBetterAuthSecret = 'code2create-local-better-auth-secret-2026-v1'

// Local-only deterministic key; production requires a random versioned key.
const attendanceWrappingKey = 'Y29kZTJjcmVhdGUtbG9jYWwtYXR0ZW5kYW5jZS1rZXk'

const localTunnelFixturesEnabled =
  process.env.LOCAL_TUNNEL_FIXTURES_ENABLED?.trim() === 'true'

function localSurfaceOrigin(key, localhostOrigin) {
  if (!localTunnelFixturesEnabled) return localhostOrigin
  const configured = process.env[key]?.trim()
  if (!configured) throw new Error(`${key} is required for local tunnel fixtures.`)
  let url
  try {
    url = new URL(configured)
  } catch {
    throw new Error(`${key} must be an HTTPS trycloudflare.com origin.`)
  }
  if (
    url.origin !== configured ||
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.trycloudflare.com')
  ) {
    throw new Error(`${key} must be an HTTPS trycloudflare.com origin.`)
  }
  return url.origin
}

const privateEnvironmentKeys = [
  'BETTER_AUTH_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'INITIAL_SUPREME_EMAILS',
  'OPENAI_API_KEY',
]

const localPrivateEnvironment = Object.fromEntries(
  privateEnvironmentKeys.flatMap((key) => {
    if (
      localTunnelFixturesEnabled &&
      (key === 'GOOGLE_CLIENT_ID' || key === 'GOOGLE_CLIENT_SECRET')
    ) {
      return []
    }
    const value = process.env[key]?.trim()
    return value ? [[key, value]] : []
  }),
)

export const localConvexEnvironment = Object.freeze({
  C2C_DEPLOYMENT_ENVIRONMENT: 'development',
  LOCAL_DEVELOPMENT_SEED_ENABLED: 'true',
  LOCAL_PROVIDER_FIXTURES_ENABLED: 'true',
  ...(localTunnelFixturesEnabled ? { LOCAL_TUNNEL_FIXTURES_ENABLED: 'true' } : {}),
  BETTER_AUTH_SECRET: localBetterAuthSecret,
  AUTH_SITE_URL: localSurfaceOrigin('AUTH_SITE_URL', 'http://localhost:3211'),
  PARTICIPANT_SITE_URL: localSurfaceOrigin(
    'PARTICIPANT_SITE_URL',
    'http://localhost:5180',
  ),
  OPERATIONS_SITE_URL: localSurfaceOrigin(
    'OPERATIONS_SITE_URL',
    'http://localhost:5181',
  ),
  HANDBOOK_SITE_URL: localSurfaceOrigin(
    'HANDBOOK_SITE_URL',
    'http://localhost:5182',
  ),
  INTELLIGENCE_WORKER_URL: localSurfaceOrigin(
    'INTELLIGENCE_WORKER_URL',
    'http://localhost:8791',
  ),
  INTELLIGENCE_INGRESS_SECRET: intelligenceIngressSecret,
  INTELLIGENCE_CALLBACK_SECRET: intelligenceCallbackSecret,
  INTELLIGENCE_READ_SECRET: intelligenceReadSecret,
  INTELLIGENCE_STREAM_SECRET: intelligenceStreamSecret,
  ATTENDANCE_WRAPPING_KEY: attendanceWrappingKey,
  ATTENDANCE_WRAPPING_KEY_VERSION: 'local-v1',
  INITIAL_EVENT_SLUG: 'code2create-7',
  ...localPrivateEnvironment,
})

export const localConvexEnvironmentRemovals = Object.freeze(
  localTunnelFixturesEnabled ? ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] : [],
)

export const localIntelligenceWorkerEnvironment = Object.freeze({
  INTELLIGENCE_INGRESS_SECRET: intelligenceIngressSecret,
  INTELLIGENCE_CALLBACK_SECRET: intelligenceCallbackSecret,
  INTELLIGENCE_READ_SECRET: intelligenceReadSecret,
  INTELLIGENCE_STREAM_SECRET: intelligenceStreamSecret,
  CONVEX_INTELLIGENCE_CALLBACK_URL:
    'http://127.0.0.1:3211/intelligence/operations-briefs/callback',
  CONVEX_INTELLIGENCE_READ_URL: 'http://127.0.0.1:3211/intelligence/operations-reads',
  CONVEX_INTELLIGENCE_RECOMMENDATION_URL:
    'http://127.0.0.1:3211/intelligence/operations-recommendations',
  CONVEX_INTELLIGENCE_AUTONOMY_CALLBACK_URL:
    'http://127.0.0.1:3211/intelligence/operations-autonomy/callback',
  CONVEX_INTELLIGENCE_AUTONOMY_READ_URL:
    'http://127.0.0.1:3211/intelligence/operations-autonomy/reads',
  CONVEX_INTELLIGENCE_AUTONOMY_WORK_URL:
    'http://127.0.0.1:3211/intelligence/operations-autonomy/work',
  CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_URL:
    'http://127.0.0.1:3211/intelligence/operations-autonomy/recommendations',
  CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_EVIDENCE_URL:
    'http://127.0.0.1:3211/intelligence/operations-autonomy/recommendation-evidence',
  OPS_ORIGIN: localSurfaceOrigin('OPERATIONS_SITE_URL', 'http://localhost:5181'),
})
