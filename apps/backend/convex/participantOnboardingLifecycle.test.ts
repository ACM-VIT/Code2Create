import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

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

describe("participant onboarding lifecycle", () => {
  test("keeps consent explicit while allowing team creation before profile completion", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedParticipant(backend);
    const participant = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });

    await expect(participant.mutation(api.teams.create, {
      eventSlug: fixture.eventSlug,
      name: "Quiet Circuit",
      clientOperationId: "team-before-consent",
    })).rejects.toThrow("Accept the current participant policy");

    const acceptance = {
      eventSlug: fixture.eventSlug,
      participantPolicyVersionId: fixture.policyId,
      accepted: true,
      clientOperationId: "accept-policy-once",
    } as const;
    const firstAcceptance = await participant.mutation(api.participants.acceptPolicy, acceptance);
    const replayedAcceptance = await participant.mutation(api.participants.acceptPolicy, acceptance);
    expect(replayedAcceptance).toEqual(firstAcceptance);
    await expect(
      participant.query(api.access.participantCapabilities, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toMatchObject({ teamJoin: true });

    await backend.run(async (ctx) => {
      const membership = await ctx.db.get(fixture.membershipId);
      if (!membership) throw new Error("The participant membership is missing.");
      expect(membership.acceptedParticipantPolicyVersionIds).toEqual([fixture.policyId]);
      expect(await ctx.db
        .query("participantProfiles")
        .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
        .unique()).toBeNull();
      expect(await ctx.db
        .query("operationResults")
        .withIndex("by_actor_operation", (index) =>
          index
            .eq("actorPersonId", fixture.personId)
            .eq("clientOperationId", acceptance.clientOperationId),
        )
        .collect()).toHaveLength(1);
    });

    await backend.run(async (ctx) => {
      const teamJoinGrant = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", fixture.subjectId)
            .eq("permissionKey", "team.join")
            .eq("status", "active"),
        )
        .unique();
      if (!teamJoinGrant) throw new Error("The team-join grant is missing.");
      await ctx.db.patch(teamJoinGrant._id, {
        status: "revoked",
        revokedAt: fixture.now + 1,
        revokedByPersonId: fixture.personId,
        revokeReason: "Permission-boundary test",
      });
    });
    await expect(
      participant.query(api.access.participantCapabilities, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toMatchObject({ teamJoin: false });
    await expect(participant.mutation(api.teams.create, {
      eventSlug: fixture.eventSlug,
      name: "Quiet Circuit",
      clientOperationId: "team-without-permission",
    })).rejects.toThrow();

    await backend.run(async (ctx) => {
      const teamJoinGrant = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", fixture.subjectId)
            .eq("permissionKey", "team.join")
            .eq("status", "revoked"),
        )
        .unique();
      if (!teamJoinGrant) throw new Error("The revoked team-join grant is missing.");
      await ctx.db.patch(teamJoinGrant._id, {
        status: "active",
        revokedAt: undefined,
        revokedByPersonId: undefined,
        revokeReason: undefined,
      });
    });
    await expect(
      participant.query(api.access.participantCapabilities, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toMatchObject({ teamJoin: true });

    const createRequest = {
      eventSlug: fixture.eventSlug,
      name: "Quiet Circuit",
      clientOperationId: "team-create-once",
    } as const;
    const created = await participant.mutation(api.teams.create, createRequest);
    const replayed = await participant.mutation(api.teams.create, createRequest);
    expect(replayed).toEqual(created);

    await backend.run(async (ctx) => {
      const membership = await ctx.db.get(fixture.membershipId);
      const teamMembers = await ctx.db
        .query("teamMembers")
        .withIndex("by_team_status", (index) =>
          index.eq("teamId", created.teamId).eq("status", "active"),
        )
        .collect();
      expect(membership?.onboardingStatus).toBe("profile_required");
      expect(teamMembers).toHaveLength(1);
      expect(teamMembers[0]?.membershipId).toBe(fixture.membershipId);
      expect(teamMembers[0]?.role).toBe("lead");
    });

    const currentTeam = await participant.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    expect(currentTeam?.activeMemberCount).toBe(1);
    expect(currentTeam).toMatchObject({
      canLeave: true,
      canManageMembers: true,
      canTransferLeadership: true,
      canRespondToLeadershipTransfer: true,
      canWriteProject: true,
      canSubmitApplication: true,
      canRespondToInformationRequest: true,
      canRespondToOffer: true,
    });

    await expect(
      participant.query(api.access.participantCapabilities, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toMatchObject({
      profileRead: true,
      profileWrite: true,
      teamJoin: true,
      hasTeamMembership: true,
      teamRead: true,
      integrations: true,
      notifications: true,
    });
    const profileReadGrantId = await backend.run(async (ctx) => {
      const profileReadGrant = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", fixture.subjectId)
            .eq("permissionKey", "participant.profile.read")
            .eq("status", "active"),
        )
        .unique();
      if (
        !profileReadGrant ||
        profileReadGrant.scopeType !== "self" ||
        profileReadGrant.scopeId !== fixture.membershipId
      ) {
        throw new Error("The exact profile-read grant is missing.");
      }
      await ctx.db.patch(profileReadGrant._id, {
        status: "revoked",
        revokedAt: fixture.now + 1,
        revokedByPersonId: fixture.personId,
        revokeReason: "Permission-boundary test",
      });
      return profileReadGrant._id;
    });
    await expect(
      participant.query(api.access.participantCapabilities, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toMatchObject({ profileRead: false, profileWrite: true });
    await expect(
      participant.query(api.participants.me, { eventSlug: fixture.eventSlug }),
    ).resolves.toMatchObject({
      membership: { id: fixture.membershipId },
      profile: null,
    });
    await backend.run(async (ctx) => {
      await ctx.db.patch(profileReadGrantId, {
        status: "active",
        revokedAt: undefined,
        revokedByPersonId: undefined,
        revokeReason: undefined,
      });
    });
    const projectWriteGrantId = await backend.run(async (ctx) => {
      const projectWriteGrant = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", fixture.subjectId)
            .eq("permissionKey", "team.project.write")
            .eq("status", "active"),
        )
        .unique();
      if (
        !projectWriteGrant ||
        projectWriteGrant.scopeType !== "team" ||
        projectWriteGrant.scopeId !== created.teamId
      ) {
        throw new Error("The exact project-write grant is missing.");
      }
      await ctx.db.patch(projectWriteGrant._id, {
        status: "revoked",
        revokedAt: fixture.now + 1,
        revokedByPersonId: fixture.personId,
        revokeReason: "Permission-boundary test",
      });
      return projectWriteGrant._id;
    });
    await expect(
      participant.query(api.teams.current, { eventSlug: fixture.eventSlug }),
    ).resolves.toMatchObject({ canWriteProject: false, canLeave: true });
    await backend.run(async (ctx) => {
      await ctx.db.patch(projectWriteGrantId, {
        status: "active",
        revokedAt: undefined,
        revokedByPersonId: undefined,
        revokeReason: undefined,
      });
    });
    const teamReadGrantId = await backend.run(async (ctx) => {
      const teamReadGrant = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", fixture.subjectId)
            .eq("permissionKey", "team.read")
            .eq("status", "active"),
        )
        .unique();
      if (
        !teamReadGrant ||
        teamReadGrant.scopeType !== "team" ||
        teamReadGrant.scopeId !== created.teamId
      ) {
        throw new Error("The exact team-read grant is missing.");
      }
      await ctx.db.patch(teamReadGrant._id, {
        status: "revoked",
        revokedAt: fixture.now + 1,
        revokedByPersonId: fixture.personId,
        revokeReason: "Permission-boundary test",
      });
      return teamReadGrant._id;
    });
    await expect(
      participant.query(api.access.participantCapabilities, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toMatchObject({
      hasTeamMembership: true,
      teamRead: false,
      integrations: true,
      notifications: true,
    });
    await expect(
      participant.query(api.teams.current, { eventSlug: fixture.eventSlug }),
    ).resolves.toBeNull();
    await expect(
      participant.query(api.teams.members, {
        eventSlug: fixture.eventSlug,
        paginationOpts: { numItems: 25, cursor: null },
      }),
    ).resolves.toEqual({ page: [], isDone: true, continueCursor: "" });
    await expect(
      participant.query(api.intake.status, { eventSlug: fixture.eventSlug }),
    ).resolves.toBeNull();
    await backend.run(async (ctx) => {
      await ctx.db.patch(teamReadGrantId, {
        status: "active",
        revokedAt: undefined,
        revokedByPersonId: undefined,
        revokeReason: undefined,
      });
    });

    const integrationReadGrantId = await backend.run(async (ctx) => {
      const integrationReadGrant = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", fixture.subjectId)
            .eq("permissionKey", "integration.read")
            .eq("status", "active"),
        )
        .unique();
      if (
        !integrationReadGrant ||
        integrationReadGrant.scopeType !== "team" ||
        integrationReadGrant.scopeId !== created.teamId
      ) {
        throw new Error("The exact integration-read grant is missing.");
      }
      await ctx.db.patch(integrationReadGrant._id, {
        status: "revoked",
        revokedAt: fixture.now + 2,
        revokedByPersonId: fixture.personId,
        revokeReason: "Permission-boundary test",
      });
      return integrationReadGrant._id;
    });
    await expect(
      participant.query(api.access.participantCapabilities, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toMatchObject({ integrations: false });
    await expect(
      participant.query(api.githubIntegrations.current, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toBeNull();
    await expect(
      participant.query(api.figmaIntegrations.current, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toBeNull();
    await backend.run(async (ctx) => {
      await ctx.db.patch(integrationReadGrantId, {
        status: "active",
        revokedAt: undefined,
        revokedByPersonId: undefined,
        revokeReason: undefined,
      });
    });

    const notificationReadGrantId = await backend.run(async (ctx) => {
      const notificationReadGrant = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", fixture.subjectId)
            .eq("permissionKey", "communications.delivery.self.read")
            .eq("status", "active"),
        )
        .unique();
      if (
        !notificationReadGrant ||
        notificationReadGrant.scopeType !== "self" ||
        notificationReadGrant.scopeId !== fixture.membershipId
      ) {
        throw new Error("The exact notification-read grant is missing.");
      }
      await ctx.db.patch(notificationReadGrant._id, {
        status: "revoked",
        revokedAt: fixture.now + 3,
        revokedByPersonId: fixture.personId,
        revokeReason: "Permission-boundary test",
      });
      return notificationReadGrant._id;
    });
    await expect(
      participant.query(api.access.participantCapabilities, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toMatchObject({ notifications: false });
    await expect(
      participant.query(api.participantNotifications.mine, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toBeNull();
    await backend.run(async (ctx) => {
      await ctx.db.patch(notificationReadGrantId, {
        status: "active",
        revokedAt: undefined,
        revokedByPersonId: undefined,
        revokeReason: undefined,
      });
    });

    const duplicateTransferIds = await backend.run(async (ctx) => {
      const transfer = {
        eventId: fixture.eventId,
        teamId: created.teamId,
        fromMembershipId: fixture.membershipId,
        toMembershipId: fixture.membershipId,
        expectedTeamVersion: 1,
        state: "pending" as const,
        requestedByPersonId: fixture.personId,
        requestedAt: fixture.now,
        expiresAt: fixture.now + 60_000,
      };
      return Promise.all([
        ctx.db.insert("teamLeadershipTransfers", {
          ...transfer,
          clientOperationId: "duplicate-transfer-one",
        }),
        ctx.db.insert("teamLeadershipTransfers", {
          ...transfer,
          clientOperationId: "duplicate-transfer-two",
        }),
      ]);
    });
    await expect(
      participant.query(api.teams.current, { eventSlug: fixture.eventSlug }),
    ).rejects.toThrow("more than one pending leadership transfer");
    await backend.run(async (ctx) => {
      await Promise.all(
        duplicateTransferIds.map((transferId) =>
          ctx.db.delete("teamLeadershipTransfers", transferId),
        ),
      );
      for (let index = 0; index < 4; index += 1) {
        const personId = await ctx.db.insert("people", {
          authUserId: `overflow-member-auth-${index}`,
          googleSubject: `overflow-member-google-${index}`,
          verifiedEmail: `overflow-member-${index}@example.test`,
          displayName: `Overflow Member ${index}`,
          status: "active",
          createdAt: fixture.now,
          updatedAt: fixture.now,
        });
        const subjectId = await ctx.db.insert("eventAccessSubjects", {
          eventId: fixture.eventId,
          personId,
          emailNormalized: `overflow-member-${index}@example.test`,
          displayName: `Overflow Member ${index}`,
          status: "active",
          linkedBy: "participant_provisioning",
          accessVersion: 1,
          createdAt: fixture.now,
          updatedAt: fixture.now,
        });
        const membershipId = await ctx.db.insert("eventMemberships", {
          eventId: fixture.eventId,
          personId,
          eventAccessSubjectId: subjectId,
          participantClass: "external_participant",
          eligibilityStatus: "eligible",
          onboardingStatus: "project_required",
          acceptedParticipantPolicyVersionIds: [fixture.policyId],
          createdAt: fixture.now,
          updatedAt: fixture.now,
        });
        await ctx.db.insert("teamMembers", {
          eventId: fixture.eventId,
          teamId: created.teamId,
          membershipId,
          role: "member",
          status: "active",
          joinedAt: fixture.now,
          source: "invitation",
        });
      }
      await ctx.db.patch(created.teamId, {
        activeMemberCount: 5,
        activeVitMemberCount: 0,
        activeExternalMemberCount: 5,
      });
    });
    await expect(
      participant.query(api.teams.current, { eventSlug: fixture.eventSlug }),
    ).rejects.toThrow("exceeds the published participant-policy maximum size");

    await backend.run(async (ctx) => {
      const event = await ctx.db.get(fixture.eventId);
      if (!event) throw new Error("The onboarding event is missing.");
      await ctx.db.patch(event._id, {
        status: "registration_closed",
        version: event.version + 1,
        updatedAt: fixture.now + 2,
      });
    });
    expect(await participant.mutation(api.teams.create, createRequest)).toEqual(created);
    await expect(participant.mutation(api.teams.leave, {
      eventSlug: fixture.eventSlug,
      teamId: created.teamId,
      expectedTeamVersion: 1,
      clientOperationId: "leave-after-applications-close",
    })).rejects.toThrow("Applications are closed");
  }, 10_000);

  test("transfers team leadership and its exact grants through an idempotent acceptance", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedParticipant(backend);
    const nextLead = await seedAdditionalParticipant(backend, fixture);
    const currentLeadClient = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const nextLeadClient = backend.withIdentity({
      subject: nextLead.authUserId,
      sessionId: nextLead.authSessionId,
    });

    await currentLeadClient.mutation(api.participants.acceptPolicy, {
      eventSlug: fixture.eventSlug,
      participantPolicyVersionId: fixture.policyId,
      accepted: true,
      clientOperationId: "lead-policy-acceptance",
    });
    await nextLeadClient.mutation(api.participants.acceptPolicy, {
      eventSlug: fixture.eventSlug,
      participantPolicyVersionId: fixture.policyId,
      accepted: true,
      clientOperationId: "next-lead-policy-acceptance",
    });

    const created = await currentLeadClient.mutation(api.teams.create, {
      eventSlug: fixture.eventSlug,
      name: "Transfer Test",
      clientOperationId: "transfer-team-create",
    });
    await nextLeadClient.mutation(api.teams.join, {
      eventSlug: fixture.eventSlug,
      code: created.publicCode,
      clientOperationId: "transfer-team-join",
    });

    const request = {
      eventSlug: fixture.eventSlug,
      toMembershipId: nextLead.membershipId,
      expectedTeamVersion: 2,
      clientOperationId: "lead-transfer-request-once",
    } as const;
    const transfer = await currentLeadClient.mutation(api.teams.requestLeadershipTransfer, request);
    expect(await currentLeadClient.mutation(api.teams.requestLeadershipTransfer, request)).toEqual(transfer);

    await expect(currentLeadClient.mutation(api.teams.respondToLeadershipTransfer, {
      eventSlug: fixture.eventSlug,
      transferId: transfer.transferId,
      accept: true,
      clientOperationId: "wrong-person-transfer-response",
    })).rejects.toThrow("not available");

    const response = {
      eventSlug: fixture.eventSlug,
      transferId: transfer.transferId,
      accept: true,
      clientOperationId: "lead-transfer-accept-once",
    } as const;
    expect(await nextLeadClient.mutation(api.teams.respondToLeadershipTransfer, response)).toEqual({
      state: "accepted",
    });
    expect(await nextLeadClient.mutation(api.teams.respondToLeadershipTransfer, response)).toEqual({
      state: "accepted",
    });

    const [oldLeadView, newLeadView] = await Promise.all([
      currentLeadClient.query(api.teams.current, { eventSlug: fixture.eventSlug }),
      nextLeadClient.query(api.teams.current, { eventSlug: fixture.eventSlug }),
    ]);
    expect(oldLeadView?.currentRole).toBe("member");
    expect(newLeadView?.currentRole).toBe("lead");
    expect(newLeadView?.version).toBe(3);
    expect(oldLeadView).toMatchObject({
      canLeave: true,
      canManageMembers: false,
      canTransferLeadership: false,
      canRespondToLeadershipTransfer: true,
      canWriteProject: true,
      canSubmitApplication: false,
      canRespondToInformationRequest: false,
      canRespondToOffer: false,
    });
    expect(newLeadView).toMatchObject({
      canLeave: true,
      canManageMembers: true,
      canTransferLeadership: true,
      canRespondToLeadershipTransfer: true,
      canWriteProject: true,
      canSubmitApplication: true,
      canRespondToInformationRequest: true,
      canRespondToOffer: true,
    });

    await backend.run(async (ctx) => {
      const oldLeadGrants = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", fixture.subjectId)
            .eq("permissionKey", "team.lead.transfer")
            .eq("status", "active"),
        )
        .collect();
      const newLeadGrants = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", nextLead.subjectId)
            .eq("permissionKey", "team.lead.transfer")
            .eq("status", "active"),
        )
        .collect();
      expect(oldLeadGrants).toHaveLength(0);
      expect(newLeadGrants).toHaveLength(1);
      expect(newLeadGrants[0]?.scopeType).toBe("team");
      expect(newLeadGrants[0]?.scopeId).toBe(created.teamId);
    });
  }, 10_000);
});

async function seedParticipant(backend: BackendTest) {
  const now = Date.UTC(2027, 6, 1, 9, 0);
  const eventSlug = "participant-onboarding";
  const authUserId = await createAuthUser(backend, now);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: "participant-onboarding-google-subject",
      verifiedEmail: "participant@example.test",
      displayName: "Aarav Menon",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Code2Create participant onboarding fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
      createdByPersonId: personId,
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
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, { publishedParticipantPolicyId: policyId });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: "participant@example.test",
      displayName: "Aarav Menon",
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
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "participant.profile.read",
      scopeType: "self",
      scopeId: membershipId,
      sourceType: "participant_membership",
      sourceId: membershipId,
      reason: "Participant onboarding fixture",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "participant.profile.write",
      scopeType: "self",
      scopeId: membershipId,
      sourceType: "participant_membership",
      sourceId: membershipId,
      reason: "Participant onboarding fixture",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "team.join",
      scopeType: "self",
      scopeId: membershipId,
      sourceType: "participant_membership",
      sourceId: membershipId,
      reason: "Participant onboarding fixture",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "communications.delivery.self.read",
      scopeType: "self",
      scopeId: membershipId,
      sourceType: "participant_membership",
      sourceId: membershipId,
      reason: "Participant onboarding fixture",
    });
    return {
      now,
      eventSlug,
      eventId,
      personId,
      subjectId,
      membershipId,
      policyId,
      authUserId,
      authSessionId,
    };
  });
}

async function seedAdditionalParticipant(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedParticipant>>,
) {
  const identity = {
    name: "Meera Rao",
    email: "meera@example.test",
    googleSubject: "participant-onboarding-next-lead-google-subject",
    sessionToken: "participant-onboarding-next-lead-session-token",
  };
  const authUserId = await createAuthUser(backend, fixture.now, identity.name, identity.email);
  const authSessionId = await createAuthSession(
    backend,
    authUserId,
    fixture.now,
    identity.sessionToken,
  );
  return backend.run(async (ctx) => {
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
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId: fixture.eventId,
      personId,
      eventAccessSubjectId: subjectId,
      participantClass: "external_participant",
      eligibilityStatus: "eligible",
      onboardingStatus: "profile_required",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: fixture.now,
      updatedAt: fixture.now,
    });
    for (const permissionKey of [
      "participant.profile.read",
      "participant.profile.write",
      "team.join",
    ] as const) {
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "self",
        scopeId: membershipId,
        sourceType: "participant_membership",
        sourceId: membershipId,
        reason: "Participant onboarding transfer fixture",
      });
    }
    return { authUserId, authSessionId, personId, subjectId, membershipId };
  });
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
    throw new Error(`${label} did not return a document ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid document ID.`);
  }
  return id;
}
