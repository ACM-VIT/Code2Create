import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'

/*
 * The developer's own secrets live in the repository-root `.env.local`, and
 * this module is imported by config files — a Vite config, a setup script —
 * that are not run through anything which loads it. Reading `process.env`
 * without this loaded the file's values silently as undefined, so the
 * intelligence worker booted, served health, and could not call a model.
 *
 * Values already in the environment win, so an explicit override on the
 * command line still beats the file.
 */
const rootEnvironmentPath = new URL('../.env.local', import.meta.url)
if (existsSync(rootEnvironmentPath)) loadEnvFile(rootEnvironmentPath)

const intelligenceIngressSecret = 'code2create-local-intelligence-ingress-2026-v1'
const intelligenceCallbackSecret = 'code2create-local-intelligence-callback-2026-v1'
/* The copilot reads the platform over its own signed channel. A separate
   secret from the callback's, because they run in opposite directions and one
   leaking should not hand over the other. */
const intelligenceReadSecret = 'code2create-local-intelligence-read-2026-v1'

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
  AUTH_SITE_URL: 'http://localhost:3211',
  PARTICIPANT_SITE_URL: 'http://localhost:5180',
  OPERATIONS_SITE_URL: 'http://localhost:5181',
  HANDBOOK_SITE_URL: 'http://localhost:5182',
  INTELLIGENCE_WORKER_URL: 'http://localhost:8791',
  INTELLIGENCE_INGRESS_SECRET: intelligenceIngressSecret,
  INTELLIGENCE_CALLBACK_SECRET: intelligenceCallbackSecret,
  INTELLIGENCE_READ_SECRET: intelligenceReadSecret,
  ...localPrivateEnvironment,
})

/* The agents call a model, and the key for it lives in the developer's own
   .env.local rather than in this file. Absent, the worker still boots and
   serves health — it just cannot think. */
const localModelEnvironment = Object.fromEntries(
  ['OPENAI_API_KEY'].flatMap((key) => {
    const value = process.env[key]?.trim()
    return value ? [[key, value]] : []
  }),
)

export const localIntelligenceWorkerEnvironment = Object.freeze({
  INTELLIGENCE_INGRESS_SECRET: intelligenceIngressSecret,
  INTELLIGENCE_CALLBACK_SECRET: intelligenceCallbackSecret,
  INTELLIGENCE_READ_SECRET: intelligenceReadSecret,
  CONVEX_INTELLIGENCE_CALLBACK_URL:
    'http://127.0.0.1:3211/intelligence/operations-briefs/callback',
  CONVEX_INTELLIGENCE_READ_URL: 'http://127.0.0.1:3211/intelligence/operations-reads',
  CONVEX_INTELLIGENCE_RECOMMENDATION_URL:
    'http://127.0.0.1:3211/intelligence/operations-recommendations',
  ...localModelEnvironment,
})
