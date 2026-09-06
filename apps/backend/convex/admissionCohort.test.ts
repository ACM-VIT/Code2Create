import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

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

afterEach(() => vi.useRealTimers());

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

  test("reports and filters mutually exclusive review coverage", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend, { extraTeams: 1 });
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });

    expect(await operator.query(api.admissions.reviewProgressCounts, {
      eventSlug: fixture.eventSlug,
    })).toEqual({ total: 4, unreviewed: 1, partial: 1, complete: 2 });

    const list = async (reviewProgress: "unreviewed" | "partial" | "complete") =>
      (await operator.query(api.admissions.list, {
        eventSlug: fixture.eventSlug,
        reviewProgress,
        paginationOpts: { cursor: null, numItems: 10 },
      })).page.map((application) => application.teamName);
    expect(await list("unreviewed")).toEqual(["Additional Team 1"]);
    expect(await list("partial")).toEqual(["Night Kiln"]);
    expect(await list("complete")).toEqual(["Steady Loom", "Split Signal"]);

    expect((await operator.query(api.admissions.searchApplications, {
      eventSlug: fixture.eventSlug,
      reviewProgress: "unreviewed",
      search: "additional",
    })).applications.map((application) => application.teamName)).toEqual(["Additional Team 1"]);
    expect((await operator.query(api.admissions.searchApplications, {
      eventSlug: fixture.eventSlug,
      reviewProgress: "complete",
      search: "additional",
    })).applications).toEqual([]);
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

  test("paginates review shortfalls within transaction limits across completed applications", async () => {
    const backend = convexTest({ schema, modules, transactionLimits: true });
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const fixture = await seedCohortFixture(backend);
    // Keep the one matching application after a long run of completed reviews.
    await backend.run(async (ctx) => {
      await ctx.db.patch(fixture.shortApplicationId, { submittedAt: fixture.now + 1_000 });
    });
    for (let batch = 0; batch < 15; batch += 1) {
      await backend.run(async (ctx) => {
        const source = await ctx.db.get(fixture.decidableApplicationId);
        if (!source) throw new Error("Missing fixture application");
        const { _id, _creationTime, ...application } = source;
        for (let index = 0; index < 20; index += 1) {
          await ctx.db.insert("applications", {
            ...application,
            submittedAt: fixture.now + batch * 20 + index,
          });
        }
      });
    }
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const ids: Id<"applications">[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const result: FunctionReturnType<typeof api.admissions.list> = await operator.query(
        api.admissions.list,
        {
          eventSlug: fixture.eventSlug,
          state: "under_review",
          needsReview: true,
          paginationOpts: { cursor, numItems: 30 },
        },
      );
      ids.push(...result.page.map((application) => application.id));
      pages += 1;
      if (result.isDone) break;
      expect(result.continueCursor).not.toBe(cursor);
      expect(pages).toBeLessThan(20);
      cursor = result.continueCursor;
    }
    expect(ids).toEqual([fixture.shortApplicationId]);
    expect(pages).toBeGreaterThan(1);
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
    const status = await operator.query(api.admissions.admissionSummary, {
      eventSlug: fixture.eventSlug,
    });
    expect(status).toMatchObject({
      total: 3,
      reviewsComplete: 2,
      reviewsNeeded: 1,
      recorded: 0,
      unrecorded: 3,
      ideaAgent: { accepted: 0, waitlisted: 0, rejected: 0, unavailable: 3 },
      humanReviews: {
        accepted: 1, waitlisted: 0, rejected: 0, split: 1, needed: 1,
        people: { accepted: 2, waitlisted: 0, rejected: 0, split: 1, needed: 3 },
      },
    });
    for (const [outcome, applicationId] of [
      ["accepted", fixture.decidableApplicationId],
      ["split", fixture.splitApplicationId],
      ["needed", fixture.shortApplicationId],
    ] as const) {
      const result = await operator.query(api.admissions.list, {
        eventSlug: fixture.eventSlug,
        recommendationFilter: { source: "human", outcome },
        paginationOpts: { cursor: null, numItems: 10 },
      });
      expect(result.page.map((application) => application.id)).toEqual([applicationId]);
    }
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
    expect(await operator.query(api.admissions.admissionSummary, {
      eventSlug: fixture.eventSlug,
    })).toMatchObject({
      reviewsComplete: 3, reviewsNeeded: 0, unrecorded: 3,
      humanReviews: {
        accepted: 2, waitlisted: 0, rejected: 0, split: 1, needed: 0,
        people: { accepted: 5, waitlisted: 0, rejected: 0, split: 1, needed: 0 },
      },
    });
  });

  test("human summary counts each team once using only active, current reviews", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend, { extraTeams: 1 });
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    await backend.run(async (ctx) => {
      const reviews = await ctx.db.query("admissionHumanReviews").collect();
      for (const review of reviews) {
        const recommendation = review.applicationId === fixture.decidableApplicationId
          ? "waitlist" : "decline";
        await ctx.db.patch(review._id, { recommendation });
      }
      const shortReview = reviews.find((review) => review.applicationId === fixture.shortApplicationId)!;
      const otherReviewer = reviews.find((review) => review.reviewerPersonId !== shortReview.reviewerPersonId)!;
      await ctx.db.insert("admissionHumanReviews", {
        eventId: fixture.eventId,
        applicationId: fixture.shortApplicationId,
        applicationContentVersion: 1,
        reviewerPersonId: otherReviewer.reviewerPersonId,
        recommendation: "decline",
        reasonCode: "out_of_scope",
        status: "active",
        createdAt: fixture.now,
      });
      await ctx.db.patch(fixture.shortApplicationId, { completedReviewCount: 2 });
      // Historical recommendations must not turn the unanimous waitlist into a split.
      for (const [status, applicationContentVersion] of [["superseded", 1], ["active", 0]] as const) {
        await ctx.db.insert("admissionHumanReviews", {
          eventId: fixture.eventId,
          applicationId: fixture.decidableApplicationId,
          applicationContentVersion,
          reviewerPersonId: otherReviewer.reviewerPersonId,
          recommendation: "accept",
          reasonCode: "strong_fit",
          status,
          createdAt: fixture.now - 1,
        });
      }
      // A final decision must not overwrite the human recommendation summary.
      await ctx.db.patch(fixture.decidableApplicationId, {
        decisionStage: "recorded", humanDecision: "accept",
      });
    });
    const queryStatus = () => operator.query(api.admissions.admissionSummary, {
      eventSlug: fixture.eventSlug,
    });
    expect(await queryStatus()).toMatchObject({
      total: 4, reviewsComplete: 3, reviewsNeeded: 1, accepted: 1,
      humanReviews: {
        accepted: 0, waitlisted: 1, rejected: 2, split: 0, needed: 1,
        people: { accepted: 0, waitlisted: 2, rejected: 4, split: 0, needed: 1 },
      },
    });
    const summary = (await queryStatus()).humanReviews;
    for (const outcome of ["accepted", "waitlisted", "rejected", "split", "needed"] as const) {
      const ids = [];
      let people = 0;
      let cursor: string | null = null;
      for (;;) {
        const page: FunctionReturnType<typeof api.admissions.list> = await operator.query(api.admissions.list, {
          eventSlug: fixture.eventSlug,
          recommendationFilter: { source: "human", outcome },
          paginationOpts: { cursor, numItems: 1 },
        });
        ids.push(...page.page.map((application) => application.id));
        people += page.page.reduce((total, application) => total + application.memberCount, 0);
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(summary[outcome]);
      expect(people).toBe(summary.people[outcome]);
    }
    expect((await operator.query(api.admissions.searchApplications, {
      eventSlug: fixture.eventSlug, search: "steady",
      recommendationFilter: { source: "human", outcome: "waitlisted" },
    })).applications.map((application) => application.id)).toEqual([fixture.decidableApplicationId]);
    expect((await operator.query(api.admissions.searchApplications, {
      eventSlug: fixture.eventSlug, search: "steady",
      recommendationFilter: { source: "human", outcome: "rejected" },
    })).applications).toEqual([]);
    await backend.run((ctx) => ctx.db.patch(fixture.shortApplicationId, { state: "withdrawn" }));
    expect(await queryStatus()).toMatchObject({
      total: 3, reviewsComplete: 2, reviewsNeeded: 1,
      humanReviews: {
        accepted: 0, waitlisted: 1, rejected: 1, split: 0, needed: 1,
        people: { accepted: 0, waitlisted: 2, rejected: 1, split: 0, needed: 1 },
      },
    });
    expect((await operator.query(api.admissions.list, {
      eventSlug: fixture.eventSlug,
      recommendationFilter: { source: "human", outcome: "rejected" },
      paginationOpts: { cursor: null, numItems: 10 },
    })).page.map((application) => application.id)).toEqual([fixture.splitApplicationId]);
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
    const queryStatus = () => operator.query(api.admissions.admissionSummary, {
      eventSlug: fixture.eventSlug,
    });
    expect(await queryStatus()).toMatchObject({
      total: 4, reviewsComplete: 2, reviewsNeeded: 2,
      ideaAgent: { accepted: 1, waitlisted: 1, rejected: 1, unavailable: 1 },
    });
    for (const [outcome, search, applicationId] of [
      ["accepted", "steady", fixture.decidableApplicationId],
      ["waitlisted", "night", fixture.shortApplicationId],
      ["rejected", "split", fixture.splitApplicationId],
    ] as const) {
      const [page, result] = await Promise.all([
        operator.query(api.admissions.list, {
          eventSlug: fixture.eventSlug,
          recommendationFilter: { source: "idea", outcome },
          paginationOpts: { cursor: null, numItems: 10 },
        }),
        operator.query(api.admissions.searchApplications, {
          eventSlug: fixture.eventSlug, search,
          recommendationFilter: { source: "idea", outcome },
        }),
      ]);
      expect(page.page.map((application) => application.id)).toEqual([applicationId]);
      expect(result.applications.map((application) => application.id)).toEqual([applicationId]);
    }
    await backend.run(async (ctx) => {
      await ctx.db.patch(recommendationIds[0]!, { state: "stale" });
      await ctx.db.patch(recommendationIds[1]!, { applicationContentVersion: 99 });
      await ctx.db.patch(fixture.splitApplicationId, { state: "withdrawn" });
    });
    expect(await queryStatus()).toMatchObject({
      total: 3,
      ideaAgent: { accepted: 0, waitlisted: 0, rejected: 0, unavailable: 3 },
    });
    const unavailable = await operator.query(api.admissions.list, {
      eventSlug: fixture.eventSlug,
      recommendationFilter: { source: "idea", outcome: "unavailable" },
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(unavailable.page).toHaveLength(3);
    expect(unavailable.page.every((application) => application.aiRecommendation === undefined)).toBe(true);
    expect((await operator.query(api.admissions.searchApplications, {
      eventSlug: fixture.eventSlug, search: "steady",
      recommendationFilter: { source: "idea", outcome: "accepted" },
    })).applications).toEqual([]);
    await backend.run(async (ctx) => {
      const grants = await ctx.db.query("permissionGrants").collect();
      for (const grant of grants) {
        if (grant.eventId === fixture.eventId && grant.permissionKey === "application.ai_recommendation.read") {
          await ctx.db.delete(grant._id);
        }
      }
    });
    expect(await queryStatus()).toMatchObject({ ideaAgent: null });
    await expect(operator.query(api.admissions.list, {
      eventSlug: fixture.eventSlug,
      recommendationFilter: { source: "idea", outcome: "unavailable" },
      paginationOpts: { cursor: null, numItems: 10 },
    })).rejects.toThrow("permission");
    await expect(operator.query(api.admissions.searchApplications, {
      eventSlug: fixture.eventSlug, search: "steady",
      recommendationFilter: { source: "idea", outcome: "accepted" },
    })).rejects.toThrow("permission");
    const onlooker = backend.withIdentity({
      subject: fixture.onlookerAuthUserId,
      sessionId: fixture.onlookerAuthSessionId,
    });
    await expect(onlooker.query(api.admissions.admissionSummary, {
      eventSlug: fixture.eventSlug,
    })).rejects.toThrow("cannot read application counts");
  });

  test("application readers see stats and filters without the Supreme role", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const reader = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    await backend.run(async (ctx) => {
      for (const role of await ctx.db.query("eventRoles").collect()) await ctx.db.delete(role._id);
    });
    expect(await reader.query(api.admissions.admissionSummary, {
      eventSlug: fixture.eventSlug,
    })).toMatchObject({
      canReleaseResults: false, total: 3, reviewsComplete: 2, reviewsNeeded: 1,
      people: { total: 6 },
      humanReviews: { accepted: 1, split: 1, needed: 1 },
      ideaAgent: { unavailable: 3, people: { unavailable: 6 } },
    });
    expect((await reader.query(api.admissions.list, {
      eventSlug: fixture.eventSlug,
      recommendationFilter: { source: "human", outcome: "accepted" },
      paginationOpts: { cursor: null, numItems: 10 },
    })).page.map((application) => application.id)).toEqual([fixture.decidableApplicationId]);
    expect((await reader.query(api.admissions.searchApplications, {
      eventSlug: fixture.eventSlug, search: "steady",
      recommendationFilter: { source: "idea", outcome: "unavailable" },
    })).applications.map((application) => application.id)).toEqual([fixture.decidableApplicationId]);
    await expect(reader.mutation(api.admissions.releaseAdmissionResults, {
      rsvpClosesAt: Date.now() + 60 * 60_000,
      eventSlug: fixture.eventSlug, expectedEventVersion: 1,
      reason: "A reader must not release results", clientOperationId: "reader-release-denied",
    })).rejects.toThrow("Only an active Supreme");
    await backend.run(async (ctx) => {
      for (const grant of await ctx.db.query("permissionGrants").collect()) {
        if (grant.permissionKey === "application.ai_recommendation.read") await ctx.db.delete(grant._id);
      }
    });
    expect(await reader.query(api.admissions.admissionSummary, {
      eventSlug: fixture.eventSlug,
    })).toMatchObject({ canReleaseResults: false, total: 3, humanReviews: { accepted: 1 }, ideaAgent: null });
  });

  test("scoped stats and AI filters include only applications covered by both read grants", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const reader = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    await backend.run(async (ctx) => {
      for (const grant of await ctx.db.query("permissionGrants").collect()) {
        if (grant.permissionKey === "application.read") {
          await ctx.db.patch(grant._id, { scopeType: "application", scopeId: fixture.decidableApplicationId });
          await insertPermissionGrant(ctx, {
            eventId: fixture.eventId, personId: fixture.operatorPersonId,
            eventAccessSubjectId: grant.eventAccessSubjectId,
            permissionKey: "application.read", scopeType: "application", scopeId: fixture.shortApplicationId,
            sourceType: "manual", sourceId: "summary-scoped-read", reason: "Scoped summary test",
          });
        }
        if (grant.permissionKey === "application.ai_recommendation.read") {
          await ctx.db.patch(grant._id, { scopeType: "application", scopeId: fixture.decidableApplicationId });
          await insertPermissionGrant(ctx, {
            eventId: fixture.eventId, personId: fixture.operatorPersonId,
            eventAccessSubjectId: grant.eventAccessSubjectId,
            permissionKey: "application.ai_recommendation.read", scopeType: "application", scopeId: fixture.splitApplicationId,
            sourceType: "manual", sourceId: "summary-scoped-ai", reason: "AI access alone must not reveal an application",
          });
        }
      }
    });
    // Even a Supreme cannot release from a summary limited to selected applications.
    expect(await reader.query(api.admissions.admissionSummary, {
      eventSlug: fixture.eventSlug,
    })).toMatchObject({
      canReleaseResults: false, total: 2, reviewsComplete: 1, reviewsNeeded: 1,
      people: { total: 5 },
      humanReviews: { accepted: 1, split: 0, needed: 1 },
      ideaAgent: { unavailable: 1, people: { unavailable: 2 } },
    });
    expect((await reader.query(api.admissions.list, {
      eventSlug: fixture.eventSlug,
      recommendationFilter: { source: "idea", outcome: "unavailable" },
      paginationOpts: { cursor: null, numItems: 10 },
    })).page.map((application) => application.id)).toEqual([fixture.decidableApplicationId]);
    expect((await reader.query(api.admissions.list, {
      eventSlug: fixture.eventSlug,
      recommendationFilter: { source: "human", outcome: "needed" },
      paginationOpts: { cursor: null, numItems: 10 },
    })).page.map((application) => application.id)).toEqual([fixture.shortApplicationId]);
    for (const [search, ids] of [
      ["steady", [fixture.decidableApplicationId]],
      ["night", []],
      ["split", []],
    ] as const) {
      expect((await reader.query(api.admissions.searchApplications, {
        eventSlug: fixture.eventSlug, search,
        recommendationFilter: { source: "idea", outcome: "unavailable" },
      })).applications.map((application) => application.id)).toEqual(ids);
    }
    await backend.run(async (ctx) => {
      for (const grant of await ctx.db.query("permissionGrants").collect()) {
        if (grant.permissionKey === "application.read") await ctx.db.delete(grant._id);
      }
    });
    await expect(reader.query(api.admissions.admissionSummary, {
      eventSlug: fixture.eventSlug,
    })).rejects.toThrow("cannot read application counts");
  });

  test("only Supreme releases the complete recorded decision set", async () => {
    vi.useFakeTimers();
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
      rsvpClosesAt: Date.now() + 60 * 60_000,
        eventSlug: fixture.eventSlug,
        expectedEventVersion: 1,
        reason: "Release the reviewed admissions set",
        clientOperationId: "release-by-onlooker",
      }),
    ).rejects.toThrow("Only an active Supreme");
    await expect(
      operator.mutation(api.admissions.releaseAdmissionResults, {
      rsvpClosesAt: Date.now() + 60 * 60_000,
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
    const readiness = await operator.query(api.admissions.admissionSummary, {
      eventSlug: fixture.eventSlug,
    });
    expect(readiness).toMatchObject({
      canReleaseResults: true,
      total: 3,
      unrecorded: 0,
      recorded: 3,
      accepted: 1,
      waitlisted: 1,
      declined: 1,
    });
    for (const reminderAt of [fixture.now - 60_000, Date.now()]) {
      await expect(operator.mutation(api.admissions.releaseAdmissionResults, {
        rsvpClosesAt: Date.now() + 60 * 60_000,
        rsvpReminderAt: reminderAt,
        eventSlug: fixture.eventSlug,
        expectedEventVersion: 1,
        reason: "Reject an elapsed reminder schedule",
        clientOperationId: `invalid-release-${reminderAt}`,
      })).rejects.toThrow("Reminder calls must start in the future");
    }
    expect((await backend.run(ctx => ctx.db.get(fixture.eventId)))?.admissionResultsReleasedAt).toBeUndefined();
    const released = await operator.mutation(api.admissions.releaseAdmissionResults, {
      rsvpClosesAt: Date.now() + 60 * 60_000,
      eventSlug: fixture.eventSlug,
      expectedEventVersion: 1,
      reason: "Release the reviewed admissions set",
      clientOperationId: "release-complete-set",
    });
    expect(released.applicationCount).toBe(3);
    for (let index = 0; index < 3; index += 1) {
      await backend.mutation(internal.admissions.finalizeReleasedAdmissionResults, {
        eventId: fixture.eventId,
        releasedAt: released.releasedAt,
        releasedByPersonId: fixture.operatorPersonId,
        communicationsPolicyVersionId: fixture.communicationsPolicyId,
      });
    }
    const rsvpArgs = {
      eventSlug: fixture.eventSlug, expectedEventVersion: 2,
      closesAt: fixture.now + 2 * 60 * 60_000, reminderAt: fixture.now + 60 * 60_000,
      reason: "Open attendance confirmation with a scheduled reminder", clientOperationId: "open-rsvp",
    };
    await expect(onlooker.mutation(api.admissionRsvp.configure, rsvpArgs)).rejects.toThrow("permission");
    const selected = await backend.run(ctx => ctx.db.get(fixture.decidableApplicationId));
    if (!selected) throw new Error("Missing accepted application");
    for (const reminderAt of [fixture.now - 60_000, Date.now()]) {
      await expect(operator.mutation(api.admissionRsvp.configure, {
        ...rsvpArgs, reminderAt, clientOperationId: `invalid-configure-${reminderAt}`,
      })).rejects.toThrow("Reminder calls must start in the future");
      await expect(operator.mutation(api.admissions.sendOffer, {
        eventSlug: fixture.eventSlug, applicationId: selected._id,
        expectedApplicationVersion: selected.version, expiresAt: rsvpArgs.closesAt, reminderAt,
        clientOperationId: `invalid-offer-${reminderAt}`,
      })).rejects.toThrow("Reminder calls must start in the future");
    }
    expect(await backend.run(ctx => ctx.db.query("admissionOffers").collect())).toEqual([]);
    expect((await backend.run(ctx => ctx.db.get(fixture.eventId)))?.version).toBe(2);
    await operator.mutation(api.admissionRsvp.configure, rsvpArgs);
    await operator.mutation(api.admissionRsvp.configure, rsvpArgs);
    // The schedule was saved on time, but a delayed worker can apply it after calls begin.
    const delayedClock = vi.spyOn(Date, "now").mockReturnValue(rsvpArgs.reminderAt + 1);
    try {
      await backend.mutation(internal.admissionRsvp.openForApplication, { applicationId: fixture.decidableApplicationId });
      await backend.mutation(internal.admissionRsvp.openForApplication, { applicationId: fixture.decidableApplicationId });
    } finally {
      delayedClock.mockRestore();
    }
    const offers = await backend.run(ctx => ctx.db.query("admissionOffers").collect());
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ state: "offered", expiresAt: rsvpArgs.closesAt, reminderAt: rsvpArgs.reminderAt });
    await operator.mutation(api.admissionRsvp.configure, {
      ...rsvpArgs, expectedEventVersion: 3, closesAt: rsvpArgs.closesAt + 60_000, reminderAt: rsvpArgs.reminderAt + 60_000, clientOperationId: "edit-rsvp",
    });
    await backend.mutation(internal.admissionRsvp.openForApplication, { applicationId: fixture.decidableApplicationId });
    const changedOffers = await backend.run(ctx => ctx.db.query("admissionOffers").collect());
    expect(changedOffers).toHaveLength(1);
    expect(changedOffers[0]).toMatchObject({ state: "offered", expiresAt: rsvpArgs.closesAt + 60_000, reminderAt: rsvpArgs.reminderAt + 60_000, version: (offers[0]?.version ?? 0) + 1 });
    const pendingOffer = changedOffers[0];
    if (!pendingOffer) throw new Error("Missing pending RSVP");
    await backend.run(async ctx => {
      const team = await ctx.db.get(pendingOffer.teamId);
      if (!team) throw new Error("Missing team");
      await ctx.db.insert("participantProfiles", {
        eventId: fixture.eventId, membershipId: team.leadMembershipId, participantClass: "vit_student",
        fullName: "Team lead", phone: "+919876543210", gender: "male", institution: "VIT",
        yearOfStudy: "first", profileVersion: 1, updatedAt: fixture.now,
      });
    });
    const callArgs = { eventSlug: fixture.eventSlug, offerId: pendingOffer._id, clientOperationId: "call-rsvp-now" };
    await expect(onlooker.mutation(api.admissionOfferCalls.sendNow, callArgs)).rejects.toThrow("permission");
    const emailsBeforeCall = await backend.run(ctx => ctx.db.query("participantNotificationDeliveries").collect());
    await operator.mutation(api.admissionOfferCalls.sendNow, callArgs);
    await operator.mutation(api.admissionOfferCalls.sendNow, callArgs);
    await backend.mutation(internal.admissionOfferCalls.remind, { offerId: pendingOffer._id });
    await backend.mutation(internal.admissionOfferCalls.remind, { offerId: pendingOffer._id });
    const immediate = await backend.run(async ctx => ({
      offer: await ctx.db.get(pendingOffer._id), calls: await ctx.db.query("outboundCallDeliveries").collect(),
      emails: await ctx.db.query("participantNotificationDeliveries").collect(),
    }));
    expect(immediate.offer?.expiresAt).toBe(pendingOffer.expiresAt);
    expect(immediate.offer?.reminderAt).toBeLessThanOrEqual(Date.now());
    expect(immediate.calls).toHaveLength(1);
    expect(immediate.calls[0]?.script).not.toMatch(/test/i);
    expect(immediate.emails).toHaveLength(emailsBeforeCall.length);
    const queued = immediate.calls[0];
    if (!queued) throw new Error("Missing reminder delivery");
    await backend.run(async ctx => {
      await ctx.db.patch(pendingOffer._id, { reminderAt: Date.now() + 60_000 });
      await ctx.db.patch(queued._id, { state: "retry_wait", nextAttemptAt: Date.now() + 120_000 });
    });
    expect(await backend.mutation(internal.outboundCallState.claimDelivery, {
      deliveryId: queued._id, attemptId: "too-early",
    })).toBeNull();
    const retryArgs = { ...callArgs, clientOperationId: "bring-existing-retry-forward" };
    await operator.mutation(api.admissionOfferCalls.sendNow, retryArgs);
    await operator.mutation(api.admissionOfferCalls.sendNow, retryArgs);
    const expedited = await backend.run(async ctx => ({
      offer: await ctx.db.get(pendingOffer._id), call: await ctx.db.get(queued._id),
      calls: await ctx.db.query("outboundCallDeliveries").collect(),
      emails: await ctx.db.query("participantNotificationDeliveries").collect(),
    }));
    expect(expedited.offer!.reminderAt).toBeLessThanOrEqual(Date.now());
    expect(expedited.call!.nextAttemptAt).toBeLessThanOrEqual(Date.now());
    expect(expedited.calls).toHaveLength(1);
    expect(expedited.emails).toEqual(immediate.emails);
    expect(await backend.mutation(internal.outboundCallState.claimDelivery, {
      deliveryId: queued._id, attemptId: "operator-expedited",
    })).not.toBeNull();
    expect(await backend.mutation(internal.outboundCallState.claimDelivery, {
      deliveryId: queued._id, attemptId: "duplicate-dispatch",
    })).toBeNull();

    const repeatArgs = {
      eventSlug: fixture.eventSlug, offerId: pendingOffer._id, previousDeliveryId: queued._id,
      reason: "Call the still-unanswered team again", clientOperationId: "repeat-rsvp-call",
    };
    await expect(onlooker.mutation(api.admissionOfferCalls.repeat, repeatArgs)).rejects.toThrow("permission");
    await expect(operator.mutation(api.admissionOfferCalls.repeat, repeatArgs)).rejects.toThrow("definite call outcome");
    await backend.run(ctx => ctx.db.patch(queued._id, { state: "completed", completedAt: Date.now() }));
    await expect(operator.mutation(api.admissionOfferCalls.repeat, repeatArgs)).rejects.toThrow("five minutes");
    await backend.run(ctx => ctx.db.patch(queued._id, { createdAt: Date.now() - 6 * 60_000 }));
    const originalCall = await backend.run(ctx => ctx.db.get(queued._id));
    await operator.mutation(api.admissionOfferCalls.repeat, repeatArgs);
    await operator.mutation(api.admissionOfferCalls.repeat, repeatArgs);
    await expect(operator.mutation(api.admissionOfferCalls.repeat, {
      ...repeatArgs, clientOperationId: "competing-repeat-rsvp-call",
    })).rejects.toThrow("Refresh the previous RSVP call");
    await backend.mutation(internal.admissionOfferCalls.remind, { offerId: pendingOffer._id });
    await operator.mutation(api.admissionOfferCalls.sendNow, { ...callArgs, clientOperationId: "after-repeat-send-now" });
    const repeated = await backend.run(async ctx => ({
      calls: await ctx.db.query("outboundCallDeliveries").collect(),
      original: await ctx.db.get(queued._id),
      emails: await ctx.db.query("participantNotificationDeliveries").collect(),
    }));
    expect(repeated.calls).toHaveLength(2);
    expect(repeated.original).toEqual(originalCall);
    expect(repeated.emails).toEqual(immediate.emails);
    const newCall = repeated.calls.find(call => call._id !== queued._id);
    if (!newCall) throw new Error("Missing repeat call");
    expect(newCall).toMatchObject({ state: "pending", attemptCount: 0, sourceId: pendingOffer._id });
    // A response arriving after enqueue cancels the new dispatch rather than calling a confirmed team.
    await backend.run(ctx => ctx.db.patch(pendingOffer._id, { state: "confirmed" }));
    expect(await backend.mutation(internal.outboundCallState.claimDelivery, {
      deliveryId: newCall._id, attemptId: "response-before-redial",
    })).toBeNull();
    await expect(operator.mutation(api.admissionOfferCalls.repeat, {
      ...repeatArgs, previousDeliveryId: newCall._id, clientOperationId: "repeat-after-rsvp",
    })).rejects.toThrow("no current unanswered RSVP");
    await backend.run(ctx => ctx.db.patch(pendingOffer._id, { state: "offered" }));

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
      ["offer_sent", "released"],
      ["waitlisted", "released"],
      ["declined", "released"],
    ]);
    expect(await operator.query(api.admissions.stageCounts, { eventSlug: fixture.eventSlug }))
      .toEqual(expect.arrayContaining([
        { state: "offer_sent", count: 1 }, { state: "waitlisted", count: 1 }, { state: "declined", count: 1 },
      ]));
    expect((await operator.query(api.admissions.list, {
      eventSlug: fixture.eventSlug, state: "recorded", paginationOpts: { cursor: null, numItems: 30 },
    })).page).toEqual([]);
  });

  test.each(["accept", "waitlist", "decline"] as const)(
    "keeps recorded results private and releases once without external %s emails",
    async (externalDecision) => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend, { primaryTeamSize: 4 });
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const participantAuthUserId = await createAuthUser(backend, fixture.now, "release-participant");
    const participantAuthSessionId = await createAuthSession(backend, participantAuthUserId, fixture.now);
    const participant = backend.withIdentity({
      subject: participantAuthUserId,
      sessionId: participantAuthSessionId,
    });
    await backend.run(async (ctx) => {
      const application = await ctx.db.get(fixture.decidableApplicationId);
      if (!application) throw new Error("Missing release application");
      const team = await ctx.db.get(application.teamId);
      if (!team) throw new Error("Missing release team");
      const lead = await ctx.db.get(team.leadMembershipId);
      if (!lead?.eventAccessSubjectId) throw new Error("Missing release lead");
      await ctx.db.patch(lead.personId, { authUserId: participantAuthUserId });
      await insertPermissionGrant(ctx, { eventId: fixture.eventId, personId: lead.personId, eventAccessSubjectId: lead.eventAccessSubjectId, permissionKey: "application.offer.respond", scopeType: "team", scopeId: team._id, sourceType: "manual", sourceId: "rsvp-rehearsal", reason: "Team lead RSVP response" });
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: lead.personId,
        eventAccessSubjectId: lead.eventAccessSubjectId,
        permissionKey: "team.read",
        scopeType: "team",
        scopeId: team._id,
        sourceType: "manual",
        sourceId: "release-rehearsal",
        grantedByPersonId: fixture.operatorPersonId,
        reason: "Release rehearsal participant access",
      });
    });
    await operator.mutation(api.admissions.decide, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.decidableApplicationId,
      expectedApplicationVersion: 1,
      decision: "accept",
      reasonCode: "strong_fit",
      aiDisposition: "unavailable",
      clientOperationId: "record-private-acceptance",
    });
    expect((await participant.query(api.intake.submitted, { eventSlug: fixture.eventSlug }))?.application.state)
      .toBe("under_review");
    expect(await backend.run((ctx) => ctx.db.query("participantNotificationDeliveries").collect()))
      .toEqual([]);
    const releaseArgs = {
      rsvpClosesAt: Date.now() + 60 * 60_000,
      eventSlug: fixture.eventSlug,
      expectedEventVersion: 1,
      reason: "Isolated admission release rehearsal",
      clientOperationId: "isolated-release",
    };
    await expect(operator.mutation(api.admissions.releaseAdmissionResults, releaseArgs))
      .rejects.toThrow("Every active application");
    await backend.run(async (ctx) => {
      for (const applicationId of [fixture.shortApplicationId, fixture.splitApplicationId]) {
        const decision = applicationId === fixture.splitApplicationId ? externalDecision : "decline";
        await ctx.db.patch(applicationId, {
          decisionStage: "recorded",
          humanDecision: decision,
          humanReasonCode: decision === "accept" ? "strong_fit" : decision === "waitlist" ? "promising_fit" : "out_of_scope",
          aiDisposition: "unavailable",
          decidedByPersonId: fixture.operatorPersonId,
          decidedAt: fixture.now,
          version: 2,
        });
      }
      const externalApplication = await ctx.db.get(fixture.splitApplicationId);
      if (!externalApplication) throw new Error("Missing external application");
      const externalProject = await ctx.db.get(externalApplication.submittedProjectVersionId);
      if (!externalProject) throw new Error("Missing external project");
      const members = await ctx.db.query("teamSubmissionMembers")
        .withIndex("by_submission_attempt_and_ordinal", (q) => q.eq("submissionAttemptId", externalProject.lockedRosterSnapshotId))
        .collect();
      for (const member of members) {
        await ctx.db.patch(member.membershipId, { participantClass: "external_participant" });
        await ctx.db.patch(member._id, { participantClass: "external_participant" });
      }
      await ctx.db.patch(externalApplication.teamId, { activeVitMemberCount: 0, activeExternalMemberCount: members.length });
    });
    const released = await operator.mutation(api.admissions.releaseAdmissionResults, releaseArgs);
    expect(released.applicationCount).toBe(3);
    expect(await operator.mutation(api.admissions.releaseAdmissionResults, releaseArgs)).toEqual(released);
    expect((await participant.query(api.intake.submitted, { eventSlug: fixture.eventSlug }))?.application.state)
      .toBe("accepted");
    const finalizeArgs = {
      eventId: fixture.eventId,
      releasedAt: released.releasedAt,
      releasedByPersonId: fixture.operatorPersonId,
      communicationsPolicyVersionId: fixture.communicationsPolicyId,
    };
    await backend.mutation(internal.admissions.finalizeReleasedAdmissionResults, finalizeArgs);
    const partial = await operator.query(api.admissions.admissionSummary, { eventSlug: fixture.eventSlug });
    expect(partial).toMatchObject({ recorded: 2, released: 1 });
    await backend.mutation(internal.admissions.finalizeReleasedAdmissionResults, finalizeArgs);
    await backend.mutation(internal.admissions.finalizeReleasedAdmissionResults, finalizeArgs);
    await backend.mutation(internal.admissions.finalizeReleasedAdmissionResults, finalizeArgs);
    for (const applicationId of [fixture.decidableApplicationId, fixture.shortApplicationId, fixture.splitApplicationId]) {
      await backend.mutation(internal.admissionRsvp.openForApplication, { applicationId });
      const batch = await backend.run(async (ctx) => {
        const application = await ctx.db.get(applicationId);
        if (!application?.humanDecision) throw new Error("Missing decision");
        const project = await ctx.db.get(application.submittedProjectVersionId);
        if (!project) throw new Error("Missing project");
        return {
          eventId: fixture.eventId,
          applicationId,
          teamId: application.teamId,
          lockedRosterSnapshotId: project.lockedRosterSnapshotId,
          lockedMemberCount: project.lockedMemberCount,
          communicationsPolicyVersionId: fixture.communicationsPolicyId,
          templateKey: application.humanDecision === "accept" ? "offer" as const : application.humanDecision,
          applicationVersion: application.version,
          cursor: null,
          processedMemberCount: 0,
        };
      });
      await backend.mutation(internal.participantNotifications.enqueueRosterBatch, batch);
      await backend.mutation(internal.participantNotifications.enqueueRosterBatch, batch);
    }
    const deliveries = await backend.run((ctx) => ctx.db.query("participantNotificationDeliveries").collect());
    expect(deliveries.filter((d) => d.applicationId === fixture.decidableApplicationId)).toHaveLength(1);
    const lead = await backend.run(async ctx => {
      const application = await ctx.db.get(fixture.decidableApplicationId);
      if (!application) throw new Error("Missing selected application");
      return (await ctx.db.get(application.submittedProjectVersionId))?.lockedLeadMembershipId;
    });
    expect(deliveries.find(d => d.applicationId === fixture.decidableApplicationId)?.membershipId).toBe(lead);
    expect(await backend.run(ctx => ctx.db.query("admissionOffers").filter(q => q.eq(q.field("applicationId"), fixture.splitApplicationId)).collect())).toEqual([]);
    expect(deliveries.filter((d) => d.applicationId === fixture.shortApplicationId)).toHaveLength(3);
    expect(deliveries.filter((d) => d.applicationId === fixture.splitApplicationId)).toHaveLength(0);
    expect(deliveries.every((d) => d.state === "pending" && d.attemptCount === 0)).toBe(true);
    expect(deliveries.filter(d => d.applicationId === fixture.decidableApplicationId).every(d => d.templateKey === "offer")).toBe(true);
    expect((await participant.query(api.intake.submitted, { eventSlug: fixture.eventSlug }))?.application.state)
      .toBe("offer_sent");
    const submitted = await participant.query(api.intake.submitted, { eventSlug: fixture.eventSlug });
    if (!submitted?.application.currentOffer) throw new Error("The selected team cannot see its RSVP.");
    const response = {
      eventSlug: fixture.eventSlug, applicationId: fixture.decidableApplicationId,
      expectedApplicationVersion: submitted.application.version,
      expectedOfferVersion: submitted.application.currentOffer.version,
      response: "confirm" as const, clientOperationId: "team-lead-confirms",
    };
    const confirmed = await participant.mutation(api.admissions.respondToOffer, response);
    expect(await participant.mutation(api.admissions.respondToOffer, response)).toEqual(confirmed);
    expect((await participant.query(api.intake.submitted, { eventSlug: fixture.eventSlug }))?.application.state).toBe("confirmed");
    },
  );

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

async function seedCohortFixture(
  backend: BackendTest,
  options: { extraTeams?: number; primaryTeamSize?: number } = {},
) {
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
    await ctx.db.insert("admissionCapacityBuckets", { eventId, admissionPolicyVersionId: chain.admissionPolicyId, capacity: 825, reserved: 0, version: 1, updatedAt: now });
    for (const permissionKey of [
      "application.offer.manage",
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
      size: options.primaryTeamSize ?? 2,
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
