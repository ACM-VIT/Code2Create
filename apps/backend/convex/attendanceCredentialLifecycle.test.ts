import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import {
  completeVitBarcodeReplacement,
  expirePendingAttendanceCredential,
  suspendActiveVitBarcode,
} from "./lib/attendanceCredentialLifecycle.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("attendance credential lifecycle", () => {
  test("a verified replacement atomically retires the old VIT ID binding", async () => {
    const now = Date.UTC(2027, 7, 8, 10, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedCredentialFixture(backend, now);

    const result = await backend.run((ctx) =>
      completeVitBarcodeReplacement(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.membershipId,
        priorCredentialId: fixture.priorCredentialId,
        expectedPriorCredentialVersion: 2,
        replacementCredentialId: fixture.replacementCredentialId,
        lookupHash: "replacement-lookup",
        symbology: "code128",
        actorPersonId: fixture.operatorPersonId,
        reason: "Printed VIT ID was replaced",
        now,
      }),
    );

    expect(result).toEqual({
      priorCredentialState: "active",
      priorCredentialVersion: 3,
      replacementCredentialVersion: 2,
    });
    expect(
      await backend.run((ctx) =>
        expirePendingAttendanceCredential(ctx, {
          credentialId: fixture.replacementCredentialId,
          expectedVersion: 1,
          now: now + 6 * 60_000,
        }),
      ),
    ).toBe(false);
    const state = await backend.run(async (ctx) => ({
      prior: await ctx.db.get(fixture.priorCredentialId),
      replacement: await ctx.db.get(fixture.replacementCredentialId),
    }));
    expect(state.prior).toMatchObject({
      state: "replaced",
      version: 3,
      replacedByCredentialId: fixture.replacementCredentialId,
      revokedByPersonId: fixture.operatorPersonId,
      revokedAt: now,
      revokeReason: "Printed VIT ID was replaced",
    });
    expect(state.replacement).toMatchObject({
      state: "active",
      version: 2,
      supersedesCredentialId: fixture.priorCredentialId,
      verifiedAt: now,
    });
    expect(state.replacement?.pendingExpiresAt).toBeUndefined();
  });

  test("an active duplicate blocks replacement without changing either credential", async () => {
    const now = Date.UTC(2027, 7, 8, 11, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedCredentialFixture(backend, now);
    const duplicateCredentialId = await backend.run(async (ctx) => {
      const second = await seedParticipant(ctx, fixture.eventId, now, "duplicate");
      return ctx.db.insert("attendanceCredentials", {
        eventId: fixture.eventId,
        membershipId: second.membershipId,
        kind: "vit_id_barcode",
        lookupHash: "replacement-lookup",
        barcodeSymbology: "code128",
        normalizationVersion: "trim-v1",
        version: 2,
        state: "active",
        enrolledByPersonId: fixture.operatorPersonId,
        enrolledAt: now - 20_000,
        verifiedAt: now - 19_000,
      });
    });

    await expect(
      backend.run((ctx) =>
        completeVitBarcodeReplacement(ctx, {
          eventId: fixture.eventId,
          membershipId: fixture.membershipId,
          priorCredentialId: fixture.priorCredentialId,
          expectedPriorCredentialVersion: 2,
          replacementCredentialId: fixture.replacementCredentialId,
          lookupHash: "replacement-lookup",
          symbology: "code128",
          actorPersonId: fixture.operatorPersonId,
          reason: "Printed VIT ID was replaced",
          now,
        }),
      ),
    ).rejects.toThrow("already bound")
    const state = await backend.run(async (ctx) => ({
      prior: await ctx.db.get(fixture.priorCredentialId),
      replacement: await ctx.db.get(fixture.replacementCredentialId),
      duplicate: await ctx.db.get(duplicateCredentialId),
    }));
    expect(state.prior).toMatchObject({ state: "active", version: 2 });
    expect(state.replacement).toMatchObject({ state: "pending_verification", version: 1 });
    expect(state.duplicate).toMatchObject({ state: "active", version: 2 });
  });

  test("an abandoned verification expires once and can never become active", async () => {
    const now = Date.UTC(2027, 7, 8, 12, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedCredentialFixture(backend, now);

    expect(
      await backend.run((ctx) =>
        expirePendingAttendanceCredential(ctx, {
          credentialId: fixture.replacementCredentialId,
          expectedVersion: 1,
          now: now + 5 * 60_000,
        }),
      ),
    ).toBe(true);
    expect(
      await backend.run((ctx) =>
        expirePendingAttendanceCredential(ctx, {
          credentialId: fixture.replacementCredentialId,
          expectedVersion: 1,
          now: now + 6 * 60_000,
        }),
      ),
    ).toBe(false);
    const state = await backend.run(async (ctx) => ({
      prior: await ctx.db.get(fixture.priorCredentialId),
      replacement: await ctx.db.get(fixture.replacementCredentialId),
    }));
    expect(state.prior).toMatchObject({ state: "active", version: 2 });
    expect(state.replacement).toMatchObject({
      state: "revoked",
      version: 2,
      revokedAt: now + 5 * 60_000,
      revokeReason: "Barcode verification was not completed in time",
    });
  });

  test("suspension atomically disables the VIT ID and cancels its pending replacement", async () => {
    const now = Date.UTC(2027, 7, 8, 13, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedCredentialFixture(backend, now);

    const result = await backend.run((ctx) =>
      suspendActiveVitBarcode(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.membershipId,
        credentialId: fixture.priorCredentialId,
        expectedCredentialVersion: 2,
        actorPersonId: fixture.operatorPersonId,
        reason: "Participant reported the VIT ID missing",
        now,
      }),
    );

    expect(result).toEqual({
      credentialVersion: 3,
      cancelledPendingCredentialIds: [fixture.replacementCredentialId],
    });
    expect(
      await backend.run((ctx) =>
        expirePendingAttendanceCredential(ctx, {
          credentialId: fixture.replacementCredentialId,
          expectedVersion: 1,
          now: now + 6 * 60_000,
        }),
      ),
    ).toBe(false);
    await expect(
      backend.run((ctx) =>
        suspendActiveVitBarcode(ctx, {
          eventId: fixture.eventId,
          membershipId: fixture.membershipId,
          credentialId: fixture.priorCredentialId,
          expectedCredentialVersion: 2,
          actorPersonId: fixture.operatorPersonId,
          reason: "Participant reported the VIT ID missing",
          now: now + 1,
        }),
      ),
    ).rejects.toThrow("changed");
    const state = await backend.run(async (ctx) => ({
      prior: await ctx.db.get(fixture.priorCredentialId),
      replacement: await ctx.db.get(fixture.replacementCredentialId),
    }));
    expect(state.prior).toMatchObject({
      state: "suspended",
      version: 3,
      revokedByPersonId: fixture.operatorPersonId,
      revokedAt: now,
      revokeReason: "Participant reported the VIT ID missing",
    });
    expect(state.replacement).toMatchObject({
      state: "revoked",
      version: 2,
      revokedByPersonId: fixture.operatorPersonId,
      revokedAt: now,
      revokeReason: "Participant reported the VIT ID missing",
    });
    expect(state.replacement?.pendingExpiresAt).toBeUndefined();
  });

  test("a suspended VIT ID can only recover through an atomic replacement", async () => {
    const now = Date.UTC(2027, 7, 8, 14, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedCredentialFixture(backend, now);
    await backend.run((ctx) =>
      ctx.db.patch(fixture.priorCredentialId, {
        state: "suspended",
        revokedByPersonId: fixture.operatorPersonId,
        revokedAt: now - 1_000,
        revokeReason: "Original card was reported missing",
      }),
    );

    const result = await backend.run((ctx) =>
      completeVitBarcodeReplacement(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.membershipId,
        priorCredentialId: fixture.priorCredentialId,
        expectedPriorCredentialVersion: 2,
        replacementCredentialId: fixture.replacementCredentialId,
        lookupHash: "replacement-lookup",
        symbology: "code128",
        actorPersonId: fixture.operatorPersonId,
        reason: "Printed VIT ID was replaced",
        now,
      }),
    );

    expect(result).toEqual({
      priorCredentialState: "suspended",
      priorCredentialVersion: 3,
      replacementCredentialVersion: 2,
    });
    const state = await backend.run(async (ctx) => ({
      prior: await ctx.db.get(fixture.priorCredentialId),
      replacement: await ctx.db.get(fixture.replacementCredentialId),
    }));
    expect(state.prior).toMatchObject({
      state: "replaced",
      version: 3,
      replacedByCredentialId: fixture.replacementCredentialId,
    });
    expect(state.replacement).toMatchObject({ state: "active", version: 2 });
  });
});

async function seedCredentialFixture(backend: BackendTest, now: number) {
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: `attendance-credential-${now}`,
      name: "Attendance credential fixture",
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
    const participant = await seedParticipant(ctx, eventId, now, "primary");
    const operatorPersonId = await ctx.db.insert("people", {
      authUserId: `credential-operator-${now}`,
      googleSubject: `credential-operator-subject-${now}`,
      verifiedEmail: `credential-operator-${now}@example.test`,
      displayName: "Credential operator",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const priorCredentialId = await ctx.db.insert("attendanceCredentials", {
      eventId,
      membershipId: participant.membershipId,
      kind: "vit_id_barcode",
      lookupHash: "prior-lookup",
      barcodeSymbology: "code128",
      normalizationVersion: "trim-v1",
      version: 2,
      state: "active",
      enrolledByPersonId: operatorPersonId,
      enrolledAt: now - 30_000,
      verifiedAt: now - 29_000,
    });
    const replacementCredentialId = await ctx.db.insert("attendanceCredentials", {
      eventId,
      membershipId: participant.membershipId,
      kind: "vit_id_barcode",
      lookupHash: "replacement-lookup",
      barcodeSymbology: "code128",
      normalizationVersion: "trim-v1",
      version: 1,
      state: "pending_verification",
      supersedesCredentialId: priorCredentialId,
      replacementReason: "Printed VIT ID was replaced",
      pendingExpiresAt: now + 5 * 60_000,
      enrolledByPersonId: operatorPersonId,
      enrolledAt: now,
    });
    return {
      eventId,
      membershipId: participant.membershipId,
      operatorPersonId,
      priorCredentialId,
      replacementCredentialId,
    } satisfies {
      eventId: Id<"events">;
      membershipId: Id<"eventMemberships">;
      operatorPersonId: Id<"people">;
      priorCredentialId: Id<"attendanceCredentials">;
      replacementCredentialId: Id<"attendanceCredentials">;
    };
  });
}

async function seedParticipant(
  ctx: Parameters<Parameters<BackendTest["run"]>[0]>[0],
  eventId: Id<"events">,
  now: number,
  suffix: string,
) {
  const personId = await ctx.db.insert("people", {
    authUserId: `credential-${suffix}-${now}`,
    googleSubject: `credential-${suffix}-subject-${now}`,
    verifiedEmail: `credential-${suffix}-${now}@example.test`,
    displayName: `Credential ${suffix}`,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const subjectId = await ctx.db.insert("eventAccessSubjects", {
    eventId,
    personId,
    emailNormalized: `credential-${suffix}-${now}@example.test`,
    displayName: `Credential ${suffix}`,
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
    participantClass: "vit_student",
    eligibilityStatus: "eligible",
    onboardingStatus: "accepted",
    acceptedParticipantPolicyVersionIds: [],
    createdAt: now,
    updatedAt: now,
  });
  return { personId, subjectId, membershipId };
}
