import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api, components } from "./_generated/api";
import {
  defaultParticipantPolicy,
  normalizeParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";

describe("team roster backfill", () => {
  test("imports a team, then first login joins lead and member", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);

    const importer = await seedImporter(backend, fixture);
    const preview = await importer.person.query(api.teamRosters.previewImport, {
      eventSlug: fixture.eventSlug,
      sourceName: "Imported teams",
      rows: [
        {
          rowNumber: 2,
          email: "lead@vitstudent.ac.in",
          displayName: "Lead Person",
          teamName: "Alpha",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: "member@gmail.com",
          displayName: "Member Person",
          teamName: "Alpha",
          role: "member",
        },
      ],
      reason: "Committee team assignments",
    });
    expect(preview.counts.pending).toBe(2);

    const confirmed = await importer.person.mutation(api.teamRosters.confirmImport, {
      eventSlug: fixture.eventSlug,
      sourceName: "Imported teams",
      rows: [
        {
          rowNumber: 2,
          email: "lead@vitstudent.ac.in",
          displayName: "Lead Person",
          teamName: "Alpha",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: "member@gmail.com",
          displayName: "Member Person",
          teamName: "Alpha",
          role: "member",
        },
      ],
      reason: "Committee team assignments",
      previewChecksum: preview.previewChecksum,
      clientOperationId: "team-roster-import-once",
    });
    expect(confirmed.rowCount).toBe(2);

    await drainScheduler(backend);

    const lead = await provisionParticipant(backend, fixture, {
      email: "lead@vitstudent.ac.in",
      googleSubject: "team-roster-lead-subject",
      vitHostedDomain: "vitstudent.ac.in",
    });
    expect(lead.me.pendingTeam).toBeNull();
    expect(lead.membership.onboardingStatus).toBe("profile_required");
    const leadTeam = await lead.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(leadTeam?.name).toBe("Alpha");

    await backend.run(async (ctx) => {
      const memberRows = await ctx.db
        .query("teamMembers")
        .withIndex("by_event_membership_status", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("membershipId", lead.membershipId)
            .eq("status", "active"),
        )
        .collect();
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]?.role).toBe("lead");
      expect(memberRows[0]?.source).toBe("backfill");
    });

    const member = await provisionParticipant(backend, fixture, {
      email: "member@gmail.com",
      googleSubject: "team-roster-member-subject",
    });
    expect(member.me.pendingTeam).toBeNull();
    const memberTeam = await member.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(memberTeam?.id).toBe(leadTeam?.id);
    expect(memberTeam?.activeMemberCount).toBe(2);
  }, 30_000);

  test("skips a person who already has an active team", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);

    const participant = await provisionParticipant(backend, fixture, {
      email: "already@gmail.com",
      googleSubject: "team-roster-already-subject",
    });
    await participant.person.mutation(api.participants.acceptPolicy, {
      eventSlug: fixture.eventSlug,
      participantPolicyVersionId: fixture.policyId,
      accepted: true,
      clientOperationId: "accept-policy-already",
    });
    const created = await participant.person.mutation(api.teams.create, {
      eventSlug: fixture.eventSlug,
      name: "Beta",
      clientOperationId: "team-create-already",
    });

    const preview = await importer.person.query(api.teamRosters.previewImport, {
      eventSlug: fixture.eventSlug,
      sourceName: "Imported teams",
      rows: [
        {
          rowNumber: 2,
          email: "lead2@gmail.com",
          displayName: "Second Lead",
          teamName: "Alpha",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: "already@gmail.com",
          displayName: "Already Busy",
          teamName: "Alpha",
          role: "member",
        },
      ],
      reason: "Committee team assignments",
    });
    expect(preview.counts.alreadyOnTeam).toBe(1);

    await importer.person.mutation(api.teamRosters.confirmImport, {
      eventSlug: fixture.eventSlug,
      sourceName: "Imported teams",
      rows: [
        {
          rowNumber: 2,
          email: "lead2@gmail.com",
          displayName: "Second Lead",
          teamName: "Alpha",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: "already@gmail.com",
          displayName: "Already Busy",
          teamName: "Alpha",
          role: "member",
        },
      ],
      reason: "Committee team assignments",
      previewChecksum: preview.previewChecksum,
      clientOperationId: "team-roster-import-skip",
    });
    await drainScheduler(backend);

    await backend.run(async (ctx) => {
      const entry = await ctx.db
        .query("teamRosterEntries")
        .withIndex("by_event_email_status", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("emailNormalized", "already@gmail.com")
            .eq("status", "skipped_has_team"),
        )
        .unique();
      expect(entry).not.toBeNull();
      const activeMembers = await ctx.db
        .query("teamMembers")
        .withIndex("by_event_membership_status", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("membershipId", participant.membershipId)
            .eq("status", "active"),
        )
        .collect();
      expect(activeMembers).toHaveLength(1);
      expect(activeMembers[0]?.teamId).toBe(created.teamId);
    });
  }, 30_000);

  test("member waits for lead, then joins when the lead provisions", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);

    const preview = await importer.person.query(api.teamRosters.previewImport, {
      eventSlug: fixture.eventSlug,
      sourceName: "Imported teams",
      rows: [
        {
          rowNumber: 2,
          email: "late-lead@vitstudent.ac.in",
          displayName: "Late Lead",
          teamName: "Gamma",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: "early-member@gmail.com",
          displayName: "Early Member",
          teamName: "Gamma",
          role: "member",
        },
      ],
      reason: "Committee team assignments",
    });
    await importer.person.mutation(api.teamRosters.confirmImport, {
      eventSlug: fixture.eventSlug,
      sourceName: "Imported teams",
      rows: [
        {
          rowNumber: 2,
          email: "late-lead@vitstudent.ac.in",
          displayName: "Late Lead",
          teamName: "Gamma",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: "early-member@gmail.com",
          displayName: "Early Member",
          teamName: "Gamma",
          role: "member",
        },
      ],
      reason: "Committee team assignments",
      previewChecksum: preview.previewChecksum,
      clientOperationId: "team-roster-import-wait",
    });
    await drainScheduler(backend);

    const member = await provisionParticipant(backend, fixture, {
      email: "early-member@gmail.com",
      googleSubject: "team-roster-early-member-subject",
    });
    expect(member.me.pendingTeam).toMatchObject({
      teamName: "Gamma",
      status: "waiting_for_lead",
    });
    const memberTeam = await member.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(memberTeam).toBeNull();

    const lead = await provisionParticipant(backend, fixture, {
      email: "late-lead@vitstudent.ac.in",
      googleSubject: "team-roster-late-lead-subject",
      vitHostedDomain: "vitstudent.ac.in",
    });
    const leadTeam = await lead.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(leadTeam?.name).toBe("Gamma");
    expect(leadTeam?.activeMemberCount).toBe(2);
    const memberAfter = await member.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(memberAfter?.id).toBe(leadTeam?.id);
  }, 30_000);

  test("leave keeps the claimed entry and does not re-add the participant", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);

    const preview = await importer.person.query(api.teamRosters.previewImport, {
      eventSlug: fixture.eventSlug,
      sourceName: "Imported teams",
      rows: [
        {
          rowNumber: 2,
          email: "leave-lead@gmail.com",
          displayName: "Leave Lead",
          teamName: "Delta",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: "leave-member@gmail.com",
          displayName: "Leave Member",
          teamName: "Delta",
          role: "member",
        },
      ],
      reason: "Committee team assignments",
    });
    await importer.person.mutation(api.teamRosters.confirmImport, {
      eventSlug: fixture.eventSlug,
      sourceName: "Imported teams",
      rows: [
        {
          rowNumber: 2,
          email: "leave-lead@gmail.com",
          displayName: "Leave Lead",
          teamName: "Delta",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: "leave-member@gmail.com",
          displayName: "Leave Member",
          teamName: "Delta",
          role: "member",
        },
      ],
      reason: "Committee team assignments",
      previewChecksum: preview.previewChecksum,
      clientOperationId: "team-roster-import-leave",
    });
    await drainScheduler(backend);

    const lead = await provisionParticipant(backend, fixture, {
      email: "leave-lead@gmail.com",
      googleSubject: "team-roster-leave-lead-subject",
    });
    const leadTeam = await lead.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(leadTeam?.name).toBe("Delta");

    const member = await provisionParticipant(backend, fixture, {
      email: "leave-member@gmail.com",
      googleSubject: "team-roster-leave-member-subject",
    });
    const team = await member.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(team).not.toBeNull();
    expect(team?.id).toBe(leadTeam?.id);

    await member.person.mutation(api.teams.leave, {
      eventSlug: fixture.eventSlug,
      teamId: team!.id,
      expectedTeamVersion: team!.version,
      clientOperationId: "team-leave-after-backfill",
    });
    const afterLeave = await member.person.query(api.participants.me, {
      eventSlug: fixture.eventSlug,
    });
    expect(afterLeave?.membership?.onboardingStatus).toBe("team_required");
    expect(afterLeave?.pendingTeam).toBeNull();

    await backend.run(async (ctx) => {
      const entry = await ctx.db
        .query("teamRosterEntries")
        .withIndex("by_event_email_status", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("emailNormalized", "leave-member@gmail.com")
            .eq("status", "claimed"),
        )
        .unique();
      expect(entry).not.toBeNull();
    });

    const secondProvision = await member.person.mutation(api.participants.provision, {
      eventSlug: fixture.eventSlug,
      participantClass: "external_participant",
    });
    expect(secondProvision.created).toBe(false);
    const stillOff = await member.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(stillOff).toBeNull();
  }, 30_000);

  test("blocks import without the team.roster.import permission", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const outsider = await provisionParticipant(backend, fixture, {
      email: "plain@gmail.com",
      googleSubject: "team-roster-plain-subject",
    });

    await expect(
      outsider.person.mutation(api.teamRosters.confirmImport, {
        eventSlug: fixture.eventSlug,
        sourceName: "Imported teams",
        rows: [
          {
            rowNumber: 2,
            email: "blocked@gmail.com",
            displayName: "Blocked Lead",
            teamName: "Epsilon",
            role: "lead",
          },
        ],
        reason: "Should not be allowed",
        previewChecksum: "anything",
        clientOperationId: "team-roster-import-blocked",
      }),
    ).rejects.toThrow();
  }, 30_000);
});

async function seedEvent(backend: BackendTest) {
  const now = Date.UTC(2027, 6, 1, 9, 0);
  const eventSlug = "team-roster-backfill";
  const ownerAuthUserId = await createAuthUser(
    backend,
    now,
    "Event Owner",
    "owner@example.test",
  );
  return backend.run(async (ctx) => {
    const ownerId = await ctx.db.insert("people", {
      authUserId: ownerAuthUserId,
      googleSubject: "team-roster-event-owner",
      verifiedEmail: "owner@example.test",
      displayName: "Event Owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Code2Create team roster fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: Date.now() + 86_400_000,
      createdByPersonId: ownerId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const policy = normalizeParticipantPolicy(defaultParticipantPolicy);
    const policyId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...policy,
      checksum: participantPolicyChecksum(policy),
      createdByPersonId: ownerId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, { publishedParticipantPolicyId: policyId });
    return { now, eventSlug, eventId, policyId };
  });
}

async function seedImporter(backend: BackendTest, fixture: Awaited<ReturnType<typeof seedEvent>>) {
  const identity = {
    name: "Supreme Organizer",
    email: "supreme@example.test",
    googleSubject: "team-roster-supreme-subject",
    sessionToken: "team-roster-supreme-session-token",
  };
  const authUserId = await createAuthUser(backend, fixture.now, identity.name, identity.email);
  const authSessionId = await createAuthSession(
    backend,
    authUserId,
    fixture.now,
    identity.sessionToken,
  );
  const seeded = await backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: identity.googleSubject,
      verifiedEmail: identity.email,
      displayName: identity.name,
      status: "active",
      createdAt: fixture.now,
      updatedAt: fixture.now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId: fixture.eventId,
      personId,
      emailNormalized: identity.email,
      displayName: identity.name,
      status: "active",
      linkedBy: "participant_provisioning",
      accessVersion: 1,
      createdAt: fixture.now,
      updatedAt: fixture.now,
    });
    for (const permissionKey of [
      "team.roster.read",
      "team.roster.import",
      "team.roster.revoke",
    ] as const) {
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "manual",
        sourceId: subjectId,
        reason: "Team roster fixture",
      });
    }
    return { personId };
  });
  return {
    personId: seeded.personId,
    person: backend.withIdentity({
      subject: authUserId,
      sessionId: authSessionId,
    }),
  };
}

async function provisionParticipant(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedEvent>>,
  args: {
    email: string;
    googleSubject: string;
    vitHostedDomain?: string;
  },
) {
  const identity = {
    name: args.email,
    email: args.email,
    googleSubject: args.googleSubject,
    sessionToken: `team-roster-${args.googleSubject}-token`,
    hostedDomain: args.vitHostedDomain ?? "gmail.com",
  };
  const authUserId = await createAuthUser(backend, fixture.now, identity.name, identity.email);
  const authSessionId = await createAuthSession(
    backend,
    authUserId,
    fixture.now,
    identity.sessionToken,
  );
  await seedGoogleIdentity(backend, authUserId, {
    googleSubject: args.googleSubject,
    email: args.email,
    ...(args.vitHostedDomain ? { hostedDomain: args.vitHostedDomain } : {}),
  });
  const person = backend.withIdentity({
    subject: authUserId,
    sessionId: authSessionId,
  });
  await person.mutation(api.participants.provision, {
    eventSlug: fixture.eventSlug,
    participantClass: args.vitHostedDomain ? "vit_student" : "external_participant",
  });
  const me = await person.query(api.participants.me, { eventSlug: fixture.eventSlug });
  if (!me?.membership) throw new Error("Provisioning did not create a membership.");
  return {
    authUserId,
    authSessionId,
    personId: me.person.id,
    membershipId: me.membership.id,
    membership: me.membership,
    me,
    person,
  };
}

async function seedGoogleIdentity(
  backend: BackendTest,
  authUserId: string,
  args: { googleSubject: string; email: string; hostedDomain?: string },
) {
  await backend.run(async (ctx) => {
    await ctx.db.insert("googleIdentityClaims", {
      authUserId,
      googleSubject: args.googleSubject,
      verifiedEmail: args.email,
      ...(args.hostedDomain ? { hostedDomain: args.hostedDomain } : {}),
      tokenIssuedAt: Date.now(),
      tokenExpiresAt: Date.now() + 3_600_000,
      verifiedAt: Date.now(),
    });
  });
}

async function drainScheduler(backend: BackendTest) {
  vi.useFakeTimers();
  try {
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
  } finally {
    vi.useRealTimers();
  }
}

async function createAuthUser(
  backend: BackendTest,
  now: number,
  name = "Aarav Menon",
  email = "participant@example.test",
) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name,
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return documentId(result, "Better Auth user");
}

async function createAuthSession(
  backend: BackendTest,
  userId: string,
  now: number,
  token = "participant-onboarding-session-token",
) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 60 * 60 * 1_000,
        token,
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
    throw new Error(`The created ${label} is invalid.`);
  }
  return String(value._id);
}
