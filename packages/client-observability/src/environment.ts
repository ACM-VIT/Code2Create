export type DeploymentEnvironment = "development" | "staging" | "production";

export function parseDeploymentEnvironment(value: string | undefined): DeploymentEnvironment {
  if (value === "development" || value === "staging" || value === "production") {
    return value;
  }
  throw new Error("Set the deployment environment to development, staging, or production.");
}

export function requiredTelemetryRelease(value: string | undefined, variableName: string) {
  const release = value?.trim();
  if (release === undefined || release.length === 0 || release.length > 120) {
    throw new Error(
      `Set a non-empty ${variableName} no longer than 120 characters when PostHog is enabled.`,
    );
  }
  return release;
}

export function validatePostHogHost(value: string) {
  const host = new URL(value);
  if (host.protocol !== "https:" || host.username || host.password || host.search || host.hash) {
    throw new Error(
      "The PostHog host must be a complete HTTPS URL without credentials, query, or fragment.",
    );
  }
  return host.origin;
}
