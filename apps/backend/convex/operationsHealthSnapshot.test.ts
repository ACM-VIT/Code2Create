import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test } from "vitest";

import { api, components, internal } from "./_generated/api";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

const savedEnvironment = {
  AUTH_SITE_URL: process.env.AUTH_SITE_URL,
  PARTICIPANT_SITE_URL: process.env.PARTICIPANT_SITE_URL,
  OPERATIONS_SITE_URL: process.env.OPERATIONS_SITE_URL,
};

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("operations-health materialization", () => {
  test("discovers no more than the deployment's one event", async () => {
    const backend = convexTest(schema, modules);
    expect(await backend.query(internal.operationsHealth.refreshTarget, {})).toBeNull();
    const firstEventId = await backend.run((ctx) => insertEvent(ctx, "first-event", 1));
    expect(await backend.query(internal.operationsHealth.refreshTarget, {})).toEqual({
      eventId: firstEventId,
    });
    await backend.run((ctx) => insertEvent(ctx, "second-event", 1));
    await expect(
      backend.query(internal.operationsHealth.refreshTarget, {}),
    ).rejects.toThrow("exactly one event");
  });

  test("upserts one row and makes exact or stale retries no-ops", async () => {
    const backend = convexTest(schema, modules);
    const eventId = await backend.run((ctx) => insertEvent(ctx, "health-upsert", 3));
    const first = healthySnapshot("health-upsert", 1_000);

    expect(await backend.mutation(internal.operationsHealth.upsertSnapshot, {
      eventId,
      eventVersion: 3,
      snapshot: first,
    })).toBe("created");
    expect(await backend.mutation(internal.operationsHealth.upsertSnapshot, {
      eventId,
      eventVersion: 3,
      snapshot: first,
    })).toBe("unchanged");
    expect(await backend.mutation(internal.operationsHealth.upsertSnapshot, {
      eventId,
      eventVersion: 2,
      snapshot: healthySnapshot("health-upsert", 1_002),
    })).toBe("stale");
    await backend.run((ctx) => ctx.db.patch(eventId, { version: 4 }));
    expect(await backend.mutation(internal.operationsHealth.upsertSnapshot, {
      eventId,
      eventVersion: 4,
      snapshot: healthySnapshot("health-upsert", 1_001),
    })).toBe("updated");

    const rows = await backend.run((ctx) => ctx.db
      .query("operationsHealthSnapshots")
      .withIndex("by_event", (index) => index.eq("eventId", eventId))
      .collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventVersion: 4,
      state: "ready",
      staleAt: 91_001,
      snapshot: { generatedAt: 1_001 },
    });
  });

  test("only the current generation's deadline can mark a snapshot stale", async () => {
    const backend = convexTest(schema, modules);
    const eventId = await backend.run((ctx) => insertEvent(ctx, "health-expiry", 1));
    await backend.mutation(internal.operationsHealth.upsertSnapshot, {
      eventId,
      eventVersion: 1,
      snapshot: healthySnapshot("health-expiry", 1_000),
    });
    await backend.mutation(internal.operationsHealth.upsertSnapshot, {
      eventId,
      eventVersion: 1,
      snapshot: healthySnapshot("health-expiry", 2_000),
    });

    expect(await backend.mutation(internal.operationsHealth.markSnapshotStale, {
      eventId,
      expectedGeneratedAt: 1_000,
    })).toBe(false);
    expect(await backend.mutation(internal.operationsHealth.markSnapshotStale, {
      eventId,
      expectedGeneratedAt: 2_000,
    })).toBe(true);
    expect(await backend.query(internal.operationsHealth.materializedForEvent, {
      eventId,
      now: 2_001,
    })).toEqual({ state: "stale", lastGeneratedAt: 2_000 });
  });

  test("the scheduled action computes once and retains one snapshot row", async () => {
    const backend = convexTest(schema, modules);
    const eventId = await backend.run((ctx) => insertEvent(ctx, "health-refresh", 1));

    expect(await backend.action(internal.operationsHealth.refresh, {})).toBe("created");
    const second = await backend.action(internal.operationsHealth.refresh, {});
    expect(["unchanged", "updated"]).toContain(second);
    const rows = await backend.run((ctx) => ctx.db
      .query("operationsHealthSnapshots")
      .withIndex("by_event", (index) => index.eq("eventId", eventId))
      .collect());
    expect(rows).toHaveLength(1);
  });

  test("surfaces stalled and recently unavailable novelty previews", async () => {
    const backend = convexTest(schema, modules);
    const now = Date.now();
    const eventId = await backend.run((ctx) => insertEvent(ctx, "health-novelty", 1));
    const personId = await backend.run(async (ctx) => {
      const id = await ctx.db.insert("people", {
        authUserId: `health-novelty-${crypto.randomUUID()}`,
        googleSubject: `health-novelty-${crypto.randomUUID()}`,
        verifiedEmail: `health-novelty-${crypto.randomUUID()}@example.test`,
        displayName: "Novelty operator",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId: id,
        emailNormalized: `health-novelty-${crypto.randomUUID()}@example.test`,
        displayName: "Novelty operator",
        status: "active",
        linkedBy: "participant_provisioning",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      const membershipId = await ctx.db.insert("eventMemberships", {
        eventId,
        personId: id,
        eventAccessSubjectId: subjectId,
        participantClass: "external_participant",
        eligibilityStatus: "eligible",
        onboardingStatus: "project_required",
        acceptedParticipantPolicyVersionIds: [],
        createdAt: now,
        updatedAt: now,
      });
      const teamId = await ctx.db.insert("teams", {
        eventId,
        name: "Health novelty team",
        publicCode: "HLTHNV",
        leadMembershipId: membershipId,
        status: "forming",
        activeMemberCount: 1,
        activeVitMemberCount: 0,
        activeExternalMemberCount: 1,
        membershipLocked: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const corpusVersionId = await ctx.db.insert("noveltyCorpusVersions", {
        eventId,
        version: 1,
        revision: 1,
        status: "published",
        importState: "ready",
        label: "Health fixture",
        minimumIdeaLength: 80,
        debounceMs: 15_000,
        maximumRequestsPerMinute: 6,
        distinctSimilarityBoundary: 0.45,
        commonSimilarityBoundary: 0.72,
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1_536,
        entryCount: 1,
        createdByPersonId: id,
        lastEditedByPersonId: id,
        createdAt: now,
        updatedAt: now,
        publishedAt: now,
      });
      const baseRequest = {
        eventId,
        teamId,
        personId: id,
        corpusVersionId,
        inputFingerprint: "health-fixture-fingerprint",
        inputCharacterCount: 120,
      };
      await ctx.db.insert("noveltyPreviewRequests", {
        ...baseRequest,
        clientRequestId: "health-stalled-preview",
        state: "running",
        requestedAt: now - 21_000,
      });
      await ctx.db.insert("noveltyPreviewRequests", {
        ...baseRequest,
        clientRequestId: "health-unavailable-preview",
        state: "unavailable",
        failureCategory: "provider_rate_limited",
        requestedAt: now - 1_000,
        completedAt: now - 900,
      });
      return id;
    });
    expect(personId).toBeTruthy();

    const { snapshot } = await backend.query(internal.operationsHealth.computeSnapshot, {
      eventId,
    });
    expect(snapshot.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "novelty_preview_stalls", count: 1 }),
      expect.objectContaining({ key: "recent_novelty_unavailable", count: 1 }),
    ]));
  });

  test("the public read exposes missing and stale states and rejects the removed refresh bucket", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedAuthorizedReader(backend);
    const reader = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });

    expect(await reader.query(api.operationsHealth.overview, {
      eventSlug: fixture.eventSlug,
    })).toEqual({ state: "missing" });
    await expect(reader.mutation(api.operationsIntelligence.request, {
      eventSlug: fixture.eventSlug,
      clientOperationId: "missing-health-request",
    })).rejects.toThrow("first operations-health check");

    const staleGeneratedAt = Date.now() - 91_000;
    await backend.mutation(internal.operationsHealth.upsertSnapshot, {
      eventId: fixture.eventId,
      eventVersion: 1,
      snapshot: healthySnapshot(fixture.eventSlug, staleGeneratedAt),
    });
    expect(await reader.query(api.operationsHealth.overview, {
      eventSlug: fixture.eventSlug,
    })).toEqual({ state: "stale", lastGeneratedAt: staleGeneratedAt });
    await expect(reader.mutation(api.operationsIntelligence.request, {
      eventSlug: fixture.eventSlug,
      clientOperationId: "stale-health-request",
    })).rejects.toThrow("checks are delayed");

    const obsoleteArgs = { eventSlug: fixture.eventSlug, refreshBucket: 1 };
    await expect(
      reader.query(api.operationsHealth.overview, obsoleteArgs),
    ).rejects.toThrow();
  });
});

function healthySnapshot(eventSlug: string, generatedAt: number) {
  return {
    generatedAt,
    event: {
      slug: eventSlug,
      name: "Health fixture",
      timezone: "Asia/Kolkata",
      status: "live" as const,
    },
    summary: {
      status: "healthy" as const,
      signalCount: 0,
      criticalSignalCount: 0,
      attentionSignalCount: 0,
      watchSignalCount: 0,
    },
    signals: [],
  };
}

function insertEvent(
  ctx: Parameters<Parameters<BackendTest["run"]>[0]>[0],
  slug: string,
  version: number,
) {
  const now = Date.now();
  return ctx.db.insert("events", {
    slug,
    name: "Health fixture",
    timezone: "Asia/Kolkata",
    status: "live",
    vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
    version,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedAuthorizedReader(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `health-reader-${crypto.randomUUID()}`;
  const authUserId = await createAuthUser(backend, now);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  const eventId = await backend.run(async (ctx) => {
    const createdEventId = await insertEvent(ctx, eventSlug, 1);
    const email = `health-reader-${crypto.randomUUID()}@example.test`;
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: `health-reader-${crypto.randomUUID()}`,
      verifiedEmail: email,
      displayName: "Health reader",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId: createdEventId,
      personId,
      emailNormalized: email,
      displayName: "Health reader",
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await insertPermissionGrant(ctx, {
      eventId: createdEventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "operations.health.read",
      scopeType: "event",
      sourceType: "manual",
      sourceId: `${eventSlug}:health`,
      grantedByPersonId: personId,
      reason: "Health snapshot test",
    });
    await insertPermissionGrant(ctx, {
      eventId: createdEventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "operations.intelligence.generate",
      scopeType: "event",
      sourceType: "manual",
      sourceId: `${eventSlug}:intelligence`,
      grantedByPersonId: personId,
      reason: "Health snapshot test",
    });
    return createdEventId;
  });
  return { eventId, eventSlug, authUserId, authSessionId };
}

async function createAuthUser(backend: BackendTest, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Health reader",
        email: `health-reader-${crypto.randomUUID()}@example.test`,
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
