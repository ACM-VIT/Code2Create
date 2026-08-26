import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import { insertPermissionGrant } from "./lib/permissions";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

const originalAuthSiteUrl = process.env.AUTH_SITE_URL;
const originalParticipantSiteUrl = process.env.PARTICIPANT_SITE_URL;
const originalOperationsSiteUrl = process.env.OPERATIONS_SITE_URL;
const originalHandbookSiteUrl = process.env.HANDBOOK_SITE_URL;

beforeAll(() => {
  process.env.AUTH_SITE_URL = "http://localhost:3211";
  process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
  process.env.OPERATIONS_SITE_URL = "http://localhost:4174";
  process.env.HANDBOOK_SITE_URL = "http://localhost:4175";
});

afterAll(() => {
  restoreEnvironment("AUTH_SITE_URL", originalAuthSiteUrl);
  restoreEnvironment("PARTICIPANT_SITE_URL", originalParticipantSiteUrl);
  restoreEnvironment("OPERATIONS_SITE_URL", originalOperationsSiteUrl);
  restoreEnvironment("HANDBOOK_SITE_URL", originalHandbookSiteUrl);
});

describe("incident summaries", () => {
  test("returns a small exact projection and enforces the active-incident boundary", async () => {
    const backend = seededBackend();
    const fixture = await seedOperator(backend);
    const now = Date.now();
    await backend.run(async (ctx) => {
      for (let index = 0; index < 20; index += 1) {
        await ctx.db.insert("incidents", {
          eventId: fixture.eventId,
          title: `Incident ${index}`,
          summary: `Operational incident fixture ${index}`,
          severity: "service_disruption",
          affectedService: "review_backend",
          state: index % 2 === 0 ? "open" : "monitoring",
          manualModeState: index === 0 ? "pending" : "not_requested",
          manualModeApprovalCount: 0,
          openedByPersonId: fixture.personId,
          openedAt: now + index,
          version: 1,
          updatedAt: now + index,
        });
      }
    });
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });

    await expect(
      operator.query(api.incidents.activeSummary, { eventSlug: fixture.eventSlug }),
    ).resolves.toEqual({ liveCount: 20, pendingManualModeCount: 1 });
    await expect(
      operator.mutation(api.incidents.create, {
        eventSlug: fixture.eventSlug,
        title: "One incident too many",
        summary: "This write must fail before it can exceed the active incident boundary.",
        severity: "major",
        affectedService: "review_backend",
        clientOperationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Resolve an active incident");

    await backend.run(async (ctx) => {
      await ctx.db.insert("incidents", {
        eventId: fixture.eventId,
        title: "Invalid overflow fixture",
        summary: "This row proves reads fail loudly if the owner invariant is broken.",
        severity: "major",
        affectedService: "attendance_backend",
        state: "open",
        manualModeState: "not_requested",
        manualModeApprovalCount: 0,
        openedByPersonId: fixture.personId,
        openedAt: now + 21,
        version: 1,
        updatedAt: now + 21,
      });
    });
    await expect(
      operator.query(api.incidents.activeSummary, { eventSlug: fixture.eventSlug }),
    ).rejects.toThrow("cannot have more than 20 active incidents");
  });

  test("a retried incident creation returns its original version", async () => {
    const backend = seededBackend();
    const fixture = await seedOperator(backend);
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const args = {
      eventSlug: fixture.eventSlug,
      title: "Review service latency",
      summary: "Reviewer requests are timing out while the event remains live.",
      severity: "major" as const,
      affectedService: "review_backend" as const,
      clientOperationId: crypto.randomUUID(),
    };
    const created = await operator.mutation(api.incidents.create, args);
    await backend.run(async (ctx) => {
      await ctx.db.patch(created.id, { state: "monitoring", version: 2 });
    });

    await expect(operator.mutation(api.incidents.create, args)).resolves.toEqual(created);
    await expect(
      backend.run(async (ctx) => (await ctx.db.get(created.id))?.version),
    ).resolves.toBe(2);
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

async function seedOperator(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `incidents-${crypto.randomUUID()}`;
  const email = `incidents-${crypto.randomUUID()}@example.test`;
  const authUserId = await createAuthUser(backend, now, email);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  const identity = await backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: crypto.randomUUID(),
      verifiedEmail: email,
      displayName: "Incident operator",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Incident fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: email,
      displayName: "Incident operator",
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    for (const permissionKey of ["incident.read", "incident.create"] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "manual",
        sourceId: `${eventSlug}:${permissionKey}`,
        grantedByPersonId: personId,
        reason: "Incident summary test",
      });
    }
    return { eventId, personId };
  });
  return { ...identity, eventSlug, authUserId, authSessionId };
}

async function createAuthUser(backend: BackendTest, now: number, email: string) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Incident operator",
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
        expiresAt: now + 60 * 60_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        userId,
      },
    },
  });
  return documentId(result, "Better Auth session");
}

function documentId(value: unknown, label: string): string {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return a document ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid document ID.`);
  }
  return id;
}

function restoreEnvironment(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
