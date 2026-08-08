import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import {
  consumePortalQrToken,
  revokeActivePortalQrTokens,
} from "./lib/attendancePortalQrLifecycle.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("attendance portal QR lifecycle", () => {
  test("a new or consumed code leaves no sibling code active", async () => {
    const now = Date.UTC(2027, 7, 8, 15, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedPortalQrFixture(backend, now);

    const revokedIds = await backend.run((ctx) =>
      revokeActivePortalQrTokens(ctx, fixture.membershipId),
    );
    expect(new Set(revokedIds)).toEqual(
      new Set([fixture.firstTokenId, fixture.secondTokenId]),
    );

    const replacementTokenId = await insertToken(backend, fixture, "replacement", now + 1);
    const siblingTokenId = await insertToken(backend, fixture, "sibling", now + 2);
    const result = await backend.run((ctx) =>
      consumePortalQrToken(ctx, {
        tokenId: replacementTokenId,
        membershipId: fixture.membershipId,
        usedAt: now + 3,
        purpose: "staffed_participant_resolution",
      }),
    );
    expect(result).toEqual({ revokedSiblingTokenIds: [siblingTokenId] });

    const state = await backend.run(async (ctx) => ({
      first: await ctx.db.get(fixture.firstTokenId),
      second: await ctx.db.get(fixture.secondTokenId),
      replacement: await ctx.db.get(replacementTokenId),
      sibling: await ctx.db.get(siblingTokenId),
    }));
    expect(state.first).toMatchObject({ state: "revoked" });
    expect(state.second).toMatchObject({ state: "revoked" });
    expect(state.replacement).toMatchObject({ state: "used", usedAt: now + 3 });
    expect(state.replacement?.usedByEventId).toBeUndefined();
    expect(state.sibling).toMatchObject({ state: "revoked" });
  });
});

async function seedPortalQrFixture(backend: BackendTest, now: number) {
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: `portal-qr-${now}`,
      name: "Portal QR fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      startsAt: now - 60_000,
      endsAt: now + 60_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: `portal-qr-${now}`,
      googleSubject: `portal-qr-subject-${now}`,
      verifiedEmail: `portal-qr-${now}@example.test`,
      displayName: "Portal QR participant",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `portal-qr-${now}@example.test`,
      displayName: "Portal QR participant",
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
    const portalCredentialId = await ctx.db.insert("attendancePortalCredentials", {
      eventId,
      membershipId,
      version: 1,
      state: "active",
      updatedAt: now,
    });
    const firstTokenId = await ctx.db.insert("attendancePortalQrTokens", {
      eventId,
      membershipId,
      portalCredentialId,
      credentialVersion: 1,
      tokenHash: "first-token",
      state: "active",
      issuedAt: now,
      expiresAt: now + 60_000,
    });
    const secondTokenId = await ctx.db.insert("attendancePortalQrTokens", {
      eventId,
      membershipId,
      portalCredentialId,
      credentialVersion: 1,
      tokenHash: "second-token",
      state: "active",
      issuedAt: now,
      expiresAt: now + 60_000,
    });
    return {
      eventId,
      membershipId,
      portalCredentialId,
      firstTokenId,
      secondTokenId,
    } satisfies {
      eventId: Id<"events">;
      membershipId: Id<"eventMemberships">;
      portalCredentialId: Id<"attendancePortalCredentials">;
      firstTokenId: Id<"attendancePortalQrTokens">;
      secondTokenId: Id<"attendancePortalQrTokens">;
    };
  });
}

async function insertToken(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedPortalQrFixture>>,
  tokenHash: string,
  issuedAt: number,
) {
  return backend.run((ctx) =>
    ctx.db.insert("attendancePortalQrTokens", {
      eventId: fixture.eventId,
      membershipId: fixture.membershipId,
      portalCredentialId: fixture.portalCredentialId,
      credentialVersion: 1,
      tokenHash,
      state: "active",
      issuedAt,
      expiresAt: issuedAt + 60_000,
    }),
  );
}
