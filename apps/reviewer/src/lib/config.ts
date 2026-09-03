import {
  parseDeploymentEnvironment,
  requiredTelemetryRelease,
  validatePostHogHost,
} from "@code2create/client-observability/environment";

const appBuild = parseAppBuild(process.env.EXPO_PUBLIC_APP_BUILD);
const apnsEnvironment = parseApnsEnvironment(process.env.EXPO_PUBLIC_APNS_ENVIRONMENT);

export const reviewerConfiguration =
  process.env.EXPO_PUBLIC_CONVEX_URL && process.env.EXPO_PUBLIC_CONVEX_SITE_URL && appBuild
    ? {
        convexUrl: process.env.EXPO_PUBLIC_CONVEX_URL,
        convexSiteUrl: process.env.EXPO_PUBLIC_CONVEX_SITE_URL,
        eventSlug: process.env.EXPO_PUBLIC_EVENT_SLUG || "code2create-7",
        scheme: "code2create-ops",
        appBuild,
        apnsEnvironment,
      }
    : null;

export const reviewerObservabilityConfiguration = createObservabilityConfiguration();

function createObservabilityConfiguration() {
  const projectToken = process.env.EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim();
  const host = process.env.EXPO_PUBLIC_POSTHOG_HOST?.trim();
  if (!projectToken && !host) return null;
  if (!projectToken || !host) {
    throw new Error("Set both EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN and EXPO_PUBLIC_POSTHOG_HOST.");
  }
  if (!appBuild) {
    throw new Error("Set a positive EXPO_PUBLIC_APP_BUILD when PostHog is enabled.");
  }
  return {
    projectToken,
    host: validatePostHogHost(host),
    deploymentEnvironment: parseDeploymentEnvironment(
      process.env.EXPO_PUBLIC_DEPLOYMENT_ENVIRONMENT?.trim(),
    ),
    release: requiredTelemetryRelease(process.env.EXPO_PUBLIC_RELEASE_ID, "EXPO_PUBLIC_RELEASE_ID"),
    appBuild,
  };
}

function parseAppBuild(value: string | undefined) {
  if (!value || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseApnsEnvironment(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "development") return "development" as const;
  if (normalized === "production") return "production" as const;
  throw new Error("EXPO_PUBLIC_APNS_ENVIRONMENT must be development or production.");
}
