import path from "node:path";

export type ReleaseEnvironment = {
  environment: "staging";
  eventSlug: string;
  operationsAccountEmail: string;
  operationsStorageStatePath: string;
  operationsUrl: string;
  participantAccountEmail: string;
  participantStorageStatePath: string;
  participantUrl: string;
  runId: string;
};

function requiredValue(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for release browser checks.`);
  }
  return value;
}

function httpsOrigin(environment: NodeJS.ProcessEnv, name: string) {
  const value = requiredValue(environment, name);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be one HTTPS origin with no path, query, or credentials.`);
  }
  return url.origin;
}

function email(environment: NodeJS.ProcessEnv, name: string) {
  const value = requiredValue(environment, name).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) || value.length > 320) {
    throw new Error(`${name} must be one valid email address.`);
  }
  return value;
}

function storageStatePath(environment: NodeJS.ProcessEnv, name: string) {
  const value = requiredValue(environment, name);
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.resolve(value);
}

function stableIdentifier(environment: NodeJS.ProcessEnv, name: string, maximumLength: number) {
  const value = requiredValue(environment, name);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value) || value.length > maximumLength) {
    throw new Error(`${name} contains unsupported characters.`);
  }
  return value;
}

export function readReleaseEnvironment(environment: NodeJS.ProcessEnv): ReleaseEnvironment {
  const deploymentEnvironment = requiredValue(environment, "C2C_E2E_ENVIRONMENT");
  if (deploymentEnvironment !== "staging") {
    throw new Error("Release browser checks can run only against staging.");
  }
  const participantUrl = httpsOrigin(environment, "C2C_PARTICIPANT_URL");
  const operationsUrl = httpsOrigin(environment, "C2C_OPERATIONS_URL");
  if (participantUrl === operationsUrl) {
    throw new Error("Participant and operations release checks require different origins.");
  }
  const participantAccountEmail = email(environment, "C2C_PARTICIPANT_ACCOUNT_EMAIL");
  const operationsAccountEmail = email(environment, "C2C_OPERATIONS_ACCOUNT_EMAIL");
  if (participantAccountEmail === operationsAccountEmail) {
    throw new Error("Participant and operations release accounts must be different.");
  }

  return {
    environment: "staging",
    eventSlug: stableIdentifier(environment, "C2C_EVENT_SLUG", 80),
    operationsAccountEmail,
    operationsStorageStatePath: storageStatePath(environment, "C2C_OPERATIONS_STORAGE_STATE_PATH"),
    operationsUrl,
    participantAccountEmail,
    participantStorageStatePath: storageStatePath(
      environment,
      "C2C_PARTICIPANT_STORAGE_STATE_PATH",
    ),
    participantUrl,
    runId: stableIdentifier(environment, "C2C_E2E_RUN_ID", 100),
  };
}
