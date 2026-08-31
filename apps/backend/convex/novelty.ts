import { ConvexError, v, type Infer } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { authComponent } from "./auth";
import { requireEventBySlug } from "./lib/events";
import { requireEventSubject, requireMembership } from "./lib/identity";
import {
  effectiveSimilarTeams,
  normalizeNoveltyIdea,
  noveltyBandForScore,
  noveltyDensitySimilarity,
  noveltyDensitySimilarityPolicy,
  noveltyEmbeddingInputs,
  noveltyEmbeddingDimensions,
  noveltyEmbeddingModel,
  noveltyInputFingerprint,
  noveltyScoreForDensity,
  noveltyDensityMatchLimit,
  strongestNoveltyMatchPerTeam,
  type NoveltyIdeaLifecycle,
  validEmbedding,
} from "./lib/novelty";
import { invalidateTeamNoveltyIndex } from "./lib/noveltyIndex";
import { requirePermission } from "./lib/permissions";
import { requirePinnedIntakePolicy, requirePublishedIntakePolicy } from "./lib/intakePolicy";
import { containsSensitiveProjectText } from "./lib/projectText";
import { normalizedText } from "./lib/strings";
import { createOpenAiEmbeddings, OpenAiEmbeddingError } from "./lib/openAiEmbeddings";

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

const beginPreviewResult = v.union(
  v.object({ kind: v.literal("complete"), result: previewResult }),
  v.object({
    kind: v.literal("run"),
    requestId: v.id("noveltyPreviewRequests"),
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
      cached.requestedAt >= now - noveltyPreviewCacheLifetimeMs
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
      eventId: event._id,
      teamId: team._id,
      corpusVersionId: corpus._id,
      corpusVersion: corpus.version,
      corpusLabel: corpus.label,
      comparedProjectCount: corpus.entryCount,
      inputFingerprint,
      embeddingInputs: noveltyEmbeddingInputs(normalizedIdea),
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

export const upsertPreviewTeamIdea = internalMutation({
  args: {
    requestId: v.id("noveltyPreviewRequests"),
    inputFingerprint: v.string(),
    embedding: v.array(v.float64()),
    segmentEmbeddings: v.optional(v.array(v.array(v.float64()))),
  },
  returns: v.object({ ideaIds: v.array(v.id("noveltyTeamIdeas")) }),
  handler: async (ctx, args) => {
    const embeddings = [args.embedding, ...(args.segmentEmbeddings ?? [])];
    if (embeddings.some((embedding) => !validEmbedding(embedding))) {
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
      embeddings,
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
  },
  returns: v.array(v.object({
    id: v.id("noveltyTeamIdeas"),
    teamId: v.id("teams"),
    lifecycle: noveltyIdeaLifecycle,
    active: v.boolean(),
  })),
  handler: async (ctx, args) => {
    const ideas = await Promise.all(args.ideaIds.map((ideaId) => ctx.db.get(ideaId)));
    const editingCutoff = Date.now() - noveltyEditingIdeaLifetimeMs;
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

const prepareDraftIndexResult = v.union(
  v.object({ kind: v.literal("complete") }),
  v.object({
    kind: v.literal("run"),
    embeddingInputs: v.array(v.string()),
    embeddingModel: v.literal("text-embedding-3-small"),
  }),
);
type PrepareDraftIndexResult = Infer<typeof prepareDraftIndexResult>;

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
    if (containsSensitiveProjectText(draft.initialIdea)) {
      await invalidateTeamNoveltyIndex(ctx, {
        teamId: draft.teamId,
        sourceUpdatedAt: draft.updatedAt,
      });
      return { kind: "complete" };
    }
    const existing = (await ctx.db
      .query("noveltyTeamIdeas")
      .withIndex("by_team", (index) => index.eq("teamId", draft.teamId))
      .collect()).filter((idea) => idea.lifecycle !== "editing");
    const embeddingInputs = noveltyEmbeddingInputs(draft.initialIdea);
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
      return { kind: "complete" };
    }
    if (existing.some((idea) => idea.sourceUpdatedAt > args.sourceUpdatedAt)) {
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
    return {
      kind: "run",
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
    segmentEmbeddings: v.optional(v.array(v.array(v.float64()))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const embeddings = [args.embedding, ...(args.segmentEmbeddings ?? [])];
    if (embeddings.some((embedding) => !validEmbedding(embedding))) {
      throw new Error("A saved team idea requires a valid embedding.");
    }
    const draft = await ctx.db.get(args.draftId);
    if (
      !draft?.initialIdea
      || noveltyInputFingerprint(draft.initialIdea) !== args.inputFingerprint
    ) {
      return null;
    }
    if (embeddings.length !== noveltyEmbeddingInputs(draft.initialIdea).length) {
      throw new Error("A saved team idea has an incomplete embedding set.");
    }
    await storeTeamIdeaEmbeddings(ctx, {
      eventId: draft.eventId,
      teamId: draft.teamId,
      inputFingerprint: args.inputFingerprint,
      lifecycle: indexedLifecycle(draft, args.inputFingerprint),
      embeddings,
      sourceUpdatedAt: args.sourceUpdatedAt,
    });
    return null;
  },
});

export const indexDraftIdea = internalAction({
  args: {
    draftId: v.id("projectDrafts"),
    inputFingerprint: v.string(),
    sourceUpdatedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const prepared = await ctx.runMutation(internal.novelty.prepareDraftIndex, args);
    if (prepared.kind === "complete") return null;
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return null;
    try {
      const response = await createOpenAiEmbeddings({
        apiKey,
        model: prepared.embeddingModel,
        input: prepared.embeddingInputs,
        timeoutMs: 12_000,
      });
      const embeddings = orderedEmbeddings(response.data, prepared.embeddingInputs.length);
      const embedding = embeddings?.[0];
      if (!embeddings || !embedding) return null;
      await ctx.runMutation(internal.novelty.finishDraftIndex, {
        ...args,
        embedding,
        segmentEmbeddings: embeddings.slice(1),
      });
    } catch {
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
  returns: prepareDraftIndexResult,
  handler: async (ctx, args): Promise<PrepareDraftIndexResult> => {
    const project = await ctx.db.get(args.projectVersionId);
    if (
      !project
      || noveltyInputFingerprint(project.initialIdea) !== args.inputFingerprint
    ) {
      return { kind: "complete" };
    }
    const team = await ctx.db.get(project.teamId);
    if (!team || team.lockedProjectVersionId !== project._id) return { kind: "complete" };
    if (containsSensitiveProjectText(project.initialIdea)) {
      await invalidateTeamNoveltyIndex(ctx, {
        teamId: project.teamId,
        sourceUpdatedAt: project.submittedAt,
      });
      return { kind: "complete" };
    }
    const existing = (await ctx.db
      .query("noveltyTeamIdeas")
      .withIndex("by_team", (index) => index.eq("teamId", project.teamId))
      .collect()).filter((idea) => idea.lifecycle !== "editing");
    const embeddingInputs = noveltyEmbeddingInputs(project.initialIdea);
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
    segmentEmbeddings: v.optional(v.array(v.array(v.float64()))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const embeddings = [args.embedding, ...(args.segmentEmbeddings ?? [])];
    if (embeddings.some((embedding) => !validEmbedding(embedding))) {
      throw new Error("A submitted team idea requires a valid embedding.");
    }
    const project = await ctx.db.get(args.projectVersionId);
    if (!project || noveltyInputFingerprint(project.initialIdea) !== args.inputFingerprint) {
      return null;
    }
    const team = await ctx.db.get(project.teamId);
    if (!team || team.lockedProjectVersionId !== project._id) return null;
    if (embeddings.length !== noveltyEmbeddingInputs(project.initialIdea).length) {
      throw new Error("A submitted team idea has an incomplete embedding set.");
    }
    await storeTeamIdeaEmbeddings(ctx, {
      eventId: project.eventId,
      teamId: project.teamId,
      inputFingerprint: args.inputFingerprint,
      lifecycle: "submitted",
      embeddings,
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const prepared = await ctx.runMutation(
      internal.novelty.prepareSubmittedProjectIndex,
      args,
    );
    if (prepared.kind === "complete") return null;
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return null;
    try {
      const response = await createOpenAiEmbeddings({
        apiKey,
        model: prepared.embeddingModel,
        input: prepared.embeddingInputs,
        timeoutMs: 12_000,
      });
      const embeddings = orderedEmbeddings(response.data, prepared.embeddingInputs.length);
      const embedding = embeddings?.[0];
      if (!embeddings || !embedding) return null;
      await ctx.runMutation(internal.novelty.finishSubmittedProjectIndex, {
        ...args,
        embedding,
        segmentEmbeddings: embeddings.slice(1),
      });
    } catch {
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
      comparedProjectCount: args.comparedTeamCount,
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
    const startedAt = Date.now();
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
        timeoutMs: 6_000,
        maximumAttempts: 2,
      });
      const embeddings = orderedEmbeddings(response.data, begun.embeddingInputs.length);
      const embedding = embeddings?.[0];
      const providerRequestId = response.requestId;
      if (!embeddings || !embedding) {
        throw new Error("The embedding provider returned an invalid idea vector set.");
      }
      await ctx.runMutation(internal.novelty.upsertPreviewTeamIdea, {
        requestId: begun.requestId,
        inputFingerprint: begun.inputFingerprint,
        embedding,
        segmentEmbeddings: embeddings.slice(1),
      });
      const searchBatches = await Promise.all(embeddings.map(async (segmentEmbedding) => {
        const [corpusMatches, teamMatches] = await Promise.all([
          ctx.vectorSearch(
            "noveltyCorpusEntries",
            "by_corpus_embedding",
            {
              vector: segmentEmbedding,
              limit: noveltyDensityMatchLimit,
              filter: (filter) => filter.eq("corpusVersionId", begun.corpusVersionId),
            },
          ),
          ctx.vectorSearch(
            "noveltyTeamIdeas",
            "by_event_embedding",
            {
              vector: segmentEmbedding,
              limit: noveltyTeamVectorMatchLimit,
              filter: (filter) => filter.eq("eventId", begun.eventId),
            },
          ),
        ]);
        return { corpusMatches, teamMatches };
      }));
      const corpusSimilarityById = new Map<Id<"noveltyCorpusEntries">, number>();
      const teamSimilarityById = new Map<Id<"noveltyTeamIdeas">, number>();
      for (const batch of searchBatches) {
        for (const match of batch.corpusMatches) {
          const current = corpusSimilarityById.get(match._id);
          if (current === undefined || match._score > current) {
            corpusSimilarityById.set(match._id, match._score);
          }
        }
        for (const match of batch.teamMatches) {
          const current = teamSimilarityById.get(match._id);
          if (current === undefined || match._score > current) {
            teamSimilarityById.set(match._id, match._score);
          }
        }
      }
      const corpusMatches = [...corpusSimilarityById]
        .map(([id, score]) => ({ _id: id, _score: score }))
        .toSorted((left, right) => right._score - left._score)
        .slice(0, noveltyDensityMatchLimit);
      const teamMatches = [...teamSimilarityById]
        .map(([id, score]) => ({ _id: id, _score: score }))
        .toSorted((left, right) => right._score - left._score)
        .slice(0, noveltyTeamVectorMatchLimit);
      const nearest = corpusMatches[0];
      if (!nearest) {
        return ctx.runMutation(internal.novelty.finishPreview, {
          requestId: begun.requestId,
          inputFingerprint: begun.inputFingerprint,
          state: "unavailable",
          ...(providerRequestId ? { providerRequestId } : {}),
          latencyMs: Date.now() - startedAt,
          failureCategory: "corpus_index_empty",
        });
      }
      const metadata = await ctx.runQuery(internal.novelty.readMatchMetadata, {
        corpusVersionId: begun.corpusVersionId,
        entryIds: [nearest._id],
      });
      const nearestMetadata = metadata[0];
      if (!nearestMetadata || nearestMetadata.id !== nearest._id) {
        throw new Error("The nearest novelty result has no approved metadata.");
      }
      const teamMetadata = await ctx.runQuery(internal.novelty.readTeamIdeaMetadata, {
        eventId: begun.eventId,
        ideaIds: teamMatches.map((match) => match._id),
      });
      const teamDensityCandidates: Array<{
        teamId: Id<"teams">;
        similarity: number;
        lifecycle: NoveltyIdeaLifecycle;
      }> = [];
      for (const idea of teamMetadata) {
        if (idea.teamId === begun.teamId || !idea.active) continue;
        const rawSimilarity = teamSimilarityById.get(idea.id);
        if (rawSimilarity === undefined) {
          throw new Error("Team novelty metadata has no vector similarity.");
        }
        const similarity = noveltyDensitySimilarity(rawSimilarity);
        teamDensityCandidates.push({
          teamId: idea.teamId,
          similarity,
          lifecycle: idea.lifecycle,
        });
      }
      const teamDensityById = strongestNoveltyMatchPerTeam(teamDensityCandidates);
      const teamDensityMatches = [...teamDensityById.values()];
      const corpusDensityMatches = corpusMatches.map((match) => ({
        similarity: noveltyDensitySimilarity(match._score),
        lifecycle: "submitted" as const,
      }));
      const densityMatches = [...corpusDensityMatches, ...teamDensityMatches]
        .toSorted((left, right) => right.similarity - left.similarity)
        .slice(0, noveltyDensityMatchLimit);
      const density = effectiveSimilarTeams(
        densityMatches,
        noveltyDensitySimilarityPolicy,
      );
      const score = noveltyScoreForDensity(density);
      return ctx.runMutation(internal.novelty.finishPreview, {
        requestId: begun.requestId,
        inputFingerprint: begun.inputFingerprint,
        state: "succeeded",
        score,
        band: noveltyBandForScore(score),
        effectiveSimilarTeams: density,
        comparedTeamCount: densityMatches.length,
        nearestSimilarity: nearest._score,
        nearestThemeLabel: nearestMetadata.themeLabel,
        reflectionPrompt: nearestMetadata.reflectionPrompt,
        ...(providerRequestId ? { providerRequestId } : {}),
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      const status = error instanceof OpenAiEmbeddingError ? error.status : undefined;
      const failureCategory = status === 429
        ? "provider_rate_limited"
        : status
          ? `provider_http_${status}`
          : error instanceof OpenAiEmbeddingError && error.timedOut
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
