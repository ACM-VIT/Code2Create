import { ConvexError } from "convex/values";

type LocalBrowserFixtureOrigins = {
  auth: string;
  participant: string;
  operations: string;
  handbook: string;
};

function localOrigin(value: string | undefined) {
  const configured = value?.trim();
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  if (
    url.origin !== configured ||
    url.protocol !== "http:" ||
    url.hostname !== "localhost"
  ) {
    return null;
  }
  return url.origin;
}

function localConvexOrigin(value: string | undefined) {
  const configured = value?.trim();
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  if (
    url.origin !== configured ||
    url.protocol !== "http:" ||
    (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
  ) {
    return null;
  }
  return url.origin;
}

export function localBrowserFixtureOrigins(): LocalBrowserFixtureOrigins | null {
  if (process.env.LOCAL_DEVELOPMENT_SEED_ENABLED !== "true") return null;
  const convexCloud = localConvexOrigin(process.env.CONVEX_CLOUD_URL);
  const convexSite = localConvexOrigin(process.env.CONVEX_SITE_URL);
  if (!convexCloud || !convexSite) return null;
  const auth = localOrigin(process.env.AUTH_SITE_URL);
  const participant = localOrigin(process.env.PARTICIPANT_SITE_URL);
  const operations = localOrigin(process.env.OPERATIONS_SITE_URL);
  const handbook = localOrigin(process.env.HANDBOOK_SITE_URL);
  if (!auth || !participant || !operations || !handbook) return null;
  if (new URL(auth).port !== new URL(convexSite).port) return null;
  if (new Set([auth, participant, operations, handbook]).size !== 4) return null;
  return { auth, participant, operations, handbook };
}

export function requireLocalDeployment() {
  if (localBrowserFixtureOrigins() === null) {
    throw new ConvexError({
      code: "LOCAL_ONLY",
      message: "Local development fixtures require the full localhost-only stack.",
    });
  }
}

export function localProviderFixturesEnabled() {
  return (
    process.env.LOCAL_PROVIDER_FIXTURES_ENABLED === "true" &&
    localBrowserFixtureOrigins() !== null
  );
}
