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
import { insertIntelligenceRecommendation } from "./intelligenceRecommendations.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;
type Fixture = Awaited<ReturnType<typeof seedFloor>>;

const callbackSecret = "callback-secret-".padEnd(48, "c");
const testConversationId = `cv_${"c".repeat(64)}`;
const savedEnvironment = {
  INTELLIGENCE_CALLBACK_SECRET: process.env.INTELLIGENCE_CALLBACK_SECRET,
  AUTH_SITE_URL: process.env.AUTH_SITE_URL,
  PARTICIPANT_SITE_URL: process.env.PARTICIPANT_SITE_URL,
  OPERATIONS_SITE_URL: process.env.OPERATIONS_SITE_URL,
};

process.env.INTELLIGENCE_CALLBACK_SECRET = callbackSecret;
process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";

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

  test("a recommendation needs a fresh citation for its exact target", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const source = proposalBody(fixture);
    const [citation] = source.citations;
    if (!citation) throw new Error("The proposal fixture has no citation.");
    const wrongTarget = await backend.mutation(
      internal.intelligenceRecommendations.proposeFromWorker,
      {
        proposal: {
          ...source,
          citations: [{ ...citation, keys: ["another-target"] }],
        },
      },
    );
    const stale = await backend.mutation(
      internal.intelligenceRecommendations.proposeFromWorker,
      {
        proposal: {
          ...source,
          proposalKey: `${source.proposalKey}:stale`,
          citations: [
            { ...citation, generatedAt: Date.now() - 16 * 60 * 1_000 },
          ],
        },
      },
    );

    expect(wrongTarget).toBe("invalid_citation");
    expect(stale).toBe("invalid_citation");
  });

  test("reusing a proposal key with different content is a conflict", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const original = proposalBody(fixture);

    expect((await signedPropose(backend, JSON.stringify(original))).status).toBe(202);
    const conflict = await signedPropose(
      backend,
      JSON.stringify({
        ...original,
        statement: "Hold this team for a different claimed reason and effect.",
      }),
    );

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "proposal_conflict" });
    const rows = await backend.run((ctx) =>
      ctx.db.query("intelligenceRecommendations").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.statement).toBe(original.statement);
  });

  test("two autonomous runs converge on one still-open semantic effect", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const source = proposalBody(fixture);
    const result = await backend.run(async (ctx) => {
      const event = await ctx.db.get(fixture.eventId);
      if (!event) throw new Error("The recommendation event is missing.");
      const policyId = await ctx.db.insert("operationsAutonomyPolicyVersions", {
        eventId: event._id,
        version: 1,
        status: "published",
        enabled: true,
        mode: "recommend",
        scheduleIntervalMinutes: 5,
        triggerSeverities: ["critical"],
        triggerAreas: ["reviews"],
        escalationSeverity: "critical",
        allowedReadTools: ["operations_health", "review_exceptions"],
        allowedRecommendationKinds: ["hold_review_team"],
        accountableOwnerEventAccessSubjectId: fixture.operatorSubjectId,
        audience: "operations_dashboard",
        checksum: "a".repeat(64),
        createdByPersonId: fixture.operatorPersonId,
        createdAt: source.citations[0]?.generatedAt ?? Date.now(),
        publishedAt: source.citations[0]?.generatedAt ?? Date.now(),
      });
      const snapshot = {
        generatedAt: source.citations[0]?.generatedAt ?? Date.now(),
        event: { slug: event.slug, name: event.name, timezone: event.timezone, status: "live" as const },
        summary: {
          status: "healthy" as const,
          signalCount: 0,
          criticalSignalCount: 0,
          attentionSignalCount: 0,
          watchSignalCount: 0,
        },
        signals: [],
      };
      const insertRun = (operationKey: string) => ctx.db.insert("operationsAutonomyRuns", {
        eventId: event._id,
        policyVersionId: policyId,
        policyVersion: 1,
        policyChecksum: "a".repeat(64),
        trigger: { kind: "schedule" as const, scheduledFor: snapshot.generatedAt },
        mode: "recommend" as const,
        escalationSeverity: "critical" as const,
        allowedReadTools: ["operations_health" as const, "review_exceptions" as const],
        allowedRecommendationKinds: ["hold_review_team" as const],
        sourceSnapshot: snapshot,
        sourceFactHighWatermarks: [],
        sourceChecksum: "b".repeat(64),
        operationKey,
        admission: { kind: "not_accepted" as const },
        executor: { kind: "unknown" as const },
        lifecycle: { kind: "pending" as const },
        attemptCount: 0,
        version: 1,
        createdAt: snapshot.generatedAt,
        updatedAt: snapshot.generatedAt,
      });
      const [runA, runB] = await Promise.all([insertRun("run-a"), insertRun("run-b")]);
      const proposal = {
        proposalKey: source.proposalKey,
        agentVersion: source.agentVersion,
        model: source.model,
        statement: source.statement,
        reasoning: source.reasoning,
        arguments: source.arguments,
      };
      const first = await insertIntelligenceRecommendation(ctx, {
        event,
        provenance: {
          kind: "autonomy",
          runId: runA,
          evidenceSet: {
            evidenceSetId: "evidence-run-a",
            rootHash: "a".repeat(64),
            leafCount: 1,
            chunkCount: 1,
            sealedSequence: 1,
          },
        },
        proposal,
        now: snapshot.generatedAt,
      });
      const second = await insertIntelligenceRecommendation(ctx, {
        event,
        provenance: {
          kind: "autonomy",
          runId: runB,
          evidenceSet: {
            evidenceSetId: "evidence-run-b",
            rootHash: "b".repeat(64),
            leafCount: 1,
            chunkCount: 1,
            sealedSequence: 1,
          },
        },
        proposal: { ...proposal, statement: `${proposal.statement} Rechecked by a later run.` },
        now: snapshot.generatedAt + 1,
      });
      return { first, second, runA, runB };
    });
    expect(result.first.state).toBe("accepted");
    expect(result.second).toMatchObject({
      state: "already_exists",
      recommendationId: result.first.state === "accepted"
        ? result.first.recommendationId
        : undefined,
    });
    if (result.first.state !== "accepted") {
      throw new Error("Expected the first autonomous proposal to be accepted.");
    }
    const recommendationId = result.first.recommendationId;
    expect(
      await backend.run((ctx) => ctx.db.query("intelligenceRecommendations").collect()),
    ).toHaveLength(1);
    const observations = await backend.run((ctx) =>
      ctx.db
        .query("intelligenceRecommendationAutonomyObservations")
        .withIndex("by_recommendation_observed_at", (index) =>
          index.eq("recommendationId", recommendationId),
        )
        .order("asc")
        .collect(),
    );
    expect(observations).toHaveLength(2);
    expect(observations.map((observation) => ({
      runId: observation.runId,
      evidenceSetId: observation.evidenceSetId,
      statement: observation.statement,
    }))).toEqual([
      {
        runId: result.runA,
        evidenceSetId: "evidence-run-a",
        statement: source.statement,
      },
      {
        runId: result.runB,
        evidenceSetId: "evidence-run-b",
        statement: `${source.statement} Rechecked by a later run.`,
      },
    ]);
  });

  test("every pending recommendation and settled decision remains reachable by cursor", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const original = proposalBody(fixture);
    await backend.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 29; index += 1) {
        const status = index < 24 ? "proposed" as const : "rejected" as const;
        await ctx.db.insert("intelligenceRecommendations", {
          eventId: fixture.eventId,
          proposalKey: `${original.proposalKey}:page-${index}`,
          effectKey: `effect-${index}`,
          provenance: {
            kind: "copilot",
            conversationId: original.conversationId,
            citations: original.citations,
          },
          arguments: original.arguments,
          statement: `${original.statement} ${index}`,
          reasoning: original.reasoning,
          status,
          agentVersion: original.agentVersion,
          model: original.model,
          proposedAt: now + index,
          ...(status === "rejected"
            ? { decidedAt: now + 1_000 + index, operatorNote: "Rejected fixture" }
            : {}),
          version: status === "rejected" ? 2 : 1,
          createdAt: now + index,
          updatedAt: now + index,
        });
      }
    });
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });
    const firstPending = await operator.query(api.intelligenceRecommendations.proposed, {
      eventSlug: fixture.eventSlug,
      paginationOpts: { numItems: 20, cursor: null },
    });
    const secondPending = await operator.query(api.intelligenceRecommendations.proposed, {
      eventSlug: fixture.eventSlug,
      paginationOpts: { numItems: 20, cursor: firstPending.continueCursor },
    });
    expect([...firstPending.page, ...secondPending.page]).toHaveLength(24);
    expect(firstPending.page[0]?.statement).toBe(`${original.statement} 0`);
    expect(secondPending.isDone).toBe(true);

    const settled = await operator.query(api.intelligenceRecommendations.settled, {
      eventSlug: fixture.eventSlug,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(settled.page).toHaveLength(5);
    expect(settled.page.map((entry) => entry.statement)).toEqual(
      [28, 27, 26, 25, 24].map((index) => `${original.statement} ${index}`),
    );
    expect(settled.isDone).toBe(true);
  });

  test("approval requires the grant of the underlying action, not a generic one", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const recommendationId = await propose(backend, fixture);

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

    const retried = await operator.mutation(api.intelligenceRecommendations.approve, {
      eventSlug: fixture.eventSlug,
      recommendationId,
      expectedVersion: 1,
      clientOperationId: "triage-approve-1",
    });
    expect(retried.version).toBe(2);
  });

  test("approval cannot execute after the cited target version changes", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const recommendationId = await propose(backend, fixture);
    await backend.run(async (ctx) => {
      await ctx.db.patch(fixture.teamRoundStateId, { version: 2, updatedAt: Date.now() });
    });
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });

    await expect(
      operator.mutation(api.intelligenceRecommendations.approve, {
        eventSlug: fixture.eventSlug,
        recommendationId,
        expectedVersion: 1,
        clientOperationId: "triage-stale-target-1",
      }),
    ).rejects.toThrow();

    const [state, recommendation] = await backend.run(async (ctx) => [
      await ctx.db.get(fixture.teamRoundStateId),
      await ctx.db.get(recommendationId),
    ] as const);
    expect(state).toMatchObject({ state: "called", version: 2 });
    expect(recommendation).toMatchObject({ status: "proposed", version: 1 });
  });

  test("detail returns the exact triage version and typed target snapshot", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const recommendationId = await propose(backend, fixture);
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });

    const detail = await operator.query(api.intelligenceRecommendations.detail, {
      eventSlug: fixture.eventSlug,
      recommendationId,
    });

    expect(detail).toMatchObject({
      id: recommendationId,
      version: 1,
      status: "proposed",
      arguments: {
        kind: "hold_review_team",
        teamRoundStateId: fixture.teamRoundStateId,
        expectedTeamRoundStateVersion: 1,
      },
    });
  });

  test("paging rejects a historical removed seat after a newer vacancy exists", async () => {
    const backend = seededBackend();
    const fixture = await seedFloor(backend);
    const { panelId, historicalMemberId } = await backend.run(async (ctx) => {
      const panelId = await ctx.db.insert("reviewPanels", {
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        stableKey: "paging-history",
        name: "Paging history",
        coordinatorPersonId: fixture.operatorPersonId,
        status: "needs_reviewer",
        version: 3,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const operator = await ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", fixture.eventId).eq("personId", fixture.operatorPersonId),
        )
        .unique();
      if (!operator) throw new Error("The operator subject is missing.");
      const member = (endedAt: number) =>
        ctx.db.insert("reviewPanelMembers", {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          panelId,
          personId: fixture.operatorPersonId,
          eventAccessSubjectId: operator._id,
          assignedCriterionIds: [],
          isCoordinator: false,
          status: "removed" as const,
          assignedAt: endedAt - 1,
          endedAt,
        });
      const historicalMemberId = await member(Date.now());
      await member(Date.now() + 1);
      for (const permissionKey of [
        "review.substitute.page",
        "review.substitute.assign",
      ] as const) {
        await insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.operatorPersonId,
          eventAccessSubjectId: operator._id,
          permissionKey,
          scopeType: "panel",
          scopeId: panelId,
          sourceType: "manual",
          sourceId: `${panelId}:${permissionKey}`,
          grantedByPersonId: fixture.operatorPersonId,
          reason: "Historical vacancy regression",
        });
      }
      return { panelId, historicalMemberId };
    });
    const operator = backend.withIdentity({
      subject: fixture.operatorAuthUserId,
      sessionId: fixture.operatorAuthSessionId,
    });

    const staleProposal = proposalBody(fixture);
    expect(
      await backend.mutation(
        internal.intelligenceRecommendations.proposeFromWorker,
        {
          proposal: {
            ...staleProposal,
            proposalKey: `${testConversationId}:page-${historicalMemberId}`,
            statement: "Page a reserve reviewer for the panel's old vacant seat.",
            reasoning:
              "The old vacancy appears related to this panel, but a newer removal now owns the open seat.",
            citations: [
              {
                read: "review_exceptions",
                generatedAt: Date.now(),
                keys: [historicalMemberId],
              },
            ],
            arguments: {
              kind: "page_reserve_reviewer",
              missingPanelMemberId: historicalMemberId,
              expectedPanelVersion: 3,
              reason: "Replace the current missing reviewer.",
            },
          },
        },
      ),
    ).toBe("invalid_target");

    await expect(
      operator.mutation(api.reviewSubstitutions.startPageChain, {
        eventSlug: fixture.eventSlug,
        missingPanelMemberId: historicalMemberId,
        expectedPanelVersion: 3,
        reason: "Replace the current missing reviewer.",
        clientOperationId: "historical-vacancy-1",
      }),
    ).rejects.toThrow("vacancy");
    expect(
      await backend.run((ctx) =>
        ctx.db
          .query("reviewerPageChains")
          .withIndex("by_panel_state", (index) =>
            index.eq("panelId", panelId).eq("state", "active"),
          )
          .unique(),
      ),
    ).toBeNull();
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
      conversationId: testConversationId,
      now: Date.now(),
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
    proposalKey: `${testConversationId}:hold-${fixture.teamRoundStateId}`,
    conversationId: testConversationId,
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
      expectedTeamRoundStateVersion: 1,
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
        applicationsCloseAt: Date.now() + 86_400_000,
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
      clockInOpensAt: now - 60 * 60 * 1_000 - 60_000,
      reviewerReportAt: now - 60 * 60 * 1_000 - 30_000,
      noShowGraceSeconds: 30,
      correctionRequestsCloseAt: now + 60 * 60 * 1_000,
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
      activeMemberCount: 0,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 0,
      membershipLocked: true,
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
      operatorSubjectId: operator.subjectId,
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
