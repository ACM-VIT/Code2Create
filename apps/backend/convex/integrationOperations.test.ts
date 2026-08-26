import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import { integrationSummaryCounts } from "./integrationOperations.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("integration operations totals", () => {
  test("counts every readable team instead of only the loaded page", () => {
    const readableTeams = ["team-a", "team-b", "team-c", "team-d"];
    const github = new Map([
      ["team-b", { health: "ready" as const }],
      ["team-c", { health: "needs_attention" as const }],
      ["unreadable-team", { health: "needs_attention" as const }],
    ]);
    const figma = new Map([
      ["team-d", { health: "ready" as const }],
    ]);

    expect(integrationSummaryCounts(readableTeams, github, figma)).toEqual({
      totalTeamCount: 4,
      disconnectedCount: 1,
      attentionCount: 1,
    });
  });

  test("filters scoped teams before pagination and reports totals beyond the loaded page", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const now = Date.now();
    const authUserId = await createAuthUser(backend, now);
    const authSessionId = await createAuthSession(backend, authUserId, now);
    const fixture = await backend.run(async (ctx) => {
      const eventId = await ctx.db.insert("events", {
        slug: `integration-page-${now}`,
        name: "Integration pagination fixture",
        timezone: "Asia/Kolkata",
        status: "live",
        vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
        startsAt: now,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const personId = await ctx.db.insert("people", {
        authUserId,
        googleSubject: `google-integration-${now}`,
        verifiedEmail: `integration-${now}@example.test`,
        displayName: "Integration operator",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId,
        emailNormalized: `integration-${now}@example.test`,
        displayName: "Integration operator",
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
        onboardingStatus: "accepted",
        acceptedParticipantPolicyVersionIds: [],
        createdAt: now,
        updatedAt: now,
      });
      const teamIds = [];
      for (let index = 0; index < 5; index += 1) {
        teamIds.push(await ctx.db.insert("teams", {
          eventId,
          name: `Team ${index + 1}`,
          publicCode: `IPAGE${index}`,
          leadMembershipId: membershipId,
          status: "confirmed",
      activeMemberCount: 0,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 0,
          membershipLocked: true,
          version: 1,
          createdAt: now + index,
          updatedAt: now + index,
        }));
      }
      const firstReadable = teamIds[1];
      const secondReadable = teamIds[4];
      if (!firstReadable || !secondReadable) throw new Error("Team fixture is incomplete.");
      for (const teamId of [firstReadable, secondReadable]) {
        await insertPermissionGrant(ctx, {
          eventId,
          personId,
          eventAccessSubjectId: subjectId,
          permissionKey: "integration.read",
          scopeType: "team",
          scopeId: teamId,
          sourceType: "event_subject",
          sourceId: subjectId,
          reason: "Integration pagination test",
          validFrom: now - 1,
        });
      }
      return { eventSlug: `integration-page-${now}` };
    });
    const operator = backend.withIdentity({ subject: authUserId, sessionId: authSessionId });

    const first = await operator.query(api.integrationOperations.teams, {
      eventSlug: fixture.eventSlug,
      paginationOpts: { cursor: null, numItems: 1 },
    });
    expect(first.page).toHaveLength(1);
    expect(first.isDone).toBe(false);
    const second = await operator.query(api.integrationOperations.teams, {
      eventSlug: fixture.eventSlug,
      paginationOpts: { cursor: first.continueCursor, numItems: 1 },
    });
    expect(second.page).toHaveLength(1);
    expect(new Set([...first.page, ...second.page].map((team) => team.teamName))).toEqual(
      new Set(["Team 2", "Team 5"]),
    );
    expect(await operator.query(api.integrationOperations.summary, {
      eventSlug: fixture.eventSlug,
    })).toEqual({ totalTeamCount: 2, disconnectedCount: 2, attentionCount: 0 });
  });
});

async function createAuthUser(backend: BackendTest, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Integration operator",
        email: `integration-${now}@example.test`,
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
        token: `integration-session-${now}`,
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
