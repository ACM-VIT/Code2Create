import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { components } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const authModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
test.each([
  { environment: "staging", verified: true, status: 200 },
  { environment: "staging", verified: false, status: 401 },
  { environment: "production", verified: true, status: 401 },
])(
  "links seeded accounts only with verified Google email on $environment ($verified)",
  async ({ environment, verified, status }) => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ keys: [jwk] })),
    );
    const token = await new SignJWT({
      email: "fixture@vitstudent.ac.in",
      email_verified: verified,
      name: "Fixture Student",
      hd: "vitstudent.ac.in",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject("fixture-google-subject")
      .setIssuer("https://accounts.google.com")
      .setAudience("fixture-client")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    vi.stubEnv("C2C_DEPLOYMENT_ENVIRONMENT", environment);
    vi.stubEnv("AUTH_SITE_URL", "http://localhost:3211");
    vi.stubEnv("CONVEX_SITE_URL", "http://localhost:3211");
    vi.stubEnv("PARTICIPANT_SITE_URL", "http://localhost:4173");
    vi.stubEnv("OPERATIONS_SITE_URL", "http://localhost:4174");
    vi.stubEnv("GOOGLE_CLIENT_ID", "fixture-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "fixture-secret");
    vi.stubEnv("BETTER_AUTH_SECRET", "fixture-secret-with-at-least-thirty-two-characters");
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, authModules);
    const now = Date.now();
    const user = await backend.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Fixture Student",
          email: "fixture@vitstudent.ac.in",
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    const response = await backend.fetch("/api/auth/one-tap/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:4173" },
      body: JSON.stringify({ idToken: token }),
    });
    expect(response.status, await response.clone().text()).toBe(status);
    if (status === 200) {
      expect(await response.json()).toMatchObject({
        user: { id: user._id, email: "fixture@vitstudent.ac.in" },
      });
    }
  },
);
