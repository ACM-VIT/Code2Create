import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import type { FunctionArgs } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant } from "./lib/permissions";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

const savedEnvironment = {
  AUTH_SITE_URL: process.env.AUTH_SITE_URL,
  PARTICIPANT_SITE_URL: process.env.PARTICIPANT_SITE_URL,
  OPERATIONS_SITE_URL: process.env.OPERATIONS_SITE_URL,
  HANDBOOK_SITE_URL: process.env.HANDBOOK_SITE_URL,
};

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";
process.env.HANDBOOK_SITE_URL = "http://localhost:4175";

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("direct permission batches", () => {
  test("grants and revokes several exact permissions as one idempotent change", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const actor = backend.withIdentity({
      subject: fixture.actorAuthUserId,
      sessionId: fixture.actorAuthSessionId,
    });
    const grantRequest: FunctionArgs<typeof api.access.grantBatch> = {
      eventSlug: fixture.eventSlug,
      targetPersonId: fixture.targetPersonId,
      grants: [
        { permissionKey: "operations.health.read", scopeType: "event" },
        { permissionKey: "handbook.read", scopeType: "event" },
      ],
      expectedAccessVersion: 1,
      reason: "Cover the event command desk",
      clientOperationId: "grant-command-desk",
    };

    const granted = await actor.mutation(api.access.grantBatch, grantRequest);
    const grantReplay = await actor.mutation(api.access.grantBatch, grantRequest);
    expect(grantReplay).toEqual(granted);
    expect(granted.createdCount).toBe(2);
    expect(granted.accessVersion).toBe(2);
    expect(new Set(granted.grantIds).size).toBe(2);

    const afterGrant = await backend.run(async (ctx) => ({
      target: await ctx.db.get(fixture.targetSubjectId),
      grants: (await Promise.all(granted.grantIds.map((id) => ctx.db.get(id))))
        .filter((row) => row !== null),
      operations: await ctx.db
        .query("operationResults")
        .withIndex("by_actor_operation", (index) =>
          index
            .eq("actorPersonId", fixture.actorPersonId)
            .eq("clientOperationId", grantRequest.clientOperationId),
        )
        .collect(),
      audits: (await ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
        .collect())
        .filter((entry) => entry.action === "access.permission_grant_batch"),
    }));
    expect(afterGrant.target?.accessVersion).toBe(2);
    expect(afterGrant.grants.map((grant) => grant.permissionKey).sort()).toEqual([
      "handbook.read",
      "operations.health.read",
    ]);
    expect(afterGrant.grants.every(
      (grant) => grant.sourceId === `access.grant_batch:${grantRequest.clientOperationId}`,
    )).toBe(true);
    expect(afterGrant.operations).toHaveLength(1);
    expect(afterGrant.audits).toHaveLength(1);

    const revokeRequest: FunctionArgs<typeof api.access.revokeBatch> = {
      eventSlug: fixture.eventSlug,
      targetPersonId: fixture.targetPersonId,
      grantIds: granted.grantIds,
      expectedAccessVersion: 2,
      reason: "The command-desk duty ended",
      clientOperationId: "revoke-command-desk",
    };
    const revoked = await actor.mutation(api.access.revokeBatch, revokeRequest);
    const revokeReplay = await actor.mutation(api.access.revokeBatch, revokeRequest);
    expect(revokeReplay).toEqual(revoked);
    expect(revoked).toMatchObject({ revokedCount: 2, accessVersion: 3 });

    const afterRevoke = await backend.run(async (ctx) => ({
      target: await ctx.db.get(fixture.targetSubjectId),
      grants: (await Promise.all(revoked.grantIds.map((id) => ctx.db.get(id))))
        .filter((row) => row !== null),
      audits: (await ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
        .collect())
        .filter((entry) => entry.action === "access.permission_revoke_batch"),
    }));
    expect(afterRevoke.target?.accessVersion).toBe(3);
    expect(afterRevoke.grants.every((grant) => grant.status === "revoked")).toBe(true);
    expect(afterRevoke.audits).toHaveLength(1);
  });

  test("lets only one stale-version batch win and never leaves a partial revoke", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const actor = backend.withIdentity({
      subject: fixture.actorAuthUserId,
      sessionId: fixture.actorAuthSessionId,
    });
    const concurrent = await Promise.allSettled([
      actor.mutation(api.access.grantBatch, {
        eventSlug: fixture.eventSlug,
        targetPersonId: fixture.targetPersonId,
        grants: [{ permissionKey: "operations.health.read", scopeType: "event" }],
        expectedAccessVersion: 1,
        reason: "First concurrent duty",
        clientOperationId: "concurrent-grant-one",
      }),
      actor.mutation(api.access.grantBatch, {
        eventSlug: fixture.eventSlug,
        targetPersonId: fixture.targetPersonId,
        grants: [{ permissionKey: "handbook.read", scopeType: "event" }],
        expectedAccessVersion: 1,
        reason: "Second concurrent duty",
        clientOperationId: "concurrent-grant-two",
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);

    const winning = concurrent.find((result) => result.status === "fulfilled");
    if (!winning || winning.status !== "fulfilled") {
      throw new Error("One direct grant batch should have committed.");
    }
    const winningGrantId = winning.value.grantIds[0];
    if (!winningGrantId) throw new Error("The winning batch returned no grant.");
    const otherGrantId = await backend.run((ctx) =>
      insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.otherPersonId,
        eventAccessSubjectId: fixture.otherSubjectId,
        permissionKey: "operations.health.read",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "other-person-grant",
        grantedByPersonId: fixture.actorPersonId,
        reason: "Different account fixture",
      }),
    );
    await expect(actor.mutation(api.access.revokeBatch, {
      eventSlug: fixture.eventSlug,
      targetPersonId: fixture.targetPersonId,
      grantIds: [winningGrantId, otherGrantId.grantId],
      expectedAccessVersion: 2,
      reason: "Invalid mixed-account removal",
      clientOperationId: "mixed-account-revoke",
    })).rejects.toThrow("Every selected grant");
    const winningGrant = await backend.run((ctx) => ctx.db.get(winningGrantId));
    expect(winningGrant?.status).toBe("active");
  });

  test("keeps a delegated batch inside every exact target, scope, and expiry ceiling", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend, false);
    const actor = backend.withIdentity({
      subject: fixture.actorAuthUserId,
      sessionId: fixture.actorAuthSessionId,
    });
    const ceiling = Date.now() + 10 * 60 * 1_000;
    await backend.run(async (ctx) => {
      for (const authorityKey of [
        "access.permissions.grant_scoped",
        "access.permissions.revoke_scoped",
      ] as const) {
        for (const permissionKey of [
          "operations.health.read",
          "handbook.read",
        ] as const) {
          await insertPermissionGrant(ctx, {
            eventId: fixture.eventId,
            personId: fixture.actorPersonId,
            eventAccessSubjectId: fixture.actorSubjectId,
            permissionKey: authorityKey,
            scopeType: "event",
            sourceType: "manual",
            sourceId: `scoped-batch:${authorityKey}:${permissionKey}`,
            grantedByPersonId: fixture.actorPersonId,
            reason: "Exact delegated batch fixture",
            validUntil: ceiling,
            delegation: {
              permissionKey,
              scopeType: "event",
              target: { kind: "exact_person", personId: fixture.targetPersonId },
            },
          });
        }
      }
    });

    const grants = [
      { permissionKey: "operations.health.read", scopeType: "event" },
      { permissionKey: "handbook.read", scopeType: "event" },
    ] as const;
    await expect(actor.mutation(api.access.grantBatch, {
      eventSlug: fixture.eventSlug,
      targetPersonId: fixture.targetPersonId,
      grants: [...grants],
      validUntil: ceiling + 1,
      expectedAccessVersion: 1,
      reason: "Outside the delegated expiry",
      clientOperationId: "scoped-batch-too-long",
    })).rejects.toThrow("cannot grant that permission");

    const granted = await actor.mutation(api.access.grantBatch, {
      eventSlug: fixture.eventSlug,
      targetPersonId: fixture.targetPersonId,
      grants: [...grants],
      validUntil: ceiling - 1,
      expectedAccessVersion: 1,
      reason: "Temporary scoped event coverage",
      clientOperationId: "scoped-batch-valid",
    });
    const rows = await backend.run((ctx) => Promise.all(
      granted.grantIds.map((grantId) => ctx.db.get(grantId)),
    ));
    expect(rows.every((grant) => (
      grant?.sourceType === "delegated" && grant.validUntil === ceiling - 1
    ))).toBe(true);

    const revoked = await actor.mutation(api.access.revokeBatch, {
      eventSlug: fixture.eventSlug,
      targetPersonId: fixture.targetPersonId,
      grantIds: granted.grantIds,
      expectedAccessVersion: 2,
      reason: "Temporary scoped event coverage ended",
      clientOperationId: "scoped-batch-revoke",
    });
    expect(revoked).toMatchObject({ revokedCount: 2, accessVersion: 3 });
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

async function seedFixture(backend: BackendTest, unrestrictedAuthority = true) {
  const now = Date.now();
  const actorAuthUserId = await createAuthUser(backend, now);
  const actorAuthSessionId = await createAuthSession(backend, actorAuthUserId, now);
  return backend.run(async (ctx) => {
    const eventSlug = `permission-batch-${crypto.randomUUID()}`;
    const actorPersonId = await ctx.db.insert("people", {
      authUserId: actorAuthUserId,
      googleSubject: `google-${actorAuthUserId}`,
      verifiedEmail: `batch-actor-${crypto.randomUUID()}@example.test`,
      displayName: "Access owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Permission batch fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
      startsAt: now - 60_000,
      endsAt: now + 60 * 60 * 1_000,
      version: 1,
      createdByPersonId: actorPersonId,
      createdAt: now,
      updatedAt: now,
    });
    const actorSubjectId = await insertEventSubject(
      ctx,
      eventId,
      actorPersonId,
      "batch-actor",
      now,
    );
    const target = await insertPersonAndSubject(ctx, eventId, "batch-target", now);
    const other = await insertPersonAndSubject(ctx, eventId, "batch-other", now);
    if (unrestrictedAuthority) {
      for (const permissionKey of [
        "access.permissions.grant_any",
        "access.permissions.revoke_any",
      ] as const) {
        await insertPermissionGrant(ctx, {
          eventId,
          personId: actorPersonId,
          eventAccessSubjectId: actorSubjectId,
          permissionKey,
          scopeType: "event",
          sourceType: "production_seed",
          sourceId: `batch-authority:${permissionKey}`,
          grantedByPersonId: actorPersonId,
          reason: "Permission batch authority fixture",
        });
      }
    }
    return {
      eventId,
      eventSlug,
      actorAuthUserId,
      actorAuthSessionId,
      actorPersonId,
      actorSubjectId,
      targetPersonId: target.personId,
      targetSubjectId: target.subjectId,
      otherPersonId: other.personId,
      otherSubjectId: other.subjectId,
    };
  });
}

type SeedCtx = Parameters<Parameters<BackendTest["run"]>[0]>[0];

async function insertPersonAndSubject(
  ctx: SeedCtx,
  eventId: Id<"events">,
  key: string,
  now: number,
) {
  const personId = await ctx.db.insert("people", {
    authUserId: `${key}-${crypto.randomUUID()}`,
    googleSubject: `google-${key}-${crypto.randomUUID()}`,
    verifiedEmail: `${key}-${crypto.randomUUID()}@example.test`,
    displayName: key,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const subjectId = await insertEventSubject(ctx, eventId, personId, key, now);
  return { personId, subjectId };
}

async function insertEventSubject(
  ctx: SeedCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  key: string,
  now: number,
) {
  return ctx.db.insert("eventAccessSubjects", {
    eventId,
    personId,
    emailNormalized: `${key}-${crypto.randomUUID()}@example.test`,
    displayName: key,
    status: "active",
    linkedBy: "access_invitation",
    accessVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
}

async function createAuthUser(backend: BackendTest, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Access owner",
        email: `batch-auth-${crypto.randomUUID()}@example.test`,
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
        expiresAt: now + 60 * 60 * 1_000,
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
