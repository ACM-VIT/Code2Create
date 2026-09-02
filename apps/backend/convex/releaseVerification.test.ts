import { convexTest, type TestConvex } from "convex-test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defaultParticipantEmailTemplates } from "@code2create/domain";

import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
  inspectReleaseFixture,
  requireStagingReleaseDeployment,
} from "./releaseVerification.ts";
import {
  communicationsPolicyChecksum,
  normalizeCommunicationsPolicy,
} from "./lib/communicationsPolicy.ts";
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
} from "./lib/intakePolicy.ts";
import {
  defaultParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import {
  createTestSubmissionSnapshot,
  linkTestSubmissionSnapshot,
} from "./lib/testSubmissionSnapshot.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;
const originalGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

beforeAll(() => {
  process.env.GOOGLE_CLIENT_ID = "release-fixture-client";
  process.env.GOOGLE_CLIENT_SECRET = "release-fixture-secret";
});

afterAll(() => {
  restoreEnvironment("GOOGLE_CLIENT_ID", originalGoogleClientId);
  restoreEnvironment("GOOGLE_CLIENT_SECRET", originalGoogleClientSecret);
});

describe("release verification", () => {
  test("runs only when the deployment identifies itself as staging", () => {
    expect(() => requireStagingReleaseDeployment(undefined)).toThrow(
      /only on the staging Convex deployment/u,
    );
    expect(() => requireStagingReleaseDeployment("production")).toThrow(
      /only on the staging Convex deployment/u,
    );
    expect(() => requireStagingReleaseDeployment("staging")).not.toThrow();
  });

  test("accepts one complete participant and directly scoped operations account", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedReleaseFixture(backend, {
      operationsRole: null,
      rehearsalGrant: true,
      teamReadScope: "team",
    });

    const readiness = await inspectFixture(backend, fixture);

    expect(readiness).toEqual({ missing: [] });
  });

  test("does not treat a Supreme role as an operations permission", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedReleaseFixture(backend, {
      operationsRole: "supreme",
      rehearsalGrant: false,
      teamReadScope: "team",
    });

    const readiness = await inspectFixture(backend, fixture);

    expect(readiness.missing).toEqual(["operations_rehearsal_read"]);
  });

  test("requires the participant team grant to name the fixture team", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedReleaseFixture(backend, {
      operationsRole: null,
      rehearsalGrant: true,
      teamReadScope: "event",
    });

    const readiness = await inspectFixture(backend, fixture);

    expect(readiness.missing).toEqual(["participant_team_read"]);
  });

  test("requires the participant code and design grant for the fixture team", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedReleaseFixture(backend, {
      operationsRole: null,
      rehearsalGrant: true,
      teamReadScope: "team",
    });
    await backend.run(async (ctx) => {
      const grant = await ctx.db
        .query("permissionGrants")
        .withIndex("by_event_permission_status", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("permissionKey", "integration.read")
            .eq("status", "active"),
        )
        .unique();
      if (!grant) throw new Error("The release fixture integration grant is missing.");
      await ctx.db.patch(grant._id, { status: "revoked", revokedAt: Date.now() });
    });

    const readiness = await inspectFixture(backend, fixture);

    expect(readiness.missing).toEqual(["participant_integration_read"]);
  });

  test("rejects a profile that no longer accepts the published policy", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedReleaseFixture(backend, {
      operationsRole: null,
      rehearsalGrant: true,
      teamReadScope: "team",
    });
    await backend.run((ctx) =>
      ctx.db.patch(fixture.participantMembershipId, {
        acceptedParticipantPolicyVersionIds: [],
      }),
    );

    const readiness = await inspectFixture(backend, fixture);

    expect(readiness.missing).toEqual(["participant_profile"]);
  });

  test("requires the confirmed participant home and its published event details", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedReleaseFixture(backend, {
      operationsRole: null,
      rehearsalGrant: true,
      teamReadScope: "team",
    });
    await backend.run(async (ctx) => {
      await Promise.all([
        ctx.db.patch(fixture.eventId, { publishedCommunicationsPolicyId: undefined }),
        ctx.db.patch(fixture.applicationId, { state: "submitted" }),
      ]);
      return null;
    });

    const readiness = await inspectFixture(backend, fixture);

    expect(readiness.missing).toEqual([
      "published_communications_policy",
      "participant_confirmed_application",
    ]);
  });

  test("requires a current materialized operations overview", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedReleaseFixture(backend, {
      operationsRole: null,
      rehearsalGrant: true,
      teamReadScope: "team",
    });
    await backend.run((ctx) => ctx.db.delete(fixture.operationsHealthSnapshotId));

    const readiness = await inspectFixture(backend, fixture);

    expect(readiness.missing).toEqual(["operations_health_snapshot"]);
  });
});

type Fixture = Awaited<ReturnType<typeof seedReleaseFixture>>;

async function inspectFixture(backend: BackendTest, fixture: Fixture) {
  return backend.run((ctx) =>
    inspectReleaseFixture(ctx, {
      eventSlug: fixture.eventSlug,
      operationsAccountEmail: fixture.operationsEmail,
      participantAccountEmail: fixture.participantEmail,
    }),
  );
}

async function seedReleaseFixture(
  backend: BackendTest,
  options: {
    operationsRole: "supreme" | null;
    rehearsalGrant: boolean;
    teamReadScope: "event" | "team";
  },
) {
  const now = Date.UTC(2027, 1, 2, 3, 4, 5);
  const healthGeneratedAt = Date.now();
  const startsAt = now + 7 * 24 * 60 * 60 * 1_000;
  const endsAt = startsAt + 36 * 60 * 60 * 1_000;
  const eventSlug = "release-fixture";
  const participantEmail = "participant.release@example.com";
  const operationsEmail = "operations.release@example.com";
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Release fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
      startsAt,
      endsAt,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const operationsHealthSnapshotId = await ctx.db.insert("operationsHealthSnapshots", {
      eventId,
      snapshot: {
        generatedAt: healthGeneratedAt,
        event: {
          slug: eventSlug,
          name: "Release fixture",
          timezone: "Asia/Kolkata",
          status: "registration_open",
        },
        summary: {
          status: "healthy",
          signalCount: 0,
          criticalSignalCount: 0,
          attentionSignalCount: 0,
          watchSignalCount: 0,
        },
        signals: [],
      },
      eventVersion: 1,
      state: "ready",
      staleAt: healthGeneratedAt + 90_000,
    });
    const participantPersonId = await insertPerson(
      ctx,
      "participant-release",
      participantEmail,
      now,
    );
    const operationsPersonId = await insertPerson(
      ctx,
      "operations-release",
      operationsEmail,
      now,
    );
    const participantPolicyId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...defaultParticipantPolicy,
      checksum: participantPolicyChecksum(defaultParticipantPolicy),
      createdByPersonId: operationsPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const communicationsPolicy = normalizeCommunicationsPolicy({
      venueName: "VIT Main Building",
      venueAddress: "Vellore Institute of Technology, Vellore",
      startsAt,
      endsAt,
      nextSteps: [
        {
          stableKey: "join_discord",
          title: "Join Discord",
          detail: "Use the event Discord for announcements and support.",
          actionUrl: "https://discord.gg/code2create",
        },
      ],
      discordUrl: "https://discord.gg/code2create",
      discordLabel: "Open Discord",
      notificationProvider: "cloudflare_email",
      emailTemplates: defaultParticipantEmailTemplates(),
    });
    const communicationsPolicyId = await ctx.db.insert("communicationsPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...communicationsPolicy,
      checksum: communicationsPolicyChecksum(communicationsPolicy),
      createdByPersonId: operationsPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const intakePolicyId = await ctx.db.insert("intakePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...defaultDeterministicIntakePolicy,
      checksum: intakePolicyChecksum(defaultDeterministicIntakePolicy),
      createdByPersonId: operationsPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const admissionPolicyId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      version: "release-fixture-admission-v1",
      status: "published",
      aiRecommendationMode: "disabled",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 100,
      criteria: [],
      decisionReasonCodes: [],
      checksum: "release-fixture-admission-policy",
      createdByPersonId: operationsPersonId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, {
      publishedParticipantPolicyId: participantPolicyId,
      publishedCommunicationsPolicyId: communicationsPolicyId,
      publishedIntakePolicyId: intakePolicyId,
      publishedAdmissionPolicyId: admissionPolicyId,
    });
    const participantSubjectId = await insertSubject(
      ctx,
      eventId,
      participantPersonId,
      participantEmail,
      "participant_provisioning",
      now,
    );
    const operationsSubjectId = await insertSubject(
      ctx,
      eventId,
      operationsPersonId,
      operationsEmail,
      "access_invitation",
      now,
    );
    const participantMembershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId: participantPersonId,
      eventAccessSubjectId: participantSubjectId,
      participantClass: "external_participant",
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [participantPolicyId],
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("participantProfiles", {
      eventId,
      membershipId: participantMembershipId,
      participantClass: "external_participant",
      fullName: "Participant Release",
      phone: "+91 90000 00000",
      gender: "female",
      institution: "Fixture University",
      yearOfStudy: "first",
      externalUniversity: "Fixture University",
      externalCollege: "Fixture College",
      profileVersion: 1,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Release team",
      publicCode: "RELEASE1",
      leadMembershipId: participantMembershipId,
      status: "confirmed",
      activeMemberCount: 1,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 1,
      membershipLocked: true,
      version: 2,
      createdAt: now,
      updatedAt: now,
    });
    const teamMemberId = await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId: participantMembershipId,
      role: "lead",
      status: "active",
      joinedAt: now,
      source: "created",
    });
    const submissionAttemptId = await createTestSubmissionSnapshot(ctx, {
      eventId,
      teamId,
      teamMemberIds: [teamMemberId],
      intakePolicyVersionId: intakePolicyId,
      participantPolicyVersionId: participantPolicyId,
      admissionPolicyVersionId: admissionPolicyId,
      submittedAt: now,
    });
    const projectVersionId = await ctx.db.insert("projectVersions", {
      eventId,
      teamId,
      version: 1,
      initialIdea: "A practical release-verification project.",
      intakePolicyVersionId: intakePolicyId,
      intakeResponses: [],
      lockedRosterSnapshotId: submissionAttemptId,
      lockedMemberCount: 1,
      lockedLeadMembershipId: participantMembershipId,
      freshForEventAttestation: {
        participantPolicyVersionId: participantPolicyId,
        acceptedByMembershipId: participantMembershipId,
        acceptedAt: now,
      },
      finalConfirmation: {
        participantPolicyVersionId: participantPolicyId,
        previewedDraftVersion: 1,
        previewedTeamVersion: 1,
        confirmedByMembershipId: participantMembershipId,
        confirmedAt: now,
      },
      participantPolicyVersionId: participantPolicyId,
      admissionPolicyVersionId: admissionPolicyId,
      sourceDraftVersion: 1,
      submittedByMembershipId: participantMembershipId,
      submittedAt: now,
    });
    const applicationId = await ctx.db.insert("applications", {
      eventId,
      teamId,
      submittedProjectVersionId: projectVersionId,
      admissionPolicyVersionId: admissionPolicyId,
      state: "confirmed",
      decisionStage: "released",
      experienceBand: "mixed_or_external",
      aiDisposition: "unavailable",
      humanDecision: "accept",
      humanReasonCode: "release_fixture_accept",
      decidedByPersonId: operationsPersonId,
      decidedAt: now,
      assignedReviewCount: 1,
      completedReviewCount: 1,
      contentVersion: 1,
      version: 3,
      submittedAt: now,
    });
    await linkTestSubmissionSnapshot(ctx, {
      submissionAttemptId,
      projectVersionId,
      applicationId,
    });
    await ctx.db.patch(teamId, {
      lockedProjectVersionId: projectVersionId,
      lockedAt: now,
      lockParticipantPolicyVersionId: participantPolicyId,
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId: participantPersonId,
      eventAccessSubjectId: participantSubjectId,
      permissionKey: "participant.profile.read",
      scopeType: "self",
      scopeId: participantMembershipId,
      sourceType: "participant_membership",
      sourceId: participantMembershipId,
      reason: "Release fixture participant profile",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId: participantPersonId,
      eventAccessSubjectId: participantSubjectId,
      permissionKey: "team.read",
      ...(options.teamReadScope === "team"
        ? { scopeType: "team", scopeId: teamId }
        : { scopeType: "event" }),
      sourceType: "team_membership",
      sourceId: teamId,
      reason: "Release fixture team",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId: participantPersonId,
      eventAccessSubjectId: participantSubjectId,
      permissionKey: "integration.read",
      scopeType: "team",
      scopeId: teamId,
      sourceType: "team_membership",
      sourceId: teamId,
      reason: "Release fixture code and design access",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId: operationsPersonId,
      eventAccessSubjectId: operationsSubjectId,
      permissionKey: "operations.health.read",
      scopeType: "event",
      sourceType: "manual",
      sourceId: "release-fixture-health",
      reason: "Release fixture health access",
    });
    if (options.rehearsalGrant) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: operationsPersonId,
        eventAccessSubjectId: operationsSubjectId,
        permissionKey: "rehearsal.read",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "release-fixture-rehearsal",
        reason: "Release fixture rehearsal access",
      });
    }
    if (options.operationsRole) {
      await ctx.db.insert("eventRoles", {
        eventId,
        personId: operationsPersonId,
        eventAccessSubjectId: operationsSubjectId,
        role: options.operationsRole,
        validFrom: now,
        status: "active",
        sourceType: "production_seed",
        sourceId: "release-fixture-role",
        assignedByPersonId: operationsPersonId,
        createdAt: now,
      });
    }
    return {
      eventId,
      eventSlug,
      applicationId,
      operationsHealthSnapshotId,
      operationsEmail,
      participantEmail,
      participantMembershipId,
    };
  });
}

async function insertPerson(
  ctx: MutationCtx,
  key: string,
  email: string,
  now: number,
) {
  return ctx.db.insert("people", {
    authUserId: `${key}-auth`,
    googleSubject: `${key}-google`,
    verifiedEmail: email,
    displayName: key,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertSubject(
  ctx: MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  email: string,
  linkedBy: "participant_provisioning" | "access_invitation",
  now: number,
) {
  return ctx.db.insert("eventAccessSubjects", {
    eventId,
    personId,
    emailNormalized: email,
    displayName: email,
    status: "active",
    linkedBy,
    accessVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
