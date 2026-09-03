import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components, internal } from "./_generated/api";
import {
  defaultParticipantPolicy,
  normalizeParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy";
import { phoneVerificationCodeDigest, phoneVerificationLifetimeMs } from "./lib/phoneVerification";
import { insertPermissionGrant } from "./lib/permissions";
import schema from "./schema";

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.PHONE_VERIFICATION_HMAC_SECRET = "A".repeat(43);

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("participant phone verification lifecycle", () => {
  test("keeps the idempotent OTP lifecycle available when the published policy does not require it", async () => {
    const backend = testBackend();
    const fixture = await seedParticipant(backend);
    const participant = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const request = {
      eventSlug: fixture.eventSlug,
      phone: "+91 90000 00000",
      clientOperationId: "phone-request-1",
    } as const;

    const queued = await participant.mutation(api.phoneVerifications.request, request);
    expect(queued).toMatchObject({
      state: "queued",
      maskedPhone: "••••0000",
      attemptsRemaining: 5,
      canVerify: false,
    });
    await expect(participant.mutation(api.phoneVerifications.request, request)).resolves.toEqual(
      queued,
    );
    await backend.run(async (ctx) => {
      expect(await ctx.db.query("participantPhoneVerifications").collect()).toHaveLength(1);
    });

    const code = "123456";
    const expiresAt = Date.now() + phoneVerificationLifetimeMs;
    const codeDigest = phoneVerificationCodeDigest({
      secret: process.env.PHONE_VERIFICATION_HMAC_SECRET!,
      verificationId: queued.verificationId,
      phone: "+919000000000",
      code,
    });
    await backend.mutation(internal.phoneVerifications.prepareDelivery, {
      verificationId: queued.verificationId,
      codeDigest,
      expiresAt,
    });
    await backend.mutation(internal.phoneVerifications.completeDelivery, {
      verificationId: queued.verificationId,
      providerMessageId: "aws-message-1",
    });

    const incorrectRequest = {
      eventSlug: fixture.eventSlug,
      verificationId: queued.verificationId,
      code: "000000",
      clientOperationId: "phone-verify-wrong-1",
    } as const;
    const incorrect = await participant.mutation(api.phoneVerifications.verify, incorrectRequest);
    expect(incorrect).toMatchObject({ outcome: "incorrect", attemptsRemaining: 4 });
    await expect(
      participant.mutation(api.phoneVerifications.verify, incorrectRequest),
    ).resolves.toEqual(incorrect);
    await backend.run(async (ctx) => {
      expect((await ctx.db.get(queued.verificationId))?.attemptCount).toBe(1);
    });

    const verified = await participant.mutation(api.phoneVerifications.verify, {
      eventSlug: fixture.eventSlug,
      verificationId: queued.verificationId,
      code,
      clientOperationId: "phone-verify-correct",
    });
    expect(verified).toMatchObject({
      outcome: "verified",
      verificationId: queued.verificationId,
      maskedPhone: "••••0000",
    });
    await expect(
      participant.query(api.phoneVerifications.status, {
        eventSlug: fixture.eventSlug,
        phone: "+919000000000",
      }),
    ).resolves.toMatchObject({ state: "verified", canVerify: false });

    const profileArgs = {
      eventSlug: fixture.eventSlug,
      participantPolicyVersionId: fixture.policyId,
      fullName: "Test Participant",
      gender: "female" as const,
      yearOfStudy: "second" as const,
      externalUniversity: "Example University",
      externalCollege: "Example College",
      expectedProfileVersion: 0,
    };
    await expect(
      participant.mutation(api.participants.saveProfile, {
        ...profileArgs,
        phone: "+91 80000 00000",
        clientOperationId: "profile-with-verification-disabled",
      }),
    ).resolves.toMatchObject({ profileVersion: 1 });
    await backend.run(async (ctx) => {
      const profile = await ctx.db
        .query("participantProfiles")
        .withIndex("by_membership", (index) => index.eq("membershipId", fixture.membershipId))
        .unique();
      expect(profile).toMatchObject({ phone: "+918000000000" });
      expect(profile?.phoneVerificationId).toBeUndefined();
      expect(profile?.phoneVerifiedAt).toBeUndefined();
    });
  });

  test("enforces the published policy when phone verification is required", async () => {
    const backend = testBackend();
    const fixture = await seedParticipant(backend, true);
    const participant = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const profileArgs = {
      eventSlug: fixture.eventSlug,
      participantPolicyVersionId: fixture.policyId,
      fullName: "Test Participant",
      phone: "+91 90000 00000",
      gender: "female" as const,
      yearOfStudy: "second" as const,
      externalUniversity: "Example University",
      externalCollege: "Example College",
      expectedProfileVersion: 0,
    };
    await expect(
      participant.mutation(api.participants.saveProfile, {
        ...profileArgs,
        clientOperationId: "profile-without-required-verification",
      }),
    ).rejects.toThrow("Verify this phone number");

    const queued = await participant.mutation(api.phoneVerifications.request, {
      eventSlug: fixture.eventSlug,
      phone: profileArgs.phone,
      clientOperationId: "required-phone-request",
    });
    const code = "123456";
    await backend.mutation(internal.phoneVerifications.prepareDelivery, {
      verificationId: queued.verificationId,
      codeDigest: phoneVerificationCodeDigest({
        secret: process.env.PHONE_VERIFICATION_HMAC_SECRET!,
        verificationId: queued.verificationId,
        phone: "+919000000000",
        code,
      }),
      expiresAt: Date.now() + phoneVerificationLifetimeMs,
    });
    await backend.mutation(internal.phoneVerifications.completeDelivery, {
      verificationId: queued.verificationId,
      providerMessageId: "aws-required-message",
    });
    await participant.mutation(api.phoneVerifications.verify, {
      eventSlug: fixture.eventSlug,
      verificationId: queued.verificationId,
      code,
      clientOperationId: "required-phone-verify",
    });

    await expect(
      participant.mutation(api.participants.saveProfile, {
        ...profileArgs,
        phoneVerificationId: queued.verificationId,
        clientOperationId: "profile-with-required-verification",
      }),
    ).resolves.toMatchObject({ profileVersion: 1 });
  });

  test("persists every incorrect attempt and locks the fifth attempt", async () => {
    const backend = testBackend();
    const fixture = await seedParticipant(backend);
    const participant = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const queued = await participant.mutation(api.phoneVerifications.request, {
      eventSlug: fixture.eventSlug,
      phone: "+919000000000",
      clientOperationId: "lockout-phone-request",
    });
    await backend.mutation(internal.phoneVerifications.prepareDelivery, {
      verificationId: queued.verificationId,
      codeDigest: phoneVerificationCodeDigest({
        secret: process.env.PHONE_VERIFICATION_HMAC_SECRET!,
        verificationId: queued.verificationId,
        phone: "+919000000000",
        code: "123456",
      }),
      expiresAt: Date.now() + phoneVerificationLifetimeMs,
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await participant.mutation(api.phoneVerifications.verify, {
        eventSlug: fixture.eventSlug,
        verificationId: queued.verificationId,
        code: "000000",
        clientOperationId: `lockout-wrong-${attempt}`,
      });
      expect(result).toMatchObject({
        outcome: attempt === 5 ? "locked" : "incorrect",
        attemptsRemaining: 5 - attempt,
      });
    }
    await backend.run(async (ctx) => {
      expect(await ctx.db.get(queued.verificationId)).toMatchObject({
        status: "locked",
        attemptCount: 5,
      });
    });
    await expect(
      participant.mutation(api.phoneVerifications.verify, {
        eventSlug: fixture.eventSlug,
        verificationId: queued.verificationId,
        code: "123456",
        clientOperationId: "lockout-after-limit",
      }),
    ).rejects.toThrow("Too many incorrect attempts");
  });
});

function testBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

async function seedParticipant(backend: BackendTest, phoneVerificationEnabled = false) {
  const now = Date.now();
  const eventSlug = "phone-verification-lifecycle";
  const authUserId = await createAuthUser(backend, now);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: "phone-verification-google-subject",
      verifiedEmail: "phone-verification@example.test",
      displayName: "Test Participant",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Phone verification lifecycle fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      externalApplicationsCloseAt: now + 86_400_000,
      applicationsCloseAt: now + 86_400_000,
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const policy = normalizeParticipantPolicy({
      ...defaultParticipantPolicy,
      phoneVerificationEnabled,
    });
    const policyId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...policy,
      checksum: participantPolicyChecksum(policy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, { publishedParticipantPolicyId: policyId });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: "phone-verification@example.test",
      displayName: "Test Participant",
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
      onboardingStatus: "profile_required",
      acceptedParticipantPolicyVersionIds: [policyId],
      createdAt: now,
      updatedAt: now,
    });
    for (const permissionKey of [
      "participant.profile.read",
      "participant.profile.write",
    ] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "self",
        scopeId: membershipId,
        sourceType: "participant_membership",
        sourceId: membershipId,
        reason: "Phone verification lifecycle fixture",
      });
    }
    return { eventSlug, policyId, membershipId, authUserId, authSessionId };
  });
}

async function createAuthUser(backend: BackendTest, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Test Participant",
        email: "phone-verification@example.test",
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
        token: "phone-verification-session-token",
        createdAt: now,
        updatedAt: now,
        userId,
      },
    },
  });
  return documentId(result, "Better Auth session");
}

function documentId(value: unknown, label: string): string {
  if (!value || typeof value !== "object" || !("_id" in value)) {
    throw new Error(`${label} did not return a document ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid document ID.`);
  }
  return id;
}
