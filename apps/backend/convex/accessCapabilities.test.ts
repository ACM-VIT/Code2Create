import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("surface capability projections", () => {
  test("participant access does not read the operations permission matrix", async () => {
    const backend = convexTest({
      schema,
      modules,
      transactionLimits: { documentsRead: 12 },
    });
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const now = Date.now();
    const identity = await createIdentity(backend, now);
    const eventSlug = `capabilities-${crypto.randomUUID()}`;
    await backend.run(async (ctx) => {
      const personId = await ctx.db.insert("people", {
        authUserId: identity.authUserId,
        googleSubject: `google:${identity.authUserId}`,
        verifiedEmail: "capabilities@example.test",
        displayName: "Capability participant",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const eventId = await ctx.db.insert("events", {
        slug: eventSlug,
        name: "Capability fixture",
        timezone: "Asia/Kolkata",
        status: "live",
        vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
        startsAt: now - 60_000,
        endsAt: now + 60_000,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId,
        emailNormalized: "capabilities@example.test",
        displayName: "Capability participant",
        status: "active",
        linkedBy: "participant_provisioning",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      const permissionKeys = [
        "support.case.read",
        "support.case.create",
        "application.read",
        "application.review.read",
        "attendance.station.read",
        "access.roster.read",
        "project.checkpoint.read",
        "round.read",
        "score.completeness.read",
        "synesthesia.catalog.read",
        "synesthesia.window.read",
        "rehearsal.read",
        "operations.intelligence.read",
        "emergency_pack.read",
        "operations.health.read",
        "operations.attention.manage",
        "event.lifecycle.read",
        "configuration.read",
        "access.permissions.read",
        "integration.read",
      ] as const;
      for (const [index, permissionKey] of permissionKeys.entries()) {
        await ctx.db.insert("permissionGrants", {
          eventId,
          personId,
          eventAccessSubjectId: subjectId,
          permissionKey,
          scopeType: "event",
          validFrom: now - 1_000,
          status: "active",
          sourceType: "manual",
          sourceId: `capability-${index}`,
          reason: "Surface capability fixture",
          createdAt: now,
          activatedAt: now,
        });
      }
    });

    const participant = backend.withIdentity({
      subject: identity.authUserId,
      sessionId: identity.authSessionId,
    });
    await expect(
      participant.query(api.access.participantCapabilities, { eventSlug }),
    ).resolves.toEqual({
      profileRead: false,
      profileWrite: false,
      teamJoin: false,
      hasTeamMembership: false,
      teamRead: false,
      integrations: false,
      notifications: false,
      attendance: false,
      projectCheckpoints: false,
      reviewQueue: false,
      scoreFeedback: false,
      supportRead: true,
      supportCreate: true,
    });
  });

  test("does not advertise broader surfaces from exact reads or action-only grants", async () => {
    const backend = convexTest({ schema, modules });
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const now = Date.now();
    const identity = await createIdentity(backend, now);
    const eventSlug = `person-reader-${crypto.randomUUID()}`;
    const fixture = await backend.run(async (ctx) => {
      const personId = await ctx.db.insert("people", {
        authUserId: identity.authUserId,
        googleSubject: `google:${identity.authUserId}`,
        verifiedEmail: "person-reader@example.test",
        displayName: "Exact person reader",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const eventId = await ctx.db.insert("events", {
        slug: eventSlug,
        name: "Exact person reader fixture",
        timezone: "Asia/Kolkata",
        status: "live",
        vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
        startsAt: now - 60_000,
        endsAt: now + 60_000,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId,
        emailNormalized: "person-reader@example.test",
        displayName: "Exact person reader",
        status: "active",
        linkedBy: "access_invitation",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("permissionGrants", {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey: "access.permissions.read",
        scopeType: "person",
        scopeId: personId,
        validFrom: now - 1_000,
        status: "active",
        sourceType: "manual",
        sourceId: "exact-person-reader",
        reason: "Exact-person capability fixture",
        createdAt: now,
        activatedAt: now,
      });
      await ctx.db.insert("permissionGrants", {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey: "support.case.manage",
        scopeType: "event",
        validFrom: now - 1_000,
        status: "active",
        sourceType: "manual",
        sourceId: "manage-support-without-read",
        reason: "Action-only capability fixture",
        createdAt: now,
        activatedAt: now,
      });
      const windowId = await ctx.db.insert("synesthesiaWindows", {
        eventId,
        name: "Assigned music queue",
        kind: "working_session",
        startsAt: now - 60_000,
        endsAt: now + 60_000,
        status: "published",
        requestsOpen: true,
        votingOpen: true,
        playbackPaused: false,
        catalogSourceLabel: "Capability fixture catalog",
        autoApproveRequests: false,
        maxRequestsPerParticipant: 3,
        maxVotesPerParticipant: 8,
        maxRequestsTotal: 200,
        maxTrackDurationSeconds: 480,
        allowExplicit: false,
        allowedEnergyTags: ["focused"],
        version: 1,
        createdByPersonId: personId,
        updatedByPersonId: personId,
        createdAt: now,
        updatedAt: now,
        publishedByPersonId: personId,
        publishedAt: now,
      });
      await ctx.db.insert("permissionGrants", {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey: "synesthesia.queue.read",
        scopeType: "synesthesia_window",
        scopeId: windowId,
        validFrom: now - 1_000,
        status: "active",
        sourceType: "manual",
        sourceId: "read-music-queue",
        reason: "Queue-reader capability fixture",
        createdAt: now,
        activatedAt: now,
      });
      return { personId, windowId };
    });

    const operator = backend.withIdentity({
      subject: identity.authUserId,
      sessionId: identity.authSessionId,
    });
    const capabilities = await operator.query(api.access.operationsCapabilities, { eventSlug });
    expect(capabilities?.accessPeople).toBe(true);
    expect(capabilities?.accessDirectory).toBe(false);
    expect(capabilities?.support).toBe(false);
    expect(capabilities?.synesthesia).toBe(true);
    await expect(
      operator.query(api.synesthesiaConfiguration.overview, { eventSlug }),
    ).resolves.toMatchObject({
      windows: [{ id: fixture.windowId, canReadQueue: true, canManage: false }],
    });
    await expect(
      operator.query(api.access.findByEmail, {
        eventSlug,
        email: "person-reader@example.test",
      }),
    ).resolves.toMatchObject({ personId: fixture.personId });
    await expect(
      operator.query(api.access.detail, {
        eventSlug,
        personId: fixture.personId,
      }),
    ).resolves.not.toBeNull();
  });
});

async function createIdentity(backend: BackendTest, now: number) {
  const user: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Capability participant",
        email: "capabilities@example.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const authUserId = documentId(user, "Better Auth user");
  const session: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 60 * 60_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        userId: authUserId,
      },
    },
  });
  return { authUserId, authSessionId: documentId(session, "Better Auth session") };
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
