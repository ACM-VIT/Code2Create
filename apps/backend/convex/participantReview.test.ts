import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import aggregateTest from "@convex-dev/aggregate/test";
import { defaultVitHostelResidenceCatalog } from "@code2create/domain";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { initializeAttendanceTeamAvailability } from "./lib/attendanceTeamAvailability.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot.ts";
import {
  insertTeamRoundState,
  participantQueuePosition,
  patchTeamRoundState,
} from "./lib/reviewQueueProjection.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;
type Fixture = Awaited<ReturnType<typeof seedQueueFixture>>;

const originalAuthSiteUrl = process.env.AUTH_SITE_URL;
const originalParticipantSiteUrl = process.env.PARTICIPANT_SITE_URL;
const originalOperationsSiteUrl = process.env.OPERATIONS_SITE_URL;

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";

afterAll(() => {
  restoreEnvironment("AUTH_SITE_URL", originalAuthSiteUrl);
  restoreEnvironment("PARTICIPANT_SITE_URL", originalParticipantSiteUrl);
  restoreEnvironment("OPERATIONS_SITE_URL", originalOperationsSiteUrl);
});

describe("participant review queue projection", () => {
  test("lets a participant observe staff placement but not place or call the team", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    await seedAwaitingReview(backend, fixture);
    const participant = asParticipant(backend, fixture);

    const queue = await currentQueue(backend, fixture);
    expect(queue).toMatchObject({
      state: "queued",
      teamsAhead: 0,
    });
    if (!queue?.estimate) throw new Error("The queued team has no wait estimate.");
    expect(queue.serverNow).toBeLessThanOrEqual(queue.estimate.earliestAt);
    expect(queue.estimate.latestAt).toBeGreaterThan(queue.estimate.earliestAt);
    expect("lowerMinutes" in queue.estimate).toBe(false);
    await expect(
      participant.mutation(api.reviewOperations.queueTeam, {
        eventSlug: fixture.eventSlug,
        roundId: fixture.roundId,
        panelId: fixture.panelId,
        teamId: fixture.teamId,
        expectedTeamRoundVersion: 1,
        reason: "Participant cannot place a team",
        clientOperationId: "participant-cannot-queue-team",
      }),
    ).rejects.toThrow("does not have permission for that exact resource");
    await expect(
      participant.mutation(api.reviewOperations.callTeam, {
        eventSlug: fixture.eventSlug,
        roundId: fixture.roundId,
        panelId: fixture.panelId,
        teamId: fixture.teamId,
        expectedTeamRoundVersion: 1,
        reason: "Participant cannot call a team",
        clientOperationId: "participant-cannot-call-team",
      }),
    ).rejects.toThrow("does not have permission for that exact resource");
  });

  test("keeps review status readable without exposing the separately scoped team code", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend, { grantTeamQr: false });
    const reviewSessionId = await seedAwaitingReview(backend, fixture);
    const participant = asParticipant(backend, fixture);

    await expect(currentQueue(backend, fixture)).resolves.toMatchObject({
      review: { id: reviewSessionId, canShowTeamQr: false },
    });
    await expect(
      participant.mutation(api.participantReview.mintTeamQr, {
        eventSlug: fixture.eventSlug,
        reviewSessionId,
      }),
    ).rejects.toThrow("does not have permission for that exact resource");
  });

  test("only exposes an admission link when the operator can read that application", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    await seedAwaitingReview(backend, fixture);
    const applicationId = await backend.run(async (ctx) => {
      const team = await ctx.db.get(fixture.teamId);
      if (!team?.lockedProjectVersionId) throw new Error("The fixture project is missing.");
      const project = await ctx.db.get(team.lockedProjectVersionId);
      if (!project) throw new Error("The fixture project is missing.");
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "round.read",
        scopeType: "round",
        scopeId: fixture.roundId,
        sourceType: "manual",
        sourceId: `${fixture.eventSlug}:round.read`,
        grantedByPersonId: fixture.personId,
        reason: "Review board access test",
      });
      return ctx.db.insert("applications", {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        submittedProjectVersionId: project._id,
        admissionPolicyVersionId: project.admissionPolicyVersionId,
        state: "submitted",
        decisionStage: "unrecorded",
        experienceBand: "first_year",
        assignedReviewCount: 0,
        completedReviewCount: 0,
        contentVersion: 1,
        version: 1,
        submittedAt: fixture.now,
      });
    });
    const participant = asParticipant(backend, fixture);
    const boardWithoutApplicationAccess = await participant.query(api.reviewOperations.roundTeams, {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(boardWithoutApplicationAccess.page).toHaveLength(1);
    expect(boardWithoutApplicationAccess.page[0]?.applicationId).toBeUndefined();

    await backend.run(async (ctx) => {
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "application.read",
        scopeType: "application",
        scopeId: applicationId,
        sourceType: "manual",
        sourceId: `${fixture.eventSlug}:application.read`,
        grantedByPersonId: fixture.personId,
        reason: "Admission link access test",
      });
    });
    const boardWithApplicationAccess = await participant.query(api.reviewOperations.roundTeams, {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(boardWithApplicationAccess.page[0]?.applicationId).toBe(applicationId);
  });

  test("preserves priority and time order through reorder, move, start, and completion", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    const olderStateId = await addQueueTeam(backend, fixture, {
      key: "older",
      panelId: fixture.panelId,
      priority: 0,
      queuedAt: fixture.now + 10,
    });
    await addQueueTeam(backend, fixture, {
      key: "priority",
      panelId: fixture.panelId,
      priority: 2,
      queuedAt: fixture.now + 50,
    });
    const targetPanelBlockerId = await addQueueTeam(backend, fixture, {
      key: "target-panel-blocker",
      panelId: fixture.targetPanelId,
      priority: 4,
      queuedAt: fixture.now + 5,
    });

    expect(await currentQueue(backend, fixture)).toMatchObject({
      state: "queued",
      teamsAhead: 2,
    });

    await patchState(backend, fixture.targetStateId, {
      priority: 3,
      updatedAt: fixture.now + 100,
    });
    expect(await currentQueue(backend, fixture)).toMatchObject({ teamsAhead: 0 });

    await patchState(backend, fixture.targetStateId, {
      panelId: fixture.targetPanelId,
      updatedAt: fixture.now + 200,
    });
    expect(await currentQueue(backend, fixture)).toMatchObject({
      panel: { id: fixture.targetPanelId, name: "Target panel" },
      teamsAhead: 1,
    });

    await patchState(backend, targetPanelBlockerId, {
      state: "called",
      calledAt: fixture.now + 300,
      updatedAt: fixture.now + 300,
    });
    expect(await currentQueue(backend, fixture)).toMatchObject({ teamsAhead: 0 });

    await patchState(backend, fixture.targetStateId, {
      state: "called",
      calledAt: fixture.now + 400,
      updatedAt: fixture.now + 400,
    });
    const called = await currentQueue(backend, fixture);
    expect(called).toMatchObject({ state: "called" });
    expect(called?.teamsAhead).toBeUndefined();

    await patchState(backend, fixture.targetStateId, {
      state: "in_review",
      updatedAt: fixture.now + 500,
    });
    expect(await currentQueue(backend, fixture)).toMatchObject({ state: "in_review" });

    await patchState(backend, fixture.targetStateId, {
      state: "completed",
      completedAt: fixture.now + 600,
      updatedAt: fixture.now + 600,
    });
    expect(await currentQueue(backend, fixture)).toBeNull();

    const olderPosition = await backend.run(async (ctx) => {
      const olderState = await ctx.db.get(olderStateId);
      if (!olderState) throw new Error("The older queue state is missing.");
      return participantQueuePosition(ctx, olderState);
    });
    expect(olderPosition).toBe(1);
  });

  test("reads an exact rank and constant participant payload within a strict document budget", async () => {
    const backend = seededBackend(48);
    const fixture = await seedQueueFixture(backend, {
      targetQueuedAt: fixtureNow() + 1_000_000,
    });
    const queuedAhead = 64;
    for (let index = 0; index < queuedAhead; index += 1) {
      await addQueueTeam(backend, fixture, {
        key: `bounded-${index}`,
        panelId: fixture.panelId,
        priority: 0,
        queuedAt: fixture.now + index,
      });
    }

    const current = await currentQueue(backend, fixture);
    expect(current).toMatchObject({ state: "queued", teamsAhead: queuedAhead });
    expect(new TextEncoder().encode(JSON.stringify(current)).byteLength).toBeLessThan(1_024);
  });

  test("rejects a queued source row that bypassed the aggregate owner", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    const driftedStateId = await backend.run(async (ctx) => {
      const teamId = await ctx.db.insert("teams", {
        eventId: fixture.eventId,
        name: "Drifted queue team",
        publicCode: "DRIFT01",
        leadMembershipId: fixture.membershipId,
        status: "confirmed",
        activeMemberCount: 0,
        activeVitMemberCount: 0,
        activeExternalMemberCount: 0,
        membershipLocked: true,
        version: 1,
        createdAt: fixture.now,
        updatedAt: fixture.now,
      });
      return ctx.db.insert("teamRoundStates", {
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        teamId,
        panelId: fixture.panelId,
        state: "queued",
        queuedAt: fixture.now,
        callAttemptCount: 0,
        priority: 10,
        version: 1,
        updatedByPersonId: fixture.personId,
        updatedAt: fixture.now,
      });
    });

    await expect(
      backend.run(async (ctx) => {
        const drifted = await ctx.db.get(driftedStateId);
        if (!drifted) throw new Error("The drifted queue state is missing.");
        return participantQueuePosition(ctx, drifted);
      }),
    ).rejects.toThrow("missing from its panel queue projection");
  });

  test("mints from one active token and the indexed latest version within a strict read budget", async () => {
    const backend = seededBackend(48);
    const fixture = await seedQueueFixture(backend);
    const reviewSessionId = await seedAwaitingReview(backend, fixture);
    const historicalTokenCount = 70;
    for (let start = 1; start <= historicalTokenCount; start += 10) {
      await backend.run(async (ctx) => {
        for (let tokenVersion = start; tokenVersion < start + 10; tokenVersion += 1) {
          await ctx.db.insert("reviewTeamQrTokens", {
            eventId: fixture.eventId,
            reviewSessionId,
            teamId: fixture.teamId,
            tokenDigest: `historical-token-${tokenVersion}`,
            manualCodeDigest: `historical-code-${tokenVersion}`,
            tokenVersion,
            state: tokenVersion === historicalTokenCount ? "active" : "superseded",
            expiresAt:
              tokenVersion === historicalTokenCount ? fixture.now - 1 : fixture.now + 60_000,
            issuedByMembershipId: fixture.membershipId,
            issuedAt: fixture.now + tokenVersion,
          });
        }
      });
    }

    const participant = asParticipant(backend, fixture);
    const first = await participant.mutation(api.participantReview.mintTeamQr, {
      eventSlug: fixture.eventSlug,
      reviewSessionId,
    });
    const second = await participant.mutation(api.participantReview.mintTeamQr, {
      eventSlug: fixture.eventSlug,
      reviewSessionId,
    });
    expect(first.payload).toMatch(/^c2c-review-v1\.[a-f0-9]{64}$/);
    expect(first.serverNow).toBeLessThan(first.expiresAt);
    expect(second.payload).toMatch(/^c2c-review-v1\.[a-f0-9]{64}$/);
    expect(second.payload).not.toBe(first.payload);
    await expect(
      participant.query(api.participantReview.teamQrState, {
        eventSlug: fixture.eventSlug,
        tokenId: first.tokenId,
      }),
    ).resolves.toMatchObject({ state: "superseded" });
    await expect(
      participant.query(api.participantReview.teamQrState, {
        eventSlug: fixture.eventSlug,
        tokenId: second.tokenId,
      }),
    ).resolves.toMatchObject({ state: "active" });

    await backend.run(async (ctx) => {
      const active = await ctx.db
        .query("reviewTeamQrTokens")
        .withIndex("by_session_state", (index) =>
          index.eq("reviewSessionId", reviewSessionId).eq("state", "active"),
        )
        .take(2);
      const latest = await ctx.db
        .query("reviewTeamQrTokens")
        .withIndex("by_session_version", (index) => index.eq("reviewSessionId", reviewSessionId))
        .order("desc")
        .take(3);
      expect(active).toHaveLength(1);
      expect(active[0]?.tokenVersion).toBe(72);
      expect(latest.map((token) => [token.tokenVersion, token.state])).toEqual([
        [72, "active"],
        [71, "superseded"],
        [70, "expired"],
      ]);
    });

    await backend.run(async (ctx) => {
      const priorToken = await ctx.db
        .query("reviewTeamQrTokens")
        .withIndex("by_session_version", (index) =>
          index.eq("reviewSessionId", reviewSessionId).eq("tokenVersion", 71),
        )
        .unique();
      if (!priorToken) throw new Error("The prior QR token is missing.");
      await ctx.db.patch(priorToken._id, { state: "active" });
    });
    await expect(
      participant.mutation(api.participantReview.mintTeamQr, {
        eventSlug: fixture.eventSlug,
        reviewSessionId,
      }),
    ).rejects.toThrow();
    await backend.run(async (ctx) => {
      const active = await ctx.db
        .query("reviewTeamQrTokens")
        .withIndex("by_session_state", (index) =>
          index.eq("reviewSessionId", reviewSessionId).eq("state", "active"),
        )
        .take(3);
      expect(active.map((token) => token.tokenVersion).sort((left, right) => left - right)).toEqual(
        [71, 72],
      );
    });
  });
});

function seededBackend(documentsRead?: number) {
  const options =
    documentsRead === undefined
      ? { schema, modules }
      : { schema, modules, transactionLimits: { documentsRead } };
  const backend = convexTest(options);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  aggregateTest.register(backend, "reviewQueue");
  return backend;
}

function asParticipant(backend: BackendTest, fixture: Fixture) {
  return backend.withIdentity({
    subject: fixture.authUserId,
    sessionId: fixture.authSessionId,
  });
}

function currentQueue(backend: BackendTest, fixture: Fixture) {
  return asParticipant(backend, fixture).query(api.participantReview.current, {
    eventSlug: fixture.eventSlug,
  });
}

async function patchState(
  backend: BackendTest,
  stateId: Id<"teamRoundStates">,
  patch: Parameters<typeof patchTeamRoundState>[2],
) {
  await backend.run(async (ctx) => {
    const state = await ctx.db.get(stateId);
    if (!state) throw new Error("The queue state is missing.");
    await patchTeamRoundState(ctx, state, patch);
  });
}

async function addQueueTeam(
  backend: BackendTest,
  fixture: Fixture,
  args: {
    key: string;
    panelId: Id<"reviewPanels">;
    priority: number;
    queuedAt: number;
  },
) {
  return backend.run(async (ctx) => {
    const teamId = await ctx.db.insert("teams", {
      eventId: fixture.eventId,
      name: `Queue team ${args.key}`,
      publicCode: `Q${args.key.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      leadMembershipId: fixture.membershipId,
      status: "confirmed",
      activeMemberCount: 0,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 0,
      membershipLocked: true,
      version: 1,
      createdAt: fixture.now,
      updatedAt: fixture.now,
    });
    return insertTeamRoundState(ctx, {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      teamId,
      panelId: args.panelId,
      state: "queued",
      queuedAt: args.queuedAt,
      callAttemptCount: 0,
      priority: args.priority,
      version: 1,
      updatedByPersonId: fixture.personId,
      updatedAt: args.queuedAt,
    });
  });
}

async function seedQueueFixture(
  backend: BackendTest,
  { grantTeamQr = true, targetQueuedAt }: { grantTeamQr?: boolean; targetQueuedAt?: number } = {},
) {
  const now = fixtureNow();
  const eventSlug = `participant-review-${crypto.randomUUID()}`;
  const authUserId = await createAuthUser(backend, now);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Participant review fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: Date.now() + 86_400_000,
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const email = `participant-${crypto.randomUUID()}@example.test`;
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: `google-${crypto.randomUUID()}`,
      verifiedEmail: email,
      displayName: "Queue participant",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: email,
      displayName: "Queue participant",
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
      participantClass: "vit_student",
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Projected queue team",
      publicCode: "QUEUE01",
      leadMembershipId: membershipId,
      status: "confirmed",
      activeMemberCount: 1,
      activeVitMemberCount: 1,
      activeExternalMemberCount: 0,
      membershipLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await initializeAttendanceTeamAvailability(ctx, {
      eventId,
      teamId,
      activeMemberCount: 1,
      now,
    });
    const teamMemberId = await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId,
      role: "lead",
      status: "active",
      joinedAt: now,
      source: "created",
    });
    const rubricVersionId = await ctx.db.insert("reviewRubricVersions", {
      eventId,
      version: 1,
      name: "Queue fixture rubric",
      status: "published",
      scoreMinimum: 0,
      scoreMaximum: 4,
      aggregationFormula: "criterion_mean_weighted_v1",
      spreadThreshold: 2,
      checksum: "queue-fixture-rubric",
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId,
      rubricVersionId,
      stableKey: "queue_fixture_round",
      name: "Queue fixture round",
      sequence: 1,
      status: "open",
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      clockInOpensAt: now - 120_000,
      reviewerReportAt: now - 90_000,
      noShowGraceSeconds: 30,
      correctionRequestsCloseAt: now + 3_600_000,
      reviewDurationSeconds: 600,
      ordinaryExtensionSeconds: 120,
      maximumOrdinaryExtensions: 1,
      missedCallGraceSeconds: 120,
      requiredCallAttempts: 2,
      substituteResponseSeconds: 60,
      missedReentryPolicy: "preserve_queue_time",
      requiredPanelSize: 1,
      minimumScorersPerCriterion: 1,
      minimumPresentParticipants: 1,
      requiresSharedCommitments: false,
      minimumReviewerBuild: 1,
      requiresCamera: false,
      requiresNotifications: false,
      version: 1,
      configurationChecksum: "queue-fixture-round",
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
      openedAt: now,
    });
    const panelId = await ctx.db.insert("reviewPanels", {
      eventId,
      roundId,
      stableKey: "queue_fixture_panel",
      name: "Queue panel",
      coordinatorPersonId: personId,
      status: "ready",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const targetPanelId = await ctx.db.insert("reviewPanels", {
      eventId,
      roundId,
      stableKey: "queue_target_panel",
      name: "Target panel",
      coordinatorPersonId: personId,
      status: "ready",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "queue.participant.read",
      scopeType: "team",
      scopeId: teamId,
      sourceType: "manual",
      sourceId: `${eventSlug}:queue.participant.read`,
      grantedByPersonId: personId,
      reason: "Participant review test",
    });
    if (grantTeamQr) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey: "review.team_qr.mint",
        scopeType: "team",
        scopeId: teamId,
        sourceType: "manual",
        sourceId: `${eventSlug}:review.team_qr.mint`,
        grantedByPersonId: personId,
        reason: "Participant review test",
      });
    }
    const targetStateId = await insertTeamRoundState(ctx, {
      eventId,
      roundId,
      teamId,
      panelId,
      state: "queued",
      queuedAt: targetQueuedAt ?? now + 30,
      callAttemptCount: 0,
      priority: 0,
      version: 1,
      updatedByPersonId: personId,
      updatedAt: now,
    });
    return {
      now,
      eventSlug,
      eventId,
      personId,
      subjectId,
      membershipId,
      teamId,
      teamMemberId,
      rubricVersionId,
      roundId,
      panelId,
      targetPanelId,
      targetStateId,
      authUserId,
      authSessionId,
    };
  });
}

async function seedAwaitingReview(backend: BackendTest, fixture: Fixture) {
  return backend.run(async (ctx) => {
    const participantPolicyVersionId = await ctx.db.insert("participantPolicyVersions", {
      eventId: fixture.eventId,
      version: 1,
      status: "published",
      label: "QR fixture participant policy",
      teamMinimumSize: 1,
      teamMaximumSize: 4,
      mixedParticipantClassesAllowed: false,
      vitHostelResidenceCatalog: defaultVitHostelResidenceCatalog,
      profileNotice: "Fixture profile notice.",
      projectTextNotice: "Fixture project notice.",
      privacyNoticeUrl: "https://example.test/privacy",
      freshProjectAttestation: "Fixture attestation.",
      finalSubmissionWarning: "Fixture warning.",
      checksum: "qr-fixture-participant-policy",
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
      publishedAt: fixture.now,
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
      checksum: "qr-fixture-intake-policy",
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
      publishedAt: fixture.now,
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
      checksum: "qr-fixture-admission-policy",
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
      publishedAt: fixture.now,
    });
    const lockedRosterSnapshotId = await createTestSubmissionSnapshot(ctx, {
      eventId: fixture.eventId,
      teamId: fixture.teamId,
      teamMemberIds: [fixture.teamMemberId],
      intakePolicyVersionId,
      participantPolicyVersionId,
      admissionPolicyVersionId,
      submittedAt: fixture.now,
    });
    const projectVersionId = await ctx.db.insert("projectVersions", {
      eventId: fixture.eventId,
      teamId: fixture.teamId,
      version: 1,
      initialIdea: "A fixture project idea.",
      intakePolicyVersionId,
      intakeResponses: [],
      lockedRosterSnapshotId,
      lockedMemberCount: 1,
      lockedLeadMembershipId: fixture.membershipId,
      freshForEventAttestation: {
        participantPolicyVersionId,
        acceptedByMembershipId: fixture.membershipId,
        acceptedAt: fixture.now,
      },
      finalConfirmation: {
        participantPolicyVersionId,
        previewedDraftVersion: 1,
        previewedTeamVersion: 1,
        confirmedByMembershipId: fixture.membershipId,
        confirmedAt: fixture.now,
      },
      participantPolicyVersionId,
      admissionPolicyVersionId,
      sourceDraftVersion: 1,
      submittedByMembershipId: fixture.membershipId,
      submittedAt: fixture.now,
    });
    await ctx.db.patch(fixture.teamId, { lockedProjectVersionId: projectVersionId });
    const evidenceCheckpointSetId = await ctx.db.insert("reviewEvidenceCheckpointSets", {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      roundSequence: 1,
      teamId: fixture.teamId,
      projectVersionId,
      githubEntries: [],
      figmaEntries: [],
      expectedResourceCount: 0,
      capturedResourceCount: 0,
      completeness: "complete",
      checksum: "qr-fixture-evidence",
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
    });
    return ctx.db.insert("reviewSessions", {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      panelId: fixture.panelId,
      teamId: fixture.teamId,
      projectVersionId,
      evidenceCheckpointSetId,
      rubricVersionId: fixture.rubricVersionId,
      panelVersion: 1,
      status: "awaiting_presence",
      extensionCount: 0,
      extensionSeconds: 0,
      sharedNotesVersion: 0,
      version: 1,
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
      updatedAt: fixture.now,
    });
  });
}

async function createAuthUser(backend: BackendTest, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Queue participant",
        email: `queue-participant-${crypto.randomUUID()}@example.test`,
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

function fixtureNow() {
  return Date.now();
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
