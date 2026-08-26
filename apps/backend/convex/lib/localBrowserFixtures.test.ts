import assert from "node:assert/strict";
import test from "node:test";

import {
  localBrowserFixtureOrigins,
  localBrowserReturnUrl,
  requireLocalDeployment,
} from "./localBrowserFixtures.ts";

const fixtureEnvironmentKeys = [
  "LOCAL_DEVELOPMENT_SEED_ENABLED",
  "LOCAL_TUNNEL_FIXTURES_ENABLED",
  "CONVEX_CLOUD_URL",
  "CONVEX_SITE_URL",
  "AUTH_SITE_URL",
  "PARTICIPANT_SITE_URL",
  "OPERATIONS_SITE_URL",
  "HANDBOOK_SITE_URL",
] as const;

type FixtureEnvironmentKey = (typeof fixtureEnvironmentKeys)[number];
type FixtureEnvironment = Record<FixtureEnvironmentKey, string | undefined>;

const validLocalEnvironment: FixtureEnvironment = {
  LOCAL_DEVELOPMENT_SEED_ENABLED: "true",
  LOCAL_TUNNEL_FIXTURES_ENABLED: undefined,
  CONVEX_CLOUD_URL: "http://127.0.0.1:3210",
  CONVEX_SITE_URL: "http://127.0.0.1:3211",
  AUTH_SITE_URL: "http://localhost:3211",
  PARTICIPANT_SITE_URL: "http://localhost:5180",
  OPERATIONS_SITE_URL: "http://localhost:5181",
  HANDBOOK_SITE_URL: "http://localhost:5182",
};

const validTunnelEnvironment: FixtureEnvironment = {
  ...validLocalEnvironment,
  LOCAL_TUNNEL_FIXTURES_ENABLED: "true",
  AUTH_SITE_URL: "https://auth-code2create.trycloudflare.com",
  PARTICIPANT_SITE_URL: "https://participant-code2create.trycloudflare.com",
  OPERATIONS_SITE_URL: "https://operations-code2create.trycloudflare.com",
  HANDBOOK_SITE_URL: "https://handbook-code2create.trycloudflare.com",
};

function readFixtureEnvironment(): FixtureEnvironment {
  return {
    LOCAL_DEVELOPMENT_SEED_ENABLED:
      process.env.LOCAL_DEVELOPMENT_SEED_ENABLED,
    LOCAL_TUNNEL_FIXTURES_ENABLED:
      process.env.LOCAL_TUNNEL_FIXTURES_ENABLED,
    CONVEX_CLOUD_URL: process.env.CONVEX_CLOUD_URL,
    CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
    AUTH_SITE_URL: process.env.AUTH_SITE_URL,
    PARTICIPANT_SITE_URL: process.env.PARTICIPANT_SITE_URL,
    OPERATIONS_SITE_URL: process.env.OPERATIONS_SITE_URL,
    HANDBOOK_SITE_URL: process.env.HANDBOOK_SITE_URL,
  };
}

function setFixtureEnvironment(environment: FixtureEnvironment) {
  for (const key of fixtureEnvironmentKeys) {
    const value = environment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function rejectsLocalFixtures(environment: FixtureEnvironment) {
  setFixtureEnvironment(environment);
  assert.equal(localBrowserFixtureOrigins(), null);
  assert.throws(
    () => requireLocalDeployment(),
    /approved local test stack/u,
  );
}

test("local fixture access requires an approved local test stack", async (t) => {
  const originalEnvironment = readFixtureEnvironment();
  try {
    await t.test("accepts the normal local stack", () => {
      setFixtureEnvironment(validLocalEnvironment);
      assert.deepEqual(localBrowserFixtureOrigins(), {
        auth: "http://localhost:3211",
        participant: "http://localhost:5180",
        operations: "http://localhost:5181",
        handbook: "http://localhost:5182",
      });
      assert.doesNotThrow(() => requireLocalDeployment());
    });

    await t.test("accepts an explicitly enabled quick-tunnel stack", () => {
      setFixtureEnvironment(validTunnelEnvironment);
      assert.deepEqual(localBrowserFixtureOrigins(), {
        auth: validTunnelEnvironment.AUTH_SITE_URL,
        participant: validTunnelEnvironment.PARTICIPANT_SITE_URL,
        operations: validTunnelEnvironment.OPERATIONS_SITE_URL,
        handbook: validTunnelEnvironment.HANDBOOK_SITE_URL,
      });
      assert.doesNotThrow(() => requireLocalDeployment());
    });

    await t.test("rejects quick-tunnel origins without the explicit flag", () => {
      rejectsLocalFixtures({
        ...validTunnelEnvironment,
        LOCAL_TUNNEL_FIXTURES_ENABLED: undefined,
      });
    });

    await t.test("rejects the seed flag without all four origins", () => {
      rejectsLocalFixtures({
        LOCAL_DEVELOPMENT_SEED_ENABLED: "true",
        LOCAL_TUNNEL_FIXTURES_ENABLED: undefined,
        CONVEX_CLOUD_URL: "http://127.0.0.1:3210",
        CONVEX_SITE_URL: "http://127.0.0.1:3211",
        AUTH_SITE_URL: undefined,
        PARTICIPANT_SITE_URL: undefined,
        OPERATIONS_SITE_URL: undefined,
        HANDBOOK_SITE_URL: undefined,
      });
    });

    await t.test("rejects localhost origins when the seed flag is off", () => {
      rejectsLocalFixtures({
        ...validLocalEnvironment,
        LOCAL_DEVELOPMENT_SEED_ENABLED: "false",
      });
    });

    await t.test("rejects missing Convex runtime origins", () => {
      rejectsLocalFixtures({
        ...validLocalEnvironment,
        CONVEX_CLOUD_URL: undefined,
        CONVEX_SITE_URL: undefined,
      });
    });

    await t.test("rejects a cloud Convex runtime", () => {
      rejectsLocalFixtures({
        ...validLocalEnvironment,
        CONVEX_CLOUD_URL: "https://example.convex.cloud",
        CONVEX_SITE_URL: "https://example.convex.site",
      });
    });

    await t.test("rejects a tunnel fixture stack on a non-Cloudflare hostname", () => {
      rejectsLocalFixtures({
        ...validTunnelEnvironment,
        OPERATIONS_SITE_URL: "https://operations.example.test",
      });
    });

    await t.test("rejects an auth origin on the wrong site port", () => {
      rejectsLocalFixtures({
        ...validLocalEnvironment,
        AUTH_SITE_URL: "http://localhost:3212",
      });
    });

    await t.test("rejects two app surfaces sharing one origin", () => {
      rejectsLocalFixtures({
        ...validLocalEnvironment,
        OPERATIONS_SITE_URL: validLocalEnvironment.PARTICIPANT_SITE_URL,
      });
    });

    const invalidOrigins: Array<{
      name: string;
      environment: FixtureEnvironment;
    }> = [
      {
        name: "HTTPS",
        environment: {
          ...validLocalEnvironment,
          AUTH_SITE_URL: "https://localhost:3211",
        },
      },
      {
        name: "a loopback IP",
        environment: {
          ...validLocalEnvironment,
          PARTICIPANT_SITE_URL: "http://127.0.0.1:5180",
        },
      },
      {
        name: "a non-local hostname",
        environment: {
          ...validLocalEnvironment,
          OPERATIONS_SITE_URL: "http://operations.example.test:5181",
        },
      },
      {
        name: "a URL with a path",
        environment: {
          ...validLocalEnvironment,
          HANDBOOK_SITE_URL: "http://localhost:5182/handbook",
        },
      },
      {
        name: "an invalid URL",
        environment: {
          ...validLocalEnvironment,
          AUTH_SITE_URL: "not-a-url",
        },
      },
    ];

    for (const fixture of invalidOrigins) {
      await t.test(`rejects ${fixture.name}`, () => {
        rejectsLocalFixtures(fixture.environment);
      });
    }
  } finally {
    setFixtureEnvironment(originalEnvironment);
  }
});

test("local sign-in keeps only a same-app return path", () => {
  assert.equal(
    localBrowserReturnUrl(
      "http://localhost:5180",
      "/join/C2C7ABC?from=invite#team",
    ).toString(),
    "http://localhost:5180/join/C2C7ABC?from=invite#team",
  );
  for (const value of [
    "",
    "join/C2C7ABC",
    "//example.test/join/C2C7ABC",
    "/\\example.test/join/C2C7ABC",
    `/join/${"x".repeat(2_048)}`,
  ]) {
    assert.throws(
      () => localBrowserReturnUrl("http://localhost:5180", value),
      /local sign-in return path/u,
    );
  }
});
