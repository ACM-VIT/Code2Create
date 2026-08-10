import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test } from "vitest";

import {
  admissionIntelligenceReadSignatureContext,
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
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
} from "./lib/intakePolicy.ts";
import {
  defaultParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;
type Fixture = Awaited<ReturnType<typeof seedCohortFixture>>;

const readSecret = "read-secret-".padEnd(48, "r");
const savedEnvironment = {
  INTELLIGENCE_READ_SECRET: process.env.INTELLIGENCE_READ_SECRET,
  LOCAL_DEVELOPMENT_SEED_ENABLED: process.env.LOCAL_DEVELOPMENT_SEED_ENABLED,
  AUTH_SITE_URL: process.env.AUTH_SITE_URL,
  PARTICIPANT_SITE_URL: process.env.PARTICIPANT_SITE_URL,
  OPERATIONS_SITE_URL: process.env.OPERATIONS_SITE_URL,
  HANDBOOK_SITE_URL: process.env.HANDBOOK_SITE_URL,
};

process.env.INTELLIGENCE_READ_SECRET = readSecret;
process.env.LOCAL_DEVELOPMENT_SEED_ENABLED = "true";
process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";
process.env.HANDBOOK_SITE_URL = "http://localhost:4175";

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
    noveltyScore: null,
    ...overrides,
  };
}

describe("admission cohort arithmetic", () => {
  test("capacity is spent in people and the line is a strict prefix of the ranking", () => {
    // Three teams already ranked by review support: sizes 2, 3, 1. With a
    // capacity of 3 people only the first team fits; the one-person team is
    // NOT pulled forward past the three-person team it ranks below.
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
    // The entry capacity is the smallest capacity that admits the team, so a
    // client can move the capacity without refetching: at 11 it enters.
    expect(selectAdmissionCohort([candidate({ applicationId: "a", teamSize: 4 })], 11, 7)[0])
      .toMatchObject({ suggestedIn: true });
  });

  test("ordering composes existing signals: reviews, then AI, then novelty, then time", () => {
    const byReviews = compareAdmissionCohortCandidates(
      candidate({ reviewAccepts: 2, noveltyScore: 0 }),
      candidate({ reviewAccepts: 0, aiRecommendation: "accept", noveltyScore: 100 }),
    );
    expect(byReviews).toBeLessThan(0);
    const byAi = compareAdmissionCohortCandidates(
      candidate({ aiRecommendation: "accept" }),
      candidate({ aiRecommendation: "decline", noveltyScore: 100 }),
    );
    expect(byAi).toBeLessThan(0);
    const byNovelty = compareAdmissionCohortCandidates(
      candidate({ noveltyScore: 80 }),
      candidate({ noveltyScore: 20 }),
    );
    expect(byNovelty).toBeLessThan(0);
    const byTime = compareAdmissionCohortCandidates(
      candidate({ submittedAt: 1 }),
      candidate({ submittedAt: 2 }),
    );
    expect(byTime).toBeLessThan(0);
    // A decline recommendation counts against, symmetric with an accept.
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
  test("ranks candidates, spends capacity in people, and marks review shortfalls", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const view = await operator.query(api.admissionCohort.cohort, {
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
    // Sizes 2, 3, 1 against 3 people: strict prefix, no bin-packing.
    expect(view.candidates.map((entry) => entry.entryCapacityPeople)).toEqual([2, 5, 6]);
    expect(view.candidates.map((entry) => entry.suggestedIn)).toEqual([true, false, false]);
    expect(view.summary).toMatchObject({
      capacityPeople: 3,
      committedPeople: 0,
      suggestedPeople: 2,
      remainingPeople: 1,
      suggestedInTeamCount: 1,
    });
    // Two reviews satisfy the published minimum of two; one does not, and the
    // view says so instead of hiding the application.
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
    // Omitting the capacity evaluates the published participant capacity.
    const published = await operator.query(api.admissionCohort.cohort, {
      eventSlug: fixture.eventSlug,
    });
    expect(published.capacityPeople).toBe(100);
    expect(published.candidates.map((entry) => entry.suggestedIn)).toEqual([true, true, true]);
  });

  test("rows are gated by application.read exactly as the admissions list gates them", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const onlooker = backend.withIdentity({
      subject: fixture.onlookerAuthUserId,
      sessionId: fixture.onlookerAuthSessionId,
    });
    // An event account without grants sees the aggregate arithmetic, the way
    // stageCounts is visible, but not one row.
    const view = await onlooker.query(api.admissionCohort.cohort, {
      eventSlug: fixture.eventSlug,
      capacityPeople: 3,
    });
    expect(view.candidates).toEqual([]);
    expect(view.hiddenApplicationCount).toBe(3);
    expect(view.summary.committedPeople).toBe(0);
    // No event access subject at all: refused outright.
    const stranger = backend.withIdentity({
      subject: fixture.strangerAuthUserId,
      sessionId: fixture.strangerAuthSessionId,
    });
    await expect(
      stranger.query(api.admissionCohort.cohort, {
        eventSlug: fixture.eventSlug,
        capacityPeople: 3,
      }),
    ).rejects.toThrow();
  });

  test("applyDecision refuses below the review minimum and otherwise decides as the operator", async () => {
    const backend = seededBackend();
    const fixture = await seedCohortFixture(backend);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    // One review against a minimum of two: refused as data, with the
    // arithmetic the surface needs to say "one more review".
    const refused = await operator.mutation(api.admissionCohort.applyDecision, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.shortApplicationId,
      expectedApplicationVersion: 1,
      decision: "accept",
      reasonCode: "strong_fit",
      informationQuestions: [],
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

    // A decidable application goes through admissions.decide as the operator.
    const applied = await operator.mutation(api.admissionCohort.applyDecision, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.decidableApplicationId,
      expectedApplicationVersion: 1,
      decision: "accept",
      reasonCode: "strong_fit",
      informationQuestions: [],
      aiDisposition: "unavailable",
      clientOperationId: "cohort-apply-1",
    });
    expect(applied).toMatchObject({ applied: true, state: "accepted" });
    const [application, audits] = await backend.run(async (ctx) => [
      await ctx.db.get(fixture.decidableApplicationId),
      await ctx.db.query("auditEvents").collect(),
    ] as const);
    expect(application).toMatchObject({
      state: "accepted",
      humanDecision: "accept",
      humanReasonCode: "strong_fit",
      decidedByPersonId: fixture.operatorPersonId,
    });
    const decisionAudit = audits.find(
      (event) => event.action === "admission.human_decision_published",
    );
    expect(decisionAudit?.actorPersonId).toBe(fixture.operatorPersonId);

    // A retried apply replays the recorded decision instead of refusing.
    const retried = await operator.mutation(api.admissionCohort.applyDecision, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.decidableApplicationId,
      expectedApplicationVersion: 1,
      decision: "accept",
      reasonCode: "strong_fit",
      informationQuestions: [],
      aiDisposition: "unavailable",
      clientOperationId: "cohort-apply-1",
    });
    expect(retried).toMatchObject({ applied: true, state: "accepted" });

    // Without the decide grant the wrapper refuses before revealing anything.
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
        informationQuestions: [],
        aiDisposition: "unavailable",
        clientOperationId: "cohort-apply-denied-1",
      }),
    ).rejects.toThrow("permission");
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
      data: { candidates: { teamName: string; suggestedIn: boolean }[] };
    };
    expect(payload.read).toBe("admission_cohort");
    expect(payload.data.candidates.map((entry) => entry.suggestedIn)).toEqual([
      true,
      false,
      false,
    ]);
    // The read carries team names and signals, never members: no field of any
    // candidate row is a person.
    expect(JSON.stringify(payload)).not.toContain("Cohort Member");
    expect(JSON.stringify(payload)).not.toContain("@example.test");
  });
});

describe("admission cohort at seeded scale", () => {
  test(
    "the opt-in seeder builds a realistic cohort and the view holds up at 350 teams",
    { timeout: 300_000 },
    async () => {
      const backend = seededBackend();
      await seedLocalCohortEvent(backend);
      const seeded = await backend.action(api.localAdmissionCohortSeed.seedAdmissionCohort, {
        confirmation: "seed-code2create-admission-cohort",
        teamCount: 350,
      });
      expect(seeded).toMatchObject({ requestedTeams: 350 });
      expect(seeded.createdTeams).toBe(350);
      const eventId = await backend.run(async (ctx) => {
        const event = await ctx.db
          .query("events")
          .withIndex("by_slug", (index) => index.eq("slug", "code2create-7"))
          .unique();
        if (!event) throw new Error("The seeded event is missing.");
        return event._id;
      });
      const capacity = 600;
      const view = await backend.query(internal.admissionCohort.cohortRead, {
        eventId,
        capacityPeople: capacity,
      });
      // Every seeded application lands in exactly one bucket.
      expect(
        view.candidates.length + view.committed.length + view.decidedOut.length,
      ).toBe(350);
      // Capacity is spent in people: entry capacities are the committed
      // people plus a running sum of team sizes, strictly non-decreasing.
      let runningPeople = view.summary.committedPeople;
      for (const entry of view.candidates) {
        runningPeople += entry.teamSize;
        expect(entry.entryCapacityPeople).toBe(runningPeople);
        expect(entry.suggestedIn).toBe(entry.entryCapacityPeople <= capacity);
      }
      expect(view.summary.suggestedPeople).toBeLessThanOrEqual(capacity);
      // The suggestion fills the room to within one team of the line.
      const firstOut = view.candidates.find((entry) => !entry.suggestedIn);
      expect(firstOut).toBeDefined();
      expect(view.summary.suggestedPeople + (firstOut?.teamSize ?? 0)).toBeGreaterThan(capacity);
      // All five year bands are represented, and the mix is reported rather
      // than balanced: in + out per band covers every candidate.
      expect(view.summary.bandMix).toHaveLength(5);
      const mixTotal = view.summary.bandMix.reduce(
        (total, band) => total + band.teamsIn + band.teamsOut,
        0,
      );
      expect(mixTotal).toBe(view.candidates.length);
      for (const band of view.summary.bandMix) {
        expect(band.teamsIn + band.teamsOut).toBeGreaterThan(0);
      }
      // Both review-coverage states exist, and not-yet-decidable teams are
      // ranked and flagged, never hidden or decided.
      expect(view.candidates.some((entry) => entry.reviewCoverage.decidable)).toBe(true);
      expect(view.candidates.some((entry) => !entry.reviewCoverage.decidable)).toBe(true);
      // Novelty signals exist for most teams and are absent for some.
      expect(view.candidates.some((entry) => entry.novelty !== null)).toBe(true);
      expect(view.candidates.some((entry) => entry.novelty === null)).toBe(true);

      // Moving the capacity moves exactly the teams whose entry capacity the
      // new number crosses — computable client-side, verified server-side.
      const widerCapacity = capacity + 40;
      const wider = await backend.query(internal.admissionCohort.cohortRead, {
        eventId,
        capacityPeople: widerCapacity,
      });
      const before = new Map(
        view.candidates.map((entry) => [entry.applicationId, entry.suggestedIn]),
      );
      for (const entry of wider.candidates) {
        expect(entry.suggestedIn).toBe(entry.entryCapacityPeople <= widerCapacity);
        const crossed =
          entry.entryCapacityPeople > capacity && entry.entryCapacityPeople <= widerCapacity;
        expect(entry.suggestedIn).toBe(Boolean(before.get(entry.applicationId)) || crossed);
      }

      // The submission search matches idea words and returns only stored
      // novelty and coverage signals.
      const search = await backend.query(internal.admissionCohort.submissionSearchRead, {
        eventId,
        searchQuery: "librarians",
        limit: 10,
      });
      expect(search.matches.length).toBeGreaterThan(0);
      expect(search.matches.length).toBeLessThanOrEqual(10);
      for (const match of search.matches) {
        expect(match.ideaExcerpt.toLowerCase()).toContain("librarians");
        expect(match.teamSize).toBeGreaterThan(0);
      }
    },
  );

  test("the seeder refuses to run outside a local deployment", async () => {
    const backend = seededBackend();
    await seedLocalCohortEvent(backend);
    process.env.LOCAL_DEVELOPMENT_SEED_ENABLED = "false";
    try {
      await expect(
        backend.action(api.localAdmissionCohortSeed.seedAdmissionCohort, {
          confirmation: "seed-code2create-admission-cohort",
          teamCount: 5,
        }),
      ).rejects.toThrow("local");
    } finally {
      process.env.LOCAL_DEVELOPMENT_SEED_ENABLED = "true";
    }
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

/**
 * Publish the policy chain the cohort seeder expects on the local event slug,
 * without running the full local-development seed: participant, intake, and
 * communications policies, one core track, and an admission policy with a
 * one-review minimum so the seeded review pattern produces both decidable and
 * not-yet-decidable applications.
 */
async function seedLocalCohortEvent(backend: BackendTest) {
  const now = Date.now();
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: "code2create-7",
      name: "Code2Create local",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      startsAt: now + 14 * 24 * 60 * 60 * 1_000,
      endsAt: now + 16 * 24 * 60 * 60 * 1_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const { personId } = await insertAccount(ctx, eventId, "cohort-seed-owner", now);
    const ids = await insertPolicyChain(ctx, eventId, personId, now, {
      minimumHumanReviews: 1,
    });
    return { eventId, ...ids };
  });
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
  const catalogId = await ctx.db.insert("trackCatalogVersions", {
    eventId,
    version: 1,
    status: "published",
    requiredCoreTrackCount: 1,
    checksum: "cohort-catalog",
    createdByPersonId: personId,
    createdAt: now,
    publishedAt: now,
  });
  const trackId = await ctx.db.insert("trackVersions", {
    eventId,
    catalogVersionId: catalogId,
    stableKey: "open-innovation",
    slug: "open-innovation",
    displayName: "Open innovation",
    description: "A practical event-sized project.",
    examples: [],
    displayOrder: 0,
    type: "core",
    status: "published",
    createdAt: now,
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
        allowedDecisions: ["needs_information", "waitlist"],
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
    notificationSubject: "Code2Create application update",
    notificationIntro: "There is an update to your team's Code2Create application.",
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
    publishedTrackCatalogId: catalogId,
    publishedAdmissionPolicyId: admissionPolicyId,
    publishedCommunicationsPolicyId: communicationsPolicyId,
  });
  return {
    participantPolicyId,
    intakePolicyId,
    catalogId,
    trackId,
    admissionPolicyId,
    communicationsPolicyId,
  };
}

/**
 * Three candidate teams with distinct review support, sizes 2, 3, and 1, so
 * the ranking, the people arithmetic, and the decidability flags all separate
 * cleanly: "Steady Loom" (two accepts, decidable), "Night Kiln" (one accept,
 * one review short of the minimum), "Split Signal" (an accept and a decline).
 */
async function seedCohortFixture(backend: BackendTest) {
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
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      startsAt: now + 14 * 24 * 60 * 60 * 1_000,
      endsAt: now + 16 * 24 * 60 * 60 * 1_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const operator = await insertAccount(ctx, eventId, "operator", now, operatorAuthUserId);
    const onlooker = await insertAccount(ctx, eventId, "onlooker", now, onlookerAuthUserId);
    // The stranger has an auth user but no event access subject at all.
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
        membershipLocked: true,
        trackLocked: true,
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
      const projectVersionId = await ctx.db.insert("projectVersions", {
        eventId,
        teamId,
        version: 1,
        initialIdea: `A calm coordination tool for ${args.name.toLowerCase()} volunteers.`,
        intakePolicyVersionId: chain.intakePolicyId,
        intakeResponses: [],
        coreTrackVersionId: chain.trackId,
        sponsorTrackVersionIds: [],
        lockedTeamMemberIds: teamMemberIds,
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
          previewedTrackVersionId: chain.trackId,
          previewedSponsorTrackVersionIds: [],
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

    return {
      eventSlug,
      eventId,
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
