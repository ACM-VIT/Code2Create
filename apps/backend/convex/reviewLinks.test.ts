import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("review links", () => {
  test("participants can submit GitHub and Figma URLs and staff can read them", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const now = Date.now();
    const authUserId = await createAuthUser(backend, now);
    const authSessionId = await createAuthSession(backend, authUserId, now);
    const fixture = await backend.run(async (ctx) => {
      const eventId = await ctx.db.insert("events", {
        slug: `review-links-${now}`,
        name: "Review links fixture",
        timezone: "Asia/Kolkata",
        status: "registration_open",
        vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: now + 86_400_000,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const personId = await ctx.db.insert("people", {
        authUserId,
        googleSubject: `google-review-links-${now}`,
        verifiedEmail: `review-links-${now}@example.test`,
        displayName: "Review participant",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId,
        emailNormalized: `review-links-${now}@example.test`,
        displayName: "Review participant",
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
        name: "Review team",
        publicCode: "REVLINKS",
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
      await ctx.db.insert("teamMembers", {
        eventId,
        teamId,
        membershipId,
        role: "lead",
        status: "active",
        joinedAt: now,
        source: "created",
      });
      await insertPermissionGrant(ctx, {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey: "integration.read",
        scopeType: "team",
        scopeId: teamId,
        sourceType: "event_subject",
        sourceId: subjectId,
        reason: "Review links test",
        validFrom: now - 1,
      });
      return { eventSlug: `review-links-${now}`, teamId };
    });

    const actor = backend.withIdentity({ subject: authUserId, sessionId: authSessionId });
    await actor.mutation(api.reviewLinks.addGithub, {
      eventSlug: fixture.eventSlug,
      repositoryUrl: "https://github.com/acm-vit/portal",
      clientOperationId: `github-${now}`,
    });
    await actor.mutation(api.reviewLinks.addFigma, {
      eventSlug: fixture.eventSlug,
      fileUrl: "https://www.figma.com/design/AbCdEf123456/Portal",
      clientOperationId: `figma-${now}`,
    });

    const mine = await actor.query(api.reviewLinks.current, { eventSlug: fixture.eventSlug });
    expect(mine?.github.map((link) => link.url)).toEqual(["https://github.com/acm-vit/portal"]);
    expect(mine?.figma.map((link) => link.url)).toEqual([
      "https://www.figma.com/design/AbCdEf123456/Portal",
    ]);

    const staffView = await actor.query(api.reviewLinks.listForTeam, {
      eventSlug: fixture.eventSlug,
      teamId: fixture.teamId,
    });
    expect(staffView.map((link) => link.url)).toEqual([
      "https://github.com/acm-vit/portal",
      "https://www.figma.com/design/AbCdEf123456/Portal",
    ]);
  }, 30_000);
});

async function createAuthUser(backend: BackendTest, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Review participant",
        email: `review-links-${now}@example.test`,
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
        token: `review-links-session-${now}`,
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
