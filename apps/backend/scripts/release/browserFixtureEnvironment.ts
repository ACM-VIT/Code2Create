export type BrowserFixtureConfiguration = {
  eventSlug: string;
  operationsAccountEmail: string;
  participantAccountEmail: string;
};

function requiredValue(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for staging browser fixture checks.`);
  return value;
}

function stableIdentifier(environment: NodeJS.ProcessEnv, name: string) {
  const value = requiredValue(environment, name).toLowerCase();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value.length > 80) {
    throw new Error(`${name} contains unsupported characters.`);
  }
  return value;
}

function email(environment: NodeJS.ProcessEnv, name: string) {
  const value = requiredValue(environment, name).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 320) {
    throw new Error(`${name} must be one valid email address.`);
  }
  return value;
}

export function readBrowserFixtureConfiguration(
  environment: NodeJS.ProcessEnv,
): BrowserFixtureConfiguration {
  if (requiredValue(environment, "C2C_E2E_ENVIRONMENT") !== "staging") {
    throw new Error("Browser fixture checks can run only against staging.");
  }
  requiredValue(environment, "CONVEX_DEPLOY_KEY");
  const participantAccountEmail = email(environment, "C2C_PARTICIPANT_ACCOUNT_EMAIL");
  const operationsAccountEmail = email(environment, "C2C_OPERATIONS_ACCOUNT_EMAIL");
  if (participantAccountEmail === operationsAccountEmail) {
    throw new Error("Participant and operations release accounts must be different.");
  }
  return {
    eventSlug: stableIdentifier(environment, "C2C_EVENT_SLUG"),
    operationsAccountEmail,
    participantAccountEmail,
  };
}
