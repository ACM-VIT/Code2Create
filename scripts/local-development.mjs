const intelligenceIngressSecret = 'code2create-local-intelligence-ingress-2026-v1'
const intelligenceCallbackSecret = 'code2create-local-intelligence-callback-2026-v1'

const privateEnvironmentKeys = [
  'BETTER_AUTH_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'INITIAL_SUPREME_EMAILS',
]

const localPrivateEnvironment = Object.fromEntries(
  privateEnvironmentKeys.flatMap((key) => {
    const value = process.env[key]?.trim()
    return value ? [[key, value]] : []
  }),
)

export const localConvexEnvironment = Object.freeze({
  LOCAL_DEVELOPMENT_SEED_ENABLED: 'true',
  LOCAL_PROVIDER_FIXTURES_ENABLED: 'true',
  AUTH_SITE_URL: 'http://localhost:3213',
  PARTICIPANT_SITE_URL: 'http://localhost:5180',
  OPERATIONS_SITE_URL: 'http://localhost:5181',
  HANDBOOK_SITE_URL: 'http://localhost:5182',
  INTELLIGENCE_WORKER_URL: 'http://localhost:8791',
  INTELLIGENCE_INGRESS_SECRET: intelligenceIngressSecret,
  INTELLIGENCE_CALLBACK_SECRET: intelligenceCallbackSecret,
  ...localPrivateEnvironment,
})

export const localIntelligenceWorkerEnvironment = Object.freeze({
  INTELLIGENCE_INGRESS_SECRET: intelligenceIngressSecret,
  INTELLIGENCE_CALLBACK_SECRET: intelligenceCallbackSecret,
  CONVEX_INTELLIGENCE_CALLBACK_URL:
    'http://127.0.0.1:3213/intelligence/operations-briefs/callback',
})
