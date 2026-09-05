import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test } from "vitest";

import {
  admissionIntelligenceReadSignatureContext,
  defaultParticipantEmailTemplates,
  operationsIntelligenceProtocolVersion,
  signServiceBody,
} from "@code2create/domain";

import { api, components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  compareAdmissionCohortCandidates,
  normalizedCapacityPeople,
  selectAdmissionCohort,
  type AdmissionCohortSignals,
} from "./admissionCohort.ts";
import {
  communicationsPolicyChecksum,
  normalizeCommunicationsPolicy,
} from "./lib/communicationsPolicy.ts";
import { defaultDeterministicIntakePolicy, intakePolicyChecksum } from "./lib/intakePolicy.ts";
import { defaultParticipantPolicy, participantPolicyChecksum } from "./lib/participantPolicy.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import { maximumApplicantTeamsPerEvent } from "./lib/reviewLimits.ts";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;
const readSecret = "read-secret-".padEnd(48, "r");
const savedEnvironment = {
  INTELLIGENCE_READ_SECRET: process.env.INTELLIGENCE_READ_SECRET,
  AUTH_SITE_URL: process.env.AUTH_SITE_URL,
  PARTICIPANT_SITE_URL: process.env.PARTICIPANT_SITE_URL,
  OPERATIONS_SITE_URL: process.env.OPERATIONS_SITE_URL,
};

process.env.INTELLIGENCE_READ_SECRET = readSecret;
process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function candidate(overrides: Partial<AdmissionCohortSignals>): AdmissionCohortSignals {
  return {
    applicationId: "application",
    teamSize: 3,
    submittedAt: 1_000,
    reviewAccepts: 0,
    reviewDeclines: 0,
    aiRecommendation: null,
    ...overrides,
  };
}

describe("admission cohort arithmetic", () => {
  test("capacity is spent in people and the line is a strict prefix of the ranking", () => {
    const selection = selectAdmissionCohort(
      [
        candidate({ applicationId: "a", teamSize: 2, reviewAccepts: 2 }),
        candidate({ applicationId: "b", teamSize: 3, reviewAccepts: 1 }),
        candidate({ applicationId: "c", teamSize: 1 }),
      ],
      3,
      0,
    );
    expect(selection.map((entry) => entry.applicationId)).toEqual(["a", "b", "c"]);
    expect(selection.map((entry) => entry.cumulativePeople)).toEqual([2, 5, 6]);
    expect(selection.map((entry) => entry.entryCapacityPeople)).toEqual([2, 5, 6]);
    expect(selection.map((entry) => entry.suggestedIn)).toEqual([true, false, false]);
  });

  test("committed people are seated before any suggestion is made", () => {
    const selection = selectAdmissionCohort(
      [candidate({ applicationId: "a", teamSize: 4 })],
      10,
      7,
    );
    expect(selection[0]).toMatchObject({ entryCapacityPeople: 11, suggestedIn: false });
    expect(
      selectAdmissionCohort([candidate({ applicationId: "a", teamSize: 4 })], 11, 7)[0],
    ).toMatchObject({ suggestedIn: true });
  });

  test("ordering composes admission signals: reviews, then AI, then time", () => {
    const byReviews = compareAdmissionCohortCandidates(
      candidate({ reviewAccepts: 2 }),
      candidate({ reviewAccepts: 0, aiRecommendation: "accept" }),
    );
    expect(byReviews).toBeLessThan(0);
    const byAi = compareAdmissionCohortCandidates(
      candidate({ aiRecommendation: "accept" }),
      candidate({ aiRecommendation: "decline" }),
    );
    expect(byAi).toBeLessThan(0);
    const byTime = compareAdmissionCohortCandidates(
      candidate({ submittedAt: 1 }),
      candidate({ submittedAt: 2 }),
    );
    expect(byTime).toBeLessThan(0);
    const declineDrops = compareAdmissionCohortCandidates(
      candidate({}),
      candidate({ reviewDeclines: 1 }),
    );
    expect(declineDrops).toBeLessThan(0);
  });

  test("capacity must be a whole number of people", () => {
    expect(normalizedCapacityPeople(280)).toBe(280);
    expect(() => normalizedCapacityPeople(0)).toThrow();
    expect(() => normalizedCapacityPeople(12.5)).toThrow();
    expect(() => normalizedCapacityPeople(1_000_000)).toThrow();
  });
});

describe("admission cohort query and decisions", () => {
  test("recorded decisions have their own counts, pages and team search", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    await operator.mutation(api.admissions.decide, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.decidableApplicationId,
      expectedApplicationVersion: 1,
      decision: "accept",
      reasonCode: "strong_fit",
      aiDisposition: "unavailable",
      clientOperationId: "record-for-queue",
    });
    await backend.run(async (ctx) => {
      await ctx.db.patch(fixture.splitApplicationId, {
        decisionStage: "recorded",
        humanDecision: "decline",
        humanReasonCode: "out_of_scope",
        decidedByPersonId: fixture.operatorPersonId,
        decidedAt: fixture.now,
      });
      const split = await ctx.db.get(fixture.splitApplicationId);
      if (!split) throw new Error("Missing fixture application");
      await ctx.db.patch(split.teamId, { activeVitMemberCount: 0, activeExternalMemberCount: 1 });
    });
    const list = (state: "recorded" | "under_review", origin?: "internal" | "external") =>
      operator.query(api.admissions.list, {
        eventSlug: fixture.eventSlug,
        state,
        ...(origin ? { origin } : {}),
        paginationOpts: { cursor: null, numItems: 10 },
      });
    expect(await operator.query(api.admissions.stageCounts, { eventSlug: fixture.eventSlug }))
      .toEqual(expect.arrayContaining([
        { state: "recorded", count: 2 }, { state: "under_review", count: 1 },
      ]));
    expect((await list("under_review")).page.map((row) => row.teamName)).toEqual(["Night Kiln"]);
    expect((await list("under_review", "internal")).page.map((row) => row.teamName)).toEqual(["Night Kiln"]);
    expect((await list("recorded", "internal")).page.map((row) => row.teamName)).toEqual(["Steady Loom"]);
    expect((await list("recorded", "external")).page.map((row) => row.teamName)).toEqual(["Split Signal"]);
    expect(await operator.query(api.admissions.stageCounts, {
      eventSlug: fixture.eventSlug, origin: "external",
    })).toEqual([{ state: "recorded", count: 1 }]);
    const first = await operator.query(api.admissions.list, {
      eventSlug: fixture.eventSlug, state: "recorded", paginationOpts: { cursor: null, numItems: 1 },
    });
    const second = await operator.query(api.admissions.list, {
      eventSlug: fixture.eventSlug, state: "recorded",
      paginationOpts: { cursor: first.continueCursor, numItems: 1 },
    });
    expect(first.page.map((row) => [row.teamName, row.humanDecision, row.state]))
      .toEqual([["Steady Loom", "accept", "under_review"]]);
    expect(second.page.map((row) => row.teamName)).toEqual(["Split Signal"]);
    for (const [state, expectedNames] of [
      ["recorded", ["Steady Loom"]], ["under_review", []],
    ] as const) {
      const result = await operator.query(api.admissions.searchApplications, {
        eventSlug: fixture.eventSlug, state, search: "steady",
      });
      expect(result.applications.map((row) => row.teamName)).toEqual(expectedNames);
    }
    expect((await operator.query(api.admissions.searchApplications, {
      eventSlug: fixture.eventSlug, state: "recorded", search: "split", origin: "internal",
    })).applications).toEqual([]);

    // An application-scoped reader sees only its own recorded decision in every view.
    await backend.run(async (ctx) => {
      const subject = await ctx.db.query("eventAccessSubjects")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", fixture.eventId).eq("personId", fixture.operatorPersonId),
        ).unique();
      if (!subject) throw new Error("Missing fixture subject");
      for (const grant of await ctx.db.query("permissionGrants").collect()) {
        if (grant.permissionKey === "application.read") await ctx.db.delete(grant._id);
      }
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId, personId: fixture.operatorPersonId,
        eventAccessSubjectId: subject._id, permissionKey: "application.read",
        scopeType: "application", scopeId: fixture.decidableApplicationId,
        sourceType: "manual", sourceId: "recorded-scope-test",
        grantedByPersonId: fixture.operatorPersonId, reason: "Test scoped queue access",
      });
    });
    expect(await operator.query(api.admissions.stageCounts, { eventSlug: fixture.eventSlug }))
      .toEqual([{ state: "recorded", count: 1 }]);
    expect((await list("recorded")).page.map((row) => row.teamName)).toEqual(["Steady Loom"]);
    expect((await operator.query(api.admissions.searchApplications, {
      eventSlug: fixture.eventSlug, state: "recorded", search: "split",
    })).applications).toEqual([]);
  });

  test("searches every application in a stage by team name", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend, { extraTeams: 31 });
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });

    const result = await operator.query(api.admissions.searchApplications, {
      eventSlug: fixture.eventSlug,
      state: "under_review",
      search: "  TEAM   31 ",
    });

    expect(result).toEqual({
      applications: [expect.objectContaining({ teamName: "Additional Team 31" })],
      truncated: false,
    });
  });

  test("filters admission counts, pages, and search to teams with exactly one review", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });

    const [counts, applications, search, excludedSearch] = await Promise.all([
      operator.query(api.admissions.stageCounts, {
        eventSlug: fixture.eventSlug,
        completedReviewCount: 1,
      }),
      operator.query(api.admissions.list, {
        eventSlug: fixture.eventSlug,
        state: "under_review",
        completedReviewCount: 1,
        paginationOpts: { cursor: null, numItems: 1 },
      }),
      operator.query(api.admissions.searchApplications, {
        eventSlug: fixture.eventSlug,
        state: "under_review",
        search: "night",
        completedReviewCount: 1,
      }),
      operator.query(api.admissions.searchApplications, {
        eventSlug: fixture.eventSlug,
        state: "under_review",
        search: "steady",
        completedReviewCount: 1,
      }),
    ]);

    expect(counts).toEqual([{ state: "under_review", count: 1 }]);
    expect(applications.page.map((application) => application.teamName)).toEqual(["Night Kiln"]);
    expect(search).toEqual({
      applications: [expect.objectContaining({ teamName: "Night Kiln", completedReviewCount: 1 })],
      truncated: false,
    });
    expect(excludedSearch).toEqual({ applications: [], truncated: false });

    const continuation = await operator.query(api.admissions.list, {
      eventSlug: fixture.eventSlug,
      state: "under_review",
      completedReviewCount: 1,
      paginationOpts: { cursor: applications.continueCursor, numItems: 1 },
    });
    expect(continuation.page).toEqual([]);
    expect(continuation.isDone).toBe(true);
  });

  test("keeps claimed applications visible until their required reviews are submitted", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });

    const [applications, matchingSearch, completedSearch] = await Promise.all([
      operator.query(api.admissions.list, {
        eventSlug: fixture.eventSlug,
        state: "under_review",
        needsReview: true,
        paginationOpts: { cursor: null, numItems: 10 },
      }),
      operator.query(api.admissions.searchApplications, {
        eventSlug: fixture.eventSlug,
        state: "under_review",
        search: "night",
        needsReview: true,
      }),
      operator.query(api.admissions.searchApplications, {
        eventSlug: fixture.eventSlug,
        state: "under_review",
        search: "steady",
        needsReview: true,
      }),
    ]);

    expect(applications.page.map((application) => application.teamName)).toEqual(["Night Kiln"]);
    expect(matchingSearch.applications.map((application) => application.teamName)).toEqual([
      "Night Kiln",
    ]);
    expect(completedSearch.applications).toEqual([]);
  });

  test("ranks candidates, spends capacity in people, and marks review shortfalls", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const view = await operator.action(api.admissionCohort.cohort, {
      eventSlug: fixture.eventSlug,
      capacityPeople: 3,
    });
    expect(view.capacityPeople).toBe(3);
    expect(view.hiddenApplicationCount).toBe(0);
    expect(view.candidates.map((entry) => entry.teamName)).toEqual([
      "Steady Loom",
      "Night Kiln",
      "Split Signal",
    ]);
    expect(view.candidates.every((entry) => !("novelty" in entry))).toBe(true);
    expect(view.candidates.map((entry) => entry.entryCapacityPeople)).toEqual([2, 5, 6]);
    expect(view.candidates.map((entry) => entry.suggestedIn)).toEqual([true, false, false]);
    expect(view.summary).toMatchObject({
      capacityPeople: 3,
      committedPeople: 0,
      suggestedPeople: 2,
      remainingPeople: 1,
      suggestedInTeamCount: 1,
    });
    const decidable = view.candidates.find((entry) => entry.teamName === "Steady Loom");
    const short = view.candidates.find((entry) => entry.teamName === "Night Kiln");
    expect(decidable?.reviewCoverage).toMatchObject({
      completed: 2,
      required: 2,
      decidable: true,
      shortfall: 0,
    });
    expect(short?.reviewCoverage).toMatchObject({
      completed: 1,
      required: 2,
      decidable: false,
      shortfall: 1,
    });
    expect(decidable?.experienceBand).toBe("early_year");
    const published = await operator.action(api.admissionCohort.cohort, {
      eventSlug: fixture.eventSlug,
    });
    expect(published.capacityPeople).toBe(100);
    expect(published.candidates.map((entry) => entry.suggestedIn)).toEqual([true, true, true]);
  });

  test("reads a cohort across bounded database pages", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend, { extraTeams: 18 });
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const view = await operator.action(api.admissionCohort.cohort, {
      eventSlug: fixture.eventSlug,
    });
    expect(view.candidates).toHaveLength(21);
    expect(view.candidates.map((candidate) => candidate.rank)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1),
    );
  });

  test("reads the configured maximum applicant cohort without one oversized transaction", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend, {
      extraTeams: maximumApplicantTeamsPerEvent - 3,
    });
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const view = await operator.action(api.admissionCohort.cohort, {
      eventSlug: fixture.eventSlug,
    });
    expect(view.candidates).toHaveLength(maximumApplicantTeamsPerEvent);
    expect(view.candidates[0]).toMatchObject({ rank: 1, teamName: "Steady Loom" });
    expect(view.candidates.at(-1)).toMatchObject({
      rank: maximumApplicantTeamsPerEvent,
      teamName: `Additional Team ${maximumApplicantTeamsPerEvent - 3}`,
    });
  }, 120_000);

  test("refuses a cohort that exceeds the configured applicant ceiling", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend, {
      extraTeams: maximumApplicantTeamsPerEvent - 2,
    });
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    await expect(
      operator.action(api.admissionCohort.cohort, {
        eventSlug: fixture.eventSlug,
      }),
    ).rejects.toThrow(
      `Admission cohort reads support at most ${maximumApplicantTeamsPerEvent} applicant teams.`,
    );
  }, 120_000);

  test("requires event-wide application read for the whole-event cohort", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const onlooker = backend.withIdentity({
      subject: fixture.onlookerAuthUserId,
      sessionId: fixture.onlookerAuthSessionId,
    });
    await expect(
      onlooker.action(api.admissionCohort.cohort, {
        eventSlug: fixture.eventSlug,
        capacityPeople: 3,
      }),
    ).rejects.toThrow("permission");
    const stranger = backend.withIdentity({
      subject: fixture.strangerAuthUserId,
      sessionId: fixture.strangerAuthSessionId,
    });
    await expect(
      stranger.action(api.admissionCohort.cohort, {
        eventSlug: fixture.eventSlug,
        capacityPeople: 3,
      }),
    ).rejects.toThrow();
  });

  test("applyDecision refuses below the review minimum and otherwise records the operator decision", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const refused = await operator.mutation(api.admissionCohort.applyDecision, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.shortApplicationId,
      expectedApplicationVersion: 1,
      decision: "accept",
      reasonCode: "strong_fit",
      aiDisposition: "unavailable",
      clientOperationId: "cohort-apply-short-1",
    });
    expect(refused).toEqual({
      applied: false,
      refusal: expect.objectContaining({
        code: "HUMAN_REVIEW_INCOMPLETE",
        completedReviewCount: 1,
        minimumHumanReviews: 2,
      }),
    });
    const untouched = await backend.run((ctx) => ctx.db.get(fixture.shortApplicationId));
    expect(untouched?.state).toBe("under_review");

    const applied = await operator.mutation(api.admissionCohort.applyDecision, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.decidableApplicationId,
      expectedApplicationVersion: 1,
      decision: "accept",
      reasonCode: "strong_fit",
      aiDisposition: "unavailable",
      clientOperationId: "cohort-apply-1",
    });
    expect(applied).toMatchObject({ applied: true, state: "under_review" });
    const [application, audits] = await backend.run(
      async (ctx) =>
        [
          await ctx.db.get(fixture.decidableApplicationId),
          await ctx.db.query("auditEvents").collect(),
        ] as const,
    );
    expect(application).toMatchObject({
      state: "under_review",
      decisionStage: "recorded",
      humanDecision: "accept",
      humanReasonCode: "strong_fit",
      decidedByPersonId: fixture.operatorPersonId,
    });
    const decisionAudit = audits.find(
      (event) => event.action === "admission.human_decision_recorded",
    );
    expect(decisionAudit?.actorPersonId).toBe(fixture.operatorPersonId);

    const retried = await operator.mutation(api.admissionCohort.applyDecision, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.decidableApplicationId,
      expectedApplicationVersion: 1,
      decision: "accept",
      reasonCode: "strong_fit",
      aiDisposition: "unavailable",
      clientOperationId: "cohort-apply-1",
    });
    expect(retried).toMatchObject({ applied: true, state: "under_review" });

    const onlooker = backend.withIdentity({
      subject: fixture.onlookerAuthUserId,
      sessionId: fixture.onlookerAuthSessionId,
    });
    await expect(
      onlooker.mutation(api.admissionCohort.applyDecision, {
        eventSlug: fixture.eventSlug,
        applicationId: fixture.shortApplicationId,
        expectedApplicationVersion: 1,
        decision: "accept",
        reasonCode: "strong_fit",
        aiDisposition: "unavailable",
        clientOperationId: "cohort-apply-denied-1",
      }),
    ).rejects.toThrow("permission");
  });

  test("separates completed human reviews from missing final decisions", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const status = await operator.query(api.admissions.admissionResultsReleaseStatus, {
      eventSlug: fixture.eventSlug,
    });
    expect(status).toMatchObject({
      total: 3,
      reviewsComplete: 2,
      reviewsNeeded: 1,
      recorded: 0,
      unrecorded: 3,
      ideaAgent: { accepted: 0, waitlisted: 0, rejected: 0, unavailable: 3 },
    });
    // Review readiness uses each application's policy, not the latest event policy.
    await backend.run(async (ctx) => {
      const application = await ctx.db.get(fixture.shortApplicationId);
      if (!application) throw new Error("Missing fixture application");
      const policy = await ctx.db.get(application.admissionPolicyVersionId);
      if (!policy) throw new Error("Missing fixture policy");
      const { _id, _creationTime, ...fields } = policy;
      const policyId = await ctx.db.insert("admissionPolicyVersions", {
        ...fields, version: "one-review", minimumHumanReviews: 1,
      });
      await ctx.db.patch(application._id, { admissionPolicyVersionId: policyId });
    });
    expect(await operator.query(api.admissions.admissionResultsReleaseStatus, {
      eventSlug: fixture.eventSlug,
    })).toMatchObject({ reviewsComplete: 3, reviewsNeeded: 0, unrecorded: 3 });
  });

  test("counts only current idea-agent recommendations and respects AI read access", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend, { extraTeams: 1 });
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const recommendationIds = await backend.run(async (ctx) => {
      const ids: Id<"admissionAIRecommendations">[] = [];
      for (const [applicationId, recommendation] of [
        [fixture.decidableApplicationId, "accept"],
        [fixture.shortApplicationId, "waitlist"],
        [fixture.splitApplicationId, "decline"],
      ] as const) {
        const application = await ctx.db.get(applicationId);
        if (!application) throw new Error("Missing fixture application");
        const id = await ctx.db.insert("admissionAIRecommendations", {
          eventId: fixture.eventId,
          applicationId,
          teamId: application.teamId,
          projectVersionId: application.submittedProjectVersionId,
          admissionPolicyVersionId: application.admissionPolicyVersionId,
          applicationContentVersion: application.contentVersion,
          sourceInputFingerprint: "summary-fixture",
          experienceBand: application.experienceBand,
          state: "succeeded",
          recommendation,
          criterionAssessments: [], strengths: [], concerns: [], limitations: [],
          createdAt: fixture.now,
        });
        await ctx.db.patch(applicationId, { aiRecommendationId: id });
        ids.push(id);
      }
      return ids;
    });
    const queryStatus = () => operator.query(api.admissions.admissionResultsReleaseStatus, {
      eventSlug: fixture.eventSlug,
    });
    expect(await queryStatus()).toMatchObject({
      total: 4, reviewsComplete: 2, reviewsNeeded: 2,
      ideaAgent: { accepted: 1, waitlisted: 1, rejected: 1, unavailable: 1 },
    });
    await backend.run(async (ctx) => {
      await ctx.db.patch(recommendationIds[0]!, { state: "stale" });
      await ctx.db.patch(recommendationIds[1]!, { applicationContentVersion: 99 });
      await ctx.db.patch(fixture.splitApplicationId, { state: "withdrawn" });
    });
    expect(await queryStatus()).toMatchObject({
      total: 3,
      ideaAgent: { accepted: 0, waitlisted: 0, rejected: 0, unavailable: 3 },
    });
    await backend.run(async (ctx) => {
      const grants = await ctx.db.query("permissionGrants").collect();
      for (const grant of grants) {
        if (grant.eventId === fixture.eventId && grant.permissionKey === "application.ai_recommendation.read") {
          await ctx.db.delete(grant._id);
        }
      }
    });
    expect(await queryStatus()).toMatchObject({ ideaAgent: null });
    const onlooker = backend.withIdentity({
      subject: fixture.onlookerAuthUserId,
      sessionId: fixture.onlookerAuthSessionId,
    });
    expect(await onlooker.query(api.admissions.admissionResultsReleaseStatus, {
      eventSlug: fixture.eventSlug,
    })).toMatchObject({ isSupreme: false, reviewsComplete: 0, reviewsNeeded: 0, ideaAgent: null });
  });

  test("only Supreme releases the complete recorded decision set", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const onlooker = backend.withIdentity({
      subject: fixture.onlookerAuthUserId,
      sessionId: fixture.onlookerAuthSessionId,
    });
    await expect(
      onlooker.mutation(api.admissions.releaseAdmissionResults, {
        eventSlug: fixture.eventSlug,
        expectedEventVersion: 1,
        reason: "Release the reviewed admissions set",
        clientOperationId: "release-by-onlooker",
      }),
    ).rejects.toThrow("Only an active Supreme");
    await expect(
      operator.mutation(api.admissions.releaseAdmissionResults, {
        eventSlug: fixture.eventSlug,
        expectedEventVersion: 1,
        reason: "Release the reviewed admissions set",
        clientOperationId: "release-before-complete",
      }),
    ).rejects.toThrow("Every active application");

    await backend.run(async (ctx) => {
      const decisions = [
        [fixture.decidableApplicationId, "accept", "strong_fit"],
        [fixture.shortApplicationId, "waitlist", "promising_fit"],
        [fixture.splitApplicationId, "decline", "out_of_scope"],
      ] as const;
      for (const [applicationId, decision, reasonCode] of decisions) {
        await ctx.db.patch(applicationId, {
          decisionStage: "recorded",
          humanDecision: decision,
          humanReasonCode: reasonCode,
          aiDisposition: "unavailable",
          decidedByPersonId: fixture.operatorPersonId,
          decidedAt: fixture.now,
          version: 2,
        });
      }
    });
    const readiness = await operator.query(api.admissions.admissionResultsReleaseStatus, {
      eventSlug: fixture.eventSlug,
    });
    expect(readiness).toMatchObject({
      isSupreme: true,
      total: 3,
      unrecorded: 0,
      recorded: 3,
      accepted: 1,
      waitlisted: 1,
      declined: 1,
    });
    const released = await operator.mutation(api.admissions.releaseAdmissionResults, {
      eventSlug: fixture.eventSlug,
      expectedEventVersion: 1,
      reason: "Release the reviewed admissions set",
      clientOperationId: "release-complete-set",
    });
    expect(released.applicationCount).toBe(3);
    await backend.mutation(internal.admissions.finalizeReleasedAdmissionResults, {
      eventId: fixture.eventId,
      releasedAt: released.releasedAt,
      releasedByPersonId: fixture.operatorPersonId,
      communicationsPolicyVersionId: fixture.communicationsPolicyId,
    });
    const applications = await backend.run((ctx) =>
      Promise.all([
        ctx.db.get(fixture.decidableApplicationId),
        ctx.db.get(fixture.shortApplicationId),
        ctx.db.get(fixture.splitApplicationId),
      ]),
    );
    expect(
      applications.map((application) => [application?.state, application?.decisionStage]),
    ).toEqual([
      ["accepted", "released"],
      ["waitlisted", "released"],
      ["declined", "released"],
    ]);
    expect(await operator.query(api.admissions.stageCounts, { eventSlug: fixture.eventSlug }))
      .toEqual(expect.arrayContaining([
        { state: "accepted", count: 1 }, { state: "waitlisted", count: 1 }, { state: "declined", count: 1 },
      ]));
    expect((await operator.query(api.admissions.list, {
      eventSlug: fixture.eventSlug, state: "recorded", paginationOpts: { cursor: null, numItems: 30 },
    })).page).toEqual([]);
  });

  test("keeps decisions unavailable while teams can still revise proposals", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    await backend.run((ctx) =>
      ctx.db.patch(fixture.eventId, {
        status: "registration_open",
        applicationsCloseAt: Date.now() + 86_400_000,
      }),
    );
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    await expect(
      operator.mutation(api.admissions.decide, {
        eventSlug: fixture.eventSlug,
        applicationId: fixture.decidableApplicationId,
        expectedApplicationVersion: 1,
        decision: "accept",
        reasonCode: "strong_fit",
        aiDisposition: "unavailable",
        clientOperationId: "cohort-decision-before-deadline",
      }),
    ).rejects.toThrow("after the application deadline");
    await expect(
      backend.run((ctx) => ctx.db.get(fixture.decidableApplicationId)),
    ).resolves.toMatchObject({ state: "under_review", version: 1 });
  });

  test("the admission read endpoint accepts only its own signature context", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const body = JSON.stringify({
      protocolVersion: operationsIntelligenceProtocolVersion,
      read: "admission_cohort",
      eventSlug: fixture.eventSlug,
      capacityPeople: 3,
    });
    const unsigned = await backend.fetch("/intelligence/admission-reads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(unsigned.status).toBe(401);
    const timestamp = Date.now().toString();
    const signature = await signServiceBody({
      context: admissionIntelligenceReadSignatureContext,
      secret: readSecret,
      timestamp,
      body,
    });
    const signed = await backend.fetch("/intelligence/admission-reads", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-signature": signature,
        "x-c2c-timestamp": timestamp,
      },
      body,
    });
    expect(signed.status).toBe(200);
    const payload = (await signed.json()) as {
      read: string;
      data: { candidates: { teamName: string; suggestedIn: boolean; novelty: unknown }[] };
    };
    expect(payload.read).toBe("admission_cohort");
    expect(payload.data.candidates.map((entry) => entry.suggestedIn)).toEqual([true, false, false]);
    expect(payload.data.candidates.every((entry) => entry.novelty === null)).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("Cohort Member");
    expect(JSON.stringify(payload)).not.toContain("@example.test");
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

async function createAuthUser(backend: BackendTest, now: number, key: string) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: `Cohort ${key}`,
        email: `cohort-${key}-${crypto.randomUUID()}@example.test`,
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

type SeedCtx = Parameters<Parameters<BackendTest["run"]>[0]>[0];

async function insertAccount(
  ctx: SeedCtx,
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

async function insertPolicyChain(
  ctx: SeedCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  now: number,
  options: { minimumHumanReviews: number },
) {
  const participantPolicyId = await ctx.db.insert("participantPolicyVersions", {
    eventId,
    version: 1,
    status: "published",
    ...defaultParticipantPolicy,
    checksum: participantPolicyChecksum(defaultParticipantPolicy),
    createdByPersonId: personId,
    createdAt: now,
    publishedAt: now,
  });
  const intakePolicyId = await ctx.db.insert("intakePolicyVersions", {
    eventId,
    version: 1,
    status: "published",
    ...defaultDeterministicIntakePolicy,
    checksum: intakePolicyChecksum(defaultDeterministicIntakePolicy),
    createdByPersonId: personId,
    createdAt: now,
    publishedAt: now,
  });
  const admissionPolicyId = await ctx.db.insert("admissionPolicyVersions", {
    eventId,
    version: "cohort-policy-v1",
    status: "published",
    aiRecommendationMode: "disabled",
    minimumHumanReviews: options.minimumHumanReviews,
    overallParticipantCapacity: 100,
    criteria: [
      {
        criterionKey: "intent",
        label: "Intent",
        guidanceByBand: {
          firstYear: "The team explains a genuine problem and workable basic idea.",
          earlyYear: "The team explains a genuine problem and a coherent event-sized idea.",
          laterYear: "The team explains a clear problem, scope, and feasibility.",
          postgraduateOrProfessional: "The team explains a credible plan and trade-offs.",
          mixedOrExternal: "The team explains a clear problem and workable approach.",
        },
      },
      {
        criterionKey: "scope",
        label: "Event-sized scope",
        guidanceByBand: {
          firstYear: "A weekend-sized slice is stated in plain words.",
          earlyYear: "A weekend-sized slice is stated and plausible.",
          laterYear: "The slice is stated with what is explicitly out of scope.",
          postgraduateOrProfessional: "The slice and its trade-offs are stated.",
          mixedOrExternal: "A weekend-sized slice is stated and plausible.",
        },
      },
    ],
    decisionReasonCodes: [
      { key: "strong_fit", label: "Strong fit", allowedDecisions: ["accept"] },
      { key: "promising_fit", label: "Promising fit", allowedDecisions: ["accept", "waitlist"] },
      { key: "out_of_scope", label: "Out of scope", allowedDecisions: ["decline"] },
      {
        key: "needs_detail",
        label: "Needs detail",
        allowedDecisions: ["waitlist"],
      },
    ],
    checksum: "cohort-policy",
    createdByPersonId: personId,
    createdAt: now,
    publishedAt: now,
  });
  const communicationsPolicy = normalizeCommunicationsPolicy({
    venueName: "Cohort fixture hall",
    startsAt: now + 14 * 24 * 60 * 60 * 1_000,
    endsAt: now + 16 * 24 * 60 * 60 * 1_000,
    nextSteps: [
      {
        stableKey: "review_portal",
        title: "Review the portal",
        detail: "Check the latest event details before confirming the team's place.",
      },
    ],
    discordUrl: "https://discord.gg/cohort-fixture",
    discordLabel: "Open event Discord",
    notificationProvider: "cloudflare_email",
    emailTemplates: defaultParticipantEmailTemplates(),
  });
  const communicationsPolicyId = await ctx.db.insert("communicationsPolicyVersions", {
    eventId,
    version: 1,
    status: "published",
    ...communicationsPolicy,
    checksum: communicationsPolicyChecksum(communicationsPolicy),
    createdByPersonId: personId,
    createdAt: now,
    publishedAt: now,
  });
  await ctx.db.patch(eventId, {
    publishedParticipantPolicyId: participantPolicyId,
    publishedIntakePolicyId: intakePolicyId,
    publishedAdmissionPolicyId: admissionPolicyId,
    publishedCommunicationsPolicyId: communicationsPolicyId,
  });
  return {
    participantPolicyId,
    intakePolicyId,
    admissionPolicyId,
    communicationsPolicyId,
  };
}

async function seedCohortFixture(backend: BackendTest, options: { extraTeams?: number } = {}) {
  const now = Date.now();
  const eventSlug = `cohort-${crypto.randomUUID()}`;
  const operatorAuthUserId = await createAuthUser(backend, now, "operator");
  const operatorAuthSessionId = await createAuthSession(backend, operatorAuthUserId, now);
  const onlookerAuthUserId = await createAuthUser(backend, now, "onlooker");
  const onlookerAuthSessionId = await createAuthSession(backend, onlookerAuthUserId, now);
  const strangerAuthUserId = await createAuthUser(backend, now, "stranger");
  const strangerAuthSessionId = await createAuthSession(backend, strangerAuthUserId, now);

  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Cohort fixture",
      timezone: "Asia/Kolkata",
      status: "registration_closed",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: now - 1,
      startsAt: now + 14 * 24 * 60 * 60 * 1_000,
      endsAt: now + 16 * 24 * 60 * 60 * 1_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const operator = await insertAccount(ctx, eventId, "operator", now, operatorAuthUserId);
    const onlooker = await insertAccount(ctx, eventId, "onlooker", now, onlookerAuthUserId);
    await ctx.db.insert("people", {
      authUserId: strangerAuthUserId,
      googleSubject: `google-stranger-${crypto.randomUUID()}`,
      verifiedEmail: `stranger-${crypto.randomUUID()}@example.test`,
      displayName: "stranger person",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const reviewer = await insertAccount(ctx, eventId, "reviewer", now);
    const secondReviewer = await insertAccount(ctx, eventId, "second-reviewer", now);
    const chain = await insertPolicyChain(ctx, eventId, operator.personId, now, {
      minimumHumanReviews: 2,
    });
    for (const permissionKey of [
      "application.read",
      "application.profile_context.read",
      "application.ai_recommendation.read",
      "application.decide",
    ] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: operator.personId,
        eventAccessSubjectId: operator.subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "manual",
        sourceId: `${eventSlug}:${permissionKey}`,
        grantedByPersonId: operator.personId,
        reason: "Cohort test",
      });
    }
    await ctx.db.insert("eventRoles", {
      eventId,
      personId: operator.personId,
      eventAccessSubjectId: operator.subjectId,
      role: "supreme",
      validFrom: now,
      status: "active",
      sourceType: "manual",
      sourceId: `${eventSlug}:supreme`,
      assignedByPersonId: operator.personId,
      createdAt: now,
      reason: "Admission release test owner",
    });
    void onlooker;

    async function insertTeam(args: {
      name: string;
      publicCode: string;
      size: number;
      band: Doc<"applications">["experienceBand"];
      submittedAt: number;
      reviews: { reviewerPersonId: Id<"people">; recommendation: "accept" | "decline" }[];
    }) {
      const memberships: Id<"eventMemberships">[] = [];
      for (let index = 0; index < args.size; index += 1) {
        const account = await insertAccount(ctx, eventId, `${args.publicCode}-m${index}`, now);
        const membershipId = await ctx.db.insert("eventMemberships", {
          eventId,
          personId: account.personId,
          eventAccessSubjectId: account.subjectId,
          participantClass: "vit_student",
          eligibilityStatus: "eligible",
          onboardingStatus: "submitted",
          acceptedParticipantPolicyVersionIds: [chain.participantPolicyId],
          createdAt: now,
          updatedAt: now,
        });
        memberships.push(membershipId);
      }
      const leadMembershipId = memberships[0];
      if (!leadMembershipId) throw new Error("The fixture team has no lead.");
      const teamId = await ctx.db.insert("teams", {
        eventId,
        name: args.name,
        publicCode: args.publicCode,
        leadMembershipId,
        status: "submitted",
        activeMemberCount: args.size,
        activeVitMemberCount: args.size,
        activeExternalMemberCount: 0,
        membershipLocked: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const teamMemberIds: Id<"teamMembers">[] = [];
      for (const [index, membershipId] of memberships.entries()) {
        teamMemberIds.push(
          await ctx.db.insert("teamMembers", {
            eventId,
            teamId,
            membershipId,
            role: index === 0 ? "lead" : "member",
            status: "active",
            joinedAt: now,
            source: index === 0 ? "created" : "code",
          }),
        );
      }
      const lockedRosterSnapshotId = await createTestSubmissionSnapshot(ctx, {
        eventId,
        teamId,
        teamMemberIds,
        intakePolicyVersionId: chain.intakePolicyId,
        participantPolicyVersionId: chain.participantPolicyId,
        admissionPolicyVersionId: chain.admissionPolicyId,
        submittedAt: now,
      });
      const projectVersionId = await ctx.db.insert("projectVersions", {
        eventId,
        teamId,
        version: 1,
        initialIdea: `A calm coordination tool for ${args.name.toLowerCase()} volunteers.`,
        intakePolicyVersionId: chain.intakePolicyId,
        intakeResponses: [],
        lockedRosterSnapshotId,
        lockedMemberCount: teamMemberIds.length,
        lockedLeadMembershipId: leadMembershipId,
        freshForEventAttestation: {
          participantPolicyVersionId: chain.participantPolicyId,
          acceptedByMembershipId: leadMembershipId,
          acceptedAt: now,
        },
        finalConfirmation: {
          participantPolicyVersionId: chain.participantPolicyId,
          previewedDraftVersion: 1,
          previewedTeamVersion: 1,
          confirmedByMembershipId: leadMembershipId,
          confirmedAt: now,
        },
        participantPolicyVersionId: chain.participantPolicyId,
        admissionPolicyVersionId: chain.admissionPolicyId,
        sourceDraftVersion: 1,
        submittedByMembershipId: leadMembershipId,
        submittedAt: args.submittedAt,
      });
      await ctx.db.patch(teamId, { lockedProjectVersionId: projectVersionId });
      const applicationId = await ctx.db.insert("applications", {
        eventId,
        teamId,
        submittedProjectVersionId: projectVersionId,
        admissionPolicyVersionId: chain.admissionPolicyId,
        state: "under_review",
        decisionStage: "unrecorded",
        experienceBand: args.band,
        assignedReviewCount: args.reviews.length,
        completedReviewCount: args.reviews.length,
        contentVersion: 1,
        version: 1,
        submittedAt: args.submittedAt,
      });
      for (const [index, review] of args.reviews.entries()) {
        await ctx.db.insert("admissionHumanReviews", {
          eventId,
          applicationId,
          applicationContentVersion: 1,
          reviewerPersonId: review.reviewerPersonId,
          recommendation: review.recommendation,
          reasonCode: review.recommendation === "accept" ? "strong_fit" : "out_of_scope",
          status: "active",
          createdAt: now + index,
        });
      }
      return applicationId;
    }

    const decidableApplicationId = await insertTeam({
      name: "Steady Loom",
      publicCode: "LOOM01",
      size: 2,
      band: "early_year",
      submittedAt: now - 3_000,
      reviews: [
        { reviewerPersonId: reviewer.personId, recommendation: "accept" },
        { reviewerPersonId: secondReviewer.personId, recommendation: "accept" },
      ],
    });
    const shortApplicationId = await insertTeam({
      name: "Night Kiln",
      publicCode: "KILN01",
      size: 3,
      band: "first_year",
      submittedAt: now - 2_000,
      reviews: [{ reviewerPersonId: reviewer.personId, recommendation: "accept" }],
    });
    const splitApplicationId = await insertTeam({
      name: "Split Signal",
      publicCode: "SPLT01",
      size: 1,
      band: "mixed_or_external",
      submittedAt: now - 1_000,
      reviews: [
        { reviewerPersonId: reviewer.personId, recommendation: "accept" },
        { reviewerPersonId: secondReviewer.personId, recommendation: "decline" },
      ],
    });
    for (let index = 0; index < (options.extraTeams ?? 0); index += 1) {
      await insertTeam({
        name: `Additional Team ${index + 1}`,
        publicCode: `MORE${String(index + 1).padStart(2, "0")}`,
        size: 1,
        band: "first_year",
        submittedAt: now + index + 1,
        reviews: [],
      });
    }

    return {
      now,
      eventSlug,
      eventId,
      communicationsPolicyId: chain.communicationsPolicyId,
      operatorPersonId: operator.personId,
      operatorAuthUserId,
      operatorAuthSessionId,
      onlookerAuthUserId,
      onlookerAuthSessionId,
      strangerAuthUserId,
      strangerAuthSessionId,
      decidableApplicationId,
      shortApplicationId,
      splitApplicationId,
    };
  });
}
