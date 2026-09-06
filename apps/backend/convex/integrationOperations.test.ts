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
    const figma = new Set(["team-d"]);

    expect(integrationSummaryCounts(readableTeams, github, figma)).toEqual({
      totalTeamCount: 4,
      disconnectedCount: 1,
      attentionCount: 1,
    });
  });

  test("returns the full selected cohort within exact team grants", async () => {
    const { backend, operator, fixture } = await seedOverview();
    const result = await operator.query(api.integrationOperations.teams, { eventSlug: fixture.eventSlug });
    expect(result.teams.map(team => team.teamName)).toEqual(["Team 2", "Team 5"]);
    expect(result.teams.map(team => team.teamCode)).toEqual(["IPAGE1", "IPAGE4"]);
    expect(result.summary).toEqual({ totalTeamCount: 2, disconnectedCount: 2, attentionCount: 0 });
    const teamId = fixture.teamIds[1];
    if (!teamId) throw new Error("Missing scoped team");
    await backend.run(ctx => ctx.db.patch("teams", teamId, { status: "withdrawn" }));
    const afterWithdrawal = await operator.query(api.integrationOperations.teams, { eventSlug: fixture.eventSlug });
    expect(afterWithdrawal.teams.map(team => team.teamName)).toEqual(["Team 5"]);
    expect(afterWithdrawal.summary.totalTeamCount).toBe(1);
  });

  test("excludes every unselected status from event-wide rows and totals", async () => {
    const { backend, operator, fixture } = await seedOverview();
    const statuses = [
      "admitted", "confirmed", "checked_in", "active", "completed",
      "forming", "profile_in_progress", "submitted", "withdrawn", "disqualified",
    ] as const;
    await backend.run(async ctx => {
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId, personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "integration.read", scopeType: "event",
        sourceType: "event_subject", sourceId: fixture.subjectId, reason: "Event overview test",
      });
      for (const [index, status] of statuses.entries()) {
        const teamId = fixture.teamIds[index];
        if (!teamId) throw new Error("Missing status fixture");
        await ctx.db.patch("teams", teamId, { status });
        if (status === "admitted" || status === "withdrawn") {
          await ctx.db.insert("teamFigmaLinks", {
            eventId: fixture.eventId, teamId, fileUrl: "https://www.figma.com/design/fixture",
            version: 1, updatedByPersonId: fixture.personId, updatedAt: Date.now(),
          });
        }
      }
    });
    const result = await operator.query(api.integrationOperations.teams, { eventSlug: fixture.eventSlug });
    expect(result.teams.map(team => team.teamStatus)).toEqual(statuses.slice(0, 5));
    expect(result.summary).toEqual({ totalTeamCount: 5, disconnectedCount: 4, attentionCount: 0 });
  });

  test("returns no rows without integration access and rejects anonymous reads", async () => {
    const { backend, operator, fixture } = await seedOverview();
    await backend.run(async ctx => {
      const grants = await ctx.db.query("permissionGrants").take(10);
      for (const grant of grants) await ctx.db.patch("permissionGrants", grant._id, { status: "revoked" });
    });
    expect(await operator.query(api.integrationOperations.teams, { eventSlug: fixture.eventSlug })).toEqual({
      teams: [], summary: { totalTeamCount: 0, disconnectedCount: 0, attentionCount: 0 },
    });
    await expect(backend.query(api.integrationOperations.teams, { eventSlug: fixture.eventSlug })).rejects.toThrow();
  });
});

async function seedOverview() {
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
      for (let index = 0; index < 10; index += 1) {
        teamIds.push(
          await ctx.db.insert("teams", {
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
          }),
        );
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
      return { eventSlug: `integration-page-${now}`, eventId, personId, subjectId, membershipId, teamIds };
    });
    const operator = backend.withIdentity({ subject: authUserId, sessionId: authSessionId });
    return { backend, operator, fixture };
}

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
