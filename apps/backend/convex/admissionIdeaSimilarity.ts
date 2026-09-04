import {
  operationsIntelligenceProtocolVersion,
  type IdeaIntelligenceHistoricalSimilarityMatch,
  type IdeaIntelligenceSimilarityBand,
  type IdeaIntelligenceSimilarityMatch,
  type IdeaIntelligenceSimilarityRequest,
  type IdeaIntelligenceSimilarityResult,
} from "@code2create/domain";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  noveltyEmbeddingDimensions,
  noveltyEmbeddingModel,
  activeAdmissionIdeaComparisonScope,
  noveltyInputFingerprint,
  validEmbedding,
} from "./lib/novelty";
import {
  isActiveAdmissionIdeaState,
  synchronizeTeamAdmissionIdeaComparison,
} from "./lib/noveltyIndex";
import { createOpenAiEmbeddings } from "./lib/openAiEmbeddings";
import { scheduledAiEmbeddingTelemetry } from "./lib/posthog";
import { redactProjectText } from "./lib/projectText";

const historicalVectorLimit = 16;
const currentSubmissionVectorLimit = 256;
const currentSubmissionScopeBatchSize = 64;
const maximumMatchesPerCollection = 6;
const minimumMeaningfulSimilarity = 0.54;
const maximumComparisonSummaryCharacters = 800;
const projectUrlPattern = /\b(?:https?:\/\/|www\.)\S+/giu;
const projectSecretPattern = /\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/gu;

const historicalMetadata = v.object({
  id: v.id("noveltyCorpusEntries"),
  themeLabel: v.string(),
  sourceYear: v.number(),
  summary: v.string(),
});

const currentSubmissionMetadata = v.object({
  id: v.id("noveltyTeamIdeas"),
  summary: v.string(),
});

function redactedComparisonText(value: string) {
  return redactProjectText(value.replace(projectSecretPattern, "[secret removed]"))
    .replace(projectUrlPattern, "[link removed]")
    .replace(/\](?=[\p{L}\p{N}])/gu, "] ")
    .trim();
}

export function comparisonSummary(value: string) {
  const redacted = redactedComparisonText(value);
  return redacted.length <= maximumComparisonSummaryCharacters
    ? redacted
    : `${redacted.slice(0, maximumComparisonSummaryCharacters - 1).trimEnd()}…`;
}

export function similarityBand(value: number): IdeaIntelligenceSimilarityBand | null {
  if (!Number.isFinite(value) || value < minimumMeaningfulSimilarity) return null;
  if (value >= 0.78) return "very_high";
  if (value >= 0.68) return "high";
  return "moderate";
}

export function exactSourceText(
  projection: {
    initialIdea: string;
    additionalInformation?: string;
    intakeResponses: Array<{ sourceRef: string; question: string; answer: string }>;
  },
  sourceRefs: readonly string[],
) {
  if (sourceRefs.length < 1 || sourceRefs.length > 4 || new Set(sourceRefs).size !== sourceRefs.length) {
    return null;
  }
  const sources = new Map<string, { question?: string; answer: string }>([
    ["initial_idea", { answer: projection.initialIdea }],
    ...(projection.additionalInformation
      ? [["additional_information", { answer: projection.additionalInformation }] as const]
      : []),
    ...projection.intakeResponses.map(
      (response) => [
        response.sourceRef,
        { question: response.question, answer: response.answer },
      ] as const,
    ),
  ]);
  const selected = sourceRefs.map((sourceRef) => sources.get(sourceRef));
  if (selected.some((source) => source === undefined)) return null;
  return selected
    .map((source) => {
      if (!source) throw new Error("A validated comparison source disappeared.");
      return source.answer;
    })
    .join("\n\n");
}

export const readSimilarityConfiguration = internalQuery({
  args: { eventId: v.id("events") },
  returns: v.union(
    v.null(),
    v.object({
      corpusVersionId: v.id("noveltyCorpusVersions"),
      historicalProjectCount: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event?.publishedNoveltyCorpusVersionId) return null;
    const corpus = await ctx.db.get(event.publishedNoveltyCorpusVersionId);
    if (
      !corpus ||
      corpus.eventId !== event._id ||
      corpus.status !== "published" ||
      corpus.importState !== "ready" ||
      corpus.embeddingModel !== noveltyEmbeddingModel ||
      corpus.embeddingDimensions !== noveltyEmbeddingDimensions
    ) {
      return null;
    }
    return {
      corpusVersionId: corpus._id,
      historicalProjectCount: corpus.entryCount,
    };
  },
});

export const readActiveComparisonScopes = internalQuery({
  args: {
    eventId: v.id("events"),
    excludedTeamId: v.id("teams"),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const applications = (
      await Promise.all(
        (["submitted", "under_review"] as const).map((state) =>
          ctx.db
            .query("applications")
            .withIndex("by_event_state_submitted", (index) =>
              index.eq("eventId", args.eventId).eq("state", state),
            )
            .collect(),
        ),
      )
    ).flat();
    const teamIds: Id<"teams">[] = [];
    const seen = new Set<Id<"teams">>();
    for (const application of applications) {
      if (application.teamId === args.excludedTeamId || seen.has(application.teamId)) continue;
      seen.add(application.teamId);
      teamIds.push(application.teamId);
    }
    return teamIds.map((teamId) => activeAdmissionIdeaComparisonScope(args.eventId, teamId));
  },
});

export const readHistoricalMatchMetadata = internalQuery({
  args: {
    eventId: v.id("events"),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    entryIds: v.array(v.id("noveltyCorpusEntries")),
  },
  returns: v.array(historicalMetadata),
  handler: async (ctx, args) => {
    const entries = await Promise.all(args.entryIds.map((entryId) => ctx.db.get(entryId)));
    return entries.map((entry, index) => {
      if (
        !entry ||
        entry.eventId !== args.eventId ||
        entry.corpusVersionId !== args.corpusVersionId
      ) {
        throw new Error(`Historical comparison ${index + 1} is outside the authorized corpus.`);
      }
      return {
        id: entry._id,
        themeLabel: entry.themeLabel,
        sourceYear: entry.sourceYear,
        summary: comparisonSummary(entry.summary),
      };
    });
  },
});

async function submittedProjectForIdea(
  ctx: QueryCtx,
  eventId: Id<"events">,
  idea: Doc<"noveltyTeamIdeas">,
) {
  if (idea.lifecycle !== "submitted") return null;
  const application = await ctx.db
    .query("applications")
    .withIndex("by_team", (index) => index.eq("teamId", idea.teamId))
    .unique();
  if (
    !application ||
    application.eventId !== eventId ||
    !isActiveAdmissionIdeaState(application.state)
  ) {
    return null;
  }
  const project = await ctx.db.get(application.submittedProjectVersionId);
  if (
    !project ||
    project.eventId !== eventId ||
    project.teamId !== idea.teamId ||
    noveltyInputFingerprint(project.initialIdea) !== idea.inputFingerprint
  ) {
    return null;
  }
  return project;
}

export const readCurrentSubmissionMatchMetadata = internalQuery({
  args: {
    eventId: v.id("events"),
    excludedTeamId: v.id("teams"),
    ideaIds: v.array(v.id("noveltyTeamIdeas")),
  },
  returns: v.array(currentSubmissionMetadata),
  handler: async (ctx, args) => {
    const ideas = await Promise.all(args.ideaIds.map((ideaId) => ctx.db.get(ideaId)));
    const matches: Array<{ id: Id<"noveltyTeamIdeas">; summary: string }> = [];
    for (const [index, idea] of ideas.entries()) {
      // Vector search and hydration are separate transactions. A candidate can
      // legitimately disappear or leave the active scope between them.
      if (!idea) continue;
      if (idea.eventId !== args.eventId) {
        throw new Error(`Current-event comparison ${index + 1} is outside the authorized event.`);
      }
      if (
        idea.comparisonScope !==
        activeAdmissionIdeaComparisonScope(args.eventId, idea.teamId)
      ) {
        continue;
      }
      if (idea.teamId === args.excludedTeamId) continue;
      const project = await submittedProjectForIdea(ctx, args.eventId, idea);
      if (!project) continue;
      matches.push({ id: idea._id, summary: comparisonSummary(project.initialIdea) });
    }
    return matches;
  },
});

export const reconcileLegacyComparisonScopes = internalMutation({
  args: { eventId: v.id("events") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const unscopedIdeas = await ctx.db
      .query("noveltyTeamIdeas")
      .withIndex("by_event_comparison_scope", (index) =>
        index.eq("eventId", args.eventId).eq("comparisonScope", undefined),
      )
      .take(64);
    const legacySubmittedIdeas = await ctx.db
      .query("noveltyTeamIdeas")
      .withIndex("by_event_comparison_scope", (index) =>
        index.eq("eventId", args.eventId).eq("comparisonScope", `${args.eventId}:submitted`),
      )
      .take(64);
    const legacyActiveIdeas = await ctx.db
      .query("noveltyTeamIdeas")
      .withIndex("by_event_comparison_scope", (index) =>
        index
          .eq("eventId", args.eventId)
          .eq("comparisonScope", `${args.eventId}:active-admission`),
      )
      .take(64);
    const ideas = [...unscopedIdeas, ...legacySubmittedIdeas, ...legacyActiveIdeas];
    const teamIds = new Set(ideas.map((idea) => idea.teamId));
    for (const teamId of teamIds) {
      await synchronizeTeamAdmissionIdeaComparison(ctx, {
        eventId: args.eventId,
        teamId,
      });
    }
    return ideas.length;
  },
});

function orderedHistoricalMatches(
  vectorMatches: readonly { _id: Id<"noveltyCorpusEntries">; _score: number }[],
  metadata: readonly {
    id: Id<"noveltyCorpusEntries">;
    themeLabel: string;
    sourceYear: number;
    summary: string;
  }[],
) {
  const metadataById = new Map(metadata.map((entry) => [entry.id, entry] as const));
  const matches: IdeaIntelligenceHistoricalSimilarityMatch[] = [];
  for (const vectorMatch of vectorMatches) {
    const entry = metadataById.get(vectorMatch._id);
    const similarity = similarityBand(vectorMatch._score);
    if (!entry || !similarity) continue;
    matches.push({
      comparisonRef: `past_project_${matches.length + 1}`,
      similarity,
      themeLabel: entry.themeLabel,
      sourceYear: entry.sourceYear,
      summary: entry.summary,
    });
    if (matches.length === maximumMatchesPerCollection) break;
  }
  return matches;
}

function orderedCurrentSubmissionMatches(
  vectorMatches: readonly { _id: Id<"noveltyTeamIdeas">; _score: number }[],
  metadata: readonly { id: Id<"noveltyTeamIdeas">; summary: string }[],
) {
  const metadataById = new Map(metadata.map((entry) => [entry.id, entry] as const));
  const matches: IdeaIntelligenceSimilarityMatch[] = [];
  for (const vectorMatch of vectorMatches) {
    const entry = metadataById.get(vectorMatch._id);
    const similarity = similarityBand(vectorMatch._score);
    if (!entry || !similarity) continue;
    matches.push({
      comparisonRef: `current_submission_${matches.length + 1}`,
      similarity,
      summary: entry.summary,
    });
    if (matches.length === maximumMatchesPerCollection) break;
  }
  return matches;
}

function batchesOf<T>(values: readonly T[], size: number) {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

export async function searchSimilarIdeas(
  ctx: ActionCtx,
  args: { request: IdeaIntelligenceSimilarityRequest; apiKey: string },
): Promise<IdeaIntelligenceSimilarityResult | null | "invalid_sources"> {
  const identity = await ctx.runQuery(internal.admissionAgentActions.prepareProjectionIdentity, {
    recommendationId: args.request.recommendationId,
  });
  if (
    !identity ||
    identity.applicationId !== args.request.applicationId ||
    identity.eventId !== args.request.eventId ||
    identity.contentVersion !== args.request.contentVersion
  ) {
    return null;
  }
  const projection = await ctx.runMutation(internal.admissionIntelligence.beginRecommendation, {
    recommendationId: identity.recommendationId,
  });
  if (
    !projection ||
    projection.applicationId !== args.request.applicationId ||
    projection.eventId !== args.request.eventId ||
    projection.contentVersion !== args.request.contentVersion ||
    projection.sourceInputFingerprint !== args.request.sourceInputFingerprint
  ) {
    return null;
  }
  const sourceText = exactSourceText(projection, args.request.sourceRefs);
  if (!sourceText) return "invalid_sources";
  const embeddingResponse = await createOpenAiEmbeddings({
    apiKey: args.apiKey,
    model: noveltyEmbeddingModel,
    input: redactedComparisonText(sourceText),
    timeoutMs: 12_000,
    maximumAttempts: 2,
    telemetry: {
      traceId: args.request.operationId,
      sessionId: args.request.recommendationId,
      operation: "admissions.similar_ideas",
      capture: async (telemetry) => {
        await ctx.scheduler.runAfter(
          0,
          internal.intelligenceActions.captureEmbeddingTelemetry,
          scheduledAiEmbeddingTelemetry(telemetry),
        );
      },
    },
  });
  const embedding = embeddingResponse.data[0]?.embedding;
  if (!embedding || !validEmbedding(embedding)) {
    throw new Error("The similarity embedding response was invalid.");
  }
  const [configuration, currentSubmissionScopes] = await Promise.all([
    ctx.runQuery(internal.admissionIdeaSimilarity.readSimilarityConfiguration, {
      eventId: projection.eventId,
    }),
    ctx.runQuery(internal.admissionIdeaSimilarity.readActiveComparisonScopes, {
      eventId: projection.eventId,
      excludedTeamId: projection.teamId,
    }),
  ]);
  while (
    (await ctx.runMutation(
      internal.admissionIdeaSimilarity.reconcileLegacyComparisonScopes,
      { eventId: projection.eventId },
    )) > 0
  ) {
    // Vector search is fully consistent, so each bounded reconciliation batch
    // becomes eligible for this same comparison request immediately.
  }
  const comparisonScopeBatches = batchesOf(
    currentSubmissionScopes,
    currentSubmissionScopeBatchSize,
  );
  const [historicalVectorMatches, currentVectorMatchPages] = await Promise.all([
    configuration
      ? ctx.vectorSearch("noveltyCorpusEntries", "by_corpus_embedding", {
          vector: embedding,
          limit: historicalVectorLimit,
          filter: (filter) => filter.eq("corpusVersionId", configuration.corpusVersionId),
        })
      : Promise.resolve([]),
    Promise.all(
      comparisonScopeBatches.map((comparisonScopes) =>
        ctx.vectorSearch("noveltyTeamIdeas", "by_event_embedding", {
          vector: embedding,
          limit: currentSubmissionVectorLimit,
          filter: (filter) =>
            filter.or(
              ...comparisonScopes.map((comparisonScope) =>
                filter.eq("comparisonScope", comparisonScope),
              ),
            ),
        }),
      ),
    ),
  ]);
  const [historicalMetadataRows, currentMetadataPages] = await Promise.all([
    configuration
      ? ctx.runQuery(internal.admissionIdeaSimilarity.readHistoricalMatchMetadata, {
          eventId: projection.eventId,
          corpusVersionId: configuration.corpusVersionId,
          entryIds: historicalVectorMatches.map((match) => match._id),
        })
      : Promise.resolve([]),
    Promise.all(
      currentVectorMatchPages.map((matches) =>
        ctx.runQuery(internal.admissionIdeaSimilarity.readCurrentSubmissionMatchMetadata, {
          eventId: projection.eventId,
          excludedTeamId: projection.teamId,
          ideaIds: matches.map((match) => match._id),
        }),
      ),
    ),
  ]);
  const currentVectorMatches = currentVectorMatchPages
    .flat()
    .toSorted(
      (left, right) =>
        right._score - left._score || String(left._id).localeCompare(String(right._id)),
    );
  const currentMetadataRows = currentMetadataPages.flat();
  return {
    protocolVersion: operationsIntelligenceProtocolVersion,
    recommendationId: projection.recommendationId,
    applicationId: projection.applicationId,
    eventId: projection.eventId,
    contentVersion: projection.contentVersion,
    sourceInputFingerprint: projection.sourceInputFingerprint,
    sourceRefs: args.request.sourceRefs,
    historicalProjectCount: configuration?.historicalProjectCount ?? 0,
    historicalMatches: orderedHistoricalMatches(historicalVectorMatches, historicalMetadataRows),
    currentSubmissionMatches: orderedCurrentSubmissionMatches(
      currentVectorMatches,
      currentMetadataRows,
    ),
  };
}
