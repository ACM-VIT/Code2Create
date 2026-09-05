import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test } from "vitest";

import { components, internal } from "./_generated/api";
import { insertPermissionGrant } from "./lib/permissions.ts";
import { createStaffedParticipantResolution } from "./lib/staffedParticipantResolution.ts";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;
const originalAuthSiteUrl = process.env.AUTH_SITE_URL;

process.env.AUTH_SITE_URL = "http://localhost:3211";

afterAll(() => {
  if (originalAuthSiteUrl === undefined) delete process.env.AUTH_SITE_URL;
  else process.env.AUTH_SITE_URL = originalAuthSiteUrl;
});

describe("external event-pass lifecycle", () => {
  test("can prepare an accepted external pass before the attendance plan is published", async () => {
    const backend = convexTest(schema, modules);
    const now = Date.UTC(2027, 7, 8, 8, 30, 0);
    const fixture = await seedMembership(backend, now, "external_participant");
    const first = await backend.mutation(
      internal.attendanceSecurity.ensureExternalPassDeliveryKeySet,
      {
        eventSlug: fixture.eventSlug,
        membershipId: fixture.membershipId,
        candidate: {
          encryptedKey: "encrypted-event-key",
          iv: "event-key-iv",
          authTag: "event-key-auth-tag",
          wrappingKeyVersion: "test-v1",
        },
      },
    );
    const repeated = await backend.mutation(
      internal.attendanceSecurity.ensureExternalPassDeliveryKeySet,
      {
        eventSlug: fixture.eventSlug,
        membershipId: fixture.membershipId,
        candidate: {
          encryptedKey: "different-key",
          iv: "different-iv",
          authTag: "different-tag",
          wrappingKeyVersion: "test-v2",
        },
      },
    );

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({ eventId: fixture.eventId, eventSlug: fixture.eventSlug });
  });

  test("keeps one static encrypted pass for an accepted external participant", async () => {
    const backend = convexTest(schema, modules);
    const now = Date.UTC(2027, 7, 8, 9, 0, 0);
    const fixture = await seedMembership(backend, now, "external_participant");
    const firstCandidate = {
      eventId: fixture.eventId,
      membershipId: fixture.membershipId,
      encryptedBearer: "encrypted-bearer-one",
      bearerIv: "abcdefghijklmnop",
      bearerAuthTag: "abcdefghijklmnopqrstuv",
      lookupHash: "a".repeat(64),
    };
    const first = await backend.mutation(
      internal.attendanceExternalPasses.ensureForDelivery,
      firstCandidate,
    );
    const repeated = await backend.mutation(
      internal.attendanceExternalPasses.ensureForDelivery,
      {
        ...firstCandidate,
        encryptedBearer: "encrypted-bearer-two",
        lookupHash: "b".repeat(64),
      },
    );

    expect(repeated).toEqual(first);
    const rows = await backend.run((ctx) => ctx.db.query("attendanceExternalPasses").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      membershipId: fixture.membershipId,
      encryptedBearer: firstCandidate.encryptedBearer,
      lookupHash: firstCandidate.lookupHash,
      state: "active",
      version: 1,
    });
    expect(rows[0]).not.toHaveProperty("bearer");
  });

  test("does not issue an external pass to a VIT participant", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedMembership(backend, Date.UTC(2027, 7, 8, 9, 0, 0), "vit_student");
    await expect(
      backend.mutation(internal.attendanceExternalPasses.ensureForDelivery, {
        eventId: fixture.eventId,
        membershipId: fixture.membershipId,
        encryptedBearer: "encrypted-bearer",
        bearerIv: "abcdefghijklmnop",
        bearerAuthTag: "abcdefghijklmnopqrstuv",
        lookupHash: "a".repeat(64),
      }),
    ).rejects.toThrow("only to accepted external participants");
  });

  test("staff can suspend and atomically rotate an external pass", async () => {
    const backend = seededBackend();
    const fixture = await seedPassManagement(backend);
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const suspendResolutionId = await createResolution(backend, fixture);
    const suspendRequest = {
      eventSlug: fixture.eventSlug,
      stationId: fixture.stationId,
      expectedConfigurationVersion: 1,
      deviceInstallationId: fixture.deviceInstallationId,
      deviceSecretHash: fixture.deviceSecretHash,
      resolutionId: suspendResolutionId,
      membershipId: fixture.membershipId,
      passId: fixture.passId,
      expectedPassVersion: 1,
      visibleIdentityConfirmed: true,
      reason: "Participant reported the emailed pass exposed.",
      clientOperationId: "external-pass-suspend-test",
    };
    const suspended = await operator.mutation(
      internal.attendanceExternalPasses.suspend,
      suspendRequest,
    );
    expect(
      await operator.mutation(internal.attendanceExternalPasses.suspend, suspendRequest),
    ).toEqual(suspended);
    expect(suspended).toEqual({ passId: fixture.passId, state: "suspended", version: 2 });

    const reissueResolutionId = await createResolution(backend, fixture);
    const reissueRequest = {
      ...suspendRequest,
      resolutionId: reissueResolutionId,
      expectedPassVersion: 2,
      encryptedBearer: "replacement-encrypted-bearer",
      bearerIv: "abcdefghijklmnop",
      bearerAuthTag: "abcdefghijklmnopqrstuv",
      lookupHash: "b".repeat(64),
      reason: "Issued a replacement after checking the participant photo ID.",
      clientOperationId: "external-pass-reissue-test",
    };
    const reissued = await operator.mutation(
      internal.attendanceExternalPasses.reissue,
      reissueRequest,
    );
    expect(
      await operator.mutation(internal.attendanceExternalPasses.reissue, reissueRequest),
    ).toEqual(reissued);
    expect(reissued).toEqual({ passId: fixture.passId, state: "active", version: 3 });

    const state = await backend.run(async (ctx) => ({
      pass: await ctx.db.get(fixture.passId),
      audits: await ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
        .collect(),
    }));
    expect(state.pass).toMatchObject({
      encryptedBearer: reissueRequest.encryptedBearer,
      lookupHash: reissueRequest.lookupHash,
      state: "active",
      version: 3,
    });
    expect(state.audits.map((audit) => audit.action)).toEqual([
      "attendance.external_pass_suspended",
      "attendance.external_pass_reissued",
    ]);
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

async function createResolution(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedPassManagement>>,
) {
  return backend.run((ctx) =>
    createStaffedParticipantResolution(ctx, {
      eventId: fixture.eventId,
      membershipId: fixture.membershipId,
      resolutionMethod: "external_pass",
      stationId: fixture.stationId,
      deviceInstallationId: fixture.deviceInstallationId,
      resolvedByPersonId: fixture.operatorPersonId,
      now: Date.now(),
    }),
  );
}

async function seedPassManagement(backend: BackendTest) {
  const now = Date.now();
  const authUserId = await createAuthUser(backend, now);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  const membership = await seedMembership(backend, now, "external_participant");
  const deviceSecretHash = "external-pass-device-secret-hash";
  const station = await backend.run(async (ctx) => {
    const participant = await ctx.db.get(membership.membershipId);
    if (!participant) throw new Error("The external participant fixture is missing.");
    const operatorPersonId = await ctx.db.insert("people", {
      authUserId,
      verifiedEmail: `external-pass-operator-${now}@example.test`,
      displayName: "External pass operator",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const operatorSubjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId: membership.eventId,
      personId: operatorPersonId,
      emailNormalized: `external-pass-operator-${now}@example.test`,
      displayName: "External pass operator",
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const planVersionId = await ctx.db.insert("attendancePlanVersions", {
      eventId: membership.eventId,
      version: 1,
      name: "External pass plan",
      vitBarcodeSymbologies: ["code128"],
      vitBarcodeNormalizationVersion: "trim-v1",
      offlineQueueMaxScans: 8,
      offlineQueueMaxAgeSeconds: 180,
      status: "published",
      checksum: "external-pass-plan",
      createdByPersonId: operatorPersonId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(membership.eventId, {
      publishedAttendancePlanVersionId: planVersionId,
    });
    const zoneId = await ctx.db.insert("attendanceZones", {
      eventId: membership.eventId,
      planVersionId,
      stableKey: "external_pass_zone",
      name: "External pass zone",
      createdAt: now,
    });
    const deviceInstallationId = await ctx.db.insert("attendanceDeviceInstallations", {
      eventId: membership.eventId,
      installationId: `external-pass-device-${now}`,
      secretHash: deviceSecretHash,
      name: "External pass phone",
      platform: "android",
      status: "active",
      registeredByPersonId: operatorPersonId,
      registeredAt: now,
      lastSeenAt: now,
      pendingReplayCount: 0,
    });
    const stationId = await ctx.db.insert("attendanceStations", {
      eventId: membership.eventId,
      planVersionId,
      zoneId,
      deviceInstallationId,
      stableKey: "external_pass_station",
      name: "External pass station",
      mode: "roving",
      allowedCredentialKinds: ["external_pass"],
      status: "active",
      configurationVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    for (const [index, grant] of [
      {
        permissionKey: "attendance.station.read" as const,
        scopeType: "station" as const,
        scopeId: stationId,
      },
      {
        permissionKey: "attendance.credential.suspend" as const,
        scopeType: "person" as const,
        scopeId: participant.personId,
      },
      {
        permissionKey: "attendance.credential.rebind" as const,
        scopeType: "person" as const,
        scopeId: participant.personId,
      },
    ].entries()) {
      await insertPermissionGrant(ctx, {
        eventId: membership.eventId,
        personId: operatorPersonId,
        eventAccessSubjectId: operatorSubjectId,
        ...grant,
        sourceType: "manual",
        sourceId: `external-pass-management-${index}`,
        grantedByPersonId: operatorPersonId,
        reason: "External pass management fixture",
      });
    }
    return { deviceInstallationId, operatorPersonId, stationId };
  });
  const issued = await backend.mutation(internal.attendanceExternalPasses.ensureForDelivery, {
    eventId: membership.eventId,
    membershipId: membership.membershipId,
    encryptedBearer: "original-encrypted-bearer",
    bearerIv: "abcdefghijklmnop",
    bearerAuthTag: "abcdefghijklmnopqrstuv",
    lookupHash: "a".repeat(64),
  });
  return {
    ...membership,
    ...station,
    authSessionId,
    authUserId,
    deviceSecretHash,
    passId: issued.passId,
  };
}

async function createAuthUser(backend: BackendTest, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "External pass operator",
        email: `external-pass-operator-${crypto.randomUUID()}@example.test`,
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

async function seedMembership(
  backend: BackendTest,
  now: number,
  participantClass: "vit_student" | "external_participant",
) {
  return backend.run(async (ctx) => {
    const eventSlug = `external-pass-${participantClass}-${now}`;
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "External pass fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: now - 1,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: `external-pass-${participantClass}-${now}`,
      verifiedEmail: `${participantClass}-${now}@example.test`,
      displayName: "Pass participant",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `${participantClass}-${now}@example.test`,
      displayName: "Pass participant",
      status: "active",
      linkedBy: "participant_provisioning",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      participantClass,
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    return { eventId, eventSlug, membershipId };
  });
}
