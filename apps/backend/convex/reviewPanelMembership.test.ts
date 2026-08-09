import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant, type GrantSource } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;
type Fixture = Awaited<ReturnType<typeof seedPanel>>;

const originalAuthSiteUrl = process.env.AUTH_SITE_URL;
const originalParticipantSiteUrl = process.env.PARTICIPANT_SITE_URL;
const originalOperationsSiteUrl = process.env.OPERATIONS_SITE_URL;
const originalHandbookSiteUrl = process.env.HANDBOOK_SITE_URL;

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";
process.env.HANDBOOK_SITE_URL = "http://localhost:4175";

afterAll(() => {
  restoreEnvironment("AUTH_SITE_URL", originalAuthSiteUrl);
  restoreEnvironment("PARTICIPANT_SITE_URL", originalParticipantSiteUrl);
  restoreEnvironment("OPERATIONS_SITE_URL", originalOperationsSiteUrl);
  restoreEnvironment("HANDBOOK_SITE_URL", originalHandbookSiteUrl);
});

describe("live panel membership", () => {
  test("moves the seat, its grants, and the reserve to the joining reviewer", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const operator = asOperator(backend, fixture);

    const result = await operator.mutation(api.reviewPanelMembership.swapPanelMember, {
      eventSlug: fixture.eventSlug,
      panelId: fixture.panelId,
      leavingPersonId: fixture.memberPersonId,
      joiningPersonId: fixture.reservePersonId,
      expectedPanelVersion: 1,
      reason: "The seated reviewer went home ill.",
      clientOperationId: "swap-once",
    });
    expect(result).toEqual({ panelId: fixture.panelId, status: "ready", version: 2 });

    await backend.run(async (ctx) => {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) => index.eq("panelId", fixture.panelId))
        .collect();
      const leaving = members.find((member) => member.personId === fixture.memberPersonId);
      const joining = members.find((member) => member.personId === fixture.reservePersonId);
      expect(leaving?.status).toBe("replaced");
      expect(joining?.status).toBe("active");
      expect(joining?.isCoordinator).toBe(false);
      expect(joining?.assignedCriterionIds).toEqual(leaving?.assignedCriterionIds);
      expect(members.filter((member) => member.status === "active")).toHaveLength(3);

      const panel = await ctx.db.get(fixture.panelId);
      expect(panel?.coordinatorPersonId).toBe(fixture.coordinatorPersonId);

      const reserve = await ctx.db.get(fixture.reserveId);
      expect(reserve?.status).toBe("assigned");

      const audit = await ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
        .collect();
      expect(audit.filter((entry) => entry.action === "review.panel_membership_changed"))
        .toHaveLength(1);
    });

    // The seat's authority follows the person sitting in it.
    expect(await activeSourceGrantCount(backend, fixture.eventId, "panel_assignment", fixture.memberId))
      .toBe(0);
    expect(await activeSourceGrantCount(backend, fixture.eventId, "reserve_assignment", fixture.reserveId))
      .toBe(0);
    const joiningMemberId = await backend.run(async (ctx) => {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", fixture.panelId).eq("status", "active"),
        )
        .collect();
      const joining = members.find((member) => member.personId === fixture.reservePersonId);
      if (!joining) throw new Error("The joining panel member is missing.");
      return joining._id;
    });
    expect(await activeSourceGrantCount(backend, fixture.eventId, "panel_assignment", joiningMemberId))
      .toBe(4);
  });

  test("refuses to change a panel while a review is live on it", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    await seedLiveReview(backend, fixture);
    const operator = asOperator(backend, fixture);

    await expect(
      operator.mutation(api.reviewPanelMembership.swapPanelMember, {
        eventSlug: fixture.eventSlug,
        panelId: fixture.panelId,
        leavingPersonId: fixture.memberPersonId,
        joiningPersonId: fixture.reservePersonId,
        expectedPanelVersion: 1,
        reason: "The seated reviewer went home ill.",
        clientOperationId: "swap-during-review",
      }),
    ).rejects.toThrow("A review is live at this panel");

    await backend.run(async (ctx) => {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) => index.eq("panelId", fixture.panelId))
        .collect();
      expect(members.filter((member) => member.status === "active")).toHaveLength(3);
      expect(await ctx.db.get(fixture.panelId)).toMatchObject({ version: 1 });
    });
  });

  test("refuses a stale expected panel version", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const operator = asOperator(backend, fixture);

    await operator.mutation(api.reviewPanelMembership.swapPanelMember, {
      eventSlug: fixture.eventSlug,
      panelId: fixture.panelId,
      leavingPersonId: fixture.memberPersonId,
      joiningPersonId: fixture.reservePersonId,
      expectedPanelVersion: 1,
      reason: "The seated reviewer went home ill.",
      clientOperationId: "swap-first",
    });

    await expect(
      operator.mutation(api.reviewPanelMembership.swapPanelMember, {
        eventSlug: fixture.eventSlug,
        panelId: fixture.panelId,
        leavingPersonId: fixture.secondMemberPersonId,
        expectedPanelVersion: 1,
        reason: "A second desk was looking at the old board.",
        clientOperationId: "swap-stale",
      }),
    ).rejects.toThrow("Refresh before continuing");
  });

  test("replays one client operation without writing a second time", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const operator = asOperator(backend, fixture);

    const request = {
      eventSlug: fixture.eventSlug,
      panelId: fixture.panelId,
      leavingPersonId: fixture.memberPersonId,
      joiningPersonId: fixture.reservePersonId,
      expectedPanelVersion: 1,
      reason: "The seated reviewer went home ill.",
      clientOperationId: "swap-replayed",
    } as const;
    const first = await operator.mutation(api.reviewPanelMembership.swapPanelMember, request);
    expect(await operator.mutation(api.reviewPanelMembership.swapPanelMember, request)).toEqual(first);

    await backend.run(async (ctx) => {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) => index.eq("panelId", fixture.panelId))
        .collect();
      expect(members).toHaveLength(4);
      expect(await ctx.db.get(fixture.panelId)).toMatchObject({ version: 2 });
      expect(
        await ctx.db
          .query("operationResults")
          .withIndex("by_actor_operation", (index) =>
            index
              .eq("actorPersonId", fixture.operatorPersonId)
              .eq("clientOperationId", request.clientOperationId),
          )
          .collect(),
      ).toHaveLength(1);
      const audit = await ctx.db
        .query("auditEvents")
        .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
        .collect();
      expect(audit.filter((entry) => entry.action === "review.panel_membership_changed"))
        .toHaveLength(1);
    });
  });

  test("refuses to leave the panel without the reviewer who runs it", async () => {
    const backend = seededBackend();
    const fixture = await seedPanel(backend);
    const operator = asOperator(backend, fixture);

    await expect(
      operator.mutation(api.reviewPanelMembership.swapPanelMember, {
        eventSlug: fixture.eventSlug,
        panelId: fixture.panelId,
        leavingPersonId: fixture.coordinatorPersonId,
        expectedPanelVersion: 1,
        reason: "The coordinator has to leave the hall.",
        clientOperationId: "remove-coordinator",
      }),
    ).rejects.toThrow("cannot lose the reviewer who runs it");

    // Swapping the same seat is the supported route, and it moves the duty.
    const result = await operator.mutation(api.reviewPanelMembership.swapPanelMember, {
      eventSlug: fixture.eventSlug,
      panelId: fixture.panelId,
      leavingPersonId: fixture.coordinatorPersonId,
      joiningPersonId: fixture.reservePersonId,
      expectedPanelVersion: 1,
      reason: "The coordinator has to leave the hall.",
      clientOperationId: "replace-coordinator",
    });
    expect(result).toEqual({ panelId: fixture.panelId, status: "ready", version: 2 });
    await backend.run(async (ctx) => {
      expect(await ctx.db.get(fixture.panelId)).toMatchObject({
        coordinatorPersonId: fixture.reservePersonId,
      });
    });
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

function asOperator(backend: BackendTest, fixture: Fixture) {
  return backend.withIdentity({
    subject: fixture.authUserId,
    sessionId: fixture.authSessionId,
  });
}

async function activeSourceGrantCount(
  backend: BackendTest,
  eventId: Id<"events">,
  sourceType: GrantSource,
  sourceId: string,
) {
  return backend.run(async (ctx) => {
    const grants = await ctx.db
      .query("permissionGrants")
      .withIndex("by_source", (index) =>
        index
          .eq("eventId", eventId)
          .eq("sourceType", sourceType)
          .eq("sourceId", sourceId)
          .eq("status", "active"),
      )
      .collect();
    return grants.length;
  });
}

async function seedPanel(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `panel-membership-${crypto.randomUUID()}`;
  const authUserId = await createAuthUser(backend, now);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Panel membership fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const operator = await insertAccount(ctx, eventId, "operator", now, authUserId);
    const criterionKeys = ["craft", "impact"];
    const reviewers = new Map<string, { personId: Id<"people">; subjectId: Id<"eventAccessSubjects"> }>();
    for (const key of ["coordinator", "member", "second-member", "reserve"]) {
      const account = await insertAccount(ctx, eventId, key, now);
      await ctx.db.insert("reviewerProfiles", {
        eventId,
        personId: account.personId,
        technicalDomains: ["backend"],
        productDomains: ["operations"],
        languages: ["english"],
        criterionKeys,
        trainingStatus: "complete",
        status: "active",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      reviewers.set(key, account);
    }
    const coordinator = requireReviewer(reviewers, "coordinator");
    const member = requireReviewer(reviewers, "member");
    const secondMember = requireReviewer(reviewers, "second-member");
    const reserve = requireReviewer(reviewers, "reserve");

    const rubricVersionId = await ctx.db.insert("reviewRubricVersions", {
      eventId,
      version: 1,
      name: "Fixture rubric",
      status: "published",
      scoreMinimum: 0,
      scoreMaximum: 4,
      aggregationFormula: "criterion_mean_weighted_v1",
      spreadThreshold: 2,
      checksum: "fixture-rubric",
      createdByPersonId: operator.personId,
      createdAt: now,
      publishedAt: now,
    });
    const criterionIds: Id<"reviewRubricCriteria">[] = [];
    for (const [index, stableKey] of criterionKeys.entries()) {
      criterionIds.push(
        await ctx.db.insert("reviewRubricCriteria", {
          eventId,
          rubricVersionId,
          stableKey,
          label: `Criterion ${stableKey}`,
          question: `How strong is the ${stableKey}?`,
          guidance: "Score what the team showed.",
          weight: 1,
          displayOrder: index,
          anchors: { zero: "0", one: "1", two: "2", three: "3", four: "4" },
          createdAt: now,
        }),
      );
    }
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId,
      rubricVersionId,
      stableKey: "fixture-round",
      name: "Fixture round",
      sequence: 1,
      status: "open",
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      reviewDurationSeconds: 600,
      ordinaryExtensionSeconds: 120,
      maximumOrdinaryExtensions: 1,
      missedCallGraceSeconds: 120,
      requiredCallAttempts: 2,
      substituteResponseSeconds: 60,
      missedReentryPolicy: "preserve_queue_time",
      requiredPanelSize: 3,
      minimumScorersPerCriterion: 1,
      minimumPresentParticipants: 1,
      requiresSharedCommitments: true,
      minimumReviewerBuild: 1,
      requiresCamera: false,
      requiresNotifications: false,
      version: 1,
      configurationChecksum: "fixture-round",
      createdByPersonId: operator.personId,
      createdAt: now,
      publishedAt: now,
      openedAt: now,
    });
    const panelId = await ctx.db.insert("reviewPanels", {
      eventId,
      roundId,
      stableKey: "fixture-panel",
      name: "Fixture panel",
      tableLabel: "A1",
      coordinatorPersonId: coordinator.personId,
      status: "ready",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const panelMemberIds = new Map<string, Id<"reviewPanelMembers">>();
    for (const [key, account] of [
      ["coordinator", coordinator],
      ["member", member],
      ["second-member", secondMember],
    ] as const) {
      const panelMemberId = await ctx.db.insert("reviewPanelMembers", {
        eventId,
        roundId,
        panelId,
        personId: account.personId,
        eventAccessSubjectId: account.subjectId,
        assignedCriterionIds: criterionIds,
        isCoordinator: key === "coordinator",
        status: "active",
        assignedAt: now,
      });
      panelMemberIds.set(key, panelMemberId);
      for (const permissionKey of ["reviewer.clock_in", "round.read"] as const) {
        await insertPermissionGrant(ctx, {
          eventId,
          personId: account.personId,
          eventAccessSubjectId: account.subjectId,
          permissionKey,
          scopeType: "round",
          scopeId: roundId,
          sourceType: "panel_assignment",
          sourceId: panelMemberId,
          grantedByPersonId: operator.personId,
          reason: "Published review panel assignment",
        });
      }
      await insertPermissionGrant(ctx, {
        eventId,
        personId: account.personId,
        eventAccessSubjectId: account.subjectId,
        permissionKey: "panel.read",
        scopeType: "panel",
        scopeId: panelId,
        sourceType: "panel_assignment",
        sourceId: panelMemberId,
        grantedByPersonId: operator.personId,
        reason: "Published review panel assignment",
      });
    }
    const reserveId = await ctx.db.insert("reviewRoundReserves", {
      eventId,
      roundId,
      personId: reserve.personId,
      eventAccessSubjectId: reserve.subjectId,
      status: "available",
      pageCount: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    for (const permissionKey of ["reviewer.clock_in", "round.read"] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: reserve.personId,
        eventAccessSubjectId: reserve.subjectId,
        permissionKey,
        scopeType: "round",
        scopeId: roundId,
        sourceType: "reserve_assignment",
        sourceId: reserveId,
        grantedByPersonId: operator.personId,
        reason: "Published reserve reviewer assignment",
      });
    }
    await insertPermissionGrant(ctx, {
      eventId,
      personId: operator.personId,
      eventAccessSubjectId: operator.subjectId,
      permissionKey: "review.substitute.assign",
      scopeType: "panel",
      scopeId: panelId,
      sourceType: "manual",
      sourceId: `${eventSlug}:review.substitute.assign`,
      grantedByPersonId: operator.personId,
      reason: "Panel membership test",
    });
    const memberId = panelMemberIds.get("member");
    if (!memberId) throw new Error("The fixture panel member is missing.");
    return {
      eventSlug,
      eventId,
      roundId,
      panelId,
      rubricVersionId,
      memberId,
      operatorPersonId: operator.personId,
      coordinatorPersonId: coordinator.personId,
      memberPersonId: member.personId,
      secondMemberPersonId: secondMember.personId,
      reservePersonId: reserve.personId,
      reserveId,
      authUserId,
      authSessionId,
    };
  });
}

/**
 * A review session pins a team, its submitted project version, and the frozen
 * evidence set, so a live-review fixture has to build that chain.
 */
async function seedLiveReview(backend: BackendTest, fixture: Fixture) {
  const now = Date.now();
  return backend.run(async (ctx) => {
    const participant = await insertAccount(ctx, fixture.eventId, "participant", now);
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId: fixture.eventId,
      personId: participant.personId,
      eventAccessSubjectId: participant.subjectId,
      participantClass: "vit_student",
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId: fixture.eventId,
      name: "Fixture team",
      publicCode: "FIXT01",
      leadMembershipId: membershipId,
      status: "confirmed",
      membershipLocked: true,
      trackLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const participantPolicyVersionId = await ctx.db.insert("participantPolicyVersions", {
      eventId: fixture.eventId,
      version: 1,
      status: "published",
      label: "Fixture participant policy",
      teamMinimumSize: 1,
      teamMaximumSize: 4,
      mixedParticipantClassesAllowed: true,
      phoneField: "not_collected",
      vitRegistrationNumberField: "required",
      vitProgrammeField: "not_collected",
      vitCampusField: "not_collected",
      externalCityField: "not_collected",
      externalCountryField: "not_collected",
      profileNotice: "Fixture profile notice.",
      projectTextNotice: "Fixture project notice.",
      privacyNoticeUrl: "https://example.test/privacy",
      freshProjectAttestation: "Fixture attestation.",
      finalSubmissionWarning: "Fixture warning.",
      checksum: "fixture-participant-policy",
      createdByPersonId: fixture.operatorPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const intakePolicyVersionId = await ctx.db.insert("intakePolicyVersions", {
      eventId: fixture.eventId,
      version: 1,
      status: "published",
      openingText: "Fixture opening.",
      initialPrompt: "Describe the idea.",
      initialHelpText: "Fixture help.",
      initialIdeaMinLength: 10,
      initialIdeaMaxLength: 500,
      followUpAnswerMinLength: 10,
      followUpAnswerMaxLength: 500,
      minimumFollowUpCount: 0,
      maximumFollowUpCount: 3,
      deterministicFollowUpCount: 3,
      questionMaxLength: 200,
      allowedPurposeKeys: [],
      fallbackQuestions: [],
      blockedTerms: [],
      commonIdeaPatterns: [],
      model: { mode: "deterministic" },
      checksum: "fixture-intake-policy",
      createdByPersonId: fixture.operatorPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const admissionPolicyVersionId = await ctx.db.insert("admissionPolicyVersions", {
      eventId: fixture.eventId,
      version: "1",
      status: "published",
      aiRecommendationMode: "disabled",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 100,
      criteria: [],
      decisionReasonCodes: [],
      checksum: "fixture-admission-policy",
      createdByPersonId: fixture.operatorPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const catalogVersionId = await ctx.db.insert("trackCatalogVersions", {
      eventId: fixture.eventId,
      version: 1,
      status: "published",
      requiredCoreTrackCount: 1,
      checksum: "fixture-track-catalog",
      createdByPersonId: fixture.operatorPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const trackVersionId = await ctx.db.insert("trackVersions", {
      eventId: fixture.eventId,
      catalogVersionId,
      stableKey: "fixture-track",
      slug: "fixture-track",
      displayName: "Fixture track",
      description: "Fixture track description.",
      examples: [],
      displayOrder: 0,
      type: "core",
      status: "published",
      createdAt: now,
    });
    const projectVersionId = await ctx.db.insert("projectVersions", {
      eventId: fixture.eventId,
      teamId,
      version: 1,
      initialIdea: "A fixture project idea.",
      intakePolicyVersionId,
      intakeResponses: [],
      coreTrackVersionId: trackVersionId,
      sponsorTrackVersionIds: [],
      lockedTeamMemberIds: [],
      lockedLeadMembershipId: membershipId,
      freshForEventAttestation: {
        participantPolicyVersionId,
        acceptedByMembershipId: membershipId,
        acceptedAt: now,
      },
      finalConfirmation: {
        participantPolicyVersionId,
        previewedDraftVersion: 1,
        previewedTeamVersion: 1,
        previewedTrackVersionId: trackVersionId,
        previewedSponsorTrackVersionIds: [],
        confirmedByMembershipId: membershipId,
        confirmedAt: now,
      },
      participantPolicyVersionId,
      admissionPolicyVersionId,
      sourceDraftVersion: 1,
      submittedByMembershipId: membershipId,
      submittedAt: now,
    });
    const evidenceCheckpointSetId = await ctx.db.insert("reviewEvidenceCheckpointSets", {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      roundSequence: 1,
      teamId,
      projectVersionId,
      githubEntries: [],
      figmaEntries: [],
      expectedResourceCount: 0,
      capturedResourceCount: 0,
      completeness: "complete",
      checksum: "fixture-evidence",
      createdByPersonId: fixture.operatorPersonId,
      createdAt: now,
    });
    return ctx.db.insert("reviewSessions", {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      panelId: fixture.panelId,
      teamId,
      projectVersionId,
      evidenceCheckpointSetId,
      rubricVersionId: fixture.rubricVersionId,
      panelVersion: 1,
      status: "active",
      startedAt: now,
      plannedEndAt: now + 600_000,
      extensionCount: 0,
      extensionSeconds: 0,
      sharedNotesVersion: 0,
      version: 1,
      createdByPersonId: fixture.operatorPersonId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

function requireReviewer(
  reviewers: Map<string, { personId: Id<"people">; subjectId: Id<"eventAccessSubjects"> }>,
  key: string,
) {
  const account = reviewers.get(key);
  if (!account) throw new Error(`The fixture reviewer ${key} is missing.`);
  return account;
}

async function insertAccount(
  ctx: Parameters<Parameters<BackendTest["run"]>[0]>[0],
  eventId: Id<"events">,
  key: string,
  now: number,
  authUserId?: string,
) {
  const email = `${key}-${crypto.randomUUID()}@example.test`;
  const personId = await ctx.db.insert("people", {
    authUserId: authUserId ?? `${key}-${crypto.randomUUID()}`,
    googleSubject: `google-${key}-${crypto.randomUUID()}`,
    verifiedEmail: email,
    displayName: `${key} person`,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const subjectId = await ctx.db.insert("eventAccessSubjects", {
    eventId,
    personId,
    emailNormalized: email,
    displayName: `${key} person`,
    status: "active",
    linkedBy: "access_invitation",
    accessVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  return { personId, subjectId };
}

async function createAuthUser(backend: BackendTest, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Panel operator",
        email: `panel-operator-${crypto.randomUUID()}@example.test`,
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

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
