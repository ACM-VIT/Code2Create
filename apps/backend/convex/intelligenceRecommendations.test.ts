import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test } from "vitest";

import {
  operationsCopilotRecommendationSignatureContext,
  operationsIntelligenceProtocolVersion,
  signServiceBody,
} from "@code2create/domain";

import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;
type Fixture = Awaited<ReturnType<typeof seedFloor>>;

const callbackSecret = "callback-secret-".padEnd(48, "c");
const savedEnvironment = {
  INTELLIGENCE_CALLBACK_SECRET: process.env.INTELLIGENCE_CALLBACK_SECRET,
  AUTH_SITE_URL: process.env.AUTH_SITE_URL,
  PARTICIPANT_SITE_URL: process.env.PARTICIPANT_SITE_URL,
  OPERATIONS_SITE_URL: process.env.OPERATIONS_SITE_URL,
  HANDBOOK_SITE_URL: process.env.HANDBOOK_SITE_URL,
};

process.env.INTELLIGENCE_CALLBACK_SECRET = callbackSecret;
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

describe("intelligence recommendations", () => {
  test("the signed webhook records a cited proposal once and only once", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const body = JSON.stringify(proposalBody(fixture));

    const unsigned = await backend.fetch("/intelligence/operations-recommendations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(unsigned.status).toBe(401);

    const first = await signedPropose(backend, body);
    const second = await signedPropose(backend, body);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ state: "accepted" });
    expect(await second.json()).toEqual({ state: "already_exists" });

    const rows = await backend.run((ctx) =>
      ctx.db.query("intelligenceRecommendations").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "proposed",
      statement: "Hold the repeatedly-absent team so the queue can move.",
    });
  });

  test("a recommendation without a citation is impossible to create", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const result = await backend.mutation(
      internal.intelligenceRecommendations.proposeFromWorker,
      { proposal: { ...proposalBody(fixture), citations: [] } },
    );
    expect(result).toBe("missing_citation");
    expect(
      await backend.run((ctx) => ctx.db.query("intelligenceRecommendations").collect()),
    ).toHaveLength(0);
  });

  test("approval requires the grant of the underlying action, not a generic one", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const recommendationId = await propose(backend, fixture);

    // The onlooker can read intelligence but holds no review.queue.hold
    // grant, so approving — and equally vetoing — is out of reach.
    const onlooker = backend.withIdentity({
      subject: fixture.onlookerAuthUserId,
      sessionId: fixture.onlookerAuthSessionId,
    });
    await expect(
      onlooker.mutation(api.intelligenceRecommendations.approve, {
        eventSlug: fixture.eventSlug,
        recommendationId,
        expectedVersion: 1,
        clientOperationId: "triage-attempt-1",
      }),
    ).rejects.toThrow("cannot hold");
    await expect(
      onlooker.mutation(api.intelligenceRecommendations.reject, {
        eventSlug: fixture.eventSlug,
        recommendationId,
        expectedVersion: 1,
        reason: "I do not like it.",
        clientOperationId: "triage-attempt-2",
      }),
    ).rejects.toThrow("cannot hold");

    const untouched = await backend.run((ctx) => ctx.db.get(recommendationId));
    expect(untouched?.status).toBe("proposed");
  });

  test("approval executes the underlying command as the operator and records both audits", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const recommendationId = await propose(backend, fixture);

    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const result = await operator.mutation(api.intelligenceRecommendations.approve, {
      eventSlug: fixture.eventSlug,
      recommendationId,
      expectedVersion: 1,
      clientOperationId: "triage-approve-1",
    });
    expect(result.version).toBe(2);

    const [state, recommendation, audits] = await backend.run(async (ctx) => [
      await ctx.db.get(fixture.teamRoundStateId),
      await ctx.db.get(recommendationId),
      await ctx.db.query("auditEvents").collect(),
    ] as const);
    expect(state).toMatchObject({
      state: "held",
      holdReason: "The team missed both calls while the queue waited.",
      updatedByPersonId: fixture.operatorPersonId,
    });
    expect(recommendation).toMatchObject({
      status: "approved",
      decidedByPersonId: fixture.operatorPersonId,
      executedTargetType: "team_round_state",
      executedTargetId: fixture.teamRoundStateId,
    });
    const actions = audits.map((event) => event.action);
    expect(actions).toContain("review.queue_team_held");
    expect(actions).toContain("operations.intelligence_recommendation_approved");
    for (const event of audits) {
      expect(event.actorPersonId).toBe(fixture.operatorPersonId);
    }

    // A retried approval replays its recorded outcome instead of colliding
    // with the settled recommendation.
    const retried = await operator.mutation(api.intelligenceRecommendations.approve, {
      eventSlug: fixture.eventSlug,
      recommendationId,
      expectedVersion: 1,
      clientOperationId: "triage-approve-1",
    });
    expect(retried.version).toBe(2);
  });

  test("a suggestion supersedes the proposal and comes back to the agent verbatim", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const recommendationId = await propose(backend, fixture);

    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    await operator.mutation(api.intelligenceRecommendations.suggest, {
      eventSlug: fixture.eventSlug,
      recommendationId,
      expectedVersion: 1,
      suggestion: "Call the team once more before holding; their table is far from the stage.",
      clientOperationId: "triage-suggest-1",
    });

    const history = await backend.query(internal.intelligenceReads.recommendationHistoryRead, {
      eventId: fixture.eventId,
    });
    expect(history.recommendations).toEqual([
      expect.objectContaining({
        kind: "hold_review_team",
        status: "superseded",
        operatorNote:
          "Call the team once more before holding; their table is far from the stage.",
      }),
    ]);

    const state = await backend.run((ctx) => ctx.db.get(fixture.teamRoundStateId));
    expect(state?.state).toBe("called");
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

function proposalBody(fixture: Fixture) {
  return {
    protocolVersion: operationsIntelligenceProtocolVersion,
    proposalKey: `conversation-1:hold-${fixture.teamRoundStateId}`,
    conversationId: "conversation-1",
    eventSlug: fixture.eventSlug,
    agentVersion: "operations-copilot-v1",
    model: "cloudflare/test-model",
    statement: "Hold the repeatedly-absent team so the queue can move.",
    reasoning:
      "review_exceptions shows this team called twice without arriving while the panel queue is non-empty.",
    citations: [
      {
        read: "review_exceptions" as const,
        generatedAt: Date.now(),
        keys: [fixture.teamRoundStateId],
      },
    ],
    arguments: {
      kind: "hold_review_team" as const,
      teamRoundStateId: fixture.teamRoundStateId,
      reason: "The team missed both calls while the queue waited.",
    },
  };
}

async function signedPropose(backend: BackendTest, body: string) {
  const timestamp = Date.now().toString();
  const signature = await signServiceBody({
    context: operationsCopilotRecommendationSignatureContext,
    secret: callbackSecret,
    timestamp,
    body,
  });
  return backend.fetch("/intelligence/operations-recommendations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-c2c-signature": signature,
      "x-c2c-timestamp": timestamp,
    },
    body,
  });
}

async function propose(backend: BackendTest, fixture: Fixture) {
  const result = await backend.mutation(
    internal.intelligenceRecommendations.proposeFromWorker,
    { proposal: proposalBody(fixture) },
  );
  expect(result).toBe("accepted");
  const rows = await backend.run((ctx) =>
    ctx.db.query("intelligenceRecommendations").collect(),
  );
  const row = rows[0];
  if (!row) throw new Error("The proposal was not recorded.");
  return row._id;
}

/**
 * One open round, one called team, and two signed-in accounts: an operator
 * holding `review.queue.hold` on the round and an onlooker holding only the
 * intelligence read — the pair every authorisation assertion needs.
 */
async function seedFloor(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `recommendation-${crypto.randomUUID()}`;
  const operatorAuthUserId = await createAuthUser(backend, now, "operator");
  const operatorAuthSessionId = await createAuthSession(backend, operatorAuthUserId, now);
  const onlookerAuthUserId = await createAuthUser(backend, now, "onlooker");
  const onlookerAuthSessionId = await createAuthSession(backend, onlookerAuthUserId, now);

  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Recommendation fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const operator = await insertAccount(ctx, eventId, "operator", now, operatorAuthUserId);
    const onlooker = await insertAccount(ctx, eventId, "onlooker", now, onlookerAuthUserId);
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
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId,
      rubricVersionId,
      stableKey: "fixture-round",
      name: "Review 1",
      sequence: 1,
      status: "open",
      startsAt: now - 60 * 60 * 1_000,
      endsAt: now + 60 * 60 * 1_000,
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
    const participant = await insertAccount(ctx, eventId, "participant", now);
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId,
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
      eventId,
      name: "Nightshift",
      publicCode: "NIGHT1",
      leadMembershipId: membershipId,
      status: "confirmed",
      membershipLocked: true,
      trackLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const teamRoundStateId = await ctx.db.insert("teamRoundStates", {
      eventId,
      roundId,
      teamId,
      state: "called",
      queuedAt: now - 20 * 60 * 1_000,
      calledAt: now - 5 * 60 * 1_000,
      callAttemptCount: 2,
      priority: 0,
      version: 1,
      updatedByPersonId: operator.personId,
      updatedAt: now,
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId: operator.personId,
      eventAccessSubjectId: operator.subjectId,
      permissionKey: "review.queue.hold",
      scopeType: "round",
      scopeId: roundId,
      sourceType: "manual",
      sourceId: `${eventSlug}:review.queue.hold`,
      grantedByPersonId: operator.personId,
      reason: "Recommendation test",
    });
    for (const account of [operator, onlooker]) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: account.personId,
        eventAccessSubjectId: account.subjectId,
        permissionKey: "operations.intelligence.read",
        scopeType: "event",
        sourceType: "manual",
        sourceId: `${eventSlug}:operations.intelligence.read:${account.personId}`,
        grantedByPersonId: operator.personId,
        reason: "Recommendation test",
      });
    }
    return {
      eventSlug,
      eventId,
      roundId,
      teamRoundStateId: teamRoundStateId as Id<"teamRoundStates">,
      operatorPersonId: operator.personId,
      operatorAuthUserId,
      operatorAuthSessionId,
      onlookerAuthUserId,
      onlookerAuthSessionId,
    };
  });
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

async function createAuthUser(backend: BackendTest, now: number, key: string) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: `Recommendation ${key}`,
        email: `recommendation-${key}-${crypto.randomUUID()}@example.test`,
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
