import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import {
  completeExternalBadgeIssue,
  completeExternalBadgeReplacement,
  expirePendingAttendanceCredential,
  revokeActiveExternalBadge,
} from "./lib/attendanceCredentialLifecycle.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("external attendance badge lifecycle", () => {
  test("a matching second scan activates an issue and expiry cannot undo it", async () => {
    const now = Date.UTC(2027, 7, 8, 13, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedBadgeFixture(backend, now, false);

    await backend.run((ctx) =>
      completeExternalBadgeIssue(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.membershipId,
        credentialId: fixture.pendingCredentialId,
        lookupHash: "new-badge-lookup",
        badgeReference: "C2C-NEW1-BADG",
        now,
      }),
    );
    expect(
      await backend.run((ctx) =>
        expirePendingAttendanceCredential(ctx, {
          credentialId: fixture.pendingCredentialId,
          expectedVersion: 1,
          now: now + 6 * 60_000,
        }),
      ),
    ).toBe(false);
    expect(await backend.run((ctx) => ctx.db.get(fixture.pendingCredentialId))).toMatchObject({
      state: "active",
      version: 2,
      verifiedAt: now,
    });
  });

  test("replacement retires the old badge only when the new badge verifies", async () => {
    const now = Date.UTC(2027, 7, 8, 14, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedBadgeFixture(backend, now, true);
    const activeCredentialId = fixture.activeCredentialId;
    if (!activeCredentialId) throw new Error("Replacement fixture is incomplete.");

    const versions = await backend.run((ctx) =>
      completeExternalBadgeReplacement(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.membershipId,
        priorCredentialId: activeCredentialId,
        expectedPriorCredentialVersion: 3,
        replacementCredentialId: fixture.pendingCredentialId,
        lookupHash: "new-badge-lookup",
        badgeReference: "C2C-NEW1-BADG",
        actorPersonId: fixture.operatorPersonId,
        reason: "Participant lost the original badge",
        now,
      }),
    );

    expect(versions).toEqual({
      priorCredentialVersion: 4,
      replacementCredentialVersion: 2,
    });
    const state = await backend.run(async (ctx) => ({
      prior: await ctx.db.get(activeCredentialId),
      replacement: await ctx.db.get(fixture.pendingCredentialId),
    }));
    expect(state.prior).toMatchObject({
      state: "replaced",
      version: 4,
      replacedByCredentialId: fixture.pendingCredentialId,
    });
    expect(state.replacement).toMatchObject({ state: "active", version: 2, verifiedAt: now });
  });

  test("a reused lookup or printed reference cannot activate", async () => {
    const now = Date.UTC(2027, 7, 8, 15, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedBadgeFixture(backend, now, false);
    await backend.run(async (ctx) => {
      const other = await seedExternalParticipant(ctx, fixture.eventId, now, "collision");
      await ctx.db.insert("attendanceCredentials", {
        eventId: fixture.eventId,
        membershipId: other.membershipId,
        kind: "badge_qr",
        lookupHash: "old-collision-lookup",
        badgeReference: "C2C-NEW1-BADG",
        version: 2,
        state: "revoked",
        enrolledByPersonId: fixture.operatorPersonId,
        enrolledAt: now - 60_000,
        revokedAt: now - 30_000,
        revokeReason: "Discarded badge",
      });
    });

    await expect(
      backend.run((ctx) =>
        completeExternalBadgeIssue(ctx, {
          eventId: fixture.eventId,
          membershipId: fixture.membershipId,
          credentialId: fixture.pendingCredentialId,
          lookupHash: "new-badge-lookup",
          badgeReference: "C2C-NEW1-BADG",
          now,
        }),
      ),
    ).rejects.toThrow("already used");
    expect(await backend.run((ctx) => ctx.db.get(fixture.pendingCredentialId))).toMatchObject({
      state: "pending_verification",
      version: 1,
    });
  });

  test("revocation also cancels an unfinished replacement and is version safe", async () => {
    const now = Date.UTC(2027, 7, 8, 16, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedBadgeFixture(backend, now, true);
    const activeCredentialId = fixture.activeCredentialId;
    if (!activeCredentialId) throw new Error("Revocation fixture is incomplete.");

    const result = await backend.run((ctx) =>
      revokeActiveExternalBadge(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.membershipId,
        credentialId: activeCredentialId,
        expectedCredentialVersion: 3,
        actorPersonId: fixture.operatorPersonId,
        reason: "Participant reported the badge lost",
        now,
      }),
    );
    expect(result).toEqual({
      credentialVersion: 4,
      cancelledPendingCredentialIds: [fixture.pendingCredentialId],
    });
    const state = await backend.run(async (ctx) => ({
      active: await ctx.db.get(activeCredentialId),
      pending: await ctx.db.get(fixture.pendingCredentialId),
    }));
    expect(state.active).toMatchObject({ state: "revoked", version: 4, revokedAt: now });
    expect(state.pending).toMatchObject({ state: "revoked", version: 2, revokedAt: now });
    await expect(
      backend.run((ctx) =>
        revokeActiveExternalBadge(ctx, {
          eventId: fixture.eventId,
          membershipId: fixture.membershipId,
          credentialId: activeCredentialId,
          expectedCredentialVersion: 3,
          actorPersonId: fixture.operatorPersonId,
          reason: "Participant reported the badge lost",
          now,
        }),
      ),
    ).rejects.toThrow("changed");
  });
});

async function seedBadgeFixture(backend: BackendTest, now: number, replacement: boolean) {
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: `attendance-badge-${now}`,
      name: "Attendance badge fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
      startsAt: now - 60 * 60_000,
      endsAt: now + 60 * 60_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const participant = await seedExternalParticipant(ctx, eventId, now, "primary");
    const operatorPersonId = await ctx.db.insert("people", {
      authUserId: `badge-operator-${now}`,
      googleSubject: `badge-operator-subject-${now}`,
      verifiedEmail: `badge-operator-${now}@example.test`,
      displayName: "Badge operator",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const activeCredentialId: Id<"attendanceCredentials"> | null = replacement
      ? await ctx.db.insert("attendanceCredentials", {
          eventId,
          membershipId: participant.membershipId,
          kind: "badge_qr",
          lookupHash: "active-badge-lookup",
          badgeReference: "C2C-OLD1-BADG",
          version: 3,
          state: "active",
          enrolledByPersonId: operatorPersonId,
          enrolledAt: now - 60_000,
          verifiedAt: now - 59_000,
        })
      : null;
    const pendingCredentialId = await ctx.db.insert("attendanceCredentials", {
      eventId,
      membershipId: participant.membershipId,
      kind: "badge_qr",
      lookupHash: "new-badge-lookup",
      badgeReference: "C2C-NEW1-BADG",
      version: 1,
      state: "pending_verification",
      ...(activeCredentialId !== null
        ? {
            supersedesCredentialId: activeCredentialId,
            replacementReason: "Participant lost the original badge",
          }
        : {}),
      pendingExpiresAt: now + 5 * 60_000,
      enrolledByPersonId: operatorPersonId,
      enrolledAt: now,
    });
    return {
      eventId,
      membershipId: participant.membershipId,
      operatorPersonId,
      activeCredentialId,
      pendingCredentialId,
    } satisfies {
      eventId: Id<"events">;
      membershipId: Id<"eventMemberships">;
      operatorPersonId: Id<"people">;
      activeCredentialId: Id<"attendanceCredentials"> | null;
      pendingCredentialId: Id<"attendanceCredentials">;
    };
  });
}

async function seedExternalParticipant(
  ctx: Parameters<Parameters<BackendTest["run"]>[0]>[0],
  eventId: Id<"events">,
  now: number,
  suffix: string,
) {
  const personId = await ctx.db.insert("people", {
    authUserId: `badge-${suffix}-${now}`,
    googleSubject: `badge-${suffix}-subject-${now}`,
    verifiedEmail: `badge-${suffix}-${now}@example.test`,
    displayName: `Badge ${suffix}`,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const subjectId = await ctx.db.insert("eventAccessSubjects", {
    eventId,
    personId,
    emailNormalized: `badge-${suffix}-${now}@example.test`,
    displayName: `Badge ${suffix}`,
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
    participantClass: "external_participant",
    eligibilityStatus: "eligible",
    onboardingStatus: "accepted",
    acceptedParticipantPolicyVersionIds: [],
    createdAt: now,
    updatedAt: now,
  });
  return { personId, subjectId, membershipId };
}
