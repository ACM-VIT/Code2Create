/**
 * What the intelligence agents are doing, read entirely from the records
 * Convex already keeps. Every brief run is one worker agent instance (the
 * dispatch id is the brief id) and its whole lifecycle — pending,
 * dispatching, accepted, succeeded, failed — is written here by the dispatch
 * action and the signed callback. Every copilot conversation is one durable
 * instance (`copilot:<eventSlug>:<conversationId>`), and the recommendations
 * it delivered are its only durable trace on this side: each one names the
 * reads it cited, which is the closest thing to a tool log that exists
 * outside the Worker.
 *
 * Deliberately absent: live per-turn state, conversation text, and the
 * copilot's individual read calls. Those live inside the agent's Durable
 * Object, and the Worker's tracing is content-free on purpose — mirroring
 * them here would open a second channel for event data that the redaction
 * boundary was built to prevent.
 */

import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  intelligenceRecommendationStatus,
} from "./lib/intelligenceRecommendationValidators";
import { requirePermission } from "./lib/permissions";

const maximumBriefRuns = 25;
const maximumRecommendationRows = 200;

const briefRunView = v.object({
  id: v.id("operationsIntelligenceBriefs"),
  origin: v.union(v.literal("manual"), v.literal("automation")),
  state: v.union(
    v.literal("pending"),
    v.literal("dispatching"),
    v.literal("accepted"),
    v.literal("succeeded"),
    v.literal("failed"),
  ),
  failureCode: v.optional(
    v.union(
      v.literal("dispatch_failed"),
      v.literal("agent_timed_out"),
      v.literal("model_did_not_publish"),
      v.literal("callback_rejected"),
    ),
  ),
  headline: v.optional(v.string()),
  agentVersion: v.optional(v.string()),
  model: v.optional(v.string()),
  requestedAt: v.number(),
  workerAcceptedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
});

const copilotRecommendationView = v.object({
  id: v.id("intelligenceRecommendations"),
  kind: v.union(
    v.literal("hold_review_team"),
    v.literal("page_reserve_reviewer"),
    v.literal("open_support_case"),
    v.literal("dismiss_attention_item"),
  ),
  statement: v.string(),
  status: intelligenceRecommendationStatus,
  citedReads: v.array(v.string()),
  agentVersion: v.string(),
  model: v.string(),
  proposedAt: v.number(),
  decidedAt: v.optional(v.number()),
  operatorNote: v.optional(v.string()),
});

const copilotInstanceView = v.object({
  instanceId: v.string(),
  conversationId: v.string(),
  lastActivityAt: v.number(),
  openCount: v.number(),
  recommendations: v.array(copilotRecommendationView),
});

const automationView = v.object({
  state: v.union(v.literal("active"), v.literal("disabled"), v.literal("superseded")),
  lastEvaluatedAt: v.optional(v.number()),
  nextEvaluationAt: v.number(),
  lastTriggerAt: v.optional(v.number()),
  briefsStartedToday: v.number(),
  maximumBriefsPerLocalDay: v.number(),
  cooldownMinutes: v.number(),
  accountableOwner: v.string(),
});

function briefRun(brief: Doc<"operationsIntelligenceBriefs">) {
  return {
    id: brief._id,
    origin: brief.origin,
    state: brief.state,
    ...(brief.failureCode !== undefined ? { failureCode: brief.failureCode } : {}),
    ...(brief.headline !== undefined ? { headline: brief.headline } : {}),
    ...(brief.agentVersion !== undefined ? { agentVersion: brief.agentVersion } : {}),
    ...(brief.model !== undefined ? { model: brief.model } : {}),
    requestedAt: brief.requestedAt,
    ...(brief.workerAcceptedAt !== undefined
      ? { workerAcceptedAt: brief.workerAcceptedAt }
      : {}),
    ...(brief.completedAt !== undefined ? { completedAt: brief.completedAt } : {}),
  };
}

export const overview = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    briefRuns: v.array(briefRunView),
    automation: v.union(v.null(), automationView),
    copilotInstances: v.array(copilotInstanceView),
  }),
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

    const briefs = await ctx.db
      .query("operationsIntelligenceBriefs")
      .withIndex("by_event_requested", (index) => index.eq("eventId", event._id))
      .order("desc")
      .take(maximumBriefRuns);

    // At most one automation state matters per event: the active one if any,
    // otherwise the most recently updated, so a just-disabled automation still
    // shows as disabled instead of vanishing.
    const automationStates = await ctx.db
      .query("operationsIntelligenceAutomationStates")
      .withIndex("by_event", (index) => index.eq("eventId", event._id))
      .collect();
    const automationState =
      automationStates.find((state) => state.state === "active") ??
      automationStates.toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
    const automationPolicy = automationState
      ? await ctx.db.get(automationState.policyVersionId)
      : null;

    const recommendations = await ctx.db
      .query("intelligenceRecommendations")
      .withIndex("by_event_proposed", (index) => index.eq("eventId", event._id))
      .order("desc")
      .take(maximumRecommendationRows);
    const instancesByConversation = new Map<
      string,
      { lastActivityAt: number; openCount: number; recommendations: ReturnType<typeof copilotRecommendation>[] }
    >();
    for (const recommendation of recommendations) {
      const instance = instancesByConversation.get(recommendation.conversationId) ?? {
        lastActivityAt: 0,
        openCount: 0,
        recommendations: [],
      };
      const activityAt = recommendation.decidedAt ?? recommendation.proposedAt;
      instance.lastActivityAt = Math.max(instance.lastActivityAt, activityAt);
      if (recommendation.status === "proposed") instance.openCount += 1;
      instance.recommendations.push(copilotRecommendation(recommendation));
      instancesByConversation.set(recommendation.conversationId, instance);
    }

    return {
      briefRuns: briefs.map(briefRun),
      automation:
        automationState && automationPolicy
          ? {
              state: automationState.state,
              ...(automationState.lastEvaluatedAt !== undefined
                ? { lastEvaluatedAt: automationState.lastEvaluatedAt }
                : {}),
              nextEvaluationAt: automationState.nextEvaluationAt,
              ...(automationState.lastTriggerAt !== undefined
                ? { lastTriggerAt: automationState.lastTriggerAt }
                : {}),
              briefsStartedToday: automationState.briefsStartedToday,
              maximumBriefsPerLocalDay: automationPolicy.maximumBriefsPerLocalDay,
              cooldownMinutes: automationPolicy.cooldownMinutes,
              accountableOwner: automationPolicy.accountableOwner,
            }
          : null,
      copilotInstances: [...instancesByConversation.entries()]
        .map(([conversationId, instance]) => ({
          instanceId: `copilot:${event.slug}:${conversationId}`,
          conversationId,
          lastActivityAt: instance.lastActivityAt,
          openCount: instance.openCount,
          recommendations: instance.recommendations,
        }))
        .toSorted((left, right) => right.lastActivityAt - left.lastActivityAt),
    };
  },
});

function copilotRecommendation(recommendation: Doc<"intelligenceRecommendations">) {
  return {
    id: recommendation._id,
    kind: recommendation.arguments.kind,
    statement: recommendation.statement,
    status: recommendation.status,
    // The reads a recommendation cites are the tools the copilot actually
    // pulled for it, deduplicated in citation order.
    citedReads: [...new Set(recommendation.citations.map((citation) => citation.read))],
    agentVersion: recommendation.agentVersion,
    model: recommendation.model,
    proposedAt: recommendation.proposedAt,
    ...(recommendation.decidedAt !== undefined
      ? { decidedAt: recommendation.decidedAt }
      : {}),
    ...(recommendation.operatorNote !== undefined
      ? { operatorNote: recommendation.operatorNote }
      : {}),
  };
}
