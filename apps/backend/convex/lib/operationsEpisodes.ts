import type {
  OperationsHealthArea,
  OperationsHealthSeverity,
  OperationsHealthSignal,
  OperationsHealthSnapshot,
} from "@code2create/domain";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { intelligenceWorkpool } from "../workpools";
import { operationFingerprint } from "./operations";

const resolutionClearPasses = 3;

const correlationByArea: Record<OperationsHealthArea, string> = {
  system: "system_resilience",
  intake: "participant_pipeline",
  admissions: "participant_pipeline",
  communications: "participant_pipeline",
  reviews: "review_flow",
  scores: "review_flow",
  attendance: "venue_operations",
  synesthesia: "venue_operations",
  integrations: "integrations",
};

const titleByCorrelation: Record<string, string> = {
  system_resilience: "System resilience",
  participant_pipeline: "Participant pipeline",
  review_flow: "Review flow",
  venue_operations: "Venue operations",
  integrations: "External integrations",
};

export function episodeCorrelationKey(area: OperationsHealthArea) {
  return correlationByArea[area];
}

function severityRank(severity: OperationsHealthSeverity) {
  if (severity === "critical") return 3;
  if (severity === "attention") return 2;
  return 1;
}

export function highestEpisodeSeverity(signals: readonly OperationsHealthSignal[]) {
  const first = signals[0];
  if (!first) throw new Error("An intelligence episode requires at least one signal.");
  return signals.reduce(
    (highest, signal) =>
      severityRank(signal.severity) > severityRank(highest)
        ? signal.severity
        : highest,
    first.severity,
  );
}

export function episodeRelevance(args: {
  severity: OperationsHealthSeverity;
  signalCount: number;
  atLeastCount: number;
}) {
  const severityBase = args.severity === "critical" ? 75 : args.severity === "attention" ? 50 : 30;
  return Math.min(100, severityBase + Math.min(15, args.signalCount * 5) + Math.min(10, args.atLeastCount * 2));
}

export function episodeConfidence(args: {
  severity: OperationsHealthSeverity;
  signalCount: number;
  atLeastCount: number;
}) {
  const severityLift = args.severity === "critical" ? 0.12 : args.severity === "attention" ? 0.08 : 0.04;
  return Math.min(0.96, 0.52 + severityLift + Math.min(0.24, args.signalCount * 0.06) - Math.min(0.12, args.atLeastCount * 0.03));
}

function episodeState(severity: OperationsHealthSeverity) {
  if (severity === "critical") return "escalating" as const;
  if (severity === "attention") return "active" as const;
  return "forming" as const;
}

function groupedSignals(snapshot: OperationsHealthSnapshot) {
  const groups = new Map<string, OperationsHealthSignal[]>();
  for (const signal of snapshot.signals) {
    const key = episodeCorrelationKey(signal.area);
    const group = groups.get(key) ?? [];
    group.push(signal);
    groups.set(key, group);
  }
  return groups;
}

function observationChecksum(signals: readonly OperationsHealthSignal[]) {
  return operationFingerprint(
    [...signals]
      .sort((left, right) => left.key.localeCompare(right.key))
      .flatMap((signal) => [
        signal.key,
        signal.severity,
        signal.count,
        signal.atLeast,
        signal.oldestAt ?? null,
      ]),
  );
}

async function activeEpisode(
  ctx: MutationCtx,
  eventId: Id<"events">,
  correlationKey: string,
) {
  return ctx.db
    .query("operationsIntelligenceEpisodes")
    .withIndex("by_event_correlation_lifecycle", (index) =>
      index.eq("eventId", eventId).eq("correlationKey", correlationKey).eq("lifecycle", "active"),
    )
    .unique();
}

async function insertFacts(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    correlationKey: string;
    snapshot: OperationsHealthSnapshot;
    signals: readonly OperationsHealthSignal[];
  },
) {
  const facts: { id: Id<"operationsIntelligenceFacts">; key: string }[] = [];
  for (const signal of args.signals) {
    const factKey = `${args.snapshot.generatedAt}:${signal.key}`;
    const checksum = operationFingerprint([
      signal.key,
      signal.severity,
      signal.count,
      signal.atLeast,
      signal.oldestAt ?? null,
    ]);
    const prior = await ctx.db
      .query("operationsIntelligenceFacts")
      .withIndex("by_event_fact_key", (index) =>
        index.eq("eventId", args.eventId).eq("factKey", factKey),
      )
      .unique();
    if (prior) {
      facts.push({ id: prior._id, key: prior.factKey });
      continue;
    }
    const id = await ctx.db.insert("operationsIntelligenceFacts", {
      eventId: args.eventId,
      factKey,
      source: "operations_health",
      correlationKey: args.correlationKey,
      signalKey: signal.key,
      area: signal.area,
      severity: signal.severity,
      title: signal.title,
      detail: signal.detail,
      owner: signal.owner,
      nextAction: signal.nextAction,
      count: signal.count,
      atLeast: signal.atLeast,
      occurredAt: signal.oldestAt ?? args.snapshot.generatedAt,
      observedAt: args.snapshot.generatedAt,
      checksum,
    });
    facts.push({ id, key: factKey });
  }
  return facts;
}

async function linkFacts(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    episodeId: Id<"operationsIntelligenceEpisodes">;
    facts: readonly { id: Id<"operationsIntelligenceFacts">; key: string }[];
    linkedAt: number;
  },
) {
  let inserted = 0;
  for (const fact of args.facts) {
    const prior = await ctx.db
      .query("operationsIntelligenceEpisodeFacts")
      .withIndex("by_episode_fact_key", (index) =>
        index.eq("episodeId", args.episodeId).eq("factKey", fact.key),
      )
      .unique();
    if (prior) continue;
    await ctx.db.insert("operationsIntelligenceEpisodeFacts", {
      eventId: args.eventId,
      episodeId: args.episodeId,
      factId: fact.id,
      factKey: fact.key,
      linkedAt: args.linkedAt,
    });
    inserted += 1;
  }
  return inserted;
}

export async function enqueueEpisodeAnalysis(
  ctx: MutationCtx,
  episodeId: Id<"operationsIntelligenceEpisodes">,
  revision: number,
) {
  await intelligenceWorkpool.enqueueAction(
    ctx,
    internal.operationsEpisodeActions.dispatchEpisode,
    { episodeId },
    {
      retry: true,
      onComplete: internal.operationsEpisodes.episodeDispatchFinished,
      context: { episodeId, revision },
    },
  );
}

function actualPredictionState(episode: Doc<"operationsIntelligenceEpisodes">) {
  if (episode.lifecycle === "terminal") return "resolved" as const;
  if (episode.state === "forming") return "active" as const;
  return episode.state;
}

export async function resolveDueEpisodePredictions(ctx: MutationCtx, now: number) {
  const predictions = await ctx.db
    .query("operationsIntelligencePredictions")
    .withIndex("by_outcome_kind_horizon_at", (index) =>
      index.eq("outcome.kind", "pending").lte("horizonAt", now),
    )
    .take(64);
  for (const prediction of predictions) {
    const episode = await ctx.db.get(prediction.episodeId);
    if (!episode) continue;
    const actualState = actualPredictionState(episode);
    const confirmed = prediction.expectedState === actualState;
    const actual = confirmed ? 1 : 0;
    const brierScore = (prediction.probability - actual) ** 2;
    const kind = confirmed ? "confirmed" as const : "disconfirmed" as const;
    await ctx.db.patch(prediction._id, {
      outcome: { kind, actualState, resolvedAt: now, brierScore },
    });
    await ctx.db.insert("operationsIntelligenceOutcomes", {
      eventId: prediction.eventId,
      episodeId: prediction.episodeId,
      predictionId: prediction._id,
      kind: confirmed ? "prediction_confirmed" : "prediction_disconfirmed",
      summary: confirmed
        ? "The predicted episode state matched the state at its forecast horizon."
        : "The predicted episode state did not match the state at its forecast horizon.",
      observedAt: now,
    });
  }
}

export async function reconcileOperationsEpisodes(
  ctx: MutationCtx,
  eventId: Id<"events">,
  snapshot: OperationsHealthSnapshot,
) {
  const groups = groupedSignals(snapshot);
  for (const [correlationKey, signals] of groups) {
    const severity = highestEpisodeSeverity(signals);
    const state = episodeState(severity);
    const atLeastCount = signals.filter((signal) => signal.atLeast).length;
    const relevanceScore = episodeRelevance({ severity, signalCount: signals.length, atLeastCount });
    const confidence = episodeConfidence({ severity, signalCount: signals.length, atLeastCount });
    const checksum = observationChecksum(signals);
    const ordered = [...signals].sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
    const lead = ordered[0];
    if (!lead) continue;
    const facts = await insertFacts(ctx, { eventId, correlationKey, snapshot, signals });
    const existing = await activeEpisode(ctx, eventId, correlationKey);
    if (!existing) {
      const episodeId = await ctx.db.insert("operationsIntelligenceEpisodes", {
        eventId,
        correlationKey,
        lifecycle: "active",
        state,
        severity,
        title: titleByCorrelation[correlationKey] ?? "Operational situation",
        summary: ordered.map((signal) => signal.title).join("; "),
        owner: lead.owner,
        nextAction: lead.nextAction,
        firstObservedAt: snapshot.generatedAt,
        lastObservedAt: snapshot.generatedAt,
        clearPassCount: 0,
        factCount: facts.length,
        signalCount: signals.length,
        relevanceScore,
        confidence,
        observationChecksum: checksum,
        revision: 1,
        analysisState: { kind: "pending" },
        updatedAt: snapshot.generatedAt,
      });
      await linkFacts(ctx, { eventId, episodeId, facts, linkedAt: snapshot.generatedAt });
      await enqueueEpisodeAnalysis(ctx, episodeId, 1);
      continue;
    }
    const insertedFacts = await linkFacts(ctx, {
      eventId,
      episodeId: existing._id,
      facts,
      linkedAt: snapshot.generatedAt,
    });
    const changed = existing.observationChecksum !== checksum || existing.state === "recovering";
    const revision = changed ? existing.revision + 1 : existing.revision;
    await ctx.db.patch(existing._id, {
      state,
      severity,
      summary: ordered.map((signal) => signal.title).join("; "),
      owner: lead.owner,
      nextAction: lead.nextAction,
      lastObservedAt: snapshot.generatedAt,
      clearPassCount: 0,
      factCount: existing.factCount + insertedFacts,
      signalCount: signals.length,
      relevanceScore,
      confidence,
      observationChecksum: checksum,
      revision,
      ...(changed ? { analysisState: { kind: "pending" } as const } : {}),
      updatedAt: snapshot.generatedAt,
    });
    if (changed) await enqueueEpisodeAnalysis(ctx, existing._id, revision);
  }

  const active = await ctx.db
    .query("operationsIntelligenceEpisodes")
    .withIndex("by_event_lifecycle_relevance", (index) =>
      index.eq("eventId", eventId).eq("lifecycle", "active"),
    )
    .take(32);
  for (const episode of active) {
    if (groups.has(episode.correlationKey)) continue;
    const clearPassCount = episode.clearPassCount + 1;
    if (clearPassCount < resolutionClearPasses) {
      const changed = episode.state !== "recovering";
      await ctx.db.patch(episode._id, {
        state: "recovering",
        clearPassCount,
        relevanceScore: Math.max(10, episode.relevanceScore - 15),
        revision: changed ? episode.revision + 1 : episode.revision,
        ...(changed ? { analysisState: { kind: "pending" } as const } : {}),
        updatedAt: snapshot.generatedAt,
      });
      if (changed) await enqueueEpisodeAnalysis(ctx, episode._id, episode.revision + 1);
      continue;
    }
    await ctx.db.patch(episode._id, {
      lifecycle: "terminal",
      state: "resolved",
      clearPassCount,
      relevanceScore: 0,
      revision: episode.revision + 1,
      resolvedAt: snapshot.generatedAt,
      updatedAt: snapshot.generatedAt,
    });
    await ctx.db.insert("operationsIntelligenceOutcomes", {
      eventId,
      episodeId: episode._id,
      kind: "episode_resolved",
      summary: "The correlated health signals remained clear for three consecutive snapshots.",
      observedAt: snapshot.generatedAt,
    });
  }
  await resolveDueEpisodePredictions(ctx, snapshot.generatedAt);
}
