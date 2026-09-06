export type LiveProviderConfiguration = {
  environment: "staging";
  githubAppClientId: string;
  githubAppClientSecret: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  githubInstallationId: string;
  githubOwner: string;
  githubRepository: string;
  githubRepositoryId: string;
  githubRequiredTopic: string;
  intelligenceUrl: string;
  openAiApiKey: string;
};

function requiredValue(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for live provider checks.`);
  return value;
}

function identifier(
  environment: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp,
  maximumLength: number,
) {
  const value = requiredValue(environment, name);
  if (!pattern.test(value) || value.length > maximumLength) {
    throw new Error(`${name} contains an unsupported value.`);
  }
  return value;
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string) {
  const value = requiredValue(environment, name);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be one positive integer.`);
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
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be one HTTPS origin.`);
  }
  return url.origin;
}

export function readLiveProviderConfiguration(
  environment: NodeJS.ProcessEnv,
): LiveProviderConfiguration {
  if (requiredValue(environment, "C2C_PROVIDER_ENVIRONMENT") !== "staging") {
    throw new Error("Live provider checks can run only against staging resources.");
  }
  return {
    environment: "staging",
    githubAppClientId: requiredValue(environment, "GITHUB_APP_CLIENT_ID"),
    githubAppClientSecret: requiredValue(environment, "GITHUB_APP_CLIENT_SECRET"),
    githubAppId: positiveInteger(environment, "GITHUB_APP_ID"),
    githubAppPrivateKey: requiredValue(environment, "GITHUB_APP_PRIVATE_KEY"),
    githubInstallationId: positiveInteger(environment, "C2C_PROVIDER_GITHUB_INSTALLATION_ID"),
    githubOwner: identifier(
      environment,
      "C2C_PROVIDER_GITHUB_OWNER",
      /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/,
      39,
    ),
    githubRepository: identifier(
      environment,
      "C2C_PROVIDER_GITHUB_REPOSITORY",
      /^[a-zA-Z0-9._-]+$/,
      100,
    ),
    githubRepositoryId: positiveInteger(environment, "C2C_PROVIDER_GITHUB_REPOSITORY_ID"),
    githubRequiredTopic: identifier(
      environment,
      "C2C_PROVIDER_GITHUB_REQUIRED_TOPIC",
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      50,
    ),
    intelligenceUrl: httpsOrigin(environment, "C2C_PROVIDER_INTELLIGENCE_URL"),
    openAiApiKey: requiredValue(environment, "OPENAI_API_KEY"),
  };
}
