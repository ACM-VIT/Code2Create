import { existsSync, readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { parseEnv } from "node:util";

// Explicit process values override the repository environment file.
const rootEnvironmentPath = new URL("../.env.local", import.meta.url);
if (existsSync(rootEnvironmentPath)) loadEnvFile(rootEnvironmentPath);

// PostHog's browser token is intentionally public. Reuse the participant app's
// ignored local environment so local server telemetry reaches the same project
// without maintaining a second copy of the token.
const participantEnvironmentPath = new URL("../apps/web/.env.local", import.meta.url);
const participantEnvironment = existsSync(participantEnvironmentPath)
  ? parseEnv(readFileSync(participantEnvironmentPath, "utf8"))
  : {};
const localPostHogProjectToken =
  process.env.POSTHOG_PROJECT_TOKEN?.trim() ||
  participantEnvironment.VITE_POSTHOG_PROJECT_TOKEN?.trim();
const localPostHogHost =
  process.env.POSTHOG_HOST?.trim() ||
  participantEnvironment.VITE_POSTHOG_HOST?.trim() ||
  "https://i.c2c.sh";
const localPostHogEnvironment = Object.freeze({
  ...(localPostHogProjectToken ? { POSTHOG_PROJECT_TOKEN: localPostHogProjectToken } : {}),
  POSTHOG_HOST: localPostHogHost,
});

const intelligenceIngressSecret = "code2create-local-intelligence-ingress-2026-v1";
const intelligenceCallbackSecret = "code2create-local-intelligence-callback-2026-v1";
// Read and callback channels use separate secrets to limit credential exposure.
const intelligenceReadSecret = "code2create-local-intelligence-read-2026-v1";
const intelligenceStreamSecret = "code2create-local-intelligence-stream-2026-v1";
const localBetterAuthSecret = "code2create-local-better-auth-secret-2026-v1";

// Local-only deterministic key; production requires a random versioned key.
const attendanceWrappingKey = "Y29kZTJjcmVhdGUtbG9jYWwtYXR0ZW5kYW5jZS1rZXk";

const privateEnvironmentKeys = [
  "APNS_BUNDLE_ID",
  "APNS_KEY_ID",
  "APNS_PRIVATE_KEY",
  "APNS_TEAM_ID",
  "ARTIFACT_S3_ACCESS_KEY_ID",
  "ARTIFACT_S3_BUCKET",
  "ARTIFACT_S3_KMS_KEY_ID",
  "ARTIFACT_S3_REGION",
  "ARTIFACT_S3_SECRET_ACCESS_KEY",
  "ATTENDANCE_PREVIOUS_WRAPPING_KEY",
  "ATTENDANCE_PREVIOUS_WRAPPING_KEY_VERSION",
  "ATTENDANCE_WRAPPING_KEY",
  "ATTENDANCE_WRAPPING_KEY_VERSION",
  "BETTER_AUTH_SECRET",
  "CLOUDFLARE_EMAIL_ACCOUNT_ID",
  "CLOUDFLARE_EMAIL_API_TOKEN",
  "CLOUDFLARE_EMAIL_FROM",
  "CLOUDFLARE_EMAIL_REPLY_TO",
  "EMAIL_EVENT_CALLBACK_SECRET",
  "FIGMA_CLIENT_ID",
  "FIGMA_CLIENT_SECRET",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_PROJECT_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "INITIAL_SUPREME_EMAILS",
  "OPENAI_API_KEY",
  "OUTBOUND_CALL_EVENT_SECRET",
  "OUTBOUND_CALL_REQUEST_SECRET",
  "OUTBOUND_CALL_WORKER_URL",
  "PHONE_VERIFICATION_HMAC_SECRET",
  "PHONE_VERIFICATION_MESSAGE_TEMPLATE",
  "POSTHOG_HOST",
  "POSTHOG_PROJECT_TOKEN",
  "PROVIDER_TOKEN_ENCRYPTION_KEY",
  "PROVIDER_TOKEN_ENCRYPTION_KEY_VERSION",
  "PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY",
  "PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION",
  "SMS_AWS_ACCESS_KEY_ID",
  "SMS_AWS_CONFIGURATION_SET",
  "SMS_AWS_ENTITY_ID",
  "SMS_AWS_ORIGINATION_IDENTITY",
  "SMS_AWS_REGION",
  "SMS_AWS_SECRET_ACCESS_KEY",
  "SMS_AWS_SESSION_TOKEN",
  "SMS_AWS_TEMPLATE_ID",
  "YOUTUBE_API_KEY",
];

const localPrivateEnvironment = Object.fromEntries(
  privateEnvironmentKeys.flatMap((key) => {
    const value = process.env[key]?.trim();
    return value ? [[key, value]] : [];
  }),
);

const localOpenAiApiKey = process.env.OPENAI_API_KEY?.trim();

export const localConvexEnvironment = Object.freeze({
  C2C_DEPLOYMENT_ENVIRONMENT: "development",
  C2C_RELEASE_ID: "development",
  BETTER_AUTH_SECRET: localBetterAuthSecret,
  AUTH_SITE_URL: "http://localhost:3211",
  PARTICIPANT_SITE_URL: "http://localhost:5180",
  OPERATIONS_SITE_URL: "http://localhost:5181",
  INTELLIGENCE_WORKER_URL: "http://localhost:8791",
  INTELLIGENCE_INGRESS_SECRET: intelligenceIngressSecret,
  INTELLIGENCE_CALLBACK_SECRET: intelligenceCallbackSecret,
  INTELLIGENCE_READ_SECRET: intelligenceReadSecret,
  INTELLIGENCE_STREAM_SECRET: intelligenceStreamSecret,
  ATTENDANCE_WRAPPING_KEY: attendanceWrappingKey,
  ATTENDANCE_WRAPPING_KEY_VERSION: "local-v1",
  INITIAL_EVENT_SLUG: "code2create-7",
  ...localPrivateEnvironment,
  ...localPostHogEnvironment,
});

export const localIntelligenceWorkerEnvironment = Object.freeze({
  ...(localOpenAiApiKey ? { OPENAI_API_KEY: localOpenAiApiKey } : {}),
  ...localPostHogEnvironment,
  C2C_DEPLOYMENT_ENVIRONMENT: "development",
  C2C_RELEASE_ID: "development",
  INTELLIGENCE_INGRESS_SECRET: intelligenceIngressSecret,
  INTELLIGENCE_CALLBACK_SECRET: intelligenceCallbackSecret,
  INTELLIGENCE_READ_SECRET: intelligenceReadSecret,
  INTELLIGENCE_STREAM_SECRET: intelligenceStreamSecret,
  CONVEX_INTELLIGENCE_CALLBACK_URL: "http://127.0.0.1:3211/intelligence/operations-briefs/callback",
  CONVEX_INTELLIGENCE_READ_URL: "http://127.0.0.1:3211/intelligence/operations-reads",
  CONVEX_INTELLIGENCE_RECOMMENDATION_URL:
    "http://127.0.0.1:3211/intelligence/operations-recommendations",
  CONVEX_INTELLIGENCE_EPISODE_READ_URL:
    "http://127.0.0.1:3211/intelligence/operations-episodes/read",
  CONVEX_INTELLIGENCE_EPISODE_CALLBACK_URL:
    "http://127.0.0.1:3211/intelligence/operations-episodes/callback",
  CONVEX_INTELLIGENCE_IDEA_READ_URL: "http://127.0.0.1:3211/intelligence/idea-submissions/read",
  CONVEX_INTELLIGENCE_IDEA_CALLBACK_URL:
    "http://127.0.0.1:3211/intelligence/idea-submissions/callback",
  CONVEX_INTELLIGENCE_AUTONOMY_CALLBACK_URL:
    "http://127.0.0.1:3211/intelligence/operations-autonomy/callback",
  CONVEX_INTELLIGENCE_AUTONOMY_READ_URL:
    "http://127.0.0.1:3211/intelligence/operations-autonomy/reads",
  CONVEX_INTELLIGENCE_AUTONOMY_WORK_URL:
    "http://127.0.0.1:3211/intelligence/operations-autonomy/work",
  CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_URL:
    "http://127.0.0.1:3211/intelligence/operations-autonomy/recommendations",
  CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_EVIDENCE_URL:
    "http://127.0.0.1:3211/intelligence/operations-autonomy/recommendation-evidence",
  OPS_ORIGIN: "http://localhost:5181",
});
