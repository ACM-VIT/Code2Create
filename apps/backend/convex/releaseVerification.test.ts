import { convexTest, type TestConvex } from "convex-test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
  inspectReleaseFixture,
  requireStagingReleaseDeployment,
} from "./releaseVerification.ts";
import {
  defaultParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
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
      version: 1,
      createdAt: now,
      updatedAt: now,
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
    await ctx.db.patch(eventId, {
      publishedParticipantPolicyId: participantPolicyId,
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
      onboardingStatus: "project_required",
      acceptedParticipantPolicyVersionIds: [participantPolicyId],
      createdAt: now,
      updatedAt: now,
    });
    const participantProfileId = await ctx.db.insert("participantProfiles", {
      eventId,
      membershipId: participantMembershipId,
      participantClass: "external_participant",
      fullName: "Participant Release",
      institution: "Fixture University",
      yearOfStudy: "first",
      externalCountry: "India",
      profileVersion: 1,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Release team",
      publicCode: "RELEASE1",
      leadMembershipId: participantMembershipId,
      status: "forming",
      membershipLocked: false,
      trackLocked: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId: participantMembershipId,
      role: "lead",
      status: "active",
      joinedAt: now,
      source: "created",
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
      eventSlug,
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
