import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import workpoolTest from "@convex-dev/workpool/test";

import {
  admissionIntelligenceReadSignatureContext,
  defaultParticipantEmailTemplates,
  operationsIntelligenceProtocolVersion,
  signServiceBody,
  shortlistProfileSchema,
  shortlistTaskSchema,
  shortlistSummarySchema,
} from "@code2create/domain";

import { api, components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
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

describe("admission cohort query and decisions", () => {
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
      applications: [
        expect.objectContaining({ teamName: "Additional Team 31" }),
      ],
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
    expect(
      applications.page.map((application) => application.teamName),
    ).toEqual(["Night Kiln"]);
    expect(search).toEqual({
      applications: [
        expect.objectContaining({
          teamName: "Night Kiln",
          completedReviewCount: 1,
        }),
      ],
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

    expect(
      applications.page.map((application) => application.teamName),
    ).toEqual(["Night Kiln"]);
    expect(
      matchingSearch.applications.map((application) => application.teamName),
    ).toEqual(["Night Kiln"]);
    expect(completedSearch.applications).toEqual([]);
  });

  test("shortlists require event-wide application, profile and AI access", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const onlooker = backend.withIdentity({
      subject: fixture.onlookerAuthUserId,
      sessionId: fixture.onlookerAuthSessionId,
    });
    await expect(
      onlooker.query(api.admissionShortlist.latest, {
        eventSlug: fixture.eventSlug,
      }),
    ).rejects.toThrow();
  });

  test("copilot does not invent a ranking when no shortlist exists", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    expect(
      await backend.action(internal.admissionCohort.cohortRead, {
        eventId: fixture.eventId,
      }),
    ).toMatchObject({
      state: "not_generated",
      summaryJson: null,
      snapshotOnly: true,
    });
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
    const untouched = await backend.run((ctx) =>
      ctx.db.get(fixture.shortApplicationId),
    );
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
    const readiness = await operator.query(
      api.admissions.admissionResultsReleaseStatus,
      {
        eventSlug: fixture.eventSlug,
      },
    );
    expect(readiness).toMatchObject({
      isSupreme: true,
      total: 3,
      unrecorded: 0,
      recorded: 3,
      accepted: 1,
      waitlisted: 1,
      declined: 1,
    });
    const released = await operator.mutation(
      api.admissions.releaseAdmissionResults,
      {
        eventSlug: fixture.eventSlug,
        expectedEventVersion: 1,
        reason: "Release the reviewed admissions set",
        clientOperationId: "release-complete-set",
      },
    );
    expect(released.applicationCount).toBe(3);
    await backend.mutation(
      internal.admissions.finalizeReleasedAdmissionResults,
      {
        eventId: fixture.eventId,
        releasedAt: released.releasedAt,
        releasedByPersonId: fixture.operatorPersonId,
        communicationsPolicyVersionId: fixture.communicationsPolicyId,
      },
    );
    const applications = await backend.run((ctx) =>
      Promise.all([
        ctx.db.get(fixture.decidableApplicationId),
        ctx.db.get(fixture.shortApplicationId),
        ctx.db.get(fixture.splitApplicationId),
      ]),
    );
    expect(
      applications.map((application) => [
        application?.state,
        application?.decisionStage,
      ]),
    ).toEqual([
      ["accepted", "released"],
      ["waitlisted", "released"],
      ["declined", "released"],
    ]);
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
      data: { state: string; summaryJson: string | null };
    };
    expect(payload.read).toBe("admission_cohort");
    expect(payload.data.state).toBe("not_generated");
    expect(payload.data.summaryJson).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("Cohort Member");
    expect(JSON.stringify(payload)).not.toContain("@example.test");
  });
});

describe("frozen advisory shortlist lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test("released places do not count historical accepts as current commitments", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    await primeShortlistFixture(backend, fixture);
    const applications = await backend.run(async (ctx) => {
      const apps = await ctx.db
        .query("applications")
        .withIndex("by_event_submitted", (q) => q.eq("eventId", fixture.eventId))
        .take(10);
      const states = ["withdrawn", "offer_expired", "under_review"] as const;
      for (const [index, app] of apps.entries()) {
        const state = states[index];
        if (!state) throw new Error("Unexpected fixture application");
        await ctx.db.patch(app._id, {
          state,
          humanDecision: "accept",
          decisionStage: "recorded",
        });
      }
      return apps;
    });
    expect(applications).toHaveLength(3);
    const currentAccept = applications[2];
    if (!currentAccept) throw new Error("Missing recorded accept fixture");
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const runId = await operator.mutation(api.admissionShortlist.start, {
      eventSlug: fixture.eventSlug,
      acceptPeople: 3,
      waitlistPeople: 2,
      operationId: "released-capacity-regression",
    });
    const candidates = await backend.run((ctx) =>
      ctx.db
        .query("admissionShortlistCandidates")
        .withIndex("by_runId", (q) => q.eq("runId", runId))
        .take(10),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      applicationId: currentAccept._id,
      committed: true,
    });
  });

  test("runs profiles, overlap comparison, selection and audit without deciding applications", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    await primeShortlistFixture(backend, fixture);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const args = {
      eventSlug: fixture.eventSlug,
      acceptPeople: 3,
      waitlistPeople: 2,
      operationId: "shortlist-test-operation",
    };
    const runId = await operator.mutation(api.admissionShortlist.start, args);
    expect(await operator.mutation(api.admissionShortlist.start, args)).toBe(
      runId,
    );
    await expect(
      operator.mutation(api.admissionShortlist.start, {
        ...args,
        acceptPeople: 4,
      }),
    ).rejects.toThrow("different targets");
    await backend.action(internal.admissionShortlistActions.advance, { runId });
    const initial = await backend.query(internal.admissionShortlist.readRun, {
      runId,
    });
    expect(initial).toMatchObject({
      state: "profiling",
      pendingJobs: 3,
      candidateCount: 3,
    });
    for (let stage = 0; stage < 3; stage++) {
      const jobs = await backend.run((ctx) =>
        ctx.db
          .query("admissionShortlistJobs")
          .withIndex("by_runId_and_state", (q) =>
            q.eq("runId", runId).eq("state", "pending"),
          )
          .take(20),
      );
      for (const job of jobs) {
        const task = shortlistTaskSchema.parse(JSON.parse(job.inputJson));
        const result =
          task.kind === "profile"
            ? shortlistProfileSchema.parse({
                user: "Campus volunteers",
                problem: "Missed collections",
                workflow: "Report and acknowledge a collection",
                mechanism: "Dispatch from recorded reports",
                deliverable: "A bounded reporting workflow",
                distinction: "Offline acknowledgement",
                domain: "civic",
                aiRole: "none",
                sourceRefs: ["initial_idea"],
                premise: {
                  assessment:
                    task.candidate.applicationId === fixture.splitApplicationId
                      ? "unsupported"
                      : "supported",
                  explanation:
                    "The evidence establishes the report-to-dispatch connection.",
                  sourceRefs: ["follow_up_4"],
                },
                category: {
                  datingOrRomanticMatchmaking: false,
                  explanation: "Collection coordination, not dating.",
                  sourceRefs: ["initial_idea"],
                },
                criteria: task.candidate.criteria.map((c) => ({
                  criterionKey: c.criterionKey,
                  evidence: "adequate",
                  sourceRefs: ["follow_up_4"],
                })),
              })
            : task.kind === "pair"
              ? {
                  overlap: "substantial",
                  preferred:
                    task.left.applicationId === fixture.shortApplicationId
                      ? "left"
                      : "right",
                  explanation:
                    "This proposal better supports the same workflow.",
                  leftSourceRefs: ["follow_up_4"],
                  rightSourceRefs: ["follow_up_4"],
                }
              : { warnings: [] };
        const callback = {
          runId,
          jobId: job._id,
          attempt: job.attempt,
          resultJson: JSON.stringify(result),
          embedding:
            task.kind === "profile"
              ? Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))
              : [],
        };
        await backend.mutation(internal.admissionShortlist.settleJob, callback);
        await backend.mutation(internal.admissionShortlist.settleJob, callback);
        await expect(
          backend.mutation(internal.admissionShortlist.settleJob, {
            ...callback,
            resultJson: "{}",
          }),
        ).rejects.toThrow("Conflicting");
      }
      await backend.action(internal.admissionShortlistActions.advance, {
        runId,
      });
    }
    const finished = await operator.query(api.admissionShortlist.latest, {
      eventSlug: fixture.eventSlug,
    });
    expect(finished?.state).toBe("complete");
    const summary = shortlistSummarySchema.parse(
      JSON.parse(finished?.summaryJson ?? "{}"),
    );
    expect(summary.totals).toEqual({
      accept: { teams: 1, people: 3 },
      waitlist: { teams: 1, people: 2 },
      reject: { teams: 1, people: 1 },
      unresolved: { teams: 0, people: 0 },
    });
    const applications = await backend.run((ctx) =>
      ctx.db
        .query("applications")
        .withIndex("by_event_submitted", (q) =>
          q.eq("eventId", fixture.eventId),
        )
        .take(10),
    );
    expect(applications.every((a) => a.humanDecision === undefined)).toBe(true);
    const copilot = await backend.action(internal.admissionCohort.cohortRead, {
      eventId: fixture.eventId,
    });
    expect(copilot.summaryJson).toBe(finished?.summaryJson);
  });

  test("changed content stales a snapshot before analysis", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    await primeShortlistFixture(backend, fixture);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const runId = await operator.mutation(api.admissionShortlist.start, {
      eventSlug: fixture.eventSlug,
      acceptPeople: 3,
      waitlistPeople: 2,
      operationId: "stale-snapshot-operation",
    });
    await backend.run((ctx) =>
      ctx.db.patch(fixture.shortApplicationId, { contentVersion: 2 }),
    );
    await backend.action(internal.admissionShortlistActions.advance, { runId });
    expect(
      (await backend.query(internal.admissionShortlist.readRun, { runId }))
        .state,
    ).toBe("stale");
  });

  test("missing quality is waiting, not an inferred rejection", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    await primeShortlistFixture(backend, fixture);
    await backend.run(async (ctx) => {
      const a = await ctx.db.get(fixture.shortApplicationId);
      if (!a?.aiRecommendationId)
        throw new Error("Missing fixture recommendation");
      await ctx.db.patch(a.aiRecommendationId, {
        state: "failed",
        recommendation: undefined,
      });
    });
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const runId = await operator.mutation(api.admissionShortlist.start, {
      eventSlug: fixture.eventSlug,
      acceptPeople: 3,
      waitlistPeople: 2,
      operationId: "missing-quality-operation",
    });
    await backend.action(internal.admissionShortlistActions.advance, { runId });
    expect(
      (await backend.query(internal.admissionShortlist.readRun, { runId }))
        .state,
    ).toBe("waiting");
    const rows = await operator.query(api.admissionShortlist.results, {
      runId,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(rows.page.every((r) => r.suggestion === undefined)).toBe(true);
  });

  test("failed task retry is idempotent and cannot accept a late prior attempt", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    await primeShortlistFixture(backend, fixture);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const runId = await operator.mutation(api.admissionShortlist.start, {
      eventSlug: fixture.eventSlug,
      acceptPeople: 3,
      waitlistPeople: 2,
      operationId: "retry-task-operation",
    });
    await backend.action(internal.admissionShortlistActions.advance, { runId });
    const job = await backend.run((ctx) =>
      ctx.db
        .query("admissionShortlistJobs")
        .withIndex("by_runId", (q) => q.eq("runId", runId))
        .first(),
    );
    if (!job) throw new Error("No profile task");
    await backend.mutation(internal.admissionShortlist.expireJob, {
      jobId: job._id,
      attempt: 1,
    });
    await backend.mutation(internal.admissionShortlist.expireJob, {
      jobId: job._id,
      attempt: 1,
    });
    expect(
      (await backend.query(internal.admissionShortlist.readRun, { runId }))
        .failedJobs,
    ).toBe(1);
    await operator.mutation(api.admissionShortlist.retry, { runId });
    await operator.mutation(api.admissionShortlist.retry, { runId });
    expect(
      (await backend.query(internal.admissionShortlist.readRun, { runId }))
        .state,
    ).toBe("retrying");
    await backend.action(internal.admissionShortlistActions.retryJobs, {
      runId,
    });
    expect((await backend.run((ctx) => ctx.db.get(job._id)))?.attempt).toBe(2);
    await expect(
      backend.mutation(internal.admissionShortlist.settleJob, {
        jobId: job._id,
        runId,
        attempt: 1,
        resultJson: "{}",
        embedding: [],
      }),
    ).rejects.toThrow("Stale");
  });

  test("revoked dispatch permission settles the task without contacting a provider", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    await primeShortlistFixture(backend, fixture);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const runId = await operator.mutation(api.admissionShortlist.start, {
      eventSlug: fixture.eventSlug,
      acceptPeople: 3,
      waitlistPeople: 2,
      operationId: "revoke-dispatch-operation",
    });
    await backend.action(internal.admissionShortlistActions.advance, { runId });
    const job = await backend.run(async (ctx) => {
      const grants = await ctx.db.query("permissionGrants").collect();
      for (const grant of grants)
        if (
          grant.personId === fixture.operatorPersonId &&
          grant.permissionKey === "application.ai_recommendation.run"
        )
          await ctx.db.patch(grant._id, { status: "revoked" });
      return ctx.db
        .query("admissionShortlistJobs")
        .withIndex("by_runId", (q) => q.eq("runId", runId))
        .first();
    });
    if (!job) throw new Error("Missing queued task");
    const network = vi.spyOn(globalThis, "fetch");
    await backend.action(internal.admissionShortlistActions.dispatchJob, {
      jobId: job._id,
      attempt: job.attempt,
    });
    expect(network).not.toHaveBeenCalled();
    expect(
      (await backend.query(internal.admissionShortlist.readRun, { runId }))
        .failedJobs,
    ).toBe(1);
  });

  test("retry preparation pages more than one batch without requeuing successes", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    await primeShortlistFixture(backend, fixture);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const runId = await operator.mutation(api.admissionShortlist.start, {
      eventSlug: fixture.eventSlug,
      acceptPeople: 3,
      waitlistPeople: 2,
      operationId: "paged-retry-operation",
    });
    await backend.run(async (ctx) => {
      for (let i = 0; i < 55; i++)
        await ctx.db.insert("admissionShortlistJobs", {
          runId,
          key: `test:${i}`,
          inputJson: JSON.stringify({ kind: "audit", candidates: [] }),
          state: i < 53 ? "failed" : "succeeded",
          attempt: 1,
        });
      await ctx.db.patch(runId, { state: "failed", failedJobs: 53 });
    });
    await operator.mutation(api.admissionShortlist.retry, { runId });
    await backend.action(internal.admissionShortlistActions.retryJobs, {
      runId,
    });
    await backend.action(internal.admissionShortlistActions.retryJobs, {
      runId,
    });
    const run = await backend.query(internal.admissionShortlist.readRun, {
      runId,
    });
    expect(run).toMatchObject({
      state: "profiling",
      failedJobs: 0,
      pendingJobs: 53,
    });
    const jobs = await backend.run((ctx) =>
      ctx.db
        .query("admissionShortlistJobs")
        .withIndex("by_runId", (q) => q.eq("runId", runId))
        .collect(),
    );
    expect(
      jobs.filter((j) => j.state === "pending").every((j) => j.attempt === 2),
    ).toBe(true);
    expect(
      jobs.filter((j) => j.state === "succeeded").every((j) => j.attempt === 1),
    ).toBe(true);
  });

  test("a changed shortlist release cannot reuse a frozen run", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    await primeShortlistFixture(backend, fixture);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const runId = await operator.mutation(api.admissionShortlist.start, {
      eventSlug: fixture.eventSlug,
      acceptPeople: 3,
      waitlistPeople: 2,
      operationId: "changed-release-operation",
    });
    await backend.run((ctx) =>
      ctx.db.patch(runId, { releaseVersion: "obsolete" }),
    );
    await backend.action(internal.admissionShortlistActions.advance, { runId });
    expect(
      (await backend.query(internal.admissionShortlist.readRun, { runId }))
        .state,
    ).toBe("stale");
  });

  test("unsigned and malformed callbacks cannot mutate the shortlist", async () => {
    vi.stubEnv(
      "INTELLIGENCE_CALLBACK_SECRET",
      "callback-test-secret".padEnd(64, "x"),
    );
    const backend = seededBackend();
    const response = await backend.fetch(
      "/intelligence/admission-shortlist/callback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(401);
    expect(
      await backend.run((ctx) =>
        ctx.db.query("admissionShortlistJobs").collect(),
      ),
    ).toEqual([]);
    await expect(
      backend.mutation(internal.admissionShortlist.settleJob, {
        jobId: "not-an-id",
        runId: "not-an-id",
        attempt: 1,
        resultJson: "{}",
        embedding: [],
      }),
    ).rejects.toThrow("Invalid shortlist identity");
  });
});

async function primeShortlistFixture(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedCohortFixture>>,
) {
  await backend.run(async (ctx) => {
    const event = await ctx.db.get(fixture.eventId);
    if (!event?.publishedAdmissionPolicyId)
      throw new Error("Missing fixture policy");
    const policyId = event.publishedAdmissionPolicyId;
    await ctx.db.patch(policyId, { aiRecommendationMode: "enabled" });
    const modelId = await ctx.db.insert("admissionModelConfigVersions", {
      eventId: event._id,
      admissionPolicyVersionId: policyId,
      version: "shortlist-test",
      modelId: "test-model",
      promptVersion: "test-prompt",
      schemaVersion: "test-schema",
      evaluationSuiteVersion: "test-eval",
      status: "published",
      checksum: "test-model",
      createdByPersonId: fixture.operatorPersonId,
      createdAt: fixture.now,
    });
    await ctx.db.patch(event._id, { publishedAdmissionModelConfigId: modelId });
    const subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (q) =>
        q.eq("eventId", event._id).eq("personId", fixture.operatorPersonId),
      )
      .unique();
    if (!subject) throw new Error("Missing operator subject");
    await insertPermissionGrant(ctx, {
      eventId: event._id,
      personId: fixture.operatorPersonId,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.ai_recommendation.run",
      scopeType: "event",
      sourceType: "manual",
      sourceId: "shortlist-test",
      grantedByPersonId: fixture.operatorPersonId,
      reason: "Local shortlist test",
    });
    const applications = await ctx.db
      .query("applications")
      .withIndex("by_event_submitted", (q) => q.eq("eventId", event._id))
      .take(10);
    for (const app of applications) {
      const project = await ctx.db.get(app.submittedProjectVersionId);
      const draft = await ctx.db
        .query("projectDrafts")
        .withIndex("by_team", (q) => q.eq("teamId", app.teamId))
        .unique();
      if (!project || !draft) throw new Error("Missing fixture project");
      const responses: Doc<"projectVersions">["intakeResponses"] = [];
      for (let ordinal = 1; ordinal <= 4; ordinal++) {
        const source = ordinal <= 2 ? ("fixed" as const) : ("model" as const);
        const questionId = await ctx.db.insert("intakeGeneratedQuestions", {
          eventId: event._id,
          teamId: app.teamId,
          draftId: draft._id,
          ordinal,
          text: `Specific question ${ordinal}`,
          purposeKey: "problem",
          answerLength: "short",
          source,
          sourceAnswerVersionIds: [],
          intakePolicyVersionId: project.intakePolicyVersionId,
          state: "answered",
          validationCategory: "valid",
          createdAt: fixture.now,
        });
        responses.push({
          questionId,
          ordinal,
          question: `Specific question ${ordinal}`,
          purposeKey: "problem",
          answerLength: "short",
          source,
          answer: `Concrete workflow evidence ${ordinal}`,
        });
      }
      await ctx.db.patch(project._id, { intakeResponses: responses });
      const recommendationId = await ctx.db.insert(
        "admissionAIRecommendations",
        {
          eventId: event._id,
          applicationId: app._id,
          teamId: app.teamId,
          projectVersionId: project._id,
          admissionPolicyVersionId: policyId,
          modelConfigVersionId: modelId,
          applicationContentVersion: app.contentVersion,
          sourceInputFingerprint: "test",
          experienceBand: app.experienceBand,
          state: "succeeded",
          recommendation: "accept",
          criterionAssessments: [],
          strengths: [],
          concerns: [],
          limitations: [],
          createdAt: fixture.now,
        },
      );
      await ctx.db.patch(app._id, { aiRecommendationId: recommendationId });
    }
  });
}

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  workpoolTest.register(backend, "admissionWorkpool");
  workpoolTest.register(backend, "intelligenceWorkpool");
  return backend;
}

async function createAuthUser(backend: BackendTest, now: number, key: string) {
  const result: unknown = await backend.mutation(
    components.betterAuth.adapter.create,
    {
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
    },
  );
  return documentId(result, "Better Auth user");
}

async function createAuthSession(
  backend: BackendTest,
  userId: string,
  now: number,
) {
  const result: unknown = await backend.mutation(
    components.betterAuth.adapter.create,
    {
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
    },
  );
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
          firstYear:
            "The team explains a genuine problem and workable basic idea.",
          earlyYear:
            "The team explains a genuine problem and a coherent event-sized idea.",
          laterYear:
            "The team explains a clear problem, scope, and feasibility.",
          postgraduateOrProfessional:
            "The team explains a credible plan and trade-offs.",
          mixedOrExternal:
            "The team explains a clear problem and workable approach.",
        },
      },
      {
        criterionKey: "scope",
        label: "Event-sized scope",
        guidanceByBand: {
          firstYear: "A weekend-sized slice is stated in plain words.",
          earlyYear: "A weekend-sized slice is stated and plausible.",
          laterYear:
            "The slice is stated with what is explicitly out of scope.",
          postgraduateOrProfessional:
            "The slice and its trade-offs are stated.",
          mixedOrExternal: "A weekend-sized slice is stated and plausible.",
        },
      },
    ],
    decisionReasonCodes: [
      { key: "strong_fit", label: "Strong fit", allowedDecisions: ["accept"] },
      {
        key: "promising_fit",
        label: "Promising fit",
        allowedDecisions: ["accept", "waitlist"],
      },
      {
        key: "out_of_scope",
        label: "Out of scope",
        allowedDecisions: ["decline"],
      },
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
        detail:
          "Check the latest event details before confirming the team's place.",
      },
    ],
    discordUrl: "https://discord.gg/cohort-fixture",
    discordLabel: "Open event Discord",
    notificationProvider: "cloudflare_email",
    emailTemplates: defaultParticipantEmailTemplates(),
  });
  const communicationsPolicyId = await ctx.db.insert(
    "communicationsPolicyVersions",
    {
      eventId,
      version: 1,
      status: "published",
      ...communicationsPolicy,
      checksum: communicationsPolicyChecksum(communicationsPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    },
  );
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
  options: { extraTeams?: number } = {},
) {
  const now = Date.now();
  const eventSlug = `cohort-${crypto.randomUUID()}`;
  const operatorAuthUserId = await createAuthUser(backend, now, "operator");
  const operatorAuthSessionId = await createAuthSession(
    backend,
    operatorAuthUserId,
    now,
  );
  const onlookerAuthUserId = await createAuthUser(backend, now, "onlooker");
  const onlookerAuthSessionId = await createAuthSession(
    backend,
    onlookerAuthUserId,
    now,
  );
  const strangerAuthUserId = await createAuthUser(backend, now, "stranger");
  const strangerAuthSessionId = await createAuthSession(
    backend,
    strangerAuthUserId,
    now,
  );

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
    const operator = await insertAccount(
      ctx,
      eventId,
      "operator",
      now,
      operatorAuthUserId,
    );
    const onlooker = await insertAccount(
      ctx,
      eventId,
      "onlooker",
      now,
      onlookerAuthUserId,
    );
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
    const secondReviewer = await insertAccount(
      ctx,
      eventId,
      "second-reviewer",
      now,
    );
    const chain = await insertPolicyChain(
      ctx,
      eventId,
      operator.personId,
      now,
      {
        minimumHumanReviews: 2,
      },
    );
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
      reviews: {
        reviewerPersonId: Id<"people">;
        recommendation: "accept" | "decline";
      }[];
    }) {
      const memberships: Id<"eventMemberships">[] = [];
      for (let index = 0; index < args.size; index += 1) {
        const account = await insertAccount(
          ctx,
          eventId,
          `${args.publicCode}-m${index}`,
          now,
        );
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
          reasonCode:
            review.recommendation === "accept" ? "strong_fit" : "out_of_scope",
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
      reviews: [
        { reviewerPersonId: reviewer.personId, recommendation: "accept" },
      ],
    });
    const splitApplicationId = await insertTeam({
      name: "Split Signal",
      publicCode: "SPLT01",
      size: 1,
      band: "mixed_or_external",
      submittedAt: now - 1_000,
      reviews: [
        { reviewerPersonId: reviewer.personId, recommendation: "accept" },
        {
          reviewerPersonId: secondReviewer.personId,
          recommendation: "decline",
        },
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
