import OpenAI from "openai";
import { ConvexError, v, type Infer } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { authComponent } from "./auth";
import { requireEventBySlug } from "./lib/events";
import { requireEventSubject, requireMembership } from "./lib/identity";
import { localProviderFixturesEnabled } from "./lib/localBrowserFixtures";
import {
  localNoveltyEmbedding,
  normalizeNoveltyIdea,
  noveltyBandForScore,
  noveltyEmbeddingDimensions,
  noveltyInputFingerprint,
  noveltyScoreForSimilarity,
  validEmbedding,
} from "./lib/novelty";
import { requirePermission } from "./lib/permissions";
import { requirePinnedIntakePolicy, requirePublishedIntakePolicy } from "./lib/intakePolicy";
import { containsSensitiveProjectText } from "./lib/projectText";
import { normalizedText } from "./lib/strings";

const noveltyBand = v.union(
  v.literal("familiar"),
  v.literal("developing"),
  v.literal("distinct"),
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
const previewResult = v.union(readyPreview, unavailablePreview);
type PreviewResult = Infer<typeof previewResult>;

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

function readyResult(
  request: Doc<"noveltyPreviewRequests">,
  corpus: Doc<"noveltyCorpusVersions">,
): ReadyPreview | null {
  if (
    request.state !== "succeeded" ||
    request.score === undefined ||
    request.band === undefined ||
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
    comparedProjectCount: corpus.entryCount,
    corpusVersion: corpus.version,
    corpusLabel: corpus.label,
    inputFingerprint: request.inputFingerprint,
  };
}

const beginPreviewResult = v.union(
  v.object({ kind: v.literal("complete"), result: previewResult }),
  v.object({
    kind: v.literal("run"),
    requestId: v.id("noveltyPreviewRequests"),
    teamId: v.id("teams"),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    corpusVersion: v.number(),
    corpusLabel: v.string(),
    comparedProjectCount: v.number(),
    inputFingerprint: v.string(),
    normalizedIdea: v.string(),
    embeddingModel: v.literal("text-embedding-3-small"),
    distinctSimilarityBoundary: v.number(),
    commonSimilarityBoundary: v.number(),
  }),
);
type BeginPreviewResult = Infer<typeof beginPreviewResult>;

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
    if (team.membershipLocked) {
      throw new ConvexError({
        code: "SUBMISSION_LOCKED",
        message: "This team has submitted and project intake is locked.",
      });
    }
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    if (draft?.stage === "submitted") {
      throw new ConvexError({ code: "SUBMISSION_LOCKED", message: "Project intake is locked." });
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
    if (containsSensitiveProjectText(normalizedIdea)) {
      return { kind: "complete", result: { state: "unavailable" } };
    }
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
        throw new ConvexError({
          code: "NOVELTY_CHECK_RUNNING",
          message: "That novelty check is still running.",
        });
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
      cached.requestedAt >= now - 30 * 60_000
    ) {
      const result = readyResult(cached, corpus);
      if (result) return { kind: "complete", result };
    }
    const recentRequests = await ctx.db
      .query("noveltyPreviewRequests")
      .withIndex("by_team_requested", (index) =>
        index.eq("teamId", team._id).gte("requestedAt", now - 60_000),
      )
      .collect();
    if (recentRequests.length >= corpus.maximumRequestsPerMinute) {
      throw new ConvexError({
        code: "NOVELTY_RATE_LIMITED",
        message: "Pause for a moment before checking the idea again.",
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
      teamId: team._id,
      corpusVersionId: corpus._id,
      corpusVersion: corpus.version,
      corpusLabel: corpus.label,
      comparedProjectCount: corpus.entryCount,
      inputFingerprint,
      normalizedIdea,
      embeddingModel: corpus.embeddingModel,
      distinctSimilarityBoundary: corpus.distinctSimilarityBoundary,
      commonSimilarityBoundary: corpus.commonSimilarityBoundary,
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
        reflectionPrompt: entry.reflectionPrompt,
      };
    });
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
    nearestSimilarity: v.optional(v.number()),
    nearestThemeLabel: v.optional(v.string()),
    reflectionPrompt: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
    latencyMs: v.number(),
    failureCategory: v.optional(v.string()),
  },
  returns: v.union(readyPreview, unavailablePreview),
  handler: async (ctx, args): Promise<PreviewResult> => {
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
        latencyMs: args.latencyMs,
        ...(args.failureCategory ? { failureCategory: args.failureCategory } : {}),
        completedAt: now,
      });
      return { state: "unavailable" };
    }
    if (
      args.score === undefined ||
      args.band === undefined ||
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
      nearestSimilarity: args.nearestSimilarity,
      nearestThemeLabel: args.nearestThemeLabel,
      reflectionPrompt: args.reflectionPrompt,
      ...(args.providerRequestId ? { providerRequestId: args.providerRequestId } : {}),
      latencyMs: args.latencyMs,
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
      noveltyInputFingerprint(draft.initialIdea) === request.inputFingerprint
    ) {
      await ctx.db.patch(draft._id, {
        noveltyEvaluatedInputFingerprint: request.inputFingerprint,
        noveltyScore: args.score,
        noveltyBand: args.band,
        noveltyNearestThemeLabel: args.nearestThemeLabel,
        noveltyReflectionPrompt: args.reflectionPrompt,
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
      comparedProjectCount: corpus.entryCount,
      corpusVersion: corpus.version,
      corpusLabel: corpus.label,
      inputFingerprint: request.inputFingerprint,
    };
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
    const begun = await ctx.runMutation(internal.novelty.beginPreview, {
      authUserId: user._id,
      ...args,
    });
    if (begun.kind === "complete") return begun.result;
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const useLocalFixture = !apiKey && localProviderFixturesEnabled();
    const startedAt = Date.now();
    if (!apiKey && !useLocalFixture) {
      return ctx.runMutation(internal.novelty.finishPreview, {
        requestId: begun.requestId,
        inputFingerprint: begun.inputFingerprint,
        state: "unavailable",
        latencyMs: Date.now() - startedAt,
        failureCategory: "provider_not_configured",
      });
    }
    const client = apiKey ? new OpenAI({ apiKey, timeout: 8_000, maxRetries: 0 }) : null;
    try {
      const response = client
        ? await client.embeddings.create({
            model: begun.embeddingModel,
            encoding_format: "float",
            input: begun.normalizedIdea,
          })
        : null;
      const embedding = response
        ? response.data[0]?.embedding
        : localNoveltyEmbedding(begun.normalizedIdea);
      if (
        !embedding ||
        (response !== null && response.data.length !== 1) ||
        !validEmbedding(embedding)
      ) {
        throw new Error("The embedding provider returned an invalid idea vector.");
      }
      const matches = await ctx.vectorSearch(
        "noveltyCorpusEntries",
        "by_corpus_embedding",
        {
          vector: embedding,
          limit: 3,
          filter: (filter) => filter.eq("corpusVersionId", begun.corpusVersionId),
        },
      );
      const nearest = matches[0];
      if (!nearest) {
        return ctx.runMutation(internal.novelty.finishPreview, {
          requestId: begun.requestId,
          inputFingerprint: begun.inputFingerprint,
          state: "unavailable",
          ...(response?._request_id ? { providerRequestId: response._request_id } : {}),
          latencyMs: Date.now() - startedAt,
          failureCategory: "corpus_index_empty",
        });
      }
      const metadata = await ctx.runQuery(internal.novelty.readMatchMetadata, {
        corpusVersionId: begun.corpusVersionId,
        entryIds: matches.map((match) => match._id),
      });
      const nearestMetadata = metadata[0];
      if (!nearestMetadata || nearestMetadata.id !== nearest._id) {
        throw new Error("The nearest novelty result has no approved metadata.");
      }
      const score = noveltyScoreForSimilarity(nearest._score, {
        distinctSimilarityBoundary: begun.distinctSimilarityBoundary,
        commonSimilarityBoundary: begun.commonSimilarityBoundary,
      });
      return ctx.runMutation(internal.novelty.finishPreview, {
        requestId: begun.requestId,
        inputFingerprint: begun.inputFingerprint,
        state: "succeeded",
        score,
        band: noveltyBandForScore(score),
        nearestSimilarity: nearest._score,
        nearestThemeLabel: nearestMetadata.themeLabel,
        reflectionPrompt: nearestMetadata.reflectionPrompt,
        ...(response?._request_id ? { providerRequestId: response._request_id } : {}),
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      const status = error instanceof OpenAI.APIError ? error.status : undefined;
      const failureCategory = status === 429
        ? "provider_rate_limited"
        : status
          ? `provider_http_${status}`
          : error instanceof OpenAI.APIConnectionTimeoutError
            ? "provider_timed_out"
            : "provider_request_failed";
      return ctx.runMutation(internal.novelty.finishPreview, {
        requestId: begun.requestId,
        inputFingerprint: begun.inputFingerprint,
        state: "failed",
        latencyMs: Date.now() - startedAt,
        failureCategory,
      });
    }
  },
});
