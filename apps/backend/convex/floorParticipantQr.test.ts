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

describe("participant floor QR", () => {
  test("keeps hall location readable without exposing the separately scoped QR action", async () => {
    const backend = seededBackend();
    const fixture = await seedParticipant(backend, { grantMint: false });
    const participant = asParticipant(backend, fixture);

    await expect(
      participant.query(api.floorParticipant.current, { eventSlug: fixture.eventSlug }),
    ).resolves.toMatchObject({
      teamId: fixture.teamId,
      planName: "Main hall",
      canMintQr: false,
    });
    await expect(
      participant.mutation(api.floorParticipant.mintTeamQr, {
        eventSlug: fixture.eventSlug,
      }),
    ).rejects.toThrow("does not have permission for that exact resource");
  });

  test("supersedes the exact active token and advances from the latest owner version", async () => {
    const backend = seededBackend();
    const fixture = await seedParticipant(backend);
    const participant = asParticipant(backend, fixture);
    await backend.run(async (ctx) => {
      await ctx.db.insert("floorTeamQrTokens", {
        eventId: fixture.eventId,
        planVersionId: fixture.planVersionId,
        teamId: fixture.teamId,
        tokenDigest: "historical-token",
        manualCodeDigest: "historical-code",
        tokenVersion: 41,
        state: "superseded",
        expiresAt: fixture.now - 60_000,
        issuedByMembershipId: fixture.membershipId,
        issuedAt: fixture.now - 120_000,
      });
      await ctx.db.insert("floorTeamQrTokens", {
        eventId: fixture.eventId,
        planVersionId: fixture.planVersionId,
        teamId: fixture.teamId,
        tokenDigest: "active-token",
        manualCodeDigest: "active-code",
        tokenVersion: 42,
        state: "active",
        expiresAt: fixture.now + 60_000,
        issuedByMembershipId: fixture.membershipId,
        issuedAt: fixture.now - 30_000,
      });
    });

    const minted = await participant.mutation(api.floorParticipant.mintTeamQr, {
      eventSlug: fixture.eventSlug,
    });
    expect(minted).toMatchObject({
      teamName: "QR Team",
      planName: "Main hall",
    });
    expect(minted.serverNow).toBeLessThan(minted.expiresAt);
    await expect(
      participant.query(api.floorParticipant.teamQrState, {
        eventSlug: fixture.eventSlug,
        tokenId: minted.tokenId,
      }),
    ).resolves.toMatchObject({ state: "active" });

    const tokens = await teamTokens(backend, fixture.teamId);
    expect(tokens.map((token) => token.tokenVersion)).toEqual([41, 42, 43]);
    expect(tokens.filter((token) => token.state === "active")).toHaveLength(1);
    expect(tokens.find((token) => token.tokenVersion === 42)?.state).toBe("superseded");
    expect(tokens.find((token) => token.tokenVersion === 43)?.state).toBe("active");

    await backend.run(async (ctx) => {
      await ctx.db.patch(minted.tokenId, { state: "used", usedAt: fixture.now });
    });
    await expect(
      participant.query(api.floorParticipant.teamQrState, {
        eventSlug: fixture.eventSlug,
        tokenId: minted.tokenId,
      }),
    ).resolves.toMatchObject({ state: "used" });
  });

  test("refuses an existing duplicate-active invariant violation", async () => {
    const backend = seededBackend();
    const fixture = await seedParticipant(backend);
    const participant = asParticipant(backend, fixture);
    await backend.run(async (ctx) => {
      for (const tokenVersion of [1, 2]) {
        await ctx.db.insert("floorTeamQrTokens", {
          eventId: fixture.eventId,
          planVersionId: fixture.planVersionId,
          teamId: fixture.teamId,
          tokenDigest: `active-token-${tokenVersion}`,
          manualCodeDigest: `active-code-${tokenVersion}`,
          tokenVersion,
          state: "active",
          expiresAt: fixture.now + 60_000,
          issuedByMembershipId: fixture.membershipId,
          issuedAt: fixture.now - (3 - tokenVersion) * 1_000,
        });
      }
    });

    await expect(
      participant.mutation(api.floorParticipant.mintTeamQr, {
        eventSlug: fixture.eventSlug,
      }),
    ).rejects.toThrow("more than one active hall-location QR");
    expect(await teamTokens(backend, fixture.teamId)).toHaveLength(2);
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

function asParticipant(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedParticipant>>,
) {
  return backend.withIdentity({
    subject: fixture.authUserId,
    sessionId: fixture.authSessionId,
  });
}

async function teamTokens(
  backend: BackendTest,
  teamId: Awaited<ReturnType<typeof seedParticipant>>["teamId"],
) {
  return backend.run((ctx) =>
    ctx.db
      .query("floorTeamQrTokens")
      .withIndex("by_team_version", (index) => index.eq("teamId", teamId))
      .collect(),
  );
}

async function seedParticipant(
  backend: BackendTest,
  { grantMint = true }: { grantMint?: boolean } = {},
) {
  const now = Date.now();
  const eventSlug = `floor-qr-${crypto.randomUUID()}`;
  const email = `floor-qr-${crypto.randomUUID()}@example.test`;
  const authUserId = await createAuthUser(backend, now, email);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  const identity = await backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: crypto.randomUUID(),
      verifiedEmail: email,
      displayName: "QR Participant",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Floor QR fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
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
      displayName: "QR Participant",
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
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "QR Team",
      publicCode: `QR-${crypto.randomUUID()}`,
      leadMembershipId: membershipId,
      status: "confirmed",
      activeMemberCount: 1,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 1,
      membershipLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId,
      role: "lead",
      status: "active",
      joinedAt: now,
      source: "created",
    });
    const planVersionId = await ctx.db.insert("floorPlanVersions", {
      eventId,
      planNumber: 1,
      name: "Main hall",
      status: "published",
      mappingState: "open",
      checksum: "floor-qr-fixture",
      version: 1,
      createdByPersonId: personId,
      createdAt: now,
      publishedByPersonId: personId,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, { publishedFloorPlanVersionId: planVersionId });
    await insertPermissionGrant(ctx, {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "floor.team.read",
      scopeType: "team",
      scopeId: teamId,
      sourceType: "team_membership",
      sourceId: `${teamId}:${membershipId}:floor-read`,
      reason: "Participant floor read test",
    });
    if (grantMint) await insertPermissionGrant(ctx, {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "floor.team_qr.mint",
      scopeType: "team",
      scopeId: teamId,
      sourceType: "team_membership",
      sourceId: `${teamId}:${membershipId}:floor-qr`,
      reason: "Participant floor QR test",
    });
    return { eventId, membershipId, teamId, planVersionId };
  });
  return { ...identity, now, eventSlug, authUserId, authSessionId };
}

async function createAuthUser(backend: BackendTest, now: number, email: string) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "QR Participant",
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
