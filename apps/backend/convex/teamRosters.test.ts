import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api, components, internal } from "./_generated/api";
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

  test("waiting member can see assignees, decline, and create another team", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);
    await importRows(importer, fixture, {
      sourceName: "Decline waiting",
      clientOperationId: "team-roster-import-decline",
      rows: [
        {
          rowNumber: 2,
          email: "stay-lead@gmail.com",
          displayName: "Stay Lead",
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
    });
    await drainScheduler(backend);

    const member = await provisionParticipant(backend, fixture, {
      email: "leave-member@gmail.com",
      googleSubject: "team-roster-decline-member-subject",
    });
    expect(member.me.pendingTeam).toMatchObject({
      teamName: "Delta",
      role: "member",
      status: "waiting_for_lead",
      assignees: [
        { displayName: "Stay Lead", role: "lead", signedIn: false, isYou: false },
        { displayName: "Leave Member", role: "member", signedIn: true, isYou: true },
      ],
    });
    const pendingTeam = member.me.pendingTeam;
    if (!pendingTeam) throw new Error("Waiting member should have a pending assignment.");

    await acceptPolicy(member.person, fixture, "accept-leave-member@gmail.com");
    await expect(
      member.person.mutation(api.teams.create, {
        eventSlug: fixture.eventSlug,
        name: "Helium",
        clientOperationId: "team-create-blocked-by-assignment",
      }),
    ).rejects.toThrow("Leave the assigned team before creating or joining another.");

    const otherLead = await provisionParticipant(backend, fixture, {
      email: "other-live-lead@gmail.com",
      googleSubject: "team-roster-other-live-lead-subject",
    });
    await acceptPolicy(otherLead.person, fixture, "accept-other-live-lead@gmail.com");
    const otherTeam = await otherLead.person.mutation(api.teams.create, {
      eventSlug: fixture.eventSlug,
      name: "Neon",
      clientOperationId: "team-create-neon",
    });
    const otherCurrent = await otherLead.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    if (!otherCurrent) throw new Error("Neon team should exist.");
    await expect(
      member.person.mutation(api.teams.join, {
        eventSlug: fixture.eventSlug,
        code: otherCurrent.publicCode,
        clientOperationId: "team-join-blocked-by-assignment",
      }),
    ).rejects.toThrow("Leave the assigned team before creating or joining another.");

    const declined = await member.person.mutation(api.participants.declineAssignedTeam, {
      eventSlug: fixture.eventSlug,
      teamRosterEntryId: pendingTeam.id,
      expectedVersion: pendingTeam.version,
      clientOperationId: "team-assignment-decline-member",
    });
    expect(declined.status).toBe("revoked");
    const replayed = await member.person.mutation(api.participants.declineAssignedTeam, {
      eventSlug: fixture.eventSlug,
      teamRosterEntryId: pendingTeam.id,
      expectedVersion: pendingTeam.version,
      clientOperationId: "team-assignment-decline-member",
    });
    expect(replayed).toEqual(declined);

    const afterDecline = await member.person.query(api.participants.me, {
      eventSlug: fixture.eventSlug,
    });
    expect(afterDecline?.pendingTeam).toBeNull();

    const created = await member.person.mutation(api.teams.create, {
      eventSlug: fixture.eventSlug,
      name: "Helium",
      clientOperationId: "team-create-after-decline",
    });
    expect(created.teamId).toBeTruthy();

    const lead = await provisionParticipant(backend, fixture, {
      email: "stay-lead@gmail.com",
      googleSubject: "team-roster-decline-lead-subject",
    });
    const leadTeam = await lead.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(leadTeam?.name).toBe("Delta");
    expect(leadTeam?.activeMemberCount).toBe(1);
    const memberTeam = await member.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(memberTeam?.name).toBe("Helium");
    expect(otherTeam.teamId).not.toBe(leadTeam?.id);
  }, 30_000);

  test("decline rejects another person's entry and a claimed row", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);
    await importRows(importer, fixture, {
      sourceName: "Decline guards",
      clientOperationId: "team-roster-import-decline-guards",
      rows: [
        {
          rowNumber: 2,
          email: "guard-lead@gmail.com",
          displayName: "Guard Lead",
          teamName: "Epsilon",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: "guard-member@gmail.com",
          displayName: "Guard Member",
          teamName: "Epsilon",
          role: "member",
        },
      ],
    });
    await drainScheduler(backend);

    const member = await provisionParticipant(backend, fixture, {
      email: "guard-member@gmail.com",
      googleSubject: "team-roster-guard-member-subject",
    });
    const leadEntryId = await backend.run(async (ctx) => {
      const entry = await ctx.db
        .query("teamRosterEntries")
        .withIndex("by_event_email_status", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("emailNormalized", "guard-lead@gmail.com")
            .eq("status", "pending"),
        )
        .unique();
      if (!entry) throw new Error("Lead assignment is missing.");
      return entry._id;
    });
    await expect(
      member.person.mutation(api.participants.declineAssignedTeam, {
        eventSlug: fixture.eventSlug,
        teamRosterEntryId: leadEntryId,
        expectedVersion: 1,
        clientOperationId: "team-assignment-decline-other",
      }),
    ).rejects.toThrow("You can only leave your own assigned team.");

    const lead = await provisionParticipant(backend, fixture, {
      email: "guard-lead@gmail.com",
      googleSubject: "team-roster-guard-lead-subject",
    });
    const claimed = await member.person.query(api.participants.me, {
      eventSlug: fixture.eventSlug,
    });
    expect(claimed?.pendingTeam).toBeNull();
    const claimedEntry = await backend.run(async (ctx) => {
      const entry = await ctx.db
        .query("teamRosterEntries")
        .withIndex("by_event_email_status", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("emailNormalized", "guard-member@gmail.com")
            .eq("status", "claimed"),
        )
        .unique();
      if (!entry) throw new Error("Claimed member assignment is missing.");
      return entry;
    });
    await expect(
      member.person.mutation(api.participants.declineAssignedTeam, {
        eventSlug: fixture.eventSlug,
        teamRosterEntryId: claimedEntry._id,
        expectedVersion: claimedEntry.version,
        clientOperationId: "team-assignment-decline-claimed",
      }),
    ).rejects.toThrow("You are already on that team. Leave it from the team panel.");
    expect(lead.me.pendingTeam).toBeNull();
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
      outsider.person.query(api.teamRosters.previewImport, {
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
      }),
    ).rejects.toThrow("cannot import participant teams");

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

  test("a full team does not block the extra person from signing up", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);
    const packed = await fillTeam(backend, fixture, "Packed", 3);

    const extraIdentity = await signInParticipant(backend, fixture, {
      email: "extra-full@gmail.com",
      googleSubject: "team-roster-extra-full-subject",
    });
    await importRows(importer, fixture, {
      sourceName: "Last seat then overflow",
      clientOperationId: "team-roster-import-overflow",
      rows: [
        {
          rowNumber: 2,
          email: packed.leadEmail,
          displayName: "Packed Lead",
          teamName: "Packed",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: extraIdentity.email,
          displayName: "Extra Person",
          teamName: "Packed",
          role: "member",
        },
      ],
    });
    await drainScheduler(backend);

    const closer = await provisionParticipant(backend, fixture, {
      email: "seat-closer@gmail.com",
      googleSubject: "team-roster-seat-closer-subject",
    });
    await acceptPolicy(closer.person, fixture, "accept-seat-closer@gmail.com");
    await closer.person.mutation(api.teams.join, {
      eventSlug: fixture.eventSlug,
      code: packed.publicCode,
      clientOperationId: "team-join-seat-closer",
    });

    await expect(
      extraIdentity.person.mutation(api.participants.provision, {
        eventSlug: fixture.eventSlug,
        participantClass: "external_participant",
      }),
    ).resolves.toMatchObject({ created: true });
    const extraMe = await extraIdentity.person.query(api.participants.me, {
      eventSlug: fixture.eventSlug,
    });
    expect(extraMe?.membership).not.toBeNull();
    const extraTeam = await extraIdentity.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(extraTeam).toBeNull();
  }, 30_000);

  test("preview does not say waiting-for-lead when the named team already exists", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);
    const live = await fillTeam(backend, fixture, "Live Alpha", 1);
    const member = await provisionParticipant(backend, fixture, {
      email: "ready-member@gmail.com",
      googleSubject: "team-roster-ready-member-subject",
    });

    const preview = await importer.person.query(api.teamRosters.previewImport, {
      eventSlug: fixture.eventSlug,
      sourceName: "Existing team",
      rows: [
        {
          rowNumber: 2,
          email: live.leadEmail,
          displayName: "Live Lead",
          teamName: "Live Alpha",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: member.me.person.verifiedEmail,
          displayName: "Ready Member",
          teamName: "Live Alpha",
          role: "member",
        },
      ],
      reason: "Committee team assignments",
    });
    const memberRow = preview.rows.find((row) => row.email === "ready-member@gmail.com");
    expect(memberRow?.outcome).not.toBe("waiting_for_lead");
  }, 30_000);

  test("preview rejects an import that would overflow a live team", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);
    const packed = await fillTeam(backend, fixture, "Overflow", 4);

    await expect(
      importer.person.query(api.teamRosters.previewImport, {
        eventSlug: fixture.eventSlug,
        sourceName: "One too many",
        rows: [
          {
            rowNumber: 2,
            email: packed.leadEmail,
            displayName: "Overflow Lead",
            teamName: "Overflow",
            role: "lead",
          },
          {
            rowNumber: 3,
            email: "one-more@gmail.com",
            displayName: "One More",
            teamName: "Overflow",
            role: "member",
          },
        ],
        reason: "Committee team assignments",
      }),
    ).rejects.toThrow();
  }, 30_000);

  test("reused withdrawn names still attach to the live team", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);
    const ghost = await provisionParticipant(backend, fixture, {
      email: "ghost-alpha@gmail.com",
      googleSubject: "team-roster-ghost-alpha-subject",
    });
    await backend.run(async (ctx) => {
      for (const code of ["OLD1", "OLD2", "OLD3"] as const) {
        await ctx.db.insert("teams", {
          eventId: fixture.eventId,
          name: "Alpha",
          publicCode: code,
          leadMembershipId: ghost.membershipId,
          status: "withdrawn",
          activeMemberCount: 0,
          activeVitMemberCount: 0,
          activeExternalMemberCount: 0,
          membershipLocked: false,
          version: 1,
          createdAt: fixture.now,
          updatedAt: fixture.now,
        });
      }
    });
    const live = await fillTeam(backend, fixture, "Alpha", 1);

    const lateMember = await signInParticipant(backend, fixture, {
      email: "late-alpha@gmail.com",
      googleSubject: "team-roster-late-alpha-subject",
    });
    await importRows(importer, fixture, {
      sourceName: "Reuse Alpha",
      clientOperationId: "team-roster-import-reuse-alpha",
      rows: [
        {
          rowNumber: 2,
          email: live.leadEmail,
          displayName: "Live Lead",
          teamName: "Alpha",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: lateMember.email,
          displayName: "Late Alpha",
          teamName: "Alpha",
          role: "member",
        },
      ],
    });
    await drainScheduler(backend);
    await lateMember.person.mutation(api.participants.provision, {
      eventSlug: fixture.eventSlug,
      participantClass: "external_participant",
    });
    const joined = await lateMember.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(joined?.id).toBe(live.teamId);
    expect(joined?.name).toBe("Alpha");
  }, 30_000);

  test("revoke stops a pending member from joining later", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);
    await importRows(importer, fixture, {
      sourceName: "Revoke member",
      clientOperationId: "team-roster-import-revoke",
      rows: [
        {
          rowNumber: 2,
          email: "keep-lead@gmail.com",
          displayName: "Keep Lead",
          teamName: "Revoked",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: "drop-member@gmail.com",
          displayName: "Drop Member",
          teamName: "Revoked",
          role: "member",
        },
      ],
    });
    await drainScheduler(backend);

    const listed = await importer.person.query(api.teamRosters.list, {
      eventSlug: fixture.eventSlug,
      paginationOpts: { numItems: 20, cursor: null },
    });
    const dropEntry = listed.page.find((entry) => entry.email === "drop-member@gmail.com");
    expect(dropEntry?.status).toBe("pending");
    await importer.person.mutation(api.teamRosters.revoke, {
      eventSlug: fixture.eventSlug,
      teamRosterEntryId: dropEntry!.id,
      expectedVersion: dropEntry!.version,
      reason: "Wrong person on this team",
      clientOperationId: "team-roster-revoke-member",
    });

    const lead = await provisionParticipant(backend, fixture, {
      email: "keep-lead@gmail.com",
      googleSubject: "team-roster-keep-lead-subject",
    });
    const dropped = await provisionParticipant(backend, fixture, {
      email: "drop-member@gmail.com",
      googleSubject: "team-roster-drop-member-subject",
    });
    expect(lead.me.pendingTeam).toBeNull();
    expect(dropped.me.pendingTeam).toBeNull();
    const droppedTeam = await dropped.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(droppedTeam).toBeNull();
    const leadTeam = await lead.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(leadTeam?.name).toBe("Revoked");
    expect(leadTeam?.activeMemberCount).toBe(1);
  }, 30_000);

  test("already-on-a-team rows are skipped as soon as they are imported", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);
    const busy = await fillTeam(backend, fixture, "Busy", 1);

    await importRows(importer, fixture, {
      sourceName: "Skip busy",
      clientOperationId: "team-roster-import-busy-pending",
      drain: false,
      rows: [
        {
          rowNumber: 2,
          email: "other-lead@gmail.com",
          displayName: "Other Lead",
          teamName: "Other",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: busy.leadEmail,
          displayName: "Busy Lead",
          teamName: "Other",
          role: "member",
        },
      ],
    });
    const listed = await importer.person.query(api.teamRosters.list, {
      eventSlug: fixture.eventSlug,
      paginationOpts: { numItems: 20, cursor: null },
    });
    const busyRow = listed.page.find((entry) => entry.email === busy.leadEmail);
    expect(busyRow?.status).toBe("skipped_has_team");
  }, 30_000);

  test("a second lead for a live team is not silently saved as a member", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);
    const live = await fillTeam(backend, fixture, "Crown", 1);

    await importRows(importer, fixture, {
      sourceName: "Second lead",
      clientOperationId: "team-roster-import-second-lead",
      rows: [
        {
          rowNumber: 2,
          email: "usurper@gmail.com",
          displayName: "Usurper",
          teamName: "Crown",
          role: "lead",
        },
      ],
    });
    await drainScheduler(backend);

    const usurper = await provisionParticipant(backend, fixture, {
      email: "usurper@gmail.com",
      googleSubject: "team-roster-usurper-subject",
    });
    const usurperTeam = await usurper.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(usurperTeam).toBeNull();
    const liveTeam = await live.lead.person.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(liveTeam?.id).toBe(live.teamId);
    await backend.run(async (ctx) => {
      const leads = await ctx.db
        .query("teamMembers")
        .withIndex("by_team_status", (index) =>
          index.eq("teamId", live.teamId).eq("status", "active"),
        )
        .collect();
      expect(leads.filter((member) => member.role === "lead")).toHaveLength(1);
      expect(leads.some((member) => member.membershipId === usurper.membershipId)).toBe(
        false,
      );
    });
  }, 30_000);

  test("one apply run claims at most five people and preserves follower outcomes", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);
    const rows: ImportRow[] = [];
    for (const [teamIndex, teamName] of ["Quartz", "Topaz"].entries()) {
      for (let memberIndex = 0; memberIndex < 4; memberIndex += 1) {
        const email = `${teamName.toLowerCase()}-${memberIndex}@gmail.com`;
        await provisionParticipant(backend, fixture, {
          email,
          googleSubject: `team-roster-cap-${teamIndex}-${memberIndex}`,
        });
        rows.push({
          rowNumber: 2 + teamIndex * 4 + memberIndex,
          email,
          displayName: `${teamName} ${memberIndex}`,
          teamName,
          role: memberIndex === 0 ? "lead" : "member",
        });
      }
    }

    const preview = await importer.person.query(api.teamRosters.previewImport, {
      eventSlug: fixture.eventSlug,
      sourceName: "Bounded import",
      rows,
      reason: "Verify bounded roster placement",
    });
    const imported = await importer.person.mutation(api.teamRosters.confirmImport, {
      eventSlug: fixture.eventSlug,
      sourceName: "Bounded import",
      rows,
      reason: "Verify bounded roster placement",
      previewChecksum: preview.previewChecksum,
      clientOperationId: "team-roster-import-bounded",
    });

    await backend.mutation(internal.teamRosters.applyImport, {
      teamRosterImportId: imported.teamRosterImportId,
    });
    await backend.run(async (ctx) => {
      const teamRosterImport = await ctx.db.get(imported.teamRosterImportId);
      expect(teamRosterImport?.appliedNowCount).toBe(5);
      const entries = await ctx.db
        .query("teamRosterEntries")
        .withIndex("by_import_row", (index) =>
          index.eq("teamRosterImportId", imported.teamRosterImportId),
        )
        .collect();
      expect(entries.filter((entry) => entry.status === "claimed")).toHaveLength(5);
      expect(entries.filter((entry) => entry.status === "skipped_has_team")).toHaveLength(0);
    });

    await backend.mutation(internal.teamRosters.applyImport, {
      teamRosterImportId: imported.teamRosterImportId,
    });
    await backend.run(async (ctx) => {
      const teamRosterImport = await ctx.db.get(imported.teamRosterImportId);
      expect(teamRosterImport?.appliedNowCount).toBe(8);
      const entries = await ctx.db
        .query("teamRosterEntries")
        .withIndex("by_import_row", (index) =>
          index.eq("teamRosterImportId", imported.teamRosterImportId),
        )
        .collect();
      expect(entries.every((entry) => entry.status === "claimed")).toBe(true);
    });
  }, 30_000);

  test("a locked team does not block the imported person from signing up", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedEvent(backend);
    const importer = await seedImporter(backend, fixture);
    const live = await fillTeam(backend, fixture, "Locked", 1);
    await backend.run(async (ctx) => {
      await ctx.db.patch(live.teamId, { membershipLocked: true });
    });
    const lockedMember = await signInParticipant(backend, fixture, {
      email: "locked-member@gmail.com",
      googleSubject: "team-roster-locked-member-subject",
    });
    await importRows(importer, fixture, {
      sourceName: "Locked team",
      clientOperationId: "team-roster-import-locked",
      rows: [
        {
          rowNumber: 2,
          email: live.leadEmail,
          displayName: "Locked Lead",
          teamName: "Locked",
          role: "lead",
        },
        {
          rowNumber: 3,
          email: lockedMember.email,
          displayName: "Locked Member",
          teamName: "Locked",
          role: "member",
        },
      ],
    });
    await drainScheduler(backend);
    await expect(
      lockedMember.person.mutation(api.participants.provision, {
        eventSlug: fixture.eventSlug,
        participantClass: "external_participant",
      }),
    ).resolves.toMatchObject({ created: true });
    const me = await lockedMember.person.query(api.participants.me, {
      eventSlug: fixture.eventSlug,
    });
    expect(me?.membership).not.toBeNull();
  }, 30_000);
});

type ImportRow = {
  rowNumber: number;
  email: string;
  displayName: string;
  teamName: string;
  role: "lead" | "member";
};

async function importRows(
  importer: Awaited<ReturnType<typeof seedImporter>>,
  fixture: Awaited<ReturnType<typeof seedEvent>>,
  args: {
    sourceName: string;
    clientOperationId: string;
    rows: ImportRow[];
    drain?: boolean;
  },
) {
  const preview = await importer.person.query(api.teamRosters.previewImport, {
    eventSlug: fixture.eventSlug,
    sourceName: args.sourceName,
    rows: args.rows,
    reason: "Committee team assignments",
  });
  await importer.person.mutation(api.teamRosters.confirmImport, {
    eventSlug: fixture.eventSlug,
    sourceName: args.sourceName,
    rows: args.rows,
    reason: "Committee team assignments",
    previewChecksum: preview.previewChecksum,
    clientOperationId: args.clientOperationId,
  });
  if (args.drain === false) return;
}

async function acceptPolicy(
  person: ReturnType<BackendTest["withIdentity"]>,
  fixture: Awaited<ReturnType<typeof seedEvent>>,
  clientOperationId: string,
) {
  await person.mutation(api.participants.acceptPolicy, {
    eventSlug: fixture.eventSlug,
    participantPolicyVersionId: fixture.policyId,
    accepted: true,
    clientOperationId,
  });
}

async function fillTeam(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedEvent>>,
  teamName: string,
  size: number,
) {
  const leadEmail = `${teamName.toLowerCase().replace(/\s+/g, "-")}-lead@gmail.com`;
  const lead = await provisionParticipant(backend, fixture, {
    email: leadEmail,
    googleSubject: `team-roster-${leadEmail}`,
  });
  await acceptPolicy(lead.person, fixture, `accept-${leadEmail}`);
  const created = await lead.person.mutation(api.teams.create, {
    eventSlug: fixture.eventSlug,
    name: teamName,
    clientOperationId: `team-create-${leadEmail}`,
  });
  const team = await lead.person.query(api.teams.current, {
    eventSlug: fixture.eventSlug,
  });
  if (!team) throw new Error("fillTeam did not create a team.");
  for (let index = 1; index < size; index += 1) {
    const email = `${teamName.toLowerCase().replace(/\s+/g, "-")}-member-${index}@gmail.com`;
    const member = await provisionParticipant(backend, fixture, {
      email,
      googleSubject: `team-roster-${email}`,
    });
    await acceptPolicy(member.person, fixture, `accept-${email}`);
    await member.person.mutation(api.teams.join, {
      eventSlug: fixture.eventSlug,
      code: team.publicCode,
      clientOperationId: `team-join-${email}`,
    });
  }
  return {
    teamId: created.teamId,
    publicCode: team.publicCode,
    leadEmail,
    leadMembershipId: lead.membershipId,
    lead,
  };
}

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

async function signInParticipant(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedEvent>>,
  args: {
    email: string;
    googleSubject: string;
    vitHostedDomain?: string;
  },
) {
  const displayName = args.vitHostedDomain ? "VIT Student 24TST0001" : args.email;
  const authUserId = await createAuthUser(backend, fixture.now, displayName, args.email);
  const authSessionId = await createAuthSession(
    backend,
    authUserId,
    fixture.now,
    `team-roster-${args.googleSubject}-token`,
  );
  await seedGoogleIdentity(backend, authUserId, {
    googleSubject: args.googleSubject,
    email: args.email,
    ...(args.vitHostedDomain ? { hostedDomain: args.vitHostedDomain } : {}),
  });
  return {
    email: args.email,
    authUserId,
    authSessionId,
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
  const identity = await signInParticipant(backend, fixture, args);
  await identity.person.mutation(api.participants.provision, {
    eventSlug: fixture.eventSlug,
    participantClass: args.vitHostedDomain ? "vit_student" : "external_participant",
  });
  const me = await identity.person.query(api.participants.me, { eventSlug: fixture.eventSlug });
  if (!me?.membership) throw new Error("Provisioning did not create a membership.");
  return {
    authUserId: identity.authUserId,
    authSessionId: identity.authSessionId,
    personId: me.person.id,
    membershipId: me.membership.id,
    membership: me.membership,
    me,
    person: identity.person,
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
