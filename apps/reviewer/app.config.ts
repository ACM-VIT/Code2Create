import type { ConfigContext, ExpoConfig } from "expo/config";

const deploymentEnvironment = readDeploymentEnvironment();
const updatesUrl = readUpdatesUrl(deploymentEnvironment);
const iosBundleIdentifier = readIosBundleIdentifier();
const androidPackage = readAndroidPackage();
const appBuild = readAppBuild();
const iosTeamId = readIosTeamId();
const androidGoogleServicesFile = readEnvironmentValue("C2C_ANDROID_GOOGLE_SERVICES_FILE");
const convexUrl = readApplicationUrl("EXPO_PUBLIC_CONVEX_URL", deploymentEnvironment);
const convexSiteUrl = readApplicationUrl("EXPO_PUBLIC_CONVEX_SITE_URL", deploymentEnvironment);
const eventSlug = readEventSlug();
const releaseId = readReleaseId();
const apnsEnvironment = readApnsEnvironment();
const posthogProjectToken = readPostHogProjectToken();
const posthogHost = readHttpsUrl("EXPO_PUBLIC_POSTHOG_HOST");
const posthogCliHost = readHttpsUrl("POSTHOG_CLI_HOST");
const posthogCliProjectId = readPositiveInteger("POSTHOG_CLI_PROJECT_ID");
const posthogCliApiKey = readEnvironmentValue("POSTHOG_CLI_API_KEY");

if (process.env.C2C_NATIVE_BUILD === "true") {
  const missing: string[] = [];
  if (!updatesUrl) missing.push("C2C_UPDATES_URL");
  if (!iosBundleIdentifier) missing.push("C2C_IOS_BUNDLE_IDENTIFIER");
  if (!androidPackage) missing.push("C2C_ANDROID_PACKAGE");
  if (!appBuild) missing.push("EXPO_PUBLIC_APP_BUILD");
  if (!convexUrl) missing.push("EXPO_PUBLIC_CONVEX_URL");
  if (!convexSiteUrl) missing.push("EXPO_PUBLIC_CONVEX_SITE_URL");
  if (!eventSlug) missing.push("EXPO_PUBLIC_EVENT_SLUG");
  if (!releaseId) missing.push("EXPO_PUBLIC_RELEASE_ID");
  if (!deploymentEnvironment) missing.push("EXPO_PUBLIC_DEPLOYMENT_ENVIRONMENT");
  if (!apnsEnvironment) missing.push("EXPO_PUBLIC_APNS_ENVIRONMENT");
  if (!posthogProjectToken) missing.push("EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN");
  if (!posthogHost) missing.push("EXPO_PUBLIC_POSTHOG_HOST");
  if (!posthogCliHost) missing.push("POSTHOG_CLI_HOST");
  if (!posthogCliProjectId) missing.push("POSTHOG_CLI_PROJECT_ID");
  if (!posthogCliApiKey) missing.push("POSTHOG_CLI_API_KEY");
  if (process.env.C2C_NATIVE_PLATFORM === "android" && !androidGoogleServicesFile) {
    missing.push("C2C_ANDROID_GOOGLE_SERVICES_FILE");
  }

  if (missing.length > 0) {
    throw new Error(`Set ${missing.join(", ")} for the selected local release.`);
  }
}

const reviewerAppConfig = ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? "Code2Create Ops",
  slug: config.slug ?? "code2create-ops",
  plugins: [
    ...(config.plugins ?? []),
    [
      "posthog-react-native/expo",
      {
        skipOnConflict: true,
        uploadNativeSymbols: process.env.C2C_NATIVE_BUILD === "true",
      },
    ],
  ],
  runtimeVersion: { policy: "appVersion" },
  ios: {
    ...config.ios,
    ...(iosBundleIdentifier ? { bundleIdentifier: iosBundleIdentifier } : {}),
    ...(appBuild ? { buildNumber: String(appBuild) } : {}),
    ...(iosTeamId ? { appleTeamId: iosTeamId } : {}),
  },
  android: {
    ...config.android,
    ...(androidPackage ? { package: androidPackage } : {}),
    ...(appBuild ? { versionCode: appBuild } : {}),
    ...(androidGoogleServicesFile ? { googleServicesFile: androidGoogleServicesFile } : {}),
  },
  ...(updatesUrl
    ? {
        updates: {
          ...config.updates,
          url: updatesUrl,
          codeSigningCertificate: "./certs/certificate.pem",
          codeSigningMetadata: {
            keyid: "main",
            alg: "rsa-v1_5-sha256",
          },
          checkAutomatically: "ON_LOAD",
          fallbackToCacheTimeout: 0,
        },
      }
    : {}),
});

export default reviewerAppConfig;

function readUpdatesUrl(environment: "development" | "staging" | "production" | null) {
  const value = readEnvironmentValue("C2C_UPDATES_URL");
  if (!value) return null;
  const url = new URL(value);
  const developmentHttp =
    environment === "development" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      isPrivateLanHost(url.hostname));
  if (
    (!developmentHttp && url.protocol !== "https:") ||
    url.pathname !== "/manifest" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "C2C_UPDATES_URL must be HTTPS outside development and end at /manifest; development may use local HTTP.",
    );
  }
  return url.href;
}

function readIosBundleIdentifier() {
  const value = readEnvironmentValue("C2C_IOS_BUNDLE_IDENTIFIER");
  if (!value) return null;
  if (!/^(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/u.test(value)) {
    throw new Error("C2C_IOS_BUNDLE_IDENTIFIER must be a reverse-DNS bundle identifier.");
  }
  return value;
}

function readAndroidPackage() {
  const value = readEnvironmentValue("C2C_ANDROID_PACKAGE");
  if (!value) return null;
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(value)) {
    throw new Error("C2C_ANDROID_PACKAGE must be a lowercase reverse-DNS package name.");
  }
  return value;
}

function readAppBuild() {
  const value = readEnvironmentValue("EXPO_PUBLIC_APP_BUILD");
  if (!value || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_100_000_000) {
    throw new Error("EXPO_PUBLIC_APP_BUILD must be a positive Android version code.");
  }
  return parsed;
}

function readIosTeamId() {
  const value = readEnvironmentValue("C2C_IOS_TEAM_ID")?.toUpperCase();
  if (!value) return null;
  if (!/^[A-Z0-9]{10}$/u.test(value)) {
    throw new Error("C2C_IOS_TEAM_ID must be a 10-character Apple team ID.");
  }
  return value;
}

function readApplicationUrl(
  name: string,
  environment: "development" | "staging" | "production" | null,
) {
  const value = readEnvironmentValue(name);
  if (!value) return null;
  const url = new URL(value);
  const developmentHttp =
    environment === "development" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      isPrivateLanHost(url.hostname));
  if ((!developmentHttp && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw new Error(`${name} must be HTTPS outside development; development may use local HTTP.`);
  }
  return url.href;
}

function isPrivateLanHost(hostname: string) {
  // Development devices reach the local backend through private IPv4 addresses.
  return /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/u.test(
    hostname,
  );
}

function readEventSlug() {
  const value = readEnvironmentValue("EXPO_PUBLIC_EVENT_SLUG");
  if (!value) return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new Error("EXPO_PUBLIC_EVENT_SLUG must be a lowercase URL slug.");
  }
  return value;
}

function readReleaseId() {
  const value = readEnvironmentValue("EXPO_PUBLIC_RELEASE_ID");
  if (!value) return null;
  if (value.length > 128 || /[\r\n]/u.test(value)) {
    throw new Error("EXPO_PUBLIC_RELEASE_ID is invalid.");
  }
  return value;
}

function readDeploymentEnvironment() {
  const value = readEnvironmentValue("EXPO_PUBLIC_DEPLOYMENT_ENVIRONMENT");
  if (!value) return null;
  if (value !== "development" && value !== "staging" && value !== "production") {
    throw new Error("EXPO_PUBLIC_DEPLOYMENT_ENVIRONMENT is invalid.");
  }
  return value;
}

function readApnsEnvironment() {
  const value = readEnvironmentValue("EXPO_PUBLIC_APNS_ENVIRONMENT");
  if (!value) return null;
  if (value !== "development" && value !== "production") {
    throw new Error("EXPO_PUBLIC_APNS_ENVIRONMENT is invalid.");
  }
  return value;
}

function readPostHogProjectToken() {
  const value = readEnvironmentValue("EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN");
  if (!value) return null;
  if (!/^phc_[A-Za-z0-9]+$/u.test(value)) {
    throw new Error("EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN is invalid.");
  }
  return value;
}

function readHttpsUrl(name: string) {
  const value = readEnvironmentValue(name);
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${name} must be a complete HTTPS URL without credentials, query, or fragment.`,
    );
  }
  return url.origin;
}

function readPositiveInteger(name: string) {
  const value = readEnvironmentValue(name);
  if (!value) return null;
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readEnvironmentValue(name: string) {
  const value = process.env[name]?.trim();
  return value || null;
}
