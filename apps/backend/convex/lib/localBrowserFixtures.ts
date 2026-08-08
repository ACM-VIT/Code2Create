type LocalBrowserFixtureOrigins = {
  auth: string;
  participant: string;
  operations: string;
  handbook: string;
};

function localOrigin(value: string | undefined) {
  const configured = value?.trim();
  if (!configured) return null;
  const url = new URL(configured);
  if (
    url.origin !== configured ||
    url.protocol !== "http:" ||
    url.hostname !== "localhost"
  ) {
    return null;
  }
  return url.origin;
}

export function localBrowserFixtureOrigins(): LocalBrowserFixtureOrigins | null {
  if (process.env.LOCAL_DEVELOPMENT_SEED_ENABLED !== "true") return null;
  const auth = localOrigin(process.env.AUTH_SITE_URL);
  const participant = localOrigin(process.env.PARTICIPANT_SITE_URL);
  const operations = localOrigin(process.env.OPERATIONS_SITE_URL);
  const handbook = localOrigin(process.env.HANDBOOK_SITE_URL);
  if (!auth || !participant || !operations || !handbook) return null;
  return { auth, participant, operations, handbook };
}

export function localProviderFixturesEnabled() {
  return (
    process.env.LOCAL_PROVIDER_FIXTURES_ENABLED === "true" &&
    localBrowserFixtureOrigins() !== null
  );
}
