import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
  defaultNoveltyPolicy,
  effectiveSimilarTeams,
  normalizeNoveltyCorpusEntries,
  noveltyBandForScore,
  noveltyEmbeddingDimensions,
  noveltyEmbeddingModel,
  noveltyInputFingerprint,
  noveltyScoreForDensity,
  noveltySimilarityWeight,
  type NoveltyCorpusEntryInput,
} from "./lib/novelty.ts";
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
  normalizeIntakePolicy,
} from "./lib/intakePolicy.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("live novelty", () => {
  test("uses weighted team density and the logarithmic novelty curve", () => {
    expect(noveltyEmbeddingModel).toBe("text-embedding-3-small");
    expect(noveltyEmbeddingDimensions).toBe(1_536);
    expect(defaultNoveltyPolicy.embeddingDimensions).toBe(1_536);
    expect(noveltySimilarityWeight(0.6, defaultNoveltyPolicy)).toBe(0);
    expect(noveltySimilarityWeight(0.75, defaultNoveltyPolicy)).toBeCloseTo(0.5);
    expect(noveltySimilarityWeight(0.9, defaultNoveltyPolicy)).toBe(1);
    expect(effectiveSimilarTeams([
      { similarity: 0.9, lifecycle: "editing" },
      { similarity: 0.9, lifecycle: "saved" },
      { similarity: 0.9, lifecycle: "submitted" },
      { similarity: 0.59, lifecycle: "submitted" },
    ], defaultNoveltyPolicy)).toBeCloseTo(2.3);
    expect(noveltyScoreForDensity(0)).toBe(100);
    expect(noveltyScoreForDensity(1)).toBe(77);
    expect(noveltyScoreForDensity(2)).toBe(64);
    expect(noveltyScoreForDensity(5)).toBe(41);
    expect(noveltyScoreForDensity(10)).toBe(21);
    expect(noveltyScoreForDensity(20)).toBe(0);
    expect(noveltyBandForScore(34)).toBe("familiar");
    expect(noveltyBandForScore(35)).toBe("developing");
    expect(noveltyBandForScore(70)).toBe("distinct");
  });

  test("rejects unsafe, duplicate, or discouraging corpus entries", () => {
    const entries = corpusEntries();
    const first = entries[0];
    const fifth = entries[4];
    if (!first || !fifth) throw new Error("The corpus fixture is incomplete.");
    expect(normalizeNoveltyCorpusEntries(entries, 2026)).toHaveLength(5);
    expect(() =>
      normalizeNoveltyCorpusEntries(
        [...entries.slice(0, 4), { ...fifth, sourceKey: first.sourceKey }],
        2026,
      ),
    ).toThrow("source keys must be unique");
    expect(() =>
      normalizeNoveltyCorpusEntries(
        [
          ...entries.slice(0, 4),
          {
            ...fifth,
            summary: "Contact prior-team@example.test for the complete project details.",
          },
        ],
        2026,
      ),
    ).toThrow("contains contact details");
    expect(() =>
      normalizeNoveltyCorpusEntries(
        [
          ...entries.slice(0, 4),
          { ...fifth, reflectionPrompt: "Would judges reject this idea?" },
        ],
        2026,
      ),
    ).toThrow("discouraging or decision-related wording");
    expect(() =>
      normalizeNoveltyCorpusEntries(
        [...entries.slice(0, 4), { ...fifth, sourceYear: 2027 }],
        2026,
      ),
    ).toThrow("Corpus entry 5 year must be a whole number from 2000 through 2026");
  });

  test("settles one request exactly once and replays its result idempotently", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const request = previewArgs(fixture, "novelty-request-0001", fixture.idea);
    const begun = await backend.mutation(internal.novelty.beginPreview, request);
    if (begun.kind !== "run") throw new Error("The novelty request did not start.");

    await expect(
      backend.mutation(internal.novelty.beginPreview, request),
    ).rejects.toThrow("still running");

    const result = await backend.mutation(internal.novelty.finishPreview, {
      requestId: begun.requestId,
      inputFingerprint: begun.inputFingerprint,
      state: "succeeded",
      score: 74,
      band: "distinct",
      effectiveSimilarTeams: 1.1,
      comparedTeamCount: 2,
      nearestSimilarity: 0.64,
      nearestThemeLabel: "Campus service routing",
      reflectionPrompt: "What happens after a volunteer accepts a request?",
      latencyMs: 90,
    });
    expect(result).toMatchObject({ state: "ready", score: 74, band: "distinct" });

    const replay = await backend.mutation(internal.novelty.beginPreview, request);
    expect(replay).toMatchObject({
      kind: "complete",
      result: { state: "ready", score: 74, band: "distinct" },
    });
    const state = await backend.run(async (ctx) => ({
      draft: await ctx.db.get(fixture.projectDraftId),
      request: await ctx.db.get(begun.requestId),
    }));
    expect(state.draft).toMatchObject({
      noveltyEvaluatedInputFingerprint: noveltyInputFingerprint(fixture.idea),
      noveltyScore: 74,
      noveltyBand: "distinct",
      noveltyPreviewRequestId: begun.requestId,
    });
    expect(state.request).not.toHaveProperty("idea");
    expect(state.request).not.toHaveProperty("initialIdea");
  });

  test("creates one row under a concurrent duplicate and never sends sensitive text onward", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const request = previewArgs(fixture, "novelty-concurrent-0001", fixture.idea);
    const attempts = await Promise.allSettled([
      backend.mutation(internal.novelty.beginPreview, request),
      backend.mutation(internal.novelty.beginPreview, request),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const requests = await backend.run((ctx) => ctx.db
      .query("noveltyPreviewRequests")
      .withIndex("by_team_requested")
      .collect());
    expect(requests).toHaveLength(1);

    const sensitive = await backend.mutation(
      internal.novelty.beginPreview,
      previewArgs(
        fixture,
        "novelty-sensitive-0001",
        `${fixture.idea} Contact the team at private-person@example.test for details.`,
      ),
    );
    expect(sensitive).toEqual({ kind: "complete", result: { state: "unavailable" } });
    const afterSensitiveCheck = await backend.run((ctx) => ctx.db
      .query("noveltyPreviewRequests")
      .withIndex("by_team_requested")
      .collect());
    expect(afterSensitiveCheck).toHaveLength(1);
  });

  test("does not attach a result after the team changes its idea", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const begun = await backend.mutation(
      internal.novelty.beginPreview,
      previewArgs(fixture, "novelty-request-stale", fixture.idea),
    );
    if (begun.kind !== "run") throw new Error("The novelty request did not start.");
    await backend.run(async (ctx) => {
      const draft = await ctx.db.get(fixture.projectDraftId);
      if (!draft) throw new Error("The fixture draft is missing.");
      await ctx.db.patch(draft._id, {
        initialIdea: `${fixture.idea} It now routes work through a shared neighborhood inventory.`,
        version: draft.version + 1,
        updatedAt: fixture.now + 1,
      });
    });

    const result = await backend.mutation(internal.novelty.finishPreview, {
      requestId: begun.requestId,
      inputFingerprint: begun.inputFingerprint,
      state: "succeeded",
      score: 61,
      band: "developing",
      effectiveSimilarTeams: 2.2,
      comparedTeamCount: 3,
      nearestSimilarity: 0.69,
      nearestThemeLabel: "Campus service routing",
      reflectionPrompt: "Which request should the system route first?",
      latencyMs: 110,
    });
    expect(result.state).toBe("ready");
    const draft = await backend.run((ctx) => ctx.db.get(fixture.projectDraftId));
    expect(draft?.noveltyScore).toBeUndefined();
    expect(draft?.noveltyPreviewRequestId).toBeUndefined();
  });

  test("keeps one density vector per team and tracks saved versus editing ideas", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const embedding = Array.from({ length: noveltyEmbeddingDimensions }, (_, index) => (
      index === 0 ? 1 : 0
    ));
    const savedRequest = await backend.mutation(
      internal.novelty.beginPreview,
      previewArgs(fixture, "novelty-density-saved", fixture.idea),
    );
    if (savedRequest.kind !== "run") throw new Error("The saved idea check did not start.");
    await backend.mutation(internal.novelty.upsertPreviewTeamIdea, {
      requestId: savedRequest.requestId,
      inputFingerprint: savedRequest.inputFingerprint,
      embedding,
    });
    const saved = await backend.run((ctx) => ctx.db
      .query("noveltyTeamIdeas")
      .withIndex("by_team")
      .unique());
    expect(saved).toMatchObject({ lifecycle: "saved" });

    const editingIdea = `${fixture.idea} The team is now exploring a different live workflow.`;
    const editingRequest = await backend.mutation(
      internal.novelty.beginPreview,
      previewArgs(fixture, "novelty-density-editing", editingIdea),
    );
    if (editingRequest.kind !== "run") throw new Error("The editing idea check did not start.");
    await backend.mutation(internal.novelty.upsertPreviewTeamIdea, {
      requestId: editingRequest.requestId,
      inputFingerprint: editingRequest.inputFingerprint,
      embedding,
    });
    const indexed = await backend.run((ctx) => ctx.db
      .query("noveltyTeamIdeas")
      .withIndex("by_team")
      .collect());
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({
      inputFingerprint: noveltyInputFingerprint(editingIdea),
      lifecycle: "editing",
    });
  });

  test("enforces the exact team scope and the published request budget", async () => {
    const wrongScopeBackend = convexTest(schema, modules);
    const wrongScope = await seedFixture(wrongScopeBackend, "other_team");
    await expect(
      wrongScopeBackend.mutation(
        internal.novelty.beginPreview,
        previewArgs(wrongScope, "novelty-wrong-team", wrongScope.idea),
      ),
    ).rejects.toThrow("does not have permission for that exact resource");

    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    for (let index = 0; index < defaultNoveltyPolicy.maximumRequestsPerMinute; index += 1) {
      const result = await backend.mutation(
        internal.novelty.beginPreview,
        previewArgs(
          fixture,
          `novelty-rate-${String(index).padStart(4, "0")}`,
          `${fixture.idea} Variation ${index + 1} focuses on a distinct handoff.`,
        ),
      );
      expect(result.kind).toBe("run");
    }
    await expect(
      backend.mutation(
        internal.novelty.beginPreview,
        previewArgs(
          fixture,
          "novelty-rate-overflow",
          `${fixture.idea} This additional variation exceeds the request window.`,
        ),
      ),
    ).rejects.toThrow("Pause for a moment");
  });

  test("imports one corpus transactionally and replays the completed operation", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const entries = corpusEntries();
    const args = {
      authUserId: fixture.authUserId,
      eventSlug: fixture.eventSlug,
      corpusVersionId: fixture.draftCorpusId,
      expectedRevision: 1,
      entries,
      reason: "Curated and privacy-reviewed past projects",
      clientOperationId: "novelty-import-0001",
    };
    const begun = await backend.mutation(internal.noveltyConfiguration.beginEntryImport, args);
    if (begun.kind !== "run") throw new Error("The novelty corpus import did not start.");
    const vector = Array.from({ length: noveltyEmbeddingDimensions }, (_, index) => (
      index === 0 ? 1 : 0
    ));
    const completed = await backend.mutation(
      internal.noveltyConfiguration.finishEntryImport,
      {
        actorPersonId: begun.actorPersonId,
        corpusVersionId: begun.corpusVersionId,
        runningRevision: begun.runningRevision,
        requestFingerprint: begun.requestFingerprint,
        reason: begun.reason,
        clientOperationId: args.clientOperationId,
        latencyMs: 140,
        entries: begun.entries.map((entry) => ({ ...entry, embedding: vector })),
      },
    );
    expect(completed).toMatchObject({ revision: 3, entryCount: 5 });
    expect(completed.checksum).toHaveLength(64);

    const replay = await backend.mutation(
      internal.noveltyConfiguration.beginEntryImport,
      args,
    );
    expect(replay).toEqual({ kind: "complete", ...completed });
    const stored = await backend.run((ctx) => ctx.db
      .query("noveltyCorpusEntries")
      .withIndex("by_corpus_source", (index) =>
        index.eq("corpusVersionId", fixture.draftCorpusId),
      )
      .collect());
    expect(stored).toHaveLength(5);
    expect(stored.every((entry) => entry.embedding.length === 1_536)).toBe(true);
  });
});

function previewArgs(
  fixture: Fixture,
  clientRequestId: string,
  idea: string,
) {
  return {
    authUserId: fixture.authUserId,
    eventSlug: fixture.eventSlug,
    corpusVersionId: fixture.publishedCorpusId,
    idea,
    clientRequestId,
  };
}

function corpusEntries(): NoveltyCorpusEntryInput[] {
  return [
    {
      sourceKey: "c2c-2022-campus-routing",
      sourceYear: 2022,
      themeLabel: "Campus service routing",
      summary: "A campus request board that routes maintenance work to available volunteers.",
      reflectionPrompt: "What useful outcome happens after a request is assigned?",
    },
    {
      sourceKey: "c2c-2023-food-redistribution",
      sourceYear: 2023,
      themeLabel: "Food redistribution",
      summary: "A workflow that connects surplus canteen food with nearby community kitchens.",
      reflectionPrompt: "How will a kitchen know that a collection is still safe and available?",
    },
    {
      sourceKey: "c2c-2023-accessible-navigation",
      sourceYear: 2023,
      themeLabel: "Accessible navigation",
      summary: "A route planner that records temporary accessibility barriers around a campus.",
      reflectionPrompt: "How will the route stay useful when a barrier changes during the day?",
    },
    {
      sourceKey: "c2c-2024-study-planning",
      sourceYear: 2024,
      themeLabel: "Study planning",
      summary: "A shared study planner that turns course deadlines into manageable weekly tasks.",
      reflectionPrompt: "What makes the plan adapt when a student falls behind?",
    },
    {
      sourceKey: "c2c-2025-waste-sorting",
      sourceYear: 2025,
      themeLabel: "Waste sorting",
      summary: "A camera-assisted guide that explains how common campus waste should be sorted.",
      reflectionPrompt: "What will users do when the material cannot be identified confidently?",
    },
  ];
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function seedFixture(
  backend: BackendTest,
  grantScope: "current_team" | "other_team" = "current_team",
) {
  const now = Date.UTC(2027, 8, 12, 9, 0, 0);
  return backend.run(async (ctx) => {
    const authUserId = `novelty-user-${grantScope}-${now}`;
    const eventSlug = `novelty-${grantScope}-${now}`;
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: `google-${authUserId}`,
      verifiedEmail: `${authUserId}@example.test`,
      displayName: "Nila Rao",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Code2Create novelty fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `${authUserId}@example.test`,
      displayName: "Nila Rao",
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
      participantClass: "external_participant",
      eligibilityStatus: "eligible",
      onboardingStatus: "project_required",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Novel Petals",
      publicCode: grantScope === "current_team" ? "NOVEL1" : "NOVEL2",
      leadMembershipId: membershipId,
      status: "forming",
      activeMemberCount: 1,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 1,
      membershipLocked: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId,
      role: "lead",
      status: "active",
      joinedAt: now,
      source: "created",
    });
    const otherTeamId = await ctx.db.insert("teams", {
      eventId,
      name: "Other Petals",
      publicCode: grantScope === "current_team" ? "OTHER1" : "OTHER2",
      leadMembershipId: membershipId,
      status: "forming",
      activeMemberCount: 0,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 0,
      membershipLocked: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const intakePolicy = normalizeIntakePolicy(defaultDeterministicIntakePolicy);
    const intakePolicyId = await ctx.db.insert("intakePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...intakePolicy,
      checksum: intakePolicyChecksum(intakePolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const publishedCorpusId = await insertCorpus(
      ctx,
      eventId,
      personId,
      1,
      "published",
      "ready",
      "published-corpus-checksum",
      now,
    );
    const draftCorpusId = await insertCorpus(
      ctx,
      eventId,
      personId,
      2,
      "draft",
      "empty",
      undefined,
      now,
    );
    await ctx.db.patch(eventId, {
      publishedIntakePolicyId: intakePolicyId,
      publishedNoveltyCorpusVersionId: publishedCorpusId,
    });
    const idea = "A shared campus workflow that helps volunteers route practical requests.";
    const projectDraftId = await ctx.db.insert("projectDrafts", {
      eventId,
      teamId,
      intakePolicyVersionId: intakePolicyId,
      noveltyCorpusVersionId: publishedCorpusId,
      stage: "follow_up",
      initialIdea: idea,
      version: 1,
      lastEditedByMembershipId: membershipId,
      updatedAt: now,
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "team.project.write",
      scopeType: "team",
      scopeId: grantScope === "current_team" ? teamId : otherTeamId,
      sourceType: "team_membership",
      sourceId: `novelty-${grantScope}`,
      reason: "Novelty preview fixture",
    });
    for (const permissionKey of [
      "configuration.novelty.entries.write",
      "configuration.novelty.read",
    ] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "manual",
        sourceId: `novelty-configuration-${permissionKey}`,
        reason: "Novelty configuration fixture",
      });
    }
    return {
      authUserId,
      eventSlug,
      publishedCorpusId,
      draftCorpusId,
      projectDraftId,
      idea,
      now,
    };
  });
}

async function insertCorpus(
  ctx: MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  version: number,
  status: "draft" | "published",
  importState: "empty" | "ready",
  checksum: string | undefined,
  now: number,
) {
  return ctx.db.insert("noveltyCorpusVersions", {
    eventId,
    version,
    revision: 1,
    status,
    importState,
    ...defaultNoveltyPolicy,
    entryCount: importState === "ready" ? 5 : 0,
    ...(checksum ? { checksum } : {}),
    createdByPersonId: personId,
    lastEditedByPersonId: personId,
    createdAt: now,
    updatedAt: now,
    ...(status === "published" ? { publishedAt: now } : {}),
  });
}
