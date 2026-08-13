import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import { insertPermissionGrant } from "./lib/permissions";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("floor mapping summary", () => {
  test("counts only mapped teams in zones the mapper can operate", async () => {
    const backend = seededBackend();
    const fixture = await seedMapper(backend);
    const mapper = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });

    await expect(
      mapper.query(api.floorMapping.summary, { eventSlug: fixture.eventSlug }),
    ).resolves.toEqual({ mappingState: "open", placedTeamCount: 1 });
  });

  test("does not read active locations outside the mapper's zones", async () => {
    const backend = seededBackend({ documentsRead: 40 });
    const fixture = await seedMapper(backend, 100);
    const mapper = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });

    await expect(
      mapper.query(api.floorMapping.summary, { eventSlug: fixture.eventSlug }),
    ).resolves.toEqual({ mappingState: "open", placedTeamCount: 1 });
  });

  test("loads mapper detail only for assigned zones", async () => {
    const backend = seededBackend({ documentsRead: 40 });
    const fixture = await seedMapper(backend, 100);
    const mapper = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });

    const result = await mapper.query(api.floorMapping.available, {
      eventSlug: fixture.eventSlug,
    });
    expect(result?.zones).toHaveLength(1);
    expect(result?.zones[0]).toMatchObject({
      name: "Visible zone",
      teams: [{ teamName: "Team 1" }],
      landmarks: [{ name: "Visible entrance" }],
    });
    expect(result).not.toHaveProperty("hall");
  });
});

function seededBackend(transactionLimits?: { documentsRead: number }) {
  const backend = convexTest({
    schema,
    modules,
    ...(transactionLimits === undefined ? {} : { transactionLimits }),
  });
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

async function seedMapper(backend: BackendTest, hiddenTeamCount = 1) {
  const now = Date.now();
  const eventSlug = `floor-${crypto.randomUUID()}`;
  const email = `floor-${crypto.randomUUID()}@example.test`;
  const authUserId = await createAuthUser(backend, now, email);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  const identity = await backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: crypto.randomUUID(),
      verifiedEmail: email,
      displayName: "Floor mapper",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Floor fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
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
      displayName: "Floor mapper",
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      participantClass: "external_participant",
      eligibilityStatus: "eligible",
      onboardingStatus: "team_required",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const planVersionId = await ctx.db.insert("floorPlanVersions", {
      eventId,
      planNumber: 1,
      name: "Main hall",
      status: "published",
      mappingState: "open",
      checksum: "floor-summary-fixture",
      version: 1,
      createdByPersonId: personId,
      createdAt: now,
      publishedByPersonId: personId,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, { publishedFloorPlanVersionId: planVersionId });
    const visibleZoneId = await ctx.db.insert("floorZones", {
      eventId,
      planVersionId,
      stableKey: "visible",
      name: "Visible zone",
      widthMeters: 10,
      depthMeters: 10,
      displayOrder: 1,
      createdAt: now,
    });
    const hiddenZoneId = await ctx.db.insert("floorZones", {
      eventId,
      planVersionId,
      stableKey: "hidden",
      name: "Hidden zone",
      widthMeters: 10,
      depthMeters: 10,
      displayOrder: 2,
      createdAt: now,
    });
    await ctx.db.insert("floorLandmarks", {
      eventId,
      planVersionId,
      zoneId: visibleZoneId,
      stableKey: "visible_entrance",
      name: "Visible entrance",
      x: 10,
      y: 10,
      displayOrder: 0,
      createdAt: now,
    });
    await ctx.db.insert("floorLandmarks", {
      eventId,
      planVersionId,
      zoneId: hiddenZoneId,
      stableKey: "hidden_entrance",
      name: "Hidden entrance",
      x: 10,
      y: 10,
      displayOrder: 0,
      createdAt: now,
    });
    const zoneIds = [
      visibleZoneId,
      ...Array.from({ length: hiddenTeamCount }, () => hiddenZoneId),
    ];
    for (const [index, zoneId] of zoneIds.entries()) {
      const teamId = await ctx.db.insert("teams", {
        eventId,
        name: `Team ${index + 1}`,
        publicCode: `FLOOR-${index + 1}`,
        leadMembershipId: membershipId,
        status: "confirmed",
        activeMemberCount: 1,
        activeVitMemberCount: 0,
        activeExternalMemberCount: 1,
        membershipLocked: true,
        trackLocked: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("teamFloorLocations", {
        eventId,
        planVersionId,
        teamId,
        zoneId,
        x: 25,
        y: 25,
        area: "north_west",
        state: "active",
        method: "team_qr_scan",
        version: 1,
        mappedByPersonId: personId,
        mappedAt: now,
      });
    }
    await insertPermissionGrant(ctx, {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "floor.location.map",
      scopeType: "floor_zone",
      scopeId: visibleZoneId,
      sourceType: "manual",
      sourceId: `${eventSlug}:visible-zone`,
      grantedByPersonId: personId,
      reason: "Floor summary test",
    });
    return { eventId };
  });
  return { ...identity, eventSlug, authUserId, authSessionId };
}

async function createAuthUser(backend: BackendTest, now: number, email: string) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Floor mapper",
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
