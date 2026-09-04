import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

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
});

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
