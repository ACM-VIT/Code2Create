import { ConvexError, v, type Infer } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { authComponent } from "./auth";
import { applicationsCloseAtFor, requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import {
  calibratedNoveltyMatch,
  isCurrentNoveltyScoringVersion,
  normalizeNoveltyIdea,
  noveltyBandForScore,
  noveltyDensitySimilarity,
  noveltyDensitySimilarityPolicy,
  noveltyEmbeddingDimensions,
  noveltyEmbeddingModel,
  noveltyEmbeddingScoringVersion,
  noveltyInputFingerprint,
  noveltyJudgeCandidateLimit,
  noveltyLifecycleWeight,
  noveltyScoreForEvidence,
  noveltyScoringVersion,
  noveltyDensityMatchLimit,
  noveltySimilarityWeight,
  semanticOverlapFromEmbedding,
  strongestCalibratedNoveltyMatch,
  strongestNoveltyMatchPerTeam,
  type NoveltyIdeaLifecycle,
  type NoveltyScoringVersion,
  validEmbedding,
} from "./lib/novelty";
import { requirePermission } from "./lib/permissions";
import { requirePinnedIntakePolicy, requirePublishedIntakePolicy } from "./lib/intakePolicy";
import { redactProjectText } from "./lib/projectText";
import { normalizedText } from "./lib/strings";
import { createOpenAiEmbeddings, OpenAiEmbeddingError } from "./lib/openAiEmbeddings";
import { scheduledAiEmbeddingTelemetry } from "./lib/posthog";
import {
  noveltyJudgeModelId,
  noveltyJudgePromptVersion,
  requestOpenAiNoveltyJudgments,
  requestOpenAiNoveltyJudgmentsWithFallback,
} from "./lib/openAiNoveltyJudge";
import {
  backgroundNoveltyIndexDeduplicationLimit,
  backgroundNoveltyIndexRateLimit,
  globalNoveltyRateLimit,
  noveltyRateLimiter,
  teamNoveltyRateLimit,
} from "./lib/noveltyRateLimits";

const noveltyBand = v.union(
  v.literal("familiar"),
  v.literal("developing"),
  v.literal("distinct"),
);

const noveltyIdeaLifecycle = v.union(
  v.literal("editing"),
  v.literal("saved"),
  v.literal("submitted"),
);

const noveltyTeamVectorMatchLimit = 256;
const noveltyEditingIdeaLifetimeMs = 45_000;
const noveltyPreviewCacheLifetimeMs = 30_000;
const noveltyPreviewRunningLifetimeMs = 8_000;
const noveltyPreviewProviderAttemptTimeoutMs = 1_500;
const noveltyJudgeProviderTimeoutMs = 10_000;

const noveltyScoringVersionValue = v.union(
  v.literal(noveltyEmbeddingScoringVersion),
  v.literal(noveltyScoringVersion),
);

const readyPreview = v.object({
  state: v.literal("ready"),
  score: v.number(),
  band: noveltyBand,
  nearestThemeLabel: v.string(),
  reflectionPrompt: v.string(),
  comparedProjectCount: v.number(),
  corpusVersion: v.number(),
  corpusLabel: v.string(),
  inputFingerprint: v.string(),
});

const unavailablePreview = v.object({ state: v.literal("unavailable") });
const waitingPreview = v.object({ state: v.literal("waiting") });
const pendingPreview = v.object({
  state: v.literal("pending"),
  requestId: v.id("noveltyPreviewRequests"),
  retryAt: v.number(),
});
const settledPreviewResult = v.union(readyPreview, unavailablePreview);
const previewResult = v.union(readyPreview, pendingPreview, unavailablePreview);
const trackedPreviewResult = v.union(waitingPreview, previewResult);
type PreviewResult = Infer<typeof previewResult>;
type TrackedPreviewResult = Infer<typeof trackedPreviewResult>;
type SettledPreviewResult = Infer<typeof settledPreviewResult>;

type ReadyPreview = {
  state: "ready";
  score: number;
  band: "familiar" | "developing" | "distinct";
  nearestThemeLabel: string;
  reflectionPrompt: string;
  comparedProjectCount: number;
  corpusVersion: number;
  corpusLabel: string;
  inputFingerprint: string;
};

function indexedLifecycle(draft: Doc<"projectDrafts">, inputFingerprint: string) {
  if (
    draft.initialIdea !== undefined
    && noveltyInputFingerprint(draft.initialIdea) === inputFingerprint
) {
    return draft.stage === "submitted" ? "submitted" : "saved";
  }
  return "editing";
}

function orderedEmbeddings(
  data: readonly { embedding: number[]; index: number }[],
  expectedCount: number,
) {
  const ordered = data.toSorted((left, right) => left.index - right.index);
  if (
    ordered.length !== expectedCount
    || ordered.some((entry, index) => entry.index !== index || !validEmbedding(entry.embedding))
  ) {
    return null;
  }
  return ordered.map((entry) => entry.embedding);
}

async function storeTeamIdeaEmbeddings(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
    inputFingerprint: string;
    lifecycle: NoveltyIdeaLifecycle;
    embeddings: number[][];
    sourceUpdatedAt: number;
  },
) {
  const embedding = args.embeddings[0];
  if (!embedding) throw new Error("A team idea requires its complete-project embedding.");
  const existing = await ctx.db
    .query("noveltyTeamIdeas")
    .withIndex("by_team", (index) => index.eq("teamId", args.teamId))
    .collect();
  const storesEditingIdea = args.lifecycle === "editing";
  const sameSourceIdeas = existing.filter(
    (idea) => (idea.lifecycle === "editing") === storesEditingIdea,
  );
  if (sameSourceIdeas.some((idea) => idea.sourceUpdatedAt > args.sourceUpdatedAt)) {
    return sameSourceIdeas.map((idea) => idea._id);
  }
  const now = Date.now();
  const obsoleteIdeas = storesEditingIdea
    ? sameSourceIdeas
    : existing.filter(
        (idea) => idea.lifecycle !== "editing" || idea.sourceUpdatedAt <= args.sourceUpdatedAt,
      );
  for (const idea of obsoleteIdeas) await ctx.db.delete(idea._id);
  const ideaId = await ctx.db.insert("noveltyTeamIdeas", {
    eventId: args.eventId,
    teamId: args.teamId,
    inputFingerprint: args.inputFingerprint,
    lifecycle: args.lifecycle,
    embedding,
    sourceUpdatedAt: args.sourceUpdatedAt,
    updatedAt: now,
  });
  return [ideaId];
}

function readyResult(
  request: Doc<"noveltyPreviewRequests">,
  corpus: Doc<"noveltyCorpusVersions">,
): ReadyPreview | null {
  if (
    request.state !== "succeeded" ||
    !isCurrentNoveltyScoringVersion(request.scoringVersion) ||
    request.score === undefined ||
    request.band === undefined ||
    request.comparedTeamCount === undefined ||
    request.nearestThemeLabel === undefined ||
    request.reflectionPrompt === undefined
  ) {
    return null;
  }
  return {
    state: "ready",
    score: request.score,
    band: request.band,
    nearestThemeLabel: request.nearestThemeLabel,
    reflectionPrompt: request.reflectionPrompt,
    comparedProjectCount: request.comparedTeamCount,
    corpusVersion: corpus.version,
    corpusLabel: corpus.label,
    inputFingerprint: request.inputFingerprint,
  };
}

function pendingResult(request: Doc<"noveltyPreviewRequests">) {
  return {
    state: "pending" as const,
    requestId: request._id,
    retryAt: request.requestedAt + noveltyPreviewRunningLifetimeMs,
  };
}

const beginPreviewResult = v.union(
  v.object({ kind: v.literal("complete"), result: previewResult }),
  v.object({
    kind: v.literal("run"),
    requestId: v.id("noveltyPreviewRequests"),
    personId: v.id("people"),
    eventId: v.id("events"),
    teamId: v.id("teams"),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    corpusVersion: v.number(),
    corpusLabel: v.string(),
    comparedProjectCount: v.number(),
    inputFingerprint: v.string(),
    embeddingInputs: v.array(v.string()),
    embeddingModel: v.literal("text-embedding-3-small"),
  }),
);
type BeginPreviewResult = Infer<typeof beginPreviewResult>;

async function recordUnavailablePreview(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
    personId: Id<"people">;
    corpusVersionId: Id<"noveltyCorpusVersions">;
    clientRequestId: string;
    inputFingerprint: string;
    inputCharacterCount: number;
    failureCategory: "team_rate_limited" | "global_rate_limited";
    now: number;
  },
): Promise<BeginPreviewResult> {
  await ctx.db.insert("noveltyPreviewRequests", {
    eventId: args.eventId,
    teamId: args.teamId,
    personId: args.personId,
    corpusVersionId: args.corpusVersionId,
    clientRequestId: args.clientRequestId,
    inputFingerprint: args.inputFingerprint,
    inputCharacterCount: args.inputCharacterCount,
    state: "unavailable",
    latencyMs: 0,
    failureCategory: args.failureCategory,
    requestedAt: args.now,
    completedAt: args.now,
  });
  return { kind: "complete", result: { state: "unavailable" } };
}

export const beginPreview = internalMutation({
  args: {
    authUserId: v.string(),
    eventSlug: v.string(),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    idea: v.string(),
    clientRequestId: v.string(),
  },
  returns: beginPreviewResult,
  handler: async (ctx, args): Promise<BeginPreviewResult> => {
    const person = await ctx.db
      .query("people")
      .withIndex("by_auth_user", (index) => index.eq("authUserId", args.authUserId))
      .unique();
    if (!person || person.status !== "active") {
      throw new ConvexError({ code: "PERSON_NOT_ACTIVE", message: "This account is not active." });
    }
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique();
    if (!member) {
      throw new ConvexError({ code: "TEAM_REQUIRED", message: "Create or join a team first." });
    }
    const team = await ctx.db.get(member.teamId);
    if (!team) throw new Error("Team membership references a missing team.");
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.project.write",
      scopeType: "team",
      scopeId: team._id,
    });
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    if (team.membershipLocked || draft?.stage === "submitted") {
      const application = await ctx.db
        .query("applications")
        .withIndex("by_team", (index) => index.eq("teamId", team._id))
        .unique();
      if (
        member.role !== "lead"
        || team.leadMembershipId !== membership._id
        || Date.now() >= applicationsCloseAtFor(event, membership.participantClass)
        || !application
        || (application.state !== "submitted" && application.state !== "under_review")
      ) {
        throw new ConvexError({
          code: "SUBMISSION_LOCKED",
          message: "This proposal can no longer be edited.",
        });
      }
    }
    const expectedCorpusId = draft?.noveltyCorpusVersionId
      ?? event.publishedNoveltyCorpusVersionId;
    if (!expectedCorpusId || expectedCorpusId !== args.corpusVersionId) {
      throw new ConvexError({
        code: "NOVELTY_CORPUS_CHANGED",
        message: "The comparison corpus changed. Refresh before checking this idea again.",
      });
    }
    const corpus = await ctx.db.get(args.corpusVersionId);
    const validStatus = draft?.noveltyCorpusVersionId
      ? corpus?.status === "published" || corpus?.status === "superseded"
      : corpus?.status === "published";
    if (
      !corpus ||
      corpus.eventId !== event._id ||
      !validStatus ||
      corpus.importState !== "ready" ||
      !corpus.checksum ||
      corpus.entryCount < 1 ||
      corpus.embeddingDimensions !== noveltyEmbeddingDimensions
    ) {
      return { kind: "complete", result: { state: "unavailable" } };
    }
    const intakePolicy = draft
      ? await requirePinnedIntakePolicy(ctx, draft)
      : await requirePublishedIntakePolicy(ctx, event);
    const normalizedIdea = normalizeNoveltyIdea(
      args.idea,
      corpus.minimumIdeaLength,
      intakePolicy.normalized.initialIdeaMaxLength,
    );
    const inputFingerprint = noveltyInputFingerprint(normalizedIdea);
    const clientRequestId = normalizedText(args.clientRequestId, "Client request ID", 8, 120);
    const existingRequest = await ctx.db
      .query("noveltyPreviewRequests")
      .withIndex("by_team_client_request", (index) =>
        index.eq("teamId", team._id).eq("clientRequestId", clientRequestId),
      )
      .unique();
    if (existingRequest) {
      if (
        existingRequest.inputFingerprint !== inputFingerprint ||
        existingRequest.corpusVersionId !== corpus._id
      ) {
        throw new ConvexError({
          code: "OPERATION_ID_REUSED",
          message: "This novelty request ID was already used for different text.",
        });
      }
      if (existingRequest.state === "running") {
        return { kind: "complete", result: pendingResult(existingRequest) };
      }
      return {
        kind: "complete",
        result: readyResult(existingRequest, corpus) ?? { state: "unavailable" },
      };
    }
    const cached = await ctx.db
      .query("noveltyPreviewRequests")
      .withIndex("by_team_fingerprint_requested", (index) =>
        index.eq("teamId", team._id).eq("inputFingerprint", inputFingerprint),
      )
      .order("desc")
      .first();
    const now = Date.now();
    if (
      cached &&
      cached.corpusVersionId === corpus._id &&
      cached.state === "running"
    ) {
      if (cached.requestedAt >= now - noveltyPreviewRunningLifetimeMs) {
        return { kind: "complete", result: pendingResult(cached) };
      }
      await ctx.db.patch(cached._id, {
        state: "failed",
        failureCategory: "abandoned_preview",
        latencyMs: now - cached.requestedAt,
        completedAt: now,
      });
    }
    if (
      cached &&
      cached.corpusVersionId === corpus._id &&
      cached.requestedAt >= now - noveltyPreviewCacheLifetimeMs
    ) {
      const result = readyResult(cached, corpus);
      if (result) return { kind: "complete", result };
    }
    const teamLimit = await noveltyRateLimiter.limit(ctx, "teamPreview", {
      key: team._id,
      config: teamNoveltyRateLimit(corpus.maximumRequestsPerMinute),
    });
    if (!teamLimit.ok) {
      return recordUnavailablePreview(ctx, {
        eventId: event._id,
        teamId: team._id,
        personId: person._id,
        corpusVersionId: corpus._id,
        clientRequestId,
        inputFingerprint,
        inputCharacterCount: normalizedIdea.length,
        failureCategory: "team_rate_limited",
        now,
      });
    }
    const globalLimit = await noveltyRateLimiter.limit(ctx, "globalPreview", {
      config: globalNoveltyRateLimit(
        process.env.NOVELTY_GLOBAL_REQUESTS_PER_MINUTE,
      ),
    });
    if (!globalLimit.ok) {
      return recordUnavailablePreview(ctx, {
        eventId: event._id,
        teamId: team._id,
        personId: person._id,
        corpusVersionId: corpus._id,
        clientRequestId,
        inputFingerprint,
        inputCharacterCount: normalizedIdea.length,
        failureCategory: "global_rate_limited",
        now,
      });
    }
    const requestId = await ctx.db.insert("noveltyPreviewRequests", {
      eventId: event._id,
      teamId: team._id,
      personId: person._id,
      corpusVersionId: corpus._id,
      clientRequestId,
      inputFingerprint,
      inputCharacterCount: normalizedIdea.length,
      state: "running",
      requestedAt: now,
    });
    return {
      kind: "run",
      requestId,
      personId: person._id,
      eventId: event._id,
      teamId: team._id,
      corpusVersionId: corpus._id,
      corpusVersion: corpus.version,
      corpusLabel: corpus.label,
      comparedProjectCount: corpus.entryCount,
      inputFingerprint,
      embeddingInputs: [normalizedIdea],
      embeddingModel: corpus.embeddingModel,
    };
  },
});

export const readMatchMetadata = internalQuery({
  args: {
    corpusVersionId: v.id("noveltyCorpusVersions"),
    entryIds: v.array(v.id("noveltyCorpusEntries")),
  },
  returns: v.array(
    v.object({
      id: v.id("noveltyCorpusEntries"),
      themeLabel: v.string(),
      summary: v.string(),
      reflectionPrompt: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const entries = await Promise.all(args.entryIds.map((entryId) => ctx.db.get(entryId)));
    return entries.map((entry, index) => {
      if (!entry || entry.corpusVersionId !== args.corpusVersionId) {
        throw new Error(`Novelty vector result ${index + 1} does not belong to its corpus.`);
      }
      return {
        id: entry._id,
        themeLabel: entry.themeLabel,
        summary: entry.summary,
        reflectionPrompt: entry.reflectionPrompt,
      };
    });
  },
});

export const upsertPreviewTeamIdea = internalMutation({
  args: {
    requestId: v.id("noveltyPreviewRequests"),
    inputFingerprint: v.string(),
    embedding: v.array(v.float64()),
  },
  returns: v.object({ ideaIds: v.array(v.id("noveltyTeamIdeas")) }),
  handler: async (ctx, args) => {
    if (!validEmbedding(args.embedding)) {
      throw new Error("A team idea index requires a valid embedding.");
    }
    const request = await ctx.db.get(args.requestId);
    if (
      !request
      || request.state !== "running"
      || request.inputFingerprint !== args.inputFingerprint
    ) {
      throw new Error("The novelty request is no longer indexable.");
    }
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", request.teamId))
      .unique();
    const lifecycle = draft ? indexedLifecycle(draft, request.inputFingerprint) : "editing";
    const ideaIds = await storeTeamIdeaEmbeddings(ctx, {
      eventId: request.eventId,
      teamId: request.teamId,
      inputFingerprint: request.inputFingerprint,
      lifecycle,
      embeddings: [args.embedding],
      sourceUpdatedAt: request.requestedAt,
    });
    if (lifecycle === "editing") {
      await ctx.scheduler.runAfter(
        noveltyEditingIdeaLifetimeMs,
        internal.novelty.expireEditingTeamIdea,
        {
          teamId: request.teamId,
          inputFingerprint: request.inputFingerprint,
          sourceUpdatedAt: request.requestedAt,
        },
      );
    }
    return { ideaIds };
  },
});

export const expireEditingTeamIdea = internalMutation({
  args: {
    teamId: v.id("teams"),
    inputFingerprint: v.string(),
    sourceUpdatedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ideas = await ctx.db
      .query("noveltyTeamIdeas")
      .withIndex("by_team", (index) => index.eq("teamId", args.teamId))
      .collect();
    for (const idea of ideas) {
      if (
        idea.lifecycle === "editing"
        && idea.inputFingerprint === args.inputFingerprint
        && idea.sourceUpdatedAt === args.sourceUpdatedAt
      ) {
        await ctx.db.delete(idea._id);
      }
    }
    return null;
  },
});

export const readTeamIdeaMetadata = internalQuery({
  args: {
    eventId: v.id("events"),
    ideaIds: v.array(v.id("noveltyTeamIdeas")),
    now: v.number(),
  },
  returns: v.array(v.object({
    id: v.id("noveltyTeamIdeas"),
    teamId: v.id("teams"),
    lifecycle: noveltyIdeaLifecycle,
    active: v.boolean(),
  })),
  handler: async (ctx, args) => {
    const ideas = await Promise.all(args.ideaIds.map((ideaId) => ctx.db.get(ideaId)));
    const editingCutoff = args.now - noveltyEditingIdeaLifetimeMs;
    return ideas.map((idea, index) => {
      if (!idea || idea.eventId !== args.eventId) {
        throw new Error(`Team novelty vector result ${index + 1} belongs to another event.`);
      }
      return {
        id: idea._id,
        teamId: idea.teamId,
        lifecycle: idea.lifecycle,
        active: idea.lifecycle !== "editing" || idea.sourceUpdatedAt > editingCutoff,
      };
    });
  },
});

type NoveltyEvaluation = {
  score: number;
  band: "familiar" | "developing" | "distinct";
  effectiveSimilarTeams: number;
  comparedTeamCount: number;
  nearestSimilarity: number;
  nearestThemeLabel: string;
  reflectionPrompt: string;
  scoringVersion: NoveltyScoringVersion;
  refinementFailureCategory?: string;
  agent?: {
    version: string;
    model: string;
    operationId: string;
    outputChecksum: string;
  };
};

type NoveltyEvaluationRequest = {
  eventId: Id<"events">;
  teamId: Id<"teams">;
  corpusVersionId: Id<"noveltyCorpusVersions">;
  embedding: number[];
} & (
  | { mode: "embedding" }
  | {
      mode: "hybrid";
      idea: string;
      apiKey: string;
      safetyIdentifier: string;
    }
);

async function evaluateNoveltyEmbedding(
  ctx: ActionCtx,
  args: NoveltyEvaluationRequest,
): Promise<NoveltyEvaluation | null> {
  const [corpusMatches, teamMatches] = await Promise.all([
    ctx.vectorSearch(
      "noveltyCorpusEntries",
      "by_corpus_embedding",
      {
        vector: args.embedding,
        limit: noveltyDensityMatchLimit,
        filter: (filter) => filter.eq("corpusVersionId", args.corpusVersionId),
      },
    ),
    ctx.vectorSearch(
      "noveltyTeamIdeas",
      "by_event_embedding",
      {
        vector: args.embedding,
        limit: noveltyTeamVectorMatchLimit,
        filter: (filter) => filter.eq("eventId", args.eventId),
      },
    ),
  ]);
  const nearest = corpusMatches[0];
  if (!nearest) return null;

  const metadata = await ctx.runQuery(internal.novelty.readMatchMetadata, {
    corpusVersionId: args.corpusVersionId,
    entryIds: corpusMatches.map((match) => match._id),
  });
  if (
    metadata.length !== corpusMatches.length
    || metadata.some((entry, index) => entry.id !== corpusMatches[index]?._id)
  ) {
    throw new Error("A novelty result has no matching approved metadata.");
  }

  const teamMetadata = await ctx.runQuery(internal.novelty.readTeamIdeaMetadata, {
    eventId: args.eventId,
    ideaIds: teamMatches.map((match) => match._id),
    now: Date.now(),
  });
  const teamSimilarityById = new Map(
    teamMatches.map((match) => [match._id, match._score] as const),
  );
  const teamCandidates: Array<{
    teamId: Id<"teams">;
    similarity: number;
    rawSimilarity: number;
    lifecycle: NoveltyIdeaLifecycle;
  }> = [];
  for (const idea of teamMetadata) {
    if (!idea.active) continue;
    const rawSimilarity = teamSimilarityById.get(idea.id);
    if (rawSimilarity === undefined) {
      throw new Error("Team novelty metadata has no vector similarity.");
    }
    teamCandidates.push({
      teamId: idea.teamId,
      similarity: noveltyDensitySimilarity(rawSimilarity),
      rawSimilarity,
      lifecycle: idea.lifecycle,
    });
  }
  const strongestTeamCandidates = strongestNoveltyMatchPerTeam(
    teamCandidates,
    args.teamId,
  );

  const judgedMetadata = metadata.slice(0, noveltyJudgeCandidateLimit);
  let judgeResponse: Awaited<ReturnType<typeof requestOpenAiNoveltyJudgments>> | undefined;
  let refinementFailureCategory: string | undefined;
  if (args.mode === "hybrid") {
    const judgeAttempt = await requestOpenAiNoveltyJudgmentsWithFallback({
      apiKey: args.apiKey,
      query: redactProjectText(args.idea),
      candidates: judgedMetadata.map((entry, index) => ({
        key: `candidate-${index + 1}`,
        text: `${entry.themeLabel}\n${entry.summary}`,
      })),
      safetyIdentifier: args.safetyIdentifier,
      timeoutMs: noveltyJudgeProviderTimeoutMs,
    });
    if (judgeAttempt.kind === "judged") {
      judgeResponse = judgeAttempt.result;
    } else {
      refinementFailureCategory = judgeAttempt.failureCategory;
    }
  }
  const judgmentByKey = new Map(
    (judgeResponse?.comparisons ?? []).map(
      (comparison) => [comparison.candidateKey, comparison] as const,
    ),
  );
  const candidateKeyByEntryId = new Map(
    judgedMetadata.map((entry, index) => [entry.id, `candidate-${index + 1}`] as const),
  );
  const corpusWeightedMatches = corpusMatches.map((match, index) => {
    const entry = metadata[index];
    if (!entry) throw new Error("A novelty result has no approved metadata.");
    const candidateKey = candidateKeyByEntryId.get(match._id);
    const judgment = candidateKey ? judgmentByKey.get(candidateKey) : undefined;
    return calibratedNoveltyMatch({
      metadata: entry,
      rawSimilarity: match._score,
      ...(judgment
        ? { relationship: judgment.relationship, confidence: judgment.confidence }
        : {}),
    });
  });
  const strongestCorpusMatch = strongestCalibratedNoveltyMatch(corpusWeightedMatches);
  if (!strongestCorpusMatch) return null;

  const weightedMatches: Array<{
    weight: number;
    lifecycle: NoveltyIdeaLifecycle;
    semanticOverlap: number;
  }> = corpusWeightedMatches.map((match) => ({
    weight: match.weight,
    lifecycle: "submitted" as const,
    semanticOverlap: match.semanticOverlap,
  }));
  for (const candidate of strongestTeamCandidates.values()) {
    weightedMatches.push({
      weight: noveltySimilarityWeight(
        candidate.similarity,
        noveltyDensitySimilarityPolicy,
      ),
      lifecycle: candidate.lifecycle,
      semanticOverlap: semanticOverlapFromEmbedding(candidate.rawSimilarity),
    });
  }
  const densityMatches = weightedMatches
    .toSorted(
      (left, right) =>
        right.weight * noveltyLifecycleWeight(right.lifecycle)
        - left.weight * noveltyLifecycleWeight(left.lifecycle),
    )
    .slice(0, noveltyDensityMatchLimit);
  const density = densityMatches.reduce(
    (total, match) => total + match.weight * noveltyLifecycleWeight(match.lifecycle),
    0,
  );
  const strongestOverlap = densityMatches.reduce(
    (strongest, match) => Math.max(
      strongest,
      match.semanticOverlap * noveltyLifecycleWeight(match.lifecycle),
    ),
    0,
  );
  const score = noveltyScoreForEvidence(density, strongestOverlap);
  return {
    score,
    band: noveltyBandForScore(score),
    effectiveSimilarTeams: density,
    comparedTeamCount: densityMatches.length,
    nearestSimilarity: strongestCorpusMatch.rawSimilarity,
    nearestThemeLabel: strongestCorpusMatch.metadata.themeLabel,
    reflectionPrompt: strongestCorpusMatch.metadata.reflectionPrompt,
    scoringVersion: judgeResponse
      ? noveltyScoringVersion
      : noveltyEmbeddingScoringVersion,
    ...(refinementFailureCategory ? { refinementFailureCategory } : {}),
    ...(judgeResponse
      ? {
          agent: {
            version: noveltyJudgePromptVersion,
            model: `openai/${noveltyJudgeModelId}`,
            operationId: judgeResponse.responseId,
            outputChecksum: judgeResponse.outputChecksum,
          },
        }
      : {}),
  };
}

const prepareDraftIndexResult = v.union(
  v.object({ kind: v.literal("complete") }),
  v.object({
    kind: v.literal("score"),
    eventId: v.id("events"),
    teamId: v.id("teams"),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    embedding: v.array(v.float64()),
    idea: v.string(),
  }),
  v.object({
    kind: v.literal("run"),
    eventId: v.id("events"),
    teamId: v.id("teams"),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    embeddingInputs: v.array(v.string()),
    embeddingModel: v.literal("text-embedding-3-small"),
  }),
);
type PrepareDraftIndexResult = Infer<typeof prepareDraftIndexResult>;

const prepareSubmittedIndexResult = v.union(
  v.object({ kind: v.literal("complete") }),
  v.object({
    kind: v.literal("run"),
    embeddingInputs: v.array(v.string()),
    embeddingModel: v.literal("text-embedding-3-small"),
  }),
);
type PrepareSubmittedIndexResult = Infer<typeof prepareSubmittedIndexResult>;

export const prepareDraftIndex = internalMutation({
  args: {
    draftId: v.id("projectDrafts"),
    inputFingerprint: v.string(),
    sourceUpdatedAt: v.number(),
  },
  returns: prepareDraftIndexResult,
  handler: async (ctx, args): Promise<PrepareDraftIndexResult> => {
    const draft = await ctx.db.get(args.draftId);
    if (
      !draft?.initialIdea
      || noveltyInputFingerprint(draft.initialIdea) !== args.inputFingerprint
    ) {
      return { kind: "complete" };
    }
    const corpus = draft.noveltyCorpusVersionId
      ? await ctx.db.get(draft.noveltyCorpusVersionId)
      : null;
    if (
      !corpus
      || (corpus.status !== "published" && corpus.status !== "superseded")
      || corpus.importState !== "ready"
    ) {
      return { kind: "complete" };
    }
    const existing = (await ctx.db
      .query("noveltyTeamIdeas")
      .withIndex("by_team", (index) => index.eq("teamId", draft.teamId))
      .collect()).filter((idea) => idea.lifecycle !== "editing");
    const embeddingInputs = [draft.initialIdea];
    if (
      existing.length === 1
      && existing.every((idea) => idea.inputFingerprint === args.inputFingerprint)
    ) {
      for (const idea of existing) {
        if (idea.sourceUpdatedAt <= args.sourceUpdatedAt) {
          await ctx.db.patch(idea._id, {
            lifecycle: indexedLifecycle(draft, args.inputFingerprint),
            sourceUpdatedAt: args.sourceUpdatedAt,
            updatedAt: Date.now(),
          });
        }
      }
      const embedding = existing[0]?.embedding;
      if (embedding && validEmbedding(embedding)) {
        return {
          kind: "score",
          eventId: draft.eventId,
          teamId: draft.teamId,
          corpusVersionId: corpus._id,
          embedding,
          idea: draft.initialIdea,
        };
      }
    }
    if (existing.some((idea) => idea.sourceUpdatedAt > args.sourceUpdatedAt)) {
      return { kind: "complete" };
    }
    return {
      kind: "run",
      eventId: draft.eventId,
      teamId: draft.teamId,
      corpusVersionId: corpus._id,
      embeddingInputs,
      embeddingModel: corpus.embeddingModel,
    };
  },
});

export const finishDraftIndex = internalMutation({
  args: {
    draftId: v.id("projectDrafts"),
    inputFingerprint: v.string(),
    sourceUpdatedAt: v.number(),
    embedding: v.array(v.float64()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!validEmbedding(args.embedding)) {
      throw new Error("A saved team idea requires a valid embedding.");
    }
    const draft = await ctx.db.get(args.draftId);
    if (
      !draft?.initialIdea
      || noveltyInputFingerprint(draft.initialIdea) !== args.inputFingerprint
    ) {
      return null;
    }
    await storeTeamIdeaEmbeddings(ctx, {
      eventId: draft.eventId,
      teamId: draft.teamId,
      inputFingerprint: args.inputFingerprint,
      lifecycle: indexedLifecycle(draft, args.inputFingerprint),
      embeddings: [args.embedding],
      sourceUpdatedAt: args.sourceUpdatedAt,
    });
    return null;
  },
});

export const finishDraftNovelty = internalMutation({
  args: {
    draftId: v.id("projectDrafts"),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    inputFingerprint: v.string(),
    score: v.number(),
    band: noveltyBand,
    nearestThemeLabel: v.string(),
    reflectionPrompt: v.string(),
    scoringVersion: noveltyScoringVersionValue,
    refinementFailureCategory: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.draftId);
    if (
      !draft?.initialIdea
      || draft.noveltyCorpusVersionId !== args.corpusVersionId
      || noveltyInputFingerprint(draft.initialIdea) !== args.inputFingerprint
    ) {
      return false;
    }
    if (
      args.scoringVersion === noveltyEmbeddingScoringVersion
      && draft.noveltyEvaluatedInputFingerprint === args.inputFingerprint
      && draft.noveltyScoringVersion === noveltyScoringVersion
    ) {
      return false;
    }
    await ctx.db.patch(draft._id, {
      noveltyEvaluatedInputFingerprint: args.inputFingerprint,
      noveltyScore: args.score,
      noveltyBand: args.band,
      noveltyNearestThemeLabel: args.nearestThemeLabel,
      noveltyReflectionPrompt: args.reflectionPrompt,
      noveltyScoringVersion: args.scoringVersion,
      noveltyRefinementFailureCategory: args.refinementFailureCategory,
      noveltyEvaluatedAt: Date.now(),
    });
    return true;
  },
});

export const indexDraftIdea = internalAction({
  args: {
    draftId: v.id("projectDrafts"),
    inputFingerprint: v.string(),
    sourceUpdatedAt: v.number(),
    attempt: v.optional(v.number()),
    deduplicationReserved: v.optional(v.boolean()),
    providerCapacityReserved: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const prepared = await ctx.runMutation(internal.novelty.prepareDraftIndex, {
      draftId: args.draftId,
      inputFingerprint: args.inputFingerprint,
      sourceUpdatedAt: args.sourceUpdatedAt,
    });
    if (prepared.kind === "complete") return null;
    try {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) return null;
      if (!args.deduplicationReserved) {
        const duplicate = await noveltyRateLimiter.limit(ctx, "backgroundIndexInput", {
          key: `draft:${args.draftId}:${args.inputFingerprint}`,
          config: backgroundNoveltyIndexDeduplicationLimit(),
        });
        if (!duplicate.ok) return null;
      }
      if (!args.providerCapacityReserved) {
        const capacity = await noveltyRateLimiter.limit(ctx, "backgroundIndexGlobal", {
          config: backgroundNoveltyIndexRateLimit(
            process.env.NOVELTY_INDEX_REQUESTS_PER_MINUTE,
          ),
          reserve: true,
        });
        if (capacity.retryAfter !== undefined) {
          await ctx.scheduler.runAfter(
            capacity.retryAfter,
            internal.novelty.indexDraftIdea,
            {
              draftId: args.draftId,
              inputFingerprint: args.inputFingerprint,
              sourceUpdatedAt: args.sourceUpdatedAt,
              ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
              deduplicationReserved: true,
              ...(capacity.ok ? { providerCapacityReserved: true } : {}),
            },
          );
          return null;
        }
        if (!capacity.ok) return null;
      }
      let embedding: number[];
      let idea: string;
      if (prepared.kind === "score") {
        embedding = prepared.embedding;
        idea = prepared.idea;
      } else {
        const embeddingInput = prepared.embeddingInputs[0];
        if (!embeddingInput) throw new Error("A saved idea requires complete text.");
        idea = embeddingInput;
        const response = await createOpenAiEmbeddings({
          apiKey,
          model: prepared.embeddingModel,
          input: prepared.embeddingInputs,
          timeoutMs: noveltyPreviewProviderAttemptTimeoutMs,
          maximumAttempts: 2,
          telemetry: {
            traceId: `${args.draftId}:${args.inputFingerprint}`,
            sessionId: args.draftId,
            operation: "novelty.index_draft",
            capture: async (telemetry) => {
              await ctx.scheduler.runAfter(
                0,
                internal.intelligenceActions.captureEmbeddingTelemetry,
                scheduledAiEmbeddingTelemetry(telemetry),
              );
            },
          },
        });
        const embeddings = orderedEmbeddings(response.data, prepared.embeddingInputs.length);
        const generatedEmbedding = embeddings?.[0];
        if (!embeddings || !generatedEmbedding) {
          throw new Error("The background embedding was invalid.");
        }
        embedding = generatedEmbedding;
        await ctx.runMutation(internal.novelty.finishDraftIndex, {
          draftId: args.draftId,
          inputFingerprint: args.inputFingerprint,
          sourceUpdatedAt: args.sourceUpdatedAt,
          embedding,
        });
      }
      const evaluation = await evaluateNoveltyEmbedding(ctx, {
        eventId: prepared.eventId,
        teamId: prepared.teamId,
        corpusVersionId: prepared.corpusVersionId,
        embedding,
        mode: "hybrid",
        idea,
        apiKey,
        safetyIdentifier: String(prepared.teamId),
      });
      if (evaluation) {
        if (evaluation.refinementFailureCategory) {
          console.warn("Novelty judge used embedding fallback.", {
            draftId: String(args.draftId),
            failureCategory: evaluation.refinementFailureCategory,
          });
        }
        const applied: boolean = await ctx.runMutation(internal.novelty.finishDraftNovelty, {
          draftId: args.draftId,
          corpusVersionId: prepared.corpusVersionId,
          inputFingerprint: args.inputFingerprint,
          score: evaluation.score,
          band: evaluation.band,
          nearestThemeLabel: evaluation.nearestThemeLabel,
          reflectionPrompt: evaluation.reflectionPrompt,
          scoringVersion: evaluation.scoringVersion,
          ...(evaluation.refinementFailureCategory
            ? { refinementFailureCategory: evaluation.refinementFailureCategory }
            : {}),
        });
        const attempt = args.attempt ?? 1;
        if (applied && evaluation.refinementFailureCategory && attempt < 3) {
          await ctx.scheduler.runAfter(
            1_000 * (2 ** (attempt - 1)),
            internal.novelty.indexDraftIdea,
            {
              draftId: args.draftId,
              inputFingerprint: args.inputFingerprint,
              sourceUpdatedAt: args.sourceUpdatedAt,
              attempt: attempt + 1,
              deduplicationReserved: true,
            },
          );
        }
      }
    } catch {
      const attempt = args.attempt ?? 1;
      if (attempt < 3) {
        await ctx.scheduler.runAfter(
          1_000 * (2 ** (attempt - 1)),
          internal.novelty.indexDraftIdea,
          {
            draftId: args.draftId,
            inputFingerprint: args.inputFingerprint,
            sourceUpdatedAt: args.sourceUpdatedAt,
            attempt: attempt + 1,
            deduplicationReserved: true,
          },
        );
      }
      return null;
    }
    return null;
  },
});

export const prepareSubmittedProjectIndex = internalMutation({
  args: {
    projectVersionId: v.id("projectVersions"),
    inputFingerprint: v.string(),
    sourceUpdatedAt: v.number(),
  },
  returns: prepareSubmittedIndexResult,
  handler: async (ctx, args): Promise<PrepareSubmittedIndexResult> => {
    const project = await ctx.db.get(args.projectVersionId);
    if (
      !project
      || noveltyInputFingerprint(project.initialIdea) !== args.inputFingerprint
    ) {
      return { kind: "complete" };
    }
    const team = await ctx.db.get(project.teamId);
    if (!team || team.lockedProjectVersionId !== project._id) return { kind: "complete" };
    const existing = (await ctx.db
      .query("noveltyTeamIdeas")
      .withIndex("by_team", (index) => index.eq("teamId", project.teamId))
      .collect()).filter((idea) => idea.lifecycle !== "editing");
    const embeddingInputs = [project.initialIdea];
    if (
      existing.length === 1
      && existing.every((idea) => idea.inputFingerprint === args.inputFingerprint)
    ) {
      for (const idea of existing) {
        if (idea.sourceUpdatedAt <= args.sourceUpdatedAt) {
          await ctx.db.patch(idea._id, {
            lifecycle: "submitted",
            sourceUpdatedAt: args.sourceUpdatedAt,
            updatedAt: Date.now(),
          });
        }
      }
      return { kind: "complete" };
    }
    if (existing.some((idea) => idea.sourceUpdatedAt > args.sourceUpdatedAt)) {
      return { kind: "complete" };
    }
    return {
      kind: "run",
      embeddingInputs,
      embeddingModel: noveltyEmbeddingModel,
    };
  },
});

export const finishSubmittedProjectIndex = internalMutation({
  args: {
    projectVersionId: v.id("projectVersions"),
    inputFingerprint: v.string(),
    sourceUpdatedAt: v.number(),
    embedding: v.array(v.float64()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!validEmbedding(args.embedding)) {
      throw new Error("A submitted team idea requires a valid embedding.");
    }
    const project = await ctx.db.get(args.projectVersionId);
    if (!project || noveltyInputFingerprint(project.initialIdea) !== args.inputFingerprint) {
      return null;
    }
    const team = await ctx.db.get(project.teamId);
    if (!team || team.lockedProjectVersionId !== project._id) return null;
    await storeTeamIdeaEmbeddings(ctx, {
      eventId: project.eventId,
      teamId: project.teamId,
      inputFingerprint: args.inputFingerprint,
      lifecycle: "submitted",
      embeddings: [args.embedding],
      sourceUpdatedAt: args.sourceUpdatedAt,
    });
    return null;
  },
});

export const indexSubmittedProjectIdea = internalAction({
  args: {
    projectVersionId: v.id("projectVersions"),
    inputFingerprint: v.string(),
    sourceUpdatedAt: v.number(),
    attempt: v.optional(v.number()),
    deduplicationReserved: v.optional(v.boolean()),
    providerCapacityReserved: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const prepared = await ctx.runMutation(
      internal.novelty.prepareSubmittedProjectIndex,
      {
        projectVersionId: args.projectVersionId,
        inputFingerprint: args.inputFingerprint,
        sourceUpdatedAt: args.sourceUpdatedAt,
      },
    );
    if (prepared.kind === "complete") return null;
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return null;
    if (!args.deduplicationReserved) {
      const duplicate = await noveltyRateLimiter.limit(ctx, "backgroundIndexInput", {
        key: `project:${args.projectVersionId}:${args.inputFingerprint}`,
        config: backgroundNoveltyIndexDeduplicationLimit(),
      });
      if (!duplicate.ok) return null;
    }
    if (!args.providerCapacityReserved) {
      const capacity = await noveltyRateLimiter.limit(ctx, "backgroundIndexGlobal", {
        config: backgroundNoveltyIndexRateLimit(
          process.env.NOVELTY_INDEX_REQUESTS_PER_MINUTE,
        ),
        reserve: true,
      });
      if (capacity.retryAfter !== undefined) {
        await ctx.scheduler.runAfter(
          capacity.retryAfter,
          internal.novelty.indexSubmittedProjectIdea,
          {
            projectVersionId: args.projectVersionId,
            inputFingerprint: args.inputFingerprint,
            sourceUpdatedAt: args.sourceUpdatedAt,
            ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
            deduplicationReserved: true,
            ...(capacity.ok ? { providerCapacityReserved: true } : {}),
          },
        );
        return null;
      }
      if (!capacity.ok) return null;
    }
    try {
      const response = await createOpenAiEmbeddings({
        apiKey,
        model: prepared.embeddingModel,
        input: prepared.embeddingInputs,
        timeoutMs: 12_000,
        telemetry: {
          traceId: `${args.projectVersionId}:${args.inputFingerprint}`,
          sessionId: args.projectVersionId,
          operation: "novelty.index_submission",
          capture: async (telemetry) => {
            await ctx.scheduler.runAfter(
              0,
              internal.intelligenceActions.captureEmbeddingTelemetry,
              scheduledAiEmbeddingTelemetry(telemetry),
            );
          },
        },
      });
      const embeddings = orderedEmbeddings(response.data, prepared.embeddingInputs.length);
      const embedding = embeddings?.[0];
      if (!embeddings || !embedding) throw new Error("The background embedding was invalid.");
      await ctx.runMutation(internal.novelty.finishSubmittedProjectIndex, {
        projectVersionId: args.projectVersionId,
        inputFingerprint: args.inputFingerprint,
        sourceUpdatedAt: args.sourceUpdatedAt,
        embedding,
      });
    } catch {
      const attempt = args.attempt ?? 1;
      if (attempt < 3) {
        await ctx.scheduler.runAfter(
          1_000 * (2 ** (attempt - 1)),
          internal.novelty.indexSubmittedProjectIdea,
          {
            projectVersionId: args.projectVersionId,
            inputFingerprint: args.inputFingerprint,
            sourceUpdatedAt: args.sourceUpdatedAt,
            attempt: attempt + 1,
            deduplicationReserved: true,
          },
        );
      }
      return null;
    }
    return null;
  },
});

export const finishPreview = internalMutation({
  args: {
    requestId: v.id("noveltyPreviewRequests"),
    inputFingerprint: v.string(),
    state: v.union(
      v.literal("succeeded"),
      v.literal("unavailable"),
      v.literal("failed"),
    ),
    score: v.optional(v.number()),
    band: v.optional(noveltyBand),
    effectiveSimilarTeams: v.optional(v.number()),
    comparedTeamCount: v.optional(v.number()),
    nearestSimilarity: v.optional(v.number()),
    nearestThemeLabel: v.optional(v.string()),
    reflectionPrompt: v.optional(v.string()),
    scoringVersion: v.optional(noveltyScoringVersionValue),
    providerRequestId: v.optional(v.string()),
    providerRemainingRequests: v.optional(v.number()),
    providerRequestReset: v.optional(v.string()),
    agentOperationId: v.optional(v.string()),
    agentOutputChecksum: v.optional(v.string()),
    agentVersion: v.optional(v.string()),
    agentModel: v.optional(v.string()),
    latencyMs: v.number(),
    failureCategory: v.optional(v.string()),
  },
  returns: settledPreviewResult,
  handler: async (ctx, args): Promise<SettledPreviewResult> => {
    const request = await ctx.db.get(args.requestId);
    if (!request || request.state !== "running") return { state: "unavailable" };
    if (request.inputFingerprint !== args.inputFingerprint) {
      throw new Error("A novelty result does not match its input fingerprint.");
    }
    const corpus = await ctx.db.get(request.corpusVersionId);
    if (!corpus || (corpus.status !== "published" && corpus.status !== "superseded")) {
      await ctx.db.patch(request._id, {
        state: "stale",
        latencyMs: args.latencyMs,
        failureCategory: "corpus_not_current",
        completedAt: Date.now(),
      });
      return { state: "unavailable" };
    }
    const now = Date.now();
    if (args.state !== "succeeded") {
      await ctx.db.patch(request._id, {
        state: args.state,
        ...(args.providerRequestId ? { providerRequestId: args.providerRequestId } : {}),
        ...(args.providerRemainingRequests !== undefined
          ? { providerRemainingRequests: args.providerRemainingRequests }
          : {}),
        ...(args.providerRequestReset
          ? { providerRequestReset: args.providerRequestReset }
          : {}),
        latencyMs: args.latencyMs,
        ...(args.failureCategory ? { failureCategory: args.failureCategory } : {}),
        completedAt: now,
      });
      return { state: "unavailable" };
    }
    if (
      args.score === undefined ||
      args.band === undefined ||
      !isCurrentNoveltyScoringVersion(args.scoringVersion) ||
      args.effectiveSimilarTeams === undefined ||
      args.comparedTeamCount === undefined ||
      args.nearestSimilarity === undefined ||
      args.nearestThemeLabel === undefined ||
      args.reflectionPrompt === undefined
    ) {
      throw new Error("A successful novelty result is incomplete.");
    }
    await ctx.db.patch(request._id, {
      state: "succeeded",
      score: args.score,
      band: args.band,
      effectiveSimilarTeams: args.effectiveSimilarTeams,
      comparedTeamCount: args.comparedTeamCount,
      nearestSimilarity: args.nearestSimilarity,
      nearestThemeLabel: args.nearestThemeLabel,
      reflectionPrompt: args.reflectionPrompt,
      scoringVersion: args.scoringVersion,
      ...(args.providerRequestId ? { providerRequestId: args.providerRequestId } : {}),
      ...(args.providerRemainingRequests !== undefined
        ? { providerRemainingRequests: args.providerRemainingRequests }
        : {}),
      ...(args.providerRequestReset ? { providerRequestReset: args.providerRequestReset } : {}),
      ...(args.agentOperationId ? { agentOperationId: args.agentOperationId } : {}),
      ...(args.agentOutputChecksum ? { agentOutputChecksum: args.agentOutputChecksum } : {}),
      agentVersion: args.agentVersion,
      ...(args.agentModel ? { agentModel: args.agentModel } : {}),
      latencyMs: args.latencyMs,
      ...(args.failureCategory ? { failureCategory: args.failureCategory } : {}),
      completedAt: now,
    });
    const team = await ctx.db.get(request.teamId);
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", request.teamId))
      .unique();
    if (
      team &&
      !team.membershipLocked &&
      draft?.initialIdea &&
      draft.stage !== "submitted" &&
      draft.noveltyCorpusVersionId === request.corpusVersionId &&
      noveltyInputFingerprint(draft.initialIdea) === request.inputFingerprint &&
      !(
        args.scoringVersion === noveltyEmbeddingScoringVersion
        && draft.noveltyEvaluatedInputFingerprint === request.inputFingerprint
        && draft.noveltyScoringVersion === noveltyScoringVersion
      )
    ) {
      await ctx.db.patch(draft._id, {
        noveltyEvaluatedInputFingerprint: request.inputFingerprint,
        noveltyScore: args.score,
        noveltyBand: args.band,
        noveltyNearestThemeLabel: args.nearestThemeLabel,
        noveltyReflectionPrompt: args.reflectionPrompt,
        noveltyScoringVersion: args.scoringVersion,
        noveltyRefinementFailureCategory: undefined,
        noveltyPreviewRequestId: request._id,
        noveltyEvaluatedAt: now,
      });
    }
    return {
      state: "ready",
      score: args.score,
      band: args.band,
      nearestThemeLabel: args.nearestThemeLabel,
      reflectionPrompt: args.reflectionPrompt,
      comparedProjectCount: args.comparedTeamCount,
      corpusVersion: corpus.version,
      corpusLabel: corpus.label,
      inputFingerprint: request.inputFingerprint,
    };
  },
});

export const previewStatus = query({
  args: {
    eventSlug: v.string(),
    requestId: v.id("noveltyPreviewRequests"),
  },
  returns: previewResult,
  handler: async (ctx, args): Promise<PreviewResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique();
    const request = await ctx.db.get(args.requestId);
    if (!member || !request || request.eventId !== event._id || request.teamId !== member.teamId) {
      return { state: "unavailable" };
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.project.write",
      scopeType: "team",
      scopeId: member.teamId,
    });
    if (request.state === "running") return pendingResult(request);
    const corpus = await ctx.db.get(request.corpusVersionId);
    if (
      !corpus
      || corpus.eventId !== event._id
      || (corpus.status !== "published" && corpus.status !== "superseded")
    ) {
      return { state: "unavailable" };
    }
    return readyResult(request, corpus) ?? { state: "unavailable" };
  },
});

export const previewStatusByClientRequest = query({
  args: {
    eventSlug: v.string(),
    clientRequestId: v.string(),
  },
  returns: trackedPreviewResult,
  handler: async (ctx, args): Promise<TrackedPreviewResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique();
    if (!member) return { state: "waiting" };
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.project.write",
      scopeType: "team",
      scopeId: member.teamId,
    });
    const clientRequestId = normalizedText(
      args.clientRequestId,
      "Client request ID",
      8,
      120,
    );
    const request = await ctx.db
      .query("noveltyPreviewRequests")
      .withIndex("by_team_client_request", (index) =>
        index.eq("teamId", member.teamId).eq("clientRequestId", clientRequestId),
      )
      .unique();
    if (!request) return { state: "waiting" };
    if (request.eventId !== event._id) return { state: "unavailable" };
    if (request.state === "running") return pendingResult(request);
    const corpus = await ctx.db.get(request.corpusVersionId);
    if (
      !corpus
      || corpus.eventId !== event._id
      || (corpus.status !== "published" && corpus.status !== "superseded")
    ) {
      return { state: "unavailable" };
    }
    return readyResult(request, corpus) ?? { state: "unavailable" };
  },
});

export const preview = action({
  args: {
    eventSlug: v.string(),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    idea: v.string(),
    clientRequestId: v.string(),
  },
  returns: previewResult,
  handler: async (ctx, args): Promise<PreviewResult> => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user.emailVerified) {
      throw new ConvexError({
        code: "EMAIL_NOT_VERIFIED",
        message: "Google must verify the email address before it can be used.",
      });
    }
    const begun: BeginPreviewResult = await ctx.runMutation(
      internal.novelty.beginPreview,
      { authUserId: user._id, ...args },
    );
    if (begun.kind === "complete") return begun.result;
    const startedAt = Date.now();
    let providerRequestId: string | undefined;
    let providerRemainingRequests: number | undefined;
    let providerRequestReset: string | undefined;
    try {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        return ctx.runMutation(internal.novelty.finishPreview, {
          requestId: begun.requestId,
          inputFingerprint: begun.inputFingerprint,
          state: "unavailable",
          latencyMs: Date.now() - startedAt,
          failureCategory: "provider_not_configured",
        });
      }
      const response = await createOpenAiEmbeddings({
        apiKey,
        model: begun.embeddingModel,
        input: begun.embeddingInputs,
        // OpenAI occasionally leaves a healthy embeddings request waiting for
        // several seconds. A short retry is materially faster than waiting on
        // that tail and still keeps the full preview outside the save path.
        timeoutMs: noveltyPreviewProviderAttemptTimeoutMs,
        maximumAttempts: 2,
        telemetry: {
          traceId: begun.requestId,
          sessionId: begun.teamId,
          distinctId: begun.personId,
          operation: "novelty.preview",
          capture: async (telemetry) => {
            await ctx.scheduler.runAfter(
              0,
              internal.intelligenceActions.captureEmbeddingTelemetry,
              scheduledAiEmbeddingTelemetry(telemetry),
            );
          },
        },
      });
      const embeddings = orderedEmbeddings(response.data, begun.embeddingInputs.length);
      const embedding = embeddings?.[0];
      providerRequestId = response.requestId;
      providerRemainingRequests = response.remainingRequests;
      providerRequestReset = response.requestReset;
      if (!embeddings || !embedding) {
        throw new Error("The embedding provider returned an invalid idea vector set.");
      }
      await ctx.runMutation(internal.novelty.upsertPreviewTeamIdea, {
        requestId: begun.requestId,
        inputFingerprint: begun.inputFingerprint,
        embedding,
      });
      const evaluation = await evaluateNoveltyEmbedding(ctx, {
        eventId: begun.eventId,
        teamId: begun.teamId,
        corpusVersionId: begun.corpusVersionId,
        embedding,
        mode: "embedding",
      });
      if (!evaluation) {
        return ctx.runMutation(internal.novelty.finishPreview, {
          requestId: begun.requestId,
          inputFingerprint: begun.inputFingerprint,
          state: "unavailable",
          ...(providerRequestId ? { providerRequestId } : {}),
          ...(providerRemainingRequests !== undefined ? { providerRemainingRequests } : {}),
          ...(providerRequestReset ? { providerRequestReset } : {}),
          latencyMs: Date.now() - startedAt,
          failureCategory: "corpus_index_empty",
        });
      }
      return ctx.runMutation(internal.novelty.finishPreview, {
        requestId: begun.requestId,
        inputFingerprint: begun.inputFingerprint,
        state: "succeeded",
        score: evaluation.score,
        band: evaluation.band,
        effectiveSimilarTeams: evaluation.effectiveSimilarTeams,
        comparedTeamCount: evaluation.comparedTeamCount,
        nearestSimilarity: evaluation.nearestSimilarity,
        nearestThemeLabel: evaluation.nearestThemeLabel,
        reflectionPrompt: evaluation.reflectionPrompt,
        scoringVersion: evaluation.scoringVersion,
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(providerRemainingRequests !== undefined ? { providerRemainingRequests } : {}),
        ...(providerRequestReset ? { providerRequestReset } : {}),
        ...(evaluation.agent
          ? {
              agentOperationId: evaluation.agent.operationId,
              agentOutputChecksum: evaluation.agent.outputChecksum,
              agentVersion: evaluation.agent.version,
              agentModel: evaluation.agent.model,
            }
          : {}),
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      const embeddingStatus = error instanceof OpenAiEmbeddingError ? error.status : undefined;
      const failureCategory = embeddingStatus === 429
        ? "provider_rate_limited"
        : embeddingStatus
          ? `provider_http_${embeddingStatus}`
          : error instanceof OpenAiEmbeddingError && error.timedOut
            ? "provider_timed_out"
            : "provider_request_failed";
      return ctx.runMutation(internal.novelty.finishPreview, {
        requestId: begun.requestId,
        inputFingerprint: begun.inputFingerprint,
        state: "failed",
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(providerRemainingRequests !== undefined ? { providerRemainingRequests } : {}),
        ...(providerRequestReset ? { providerRequestReset } : {}),
        latencyMs: Date.now() - startedAt,
        failureCategory,
      });
    }
  },
});
