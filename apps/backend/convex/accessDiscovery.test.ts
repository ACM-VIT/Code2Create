import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";

import { api, components } from "./_generated/api";
import schema from "./schema.ts";

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

test("discovers email-targeted access before a complete Google profile claim exists", async () => {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const now = Date.now();
  const email = "invited@example.test";
  const authUserId = await createAuthUser(backend, now, email);
  const sessionId = await createAuthSession(backend, authUserId, now);
  const eventSlug = `access-discovery-${crypto.randomUUID()}`;
  await backend.run(async (ctx) => {
    const creatorPersonId = await ctx.db.insert("people", {
      authUserId: crypto.randomUUID(),
      googleSubject: crypto.randomUUID(),
      verifiedEmail: "creator@example.test",
      displayName: "Access creator",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Access discovery fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: now + 86_400_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("eventAccessInvitations", {
      eventId,
      emailNormalized: email,
      status: "pending",
      validUntil: now + 3_600_000,
      version: 1,
      createdByPersonId: creatorPersonId,
      creationOperationId: "access-discovery-invitation",
      reason: "Regression fixture",
      createdAt: now,
    });
    await ctx.db.insert("googleIdentityClaims", {
      authUserId,
      googleSubject: crypto.randomUUID(),
      verifiedEmail: email,
      tokenIssuedAt: now,
      tokenExpiresAt: now + 3_600_000,
      verifiedAt: now,
    });
  });
  const authenticated = backend.withIdentity({
    subject: authUserId,
    sessionId,
  });

  await expect(
    authenticated.query(api.accessInvitations.mine, {
      eventSlug,
    }),
  ).resolves.toMatchObject({ email });
  await expect(
    authenticated.query(api.rosters.mine, {
      eventSlug,
    }),
  ).resolves.toBeNull();
});

async function createAuthUser(backend: BackendTest, now: number, email: string) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Invited tester",
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return documentId(result, "Better Auth user");
}

async function createAuthSession(backend: BackendTest, userId: string, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 3_600_000,
        token: `access-discovery-${crypto.randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        userId,
      },
    },
  });
  return documentId(result, "Better Auth session");
}

function documentId(value: unknown, label: string) {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return a document ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid document ID.`);
  }
  return id;
}
