import assert from "node:assert/strict";
import test from "node:test";

import { validateWebReleaseEnvironment } from "./webEnvironment.ts";

function validBuildEnvironment(): Record<string, string | undefined> {
  return {
    CLOUDFLARE_ENV: "staging",
    VITE_CONVEX_URL: "https://realtime-staging.c2c.sh",
    VITE_CONVEX_SITE_URL: "https://api-staging.c2c.sh",
    VITE_DEPLOYMENT_ENVIRONMENT: "staging",
    VITE_EVENT_SLUG: "code2create-7",
    VITE_RELEASE_ID: "release-42",
    VITE_POSTHOG_PROJECT_TOKEN: "phc_publicprojecttoken",
    VITE_POSTHOG_HOST: "https://i.c2c.sh",
    POSTHOG_CLI_HOST: "https://eu.posthog.com",
    POSTHOG_CLI_PROJECT_ID: "169929",
    POSTHOG_CLI_API_KEY: "secret-token",
  };
}

test("accepts a complete participant release build", () => {
  const environment = validBuildEnvironment();
  assert.doesNotThrow(() => validateWebReleaseEnvironment("participant", "build", environment));
});

test("accepts a landing release without participant-only configuration", () => {
  const environment = validBuildEnvironment();
  environment.VITE_CONVEX_URL = undefined;
  environment.VITE_CONVEX_SITE_URL = undefined;
  environment.VITE_EVENT_SLUG = undefined;
  assert.doesNotThrow(() => validateWebReleaseEnvironment("landing", "build", environment));
});

test("rejects a deployment-environment mismatch", () => {
  const environment = validBuildEnvironment();
  environment.VITE_DEPLOYMENT_ENVIRONMENT = "production";
  assert.throws(
    () => validateWebReleaseEnvironment("operations", "build", environment),
    /VITE_DEPLOYMENT_ENVIRONMENT must match CLOUDFLARE_ENV/u,
  );
});

test("accepts the production Convex origins only for production", () => {
  const environment = validBuildEnvironment();
  environment.CLOUDFLARE_ENV = "production";
  environment.VITE_DEPLOYMENT_ENVIRONMENT = "production";
  environment.VITE_CONVEX_URL = "https://realtime.c2c.sh";
  environment.VITE_CONVEX_SITE_URL = "https://api.c2c.sh";
  assert.doesNotThrow(() => validateWebReleaseEnvironment("participant", "deploy", environment));
});

test("rejects staging Convex origins in a production build", () => {
  const environment = validBuildEnvironment();
  environment.CLOUDFLARE_ENV = "production";
  environment.VITE_DEPLOYMENT_ENVIRONMENT = "production";
  assert.throws(
    () => validateWebReleaseEnvironment("participant", "deploy", environment),
    /VITE_CONVEX_URL must be https:\/\/realtime\.c2c\.sh for production/u,
  );
});

test("requires PostHog upload configuration for browser releases", () => {
  const environment = validBuildEnvironment();
  environment.POSTHOG_CLI_API_KEY = undefined;
  assert.throws(
    () => validateWebReleaseEnvironment("participant", "build", environment),
    /Set POSTHOG_CLI_API_KEY/u,
  );
});

test("accepts a deploy with complete public runtime configuration and no upload credential", () => {
  const environment = validBuildEnvironment();
  environment.POSTHOG_CLI_API_KEY = undefined;
  assert.doesNotThrow(() => validateWebReleaseEnvironment("operations", "deploy", environment));
});

test("rejects a deploy without its Convex runtime configuration", () => {
  const environment = validBuildEnvironment();
  environment.VITE_CONVEX_URL = undefined;
  assert.throws(
    () => validateWebReleaseEnvironment("operations", "deploy", environment),
    /Set VITE_CONVEX_URL/u,
  );
});

test("rejects a deploy without its PostHog runtime configuration", () => {
  const environment = validBuildEnvironment();
  environment.VITE_POSTHOG_HOST = undefined;
  assert.throws(
    () => validateWebReleaseEnvironment("participant", "deploy", environment),
    /Set VITE_POSTHOG_HOST/u,
  );
});
