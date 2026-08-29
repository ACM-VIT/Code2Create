import {
  operationsIntelligenceProtocolVersion,
  type OperationsEpisodeProjection,
} from "@code2create/domain";
import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { operationFingerprint } from "./lib/operations";
import {
  operationsEpisodeExpectedState,
  operationsEpisodeHypothesisStance,
} from "./lib/operationsEpisodeValidators";
import {
  operationsHealthSeverity,
} from "./lib/operationsIntelligenceValidators";
import { requirePermission } from "./lib/permissions";

const hypothesisInput = v.object({
  stance: operationsEpisodeHypothesisStance,
  statement: v.string(),
  confidence: v.number(),
  evidenceFactKeys: v.array(v.string()),
});

const predictionInput = v.object({
  statement: v.string(),
  expectedState: operationsEpisodeExpectedState,
  probability: v.number(),
  horizonAt: v.number(),
  evidenceFactKeys: v.array(v.string()),
});

const counterfactualInput = v.object({
  intervention: v.string(),
  expectedState: operationsEpisodeExpectedState,
  probability: v.number(),
  rationale: v.string(),
  evidenceFactKeys: v.array(v.string()),
});

const episodeListItem = v.object({
  episodeId: v.id("operationsIntelligenceEpisodes"),
  correlationKey: v.string(),
  state: v.union(
    v.literal("forming"),
    v.literal("active"),
    v.literal("escalating"),
    v.literal("recovering"),
  ),
  severity: operationsHealthSeverity,
  title: v.string(),
  summary: v.string(),
  owner: v.string(),
  nextAction: v.string(),
  firstObservedAt: v.number(),
  lastObservedAt: v.number(),
  signalCount: v.number(),
  factCount: v.number(),
  relevanceScore: v.number(),
  confidence: v.number(),
  revision: v.number(),
  analysisStatus: v.string(),
  analysisSummary: v.optional(v.string()),
  suggestedAction: v.optional(v.string()),
  hypotheses: v.array(v.object({
    stance: operationsEpisodeHypothesisStance,
    statement: v.string(),
    confidence: v.number(),
  })),
  predictions: v.array(v.object({
    statement: v.string(),
    expectedState: operationsEpisodeExpectedState,
    probability: v.number(),
    horizonAt: v.number(),
    outcome: v.string(),
  })),
  counterfactuals: v.array(v.object({
    intervention: v.string(),
    expectedState: operationsEpisodeExpectedState,
    probability: v.number(),
    rationale: v.string(),
  })),
});

const calibrationResult = v.object({
  resolvedCount: v.number(),
  confirmedCount: v.number(),
  meanBrierScore: v.union(v.null(), v.number()),
});

function boundedModelText(value: string, label: string, minimum: number, maximum: number) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ConvexError({
      code: "EPISODE_ANALYSIS_INVALID",
      message: `${label} must be between ${minimum} and ${maximum} characters.`,
    });
  }
  return normalized;
}

function boundedProbability(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ConvexError({
      code: "EPISODE_ANALYSIS_INVALID",
      message: `${label} must be between zero and one.`,
    });
  }
  return value;
}

export const relevant = query({
  args: { eventSlug: v.string(), limit: v.optional(v.number()) },
  returns: v.array(episodeListItem),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "operations.intelligence.read",
      scopeType: "event",
    });
    const requested = args.limit ?? 12;
    const limit = Number.isSafeInteger(requested) ? Math.min(20, Math.max(1, requested)) : 12;
    const episodes = await ctx.db
      .query("operationsIntelligenceEpisodes")
      .withIndex("by_event_lifecycle_relevance", (index) =>
        index.eq("eventId", event._id).eq("lifecycle", "active"),
      )
      .order("desc")
      .take(limit);
    return Promise.all(episodes.map(async (episode) => {
      const [hypotheses, predictions, counterfactuals] = await Promise.all([
        ctx.db
          .query("operationsIntelligenceHypotheses")
          .withIndex("by_episode_revision_ordinal", (index) =>
            index.eq("episodeId", episode._id).eq("analysisRevision", episode.revision),
          )
          .take(3),
        ctx.db
          .query("operationsIntelligencePredictions")
          .withIndex("by_episode_revision_ordinal", (index) =>
            index.eq("episodeId", episode._id).eq("analysisRevision", episode.revision),
          )
          .take(3),
        ctx.db
          .query("operationsIntelligenceCounterfactuals")
          .withIndex("by_episode_revision_ordinal", (index) =>
            index.eq("episodeId", episode._id).eq("analysisRevision", episode.revision),
          )
          .take(3),
      ]);
      return {
        episodeId: episode._id,
        correlationKey: episode.correlationKey,
        state: episode.state as "forming" | "active" | "escalating" | "recovering",
        severity: episode.severity,
        title: episode.title,
        summary: episode.summary,
        owner: episode.owner,
        nextAction: episode.nextAction,
        firstObservedAt: episode.firstObservedAt,
        lastObservedAt: episode.lastObservedAt,
        signalCount: episode.signalCount,
        factCount: episode.factCount,
        relevanceScore: episode.relevanceScore,
        confidence: episode.confidence,
        revision: episode.revision,
        analysisStatus: episode.analysisState.kind,
        ...(episode.analysisSummary ? { analysisSummary: episode.analysisSummary } : {}),
        ...(episode.suggestedAction ? { suggestedAction: episode.suggestedAction } : {}),
        hypotheses: hypotheses.map((hypothesis) => ({
          stance: hypothesis.stance,
          statement: hypothesis.statement,
          confidence: hypothesis.confidence,
        })),
        predictions: predictions.map((prediction) => ({
          statement: prediction.statement,
          expectedState: prediction.expectedState,
          probability: prediction.probability,
          horizonAt: prediction.horizonAt,
          outcome: prediction.outcome.kind,
        })),
        counterfactuals: counterfactuals.map((counterfactual) => ({
          intervention: counterfactual.intervention,
          expectedState: counterfactual.expectedState,
          probability: counterfactual.probability,
          rationale: counterfactual.rationale,
        })),
      };
    }));
  },
});

export const calibration = query({
  args: { eventSlug: v.string() },
  returns: calibrationResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "operations.intelligence.read",
      scopeType: "event",
    });
    const [confirmed, disconfirmed] = await Promise.all([
      ctx.db
        .query("operationsIntelligencePredictions")
        .withIndex("by_event_outcome_kind_horizon_at", (index) =>
          index.eq("eventId", event._id).eq("outcome.kind", "confirmed"),
        )
        .order("desc")
        .take(50),
      ctx.db
        .query("operationsIntelligencePredictions")
        .withIndex("by_event_outcome_kind_horizon_at", (index) =>
          index.eq("eventId", event._id).eq("outcome.kind", "disconfirmed"),
        )
        .order("desc")
        .take(50),
    ]);
    const resolved = [...confirmed, ...disconfirmed];
    const brierScores = resolved.flatMap((prediction) =>
      prediction.outcome.kind === "confirmed" || prediction.outcome.kind === "disconfirmed"
        ? [prediction.outcome.brierScore]
        : [],
    );
    return {
      resolvedCount: resolved.length,
      confirmedCount: confirmed.length,
      meanBrierScore: brierScores.length === 0
        ? null
        : brierScores.reduce((sum, score) => sum + score, 0) / brierScores.length,
    };
  },
});

export const serviceProjection = internalQuery({
  args: { episodeId: v.string(), operationId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    if (args.operationId.length < 8 || args.operationId.length > 240) return null;
    const episodeId = ctx.db.normalizeId("operationsIntelligenceEpisodes", args.episodeId);
    if (!episodeId) return null;
    const episode = await ctx.db.get(episodeId);
    if (!episode || episode.lifecycle !== "active") return null;
    const event = await ctx.db.get(episode.eventId);
    if (!event || event.status !== "live") return null;
    const links = await ctx.db
      .query("operationsIntelligenceEpisodeFacts")
      .withIndex("by_episode_linked_at", (index) => index.eq("episodeId", episode._id))
      .order("desc")
      .take(64);
    const facts: Doc<"operationsIntelligenceFacts">[] = [];
    const seen = new Set<string>();
    for (const link of links) {
      const fact = await ctx.db.get(link.factId);
      if (!fact || seen.has(fact.signalKey)) continue;
      seen.add(fact.signalKey);
      facts.push(fact);
      if (facts.length === 16) break;
    }
    const projection: OperationsEpisodeProjection = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      episodeId: episode._id,
      eventId: episode.eventId,
      revision: episode.revision,
      correlationKey: episode.correlationKey,
      state: episode.state as "forming" | "active" | "escalating" | "recovering",
      severity: episode.severity,
      title: episode.title,
      summary: episode.summary,
      owner: episode.owner,
      nextAction: episode.nextAction,
      firstObservedAt: episode.firstObservedAt,
      lastObservedAt: episode.lastObservedAt,
      relevanceScore: episode.relevanceScore,
      confidence: episode.confidence,
      facts: facts.map((fact) => ({
        factKey: fact.factKey,
        signalKey: fact.signalKey,
        area: fact.area,
        severity: fact.severity,
        title: fact.title,
        detail: fact.detail,
        count: fact.count,
        atLeast: fact.atLeast,
        observedAt: fact.observedAt,
      })),
    };
    return JSON.stringify(projection);
  },
});

export const prepareDispatch = internalMutation({
  args: { episodeId: v.id("operationsIntelligenceEpisodes"), now: v.number() },
  returns: v.union(v.null(), v.object({
    episodeId: v.id("operationsIntelligenceEpisodes"),
    eventId: v.id("events"),
    revision: v.number(),
    attemptId: v.string(),
  })),
  handler: async (ctx, args) => {
    const episode = await ctx.db.get(args.episodeId);
    if (!episode || episode.lifecycle !== "active") return null;
    if (episode.analysisState.kind !== "pending" && episode.analysisState.kind !== "failed") {
      return null;
    }
    const attemptId = crypto.randomUUID();
    await ctx.db.patch(episode._id, {
      analysisState: {
        kind: "dispatching",
        revision: episode.revision,
        attemptId,
        startedAt: args.now,
      },
      updatedAt: args.now,
    });
    return {
      episodeId: episode._id,
      eventId: episode.eventId,
      revision: episode.revision,
      attemptId,
    };
  },
});

export const recordDispatchReceipt = internalMutation({
  args: {
    episodeId: v.id("operationsIntelligenceEpisodes"),
    revision: v.number(),
    attemptId: v.string(),
    submissionId: v.string(),
    acceptedAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const episode = await ctx.db.get(args.episodeId);
    if (
      !episode ||
      episode.revision !== args.revision ||
      episode.analysisState.kind !== "dispatching" ||
      episode.analysisState.attemptId !== args.attemptId
    ) return false;
    await ctx.db.patch(episode._id, {
      analysisState: {
        kind: "accepted",
        revision: args.revision,
        submissionId: args.submissionId,
        acceptedAt: args.acceptedAt,
      },
      updatedAt: args.acceptedAt,
    });
    return true;
  },
});

export const recordDispatchFailure = internalMutation({
  args: {
    episodeId: v.id("operationsIntelligenceEpisodes"),
    revision: v.number(),
    attemptId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const episode = await ctx.db.get(args.episodeId);
    if (
      !episode ||
      episode.revision !== args.revision ||
      episode.analysisState.kind !== "dispatching" ||
      episode.analysisState.attemptId !== args.attemptId
    ) return false;
    await ctx.db.patch(episode._id, {
      analysisState: { kind: "failed", revision: args.revision },
      updatedAt: args.now,
    });
    return true;
  },
});

export const recordAnalysis = internalMutation({
  args: {
    episodeId: v.string(),
    revision: v.number(),
    operationId: v.string(),
    summary: v.string(),
    confidence: v.number(),
    suggestedAction: v.string(),
    hypotheses: v.array(hypothesisInput),
    predictions: v.array(predictionInput),
    counterfactuals: v.array(counterfactualInput),
    agentVersion: v.string(),
    model: v.string(),
    completedAt: v.number(),
  },
  returns: v.union(v.literal("accepted"), v.literal("already_exists"), v.literal("stale")),
  handler: async (ctx, args) => {
    const episodeId = ctx.db.normalizeId("operationsIntelligenceEpisodes", args.episodeId);
    if (!episodeId) return "stale";
    const episode = await ctx.db.get(episodeId);
    if (!episode || episode.lifecycle !== "active" || episode.revision !== args.revision) {
      return "stale";
    }
    const checksum = operationFingerprint([
      args.revision,
      args.summary,
      args.confidence,
      args.suggestedAction,
      JSON.stringify(args.hypotheses),
      JSON.stringify(args.predictions),
      JSON.stringify(args.counterfactuals),
      args.agentVersion,
      args.model,
    ]);
    if (episode.analysisOperationId === args.operationId) {
      if (episode.analysisChecksum !== checksum) {
        throw new ConvexError({
          code: "EPISODE_ANALYSIS_CONFLICT",
          message: "The episode analysis operation was reused for different output.",
        });
      }
      return "already_exists";
    }
    if (args.operationId.length < 8 || args.operationId.length > 240) {
      throw new ConvexError({ code: "EPISODE_ANALYSIS_INVALID", message: "The operation ID is invalid." });
    }
    if (
      args.hypotheses.length < 1 ||
      args.hypotheses.length > 3 ||
      args.predictions.length > 3 ||
      args.counterfactuals.length > 3
    ) {
      throw new ConvexError({
        code: "EPISODE_ANALYSIS_INVALID",
        message: "An analysis requires one to three hypotheses and at most three predictions.",
      });
    }
    const links = await ctx.db
      .query("operationsIntelligenceEpisodeFacts")
      .withIndex("by_episode_linked_at", (index) => index.eq("episodeId", episode._id))
      .order("desc")
      .take(128);
    const allowedFactKeys = new Set(links.map((link) => link.factKey));
    const validateEvidence = (factKeys: string[]) => {
      if (factKeys.length < 1 || factKeys.length > 8 || factKeys.some((key) => !allowedFactKeys.has(key))) {
        throw new ConvexError({
          code: "EPISODE_ANALYSIS_INVALID",
          message: "Analysis evidence must cite one to eight facts from this episode.",
        });
      }
      return [...new Set(factKeys)];
    };
    const summary = boundedModelText(args.summary, "Analysis summary", 12, 600);
    const suggestedAction = boundedModelText(args.suggestedAction, "Suggested action", 8, 300);
    const confidence = boundedProbability(args.confidence, "Analysis confidence");
    for (let ordinal = 0; ordinal < args.hypotheses.length; ordinal += 1) {
      const hypothesis = args.hypotheses[ordinal];
      if (!hypothesis) continue;
      await ctx.db.insert("operationsIntelligenceHypotheses", {
        eventId: episode.eventId,
        episodeId: episode._id,
        analysisRevision: episode.revision,
        ordinal,
        stance: hypothesis.stance,
        statement: boundedModelText(hypothesis.statement, "Hypothesis", 8, 400),
        confidence: boundedProbability(hypothesis.confidence, "Hypothesis confidence"),
        evidenceFactKeys: validateEvidence(hypothesis.evidenceFactKeys),
        createdAt: args.completedAt,
      });
    }
    const maximumHorizon = args.completedAt + 7 * 24 * 60 * 60 * 1_000;
    for (let ordinal = 0; ordinal < args.predictions.length; ordinal += 1) {
      const prediction = args.predictions[ordinal];
      if (!prediction) continue;
      if (prediction.horizonAt <= args.completedAt || prediction.horizonAt > maximumHorizon) {
        throw new ConvexError({
          code: "EPISODE_ANALYSIS_INVALID",
          message: "Prediction horizons must be within the next seven days.",
        });
      }
      await ctx.db.insert("operationsIntelligencePredictions", {
        eventId: episode.eventId,
        episodeId: episode._id,
        analysisRevision: episode.revision,
        ordinal,
        statement: boundedModelText(prediction.statement, "Prediction", 8, 400),
        expectedState: prediction.expectedState,
        probability: boundedProbability(prediction.probability, "Prediction probability"),
        horizonAt: prediction.horizonAt,
        evidenceFactKeys: validateEvidence(prediction.evidenceFactKeys),
        outcome: { kind: "pending" },
        createdAt: args.completedAt,
      });
    }
    for (let ordinal = 0; ordinal < args.counterfactuals.length; ordinal += 1) {
      const counterfactual = args.counterfactuals[ordinal];
      if (!counterfactual) continue;
      await ctx.db.insert("operationsIntelligenceCounterfactuals", {
        eventId: episode.eventId,
        episodeId: episode._id,
        analysisRevision: episode.revision,
        ordinal,
        intervention: boundedModelText(counterfactual.intervention, "Counterfactual intervention", 8, 300),
        expectedState: counterfactual.expectedState,
        probability: boundedProbability(counterfactual.probability, "Counterfactual probability"),
        rationale: boundedModelText(counterfactual.rationale, "Counterfactual rationale", 8, 400),
        evidenceFactKeys: validateEvidence(counterfactual.evidenceFactKeys),
        createdAt: args.completedAt,
      });
    }
    await ctx.db.patch(episode._id, {
      analysisState: { kind: "ready", revision: episode.revision },
      analysisSummary: summary,
      suggestedAction,
      analysisOperationId: args.operationId,
      analysisChecksum: checksum,
      analysisAgentVersion: boundedModelText(args.agentVersion, "Agent version", 3, 120),
      analysisModel: boundedModelText(args.model, "Model", 3, 120),
      confidence: Math.max(episode.confidence, confidence),
      updatedAt: args.completedAt,
    });
    return "accepted";
  },
});
