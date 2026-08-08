import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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
  });
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

async function createAuthUser(backend: BackendTest, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Aarav Menon",
        email: "participant@example.test",
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
        token: "participant-onboarding-session-token",
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
