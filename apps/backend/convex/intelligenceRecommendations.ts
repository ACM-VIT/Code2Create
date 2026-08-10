/**
 * The copilot's proposals and the human decisions over them.
 *
 * The separation of powers is structural, not procedural. The Worker's only
 * way in is the signed webhook below, and the webhook can do exactly one
 * thing: insert a row in `proposed` with citations. Approval, rejection, and
 * suggestion are ordinary authenticated mutations — they resolve a signed-in
 * operator, check the grant the *underlying action* requires, and on approval
 * run that action's existing mutation with the operator as the actor. The
 * agent therefore cannot approve its own work for the same reason it cannot
 * pause a round directly: no session, no grants, no path to the mutations.
 */

import {
  operationsCopilotRecommendationSignatureContext,
  operationsIntelligenceProtocolVersion,
  operationsIntelligenceReadNames,
  verifyServiceBody,
} from "@code2create/domain";
import { ConvexError, v } from "convex/values";
import { z } from "zod";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  httpAction,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  intelligenceRecommendationArguments,
  intelligenceRecommendationCitation,
  intelligenceRecommendationStatus,
} from "./lib/intelligenceRecommendationValidators";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import type { PermissionKey } from "./lib/permissionCatalog";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";

const maximumBodyBytes = 24 * 1_024;
const maximumSignatureAgeMs = 5 * 60 * 1_000;

const supportCategories = [
  "identity",
  "team",
  "project_intake",
  "track_configuration",
  "attendance_credential",
  "missing_scan",
  "scanner_device",
  "table_location",
  "integration",
  "queue",
  "reviewer_device",
  "scorecard",
  "accessibility",
  "safety",
] as const;

const citation = z
  .object({
    read: z.enum(operationsIntelligenceReadNames),
    generatedAt: z.number().int().nonnegative(),
    keys: z.array(z.string().min(1).max(200)).min(1).max(16),
  })
  .strict();

const proposalArguments = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("hold_review_team"),
      teamRoundStateId: z.string().min(1).max(64),
      reason: z.string().min(5).max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("page_reserve_reviewer"),
      missingPanelMemberId: z.string().min(1).max(64),
      reason: z.string().min(5).max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("open_support_case"),
      category: z.enum(supportCategories),
      description: z.string().min(10).max(2_000),
      roundId: z.string().min(1).max(64).optional(),
      teamId: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dismiss_attention_item"),
      itemId: z.string().min(1).max(64),
      reason: z.string().min(5).max(500),
    })
    .strict(),
]);

const proposal = z
  .object({
    protocolVersion: z.literal(operationsIntelligenceProtocolVersion),
    proposalKey: z.string().min(8).max(200),
    conversationId: z.string().min(1).max(200),
    eventSlug: z.string().min(1).max(120),
    agentVersion: z.string().min(1).max(80),
    model: z.string().min(3).max(160),
    statement: z.string().min(10).max(300),
    reasoning: z.string().min(10).max(1_500),
    citations: z.array(citation).min(1).max(8),
    arguments: proposalArguments,
  })
  .strict();

function recommendationSecret() {
  const value = process.env.INTELLIGENCE_CALLBACK_SECRET?.trim();
  if (!value) throw new Error("INTELLIGENCE_CALLBACK_SECRET is not configured.");
  return value;
}

export const intelligenceRecommendationWebhook = httpAction(async (ctx, request) => {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return Response.json({ error: "unsupported_media_type" }, { status: 415 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumBodyBytes) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  let verified = false;
  try {
    verified = await verifyServiceBody({
      context: operationsCopilotRecommendationSignatureContext,
      secret: recommendationSecret(),
      timestamp: request.headers.get("x-c2c-timestamp") ?? "",
      signature: request.headers.get("x-c2c-signature") ?? "",
      body,
      now: Date.now(),
      maximumAgeMs: maximumSignatureAgeMs,
    });
  } catch {
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }
  if (!verified) return Response.json({ error: "unauthorized" }, { status: 401 });
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = proposal.safeParse(json);
  if (!parsed.success) return Response.json({ error: "invalid_proposal" }, { status: 422 });
  // Zod's optionals type as `string | undefined`; Convex optionals require the
  // key to be absent, so the support-case arm is rebuilt without absent links.
  const parsedArguments = parsed.data.arguments;
  const cleanArguments =
    parsedArguments.kind === "open_support_case"
      ? {
          kind: parsedArguments.kind,
          category: parsedArguments.category,
          description: parsedArguments.description,
          ...(parsedArguments.roundId !== undefined ? { roundId: parsedArguments.roundId } : {}),
          ...(parsedArguments.teamId !== undefined ? { teamId: parsedArguments.teamId } : {}),
        }
      : parsedArguments;
  const result = await ctx.runMutation(
    internal.intelligenceRecommendations.proposeFromWorker,
    { proposal: { ...parsed.data, arguments: cleanArguments } },
  );
  if (result === "accepted" || result === "already_exists") {
    return Response.json({ state: result }, { status: 202 });
  }
  return Response.json({ error: result }, { status: 422 });
});

/**
 * The worker's ids arrive as strings and become trusted references only after
 * they normalize into the right table AND resolve to a document of this
 * event. A proposal aimed at another event's rows dies here, not at triage.
 */
async function normalizedArguments(
  ctx: MutationCtx,
  eventId: Id<"events">,
  args: z.infer<typeof proposalArguments>,
): Promise<Doc<"intelligenceRecommendations">["arguments"] | null> {
  if (args.kind === "hold_review_team") {
    const stateId = ctx.db.normalizeId("teamRoundStates", args.teamRoundStateId);
    const state = stateId ? await ctx.db.get(stateId) : null;
    if (!stateId || !state || state.eventId !== eventId) return null;
    return { kind: "hold_review_team", teamRoundStateId: stateId, reason: args.reason };
  }
  if (args.kind === "page_reserve_reviewer") {
    const memberId = ctx.db.normalizeId("reviewPanelMembers", args.missingPanelMemberId);
    const member = memberId ? await ctx.db.get(memberId) : null;
    if (!memberId || !member || member.eventId !== eventId) return null;
    return {
      kind: "page_reserve_reviewer",
      missingPanelMemberId: memberId,
      reason: args.reason,
    };
  }
  if (args.kind === "dismiss_attention_item") {
    const itemId = ctx.db.normalizeId("operationsAttentionItems", args.itemId);
    const item = itemId ? await ctx.db.get(itemId) : null;
    if (!itemId || !item || item.eventId !== eventId) return null;
    return { kind: "dismiss_attention_item", itemId, reason: args.reason };
  }
  const roundId = args.roundId ? ctx.db.normalizeId("reviewRounds", args.roundId) : undefined;
  if (args.roundId !== undefined) {
    const round = roundId ? await ctx.db.get(roundId) : null;
    if (!roundId || !round || round.eventId !== eventId) return null;
  }
  const teamId = args.teamId ? ctx.db.normalizeId("teams", args.teamId) : undefined;
  if (args.teamId !== undefined) {
    const team = teamId ? await ctx.db.get(teamId) : null;
    if (!teamId || !team || team.eventId !== eventId) return null;
  }
  return {
    kind: "open_support_case",
    category: args.category,
    description: args.description,
    ...(roundId ? { roundId } : {}),
    ...(teamId ? { teamId } : {}),
  };
}

export const proposeFromWorker = internalMutation({
  args: {
    proposal: v.object({
      protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
      proposalKey: v.string(),
      conversationId: v.string(),
      eventSlug: v.string(),
      agentVersion: v.string(),
      model: v.string(),
      statement: v.string(),
      reasoning: v.string(),
      citations: v.array(intelligenceRecommendationCitation),
      arguments: v.union(
        v.object({
          kind: v.literal("hold_review_team"),
          teamRoundStateId: v.string(),
          reason: v.string(),
        }),
        v.object({
          kind: v.literal("page_reserve_reviewer"),
          missingPanelMemberId: v.string(),
          reason: v.string(),
        }),
        v.object({
          kind: v.literal("open_support_case"),
          category: v.union(...supportCategories.map((value) => v.literal(value))),
          description: v.string(),
          roundId: v.optional(v.string()),
          teamId: v.optional(v.string()),
        }),
        v.object({
          kind: v.literal("dismiss_attention_item"),
          itemId: v.string(),
          reason: v.string(),
        }),
      ),
    }),
  },
  returns: v.union(
    v.literal("accepted"),
    v.literal("already_exists"),
    v.literal("event_not_found"),
    v.literal("invalid_target"),
    v.literal("missing_citation"),
  ),
  handler: async (ctx, args) => {
    // Belt over the webhook's braces: even an internal caller cannot record
    // an uncited recommendation.
    if (
      args.proposal.citations.length === 0 ||
      args.proposal.citations.some((entry) => entry.keys.length === 0)
    ) {
      return "missing_citation";
    }
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) =>
        index.eq("slug", args.proposal.eventSlug.trim().toLowerCase()),
      )
      .unique();
    if (!event) return "event_not_found";
    const existing = await ctx.db
      .query("intelligenceRecommendations")
      .withIndex("by_event_proposal", (index) =>
        index.eq("eventId", event._id).eq("proposalKey", args.proposal.proposalKey),
      )
      .unique();
    if (existing) return "already_exists";
    const normalized = await normalizedArguments(ctx, event._id, args.proposal.arguments);
    if (!normalized) return "invalid_target";
    const now = Date.now();
    await ctx.db.insert("intelligenceRecommendations", {
      eventId: event._id,
      proposalKey: args.proposal.proposalKey,
      conversationId: args.proposal.conversationId,
      arguments: normalized,
      statement: args.proposal.statement,
      reasoning: args.proposal.reasoning,
      citations: args.proposal.citations,
      status: "proposed",
      agentVersion: args.proposal.agentVersion,
      model: args.proposal.model,
      proposedAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return "accepted";
  },
});

const recommendationView = v.object({
  id: v.id("intelligenceRecommendations"),
  arguments: intelligenceRecommendationArguments,
  statement: v.string(),
  reasoning: v.string(),
  citations: v.array(intelligenceRecommendationCitation),
  status: intelligenceRecommendationStatus,
  agentVersion: v.string(),
  model: v.string(),
  proposedAt: v.number(),
  decidedAt: v.optional(v.number()),
  operatorNote: v.optional(v.string()),
  executedTargetType: v.optional(v.string()),
  executedTargetId: v.optional(v.string()),
  version: v.number(),
});

export const list = query({
  args: { eventSlug: v.string() },
  returns: v.array(recommendationView),
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
    const rows = await ctx.db
      .query("intelligenceRecommendations")
      .withIndex("by_event_proposed", (index) => index.eq("eventId", event._id))
      .order("desc")
      .take(100);
    return rows.map((row) => ({
      id: row._id,
      arguments: row.arguments,
      statement: row.statement,
      reasoning: row.reasoning,
      citations: row.citations,
      status: row.status,
      agentVersion: row.agentVersion,
      model: row.model,
      proposedAt: row.proposedAt,
      ...(row.decidedAt !== undefined ? { decidedAt: row.decidedAt } : {}),
      ...(row.operatorNote !== undefined ? { operatorNote: row.operatorNote } : {}),
      ...(row.executedTargetType !== undefined
        ? { executedTargetType: row.executedTargetType }
        : {}),
      ...(row.executedTargetId !== undefined
        ? { executedTargetId: row.executedTargetId }
        : {}),
      version: row.version,
    }));
  },
});

type KindAuthorization = {
  permissionKey: PermissionKey;
  grantIds: Id<"permissionGrants">[];
  scopeType: Doc<"permissionGrants">["scopeType"];
  scopeId?: string;
};

/**
 * Triage authority is the authority to run the proposed command, resolved the
 * way the command itself resolves it. Rejecting or redirecting a proposal is
 * a judgement about that command, so it demands the same grant — an operator
 * who could not hold the team has no standing to veto holding it either.
 */
async function requireKindAuthorization(
  ctx: MutationCtx,
  event: Doc<"events">,
  subjectId: Id<"eventAccessSubjects">,
  recommendation: Doc<"intelligenceRecommendations">,
): Promise<KindAuthorization> {
  const args = recommendation.arguments;
  if (args.kind === "hold_review_team") {
    const state = await ctx.db.get(args.teamRoundStateId);
    if (!state || state.eventId !== event._id) {
      throw new ConvexError({
        code: "RECOMMENDATION_TARGET_GONE",
        message: "The team this recommendation names is no longer in the round.",
      });
    }
    // The same team-then-round-then-panel resolution the hold command uses,
    // so triage authority and execution authority cannot diverge.
    const scopes: Array<{ scopeType: "team" | "round" | "panel"; scopeId: string }> = [
      { scopeType: "team", scopeId: state.teamId },
      { scopeType: "round", scopeId: state.roundId },
      ...(state.panelId ? [{ scopeType: "panel" as const, scopeId: state.panelId }] : []),
    ];
    for (const scope of scopes) {
      const grantIds = await matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subjectId,
        permissionKey: "review.queue.hold",
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
      });
      if (grantIds.length > 0) {
        return { permissionKey: "review.queue.hold", grantIds, ...scope };
      }
    }
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message: "This account cannot hold that exact team, round, or panel.",
    });
  }
  if (args.kind === "page_reserve_reviewer") {
    const member = await ctx.db.get(args.missingPanelMemberId);
    if (!member || member.eventId !== event._id) {
      throw new ConvexError({
        code: "RECOMMENDATION_TARGET_GONE",
        message: "The panel vacancy this recommendation names no longer exists.",
      });
    }
    const grantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subjectId,
      permissionKey: "review.substitute.page",
      scopeType: "panel",
      scopeId: member.panelId,
    });
    if (grantIds.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot page a substitute for that exact panel.",
      });
    }
    return {
      permissionKey: "review.substitute.page",
      grantIds,
      scopeType: "panel",
      scopeId: member.panelId,
    };
  }
  if (args.kind === "open_support_case") {
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subjectId,
      permissionKey: "support.case.create",
      scopeType: "event",
    });
    return { permissionKey: "support.case.create", grantIds, scopeType: "event" };
  }
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subjectId,
    permissionKey: "operations.attention.manage",
    scopeType: "event",
  });
  return { permissionKey: "operations.attention.manage", grantIds, scopeType: "event" };
}

/**
 * Resolve the caller, replay a prior identical triage operation if one is
 * recorded, and only then authorise against the live recommendation. The
 * prior-operation check has to come before the `proposed` check: a retried
 * decision finds its recommendation already settled — by itself — and must
 * read that as its own success, not as a conflict.
 */
async function requireTriageContext(
  ctx: MutationCtx,
  args: {
    eventSlug: string;
    recommendationId: Id<"intelligenceRecommendations">;
    expectedVersion: number;
  },
  operation: { clientOperationId: string; commandName: string; requestFingerprint: string },
) {
  const event = await requireEventBySlug(ctx, args.eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const prior = await findOperation(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    ...operation,
  });
  if (prior) {
    const saved = await ctx.db.get(args.recommendationId);
    if (!saved) throw new Error("A prior recommendation decision no longer resolves.");
    return { event, person, recommendation: saved, prior } as const;
  }
  const recommendation = await ctx.db.get(args.recommendationId);
  if (!recommendation || recommendation.eventId !== event._id) {
    throw new ConvexError({
      code: "RECOMMENDATION_NOT_FOUND",
      message: "That recommendation is unavailable.",
    });
  }
  const authorization = await requireKindAuthorization(ctx, event, subject._id, recommendation);
  if (recommendation.status !== "proposed" || recommendation.version !== args.expectedVersion) {
    throw new ConvexError({
      code: "RECOMMENDATION_CHANGED",
      message: "That recommendation was already decided or changed. Refresh before continuing.",
    });
  }
  return { event, person, recommendation, authorization, prior: null } as const;
}

/**
 * The action clientOperationId is derived from the recommendation, not the
 * caller's triage operation id, so a recommendation executes its underlying
 * command at most once across operators and retries.
 */
function actionOperationId(recommendationId: Id<"intelligenceRecommendations">) {
  return `intelligence-recommendation-${recommendationId}`;
}

async function executeApprovedKind(
  ctx: MutationCtx,
  eventSlug: string,
  recommendation: Doc<"intelligenceRecommendations">,
): Promise<{ targetType: string; targetId: string }> {
  const args = recommendation.arguments;
  const clientOperationId = actionOperationId(recommendation._id);
  if (args.kind === "hold_review_team") {
    const state = await ctx.db.get(args.teamRoundStateId);
    if (!state) throw new Error("The recommended team round state no longer resolves.");
    const result = await ctx.runMutation(api.reviewExceptions.holdTeam, {
      eventSlug,
      teamRoundStateId: args.teamRoundStateId,
      expectedVersion: state.version,
      reason: args.reason,
      clientOperationId,
    });
    return { targetType: "team_round_state", targetId: result.teamRoundStateId };
  }
  if (args.kind === "page_reserve_reviewer") {
    const member = await ctx.db.get(args.missingPanelMemberId);
    const panel = member ? await ctx.db.get(member.panelId) : null;
    if (!member || !panel) throw new Error("The recommended panel vacancy no longer resolves.");
    const result = await ctx.runMutation(api.reviewSubstitutions.startPageChain, {
      eventSlug,
      missingPanelMemberId: args.missingPanelMemberId,
      expectedPanelVersion: panel.version,
      reason: args.reason,
      clientOperationId,
    });
    return { targetType: "reviewer_page_chain", targetId: result.pageChainId };
  }
  if (args.kind === "open_support_case") {
    const result = await ctx.runMutation(api.support.createStaff, {
      eventSlug,
      category: args.category,
      description: args.description,
      ...(args.roundId ? { roundId: args.roundId } : {}),
      ...(args.teamId ? { teamId: args.teamId } : {}),
      clientOperationId,
    });
    return { targetType: "support_case", targetId: result.id };
  }
  const item = await ctx.db.get(args.itemId);
  if (!item) throw new Error("The recommended attention item no longer resolves.");
  await ctx.runMutation(api.operationsAttention.dismiss, {
    eventSlug,
    itemId: args.itemId,
    expectedVersion: item.version,
    reason: args.reason,
  });
  return { targetType: "operations_attention_item", targetId: args.itemId };
}

const triageArgs = {
  eventSlug: v.string(),
  recommendationId: v.id("intelligenceRecommendations"),
  expectedVersion: v.number(),
  clientOperationId: v.string(),
};

const triageResult = v.object({ version: v.number() });

export const approve = mutation({
  args: triageArgs,
  returns: triageResult,
  handler: async (ctx, args) => {
    const clientOperationId = normalizedText(args.clientOperationId, "Operation ID", 8, 100);
    const requestFingerprint = operationFingerprint([
      args.recommendationId,
      args.expectedVersion,
      "approve",
    ]);
    const context = await requireTriageContext(ctx, args, {
      clientOperationId,
      commandName: "operations.intelligence.recommendation.approve",
      requestFingerprint,
    });
    if (context.prior) return { version: context.recommendation.version };
    const { event, person, recommendation, authorization } = context;
    // The underlying command runs first, as the operator, through its own
    // mutation: grants, target versions, and its own audit all re-check
    // there. A refusal rolls the whole approval back.
    const executed = await executeApprovedKind(ctx, args.eventSlug, recommendation);
    const now = Date.now();
    const version = recommendation.version + 1;
    await ctx.db.patch(recommendation._id, {
      status: "approved",
      decidedByPersonId: person._id,
      decidedAt: now,
      executedTargetType: executed.targetType,
      executedTargetId: executed.targetId,
      version,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "operations.intelligence.recommendation.approve",
      requestFingerprint,
      targetType: "intelligence_recommendation",
      targetId: recommendation._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: authorization.permissionKey,
      grantIds: authorization.grantIds,
      scopeType: authorization.scopeType,
      ...(authorization.scopeId !== undefined ? { scopeId: authorization.scopeId } : {}),
      action: "operations.intelligence_recommendation_approved",
      targetType: "intelligence_recommendation",
      targetId: recommendation._id,
      previousSummary: JSON.stringify({ status: "proposed", version: recommendation.version }),
      nextSummary: JSON.stringify({
        status: "approved",
        version,
        executedTargetType: executed.targetType,
        executedTargetId: executed.targetId,
      }),
      reason: recommendation.statement,
    });
    return { version };
  },
});

export const reject = mutation({
  args: { ...triageArgs, reason: v.string() },
  returns: triageResult,
  handler: async (ctx, args) => {
    const clientOperationId = normalizedText(args.clientOperationId, "Operation ID", 8, 100);
    const reason = normalizedText(args.reason, "Rejection reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.recommendationId,
      args.expectedVersion,
      "reject",
      reason,
    ]);
    const context = await requireTriageContext(ctx, args, {
      clientOperationId,
      commandName: "operations.intelligence.recommendation.reject",
      requestFingerprint,
    });
    if (context.prior) return { version: context.recommendation.version };
    const { event, person, recommendation, authorization } = context;
    const now = Date.now();
    const version = recommendation.version + 1;
    await ctx.db.patch(recommendation._id, {
      status: "rejected",
      decidedByPersonId: person._id,
      decidedAt: now,
      operatorNote: reason,
      version,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "operations.intelligence.recommendation.reject",
      requestFingerprint,
      targetType: "intelligence_recommendation",
      targetId: recommendation._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: authorization.permissionKey,
      grantIds: authorization.grantIds,
      scopeType: authorization.scopeType,
      ...(authorization.scopeId !== undefined ? { scopeId: authorization.scopeId } : {}),
      action: "operations.intelligence_recommendation_rejected",
      targetType: "intelligence_recommendation",
      targetId: recommendation._id,
      previousSummary: JSON.stringify({ status: "proposed", version: recommendation.version }),
      nextSummary: JSON.stringify({ status: "rejected", version }),
      reason,
    });
    return { version };
  },
});

/**
 * "Not like this — like that." The recommendation is closed as superseded and
 * the operator's words are stored where the recommendation-history read
 * returns them, which is how the agent's next proposal gets to be better than
 * its last one.
 */
export const suggest = mutation({
  args: { ...triageArgs, suggestion: v.string() },
  returns: triageResult,
  handler: async (ctx, args) => {
    const clientOperationId = normalizedText(args.clientOperationId, "Operation ID", 8, 100);
    const suggestion = normalizedText(args.suggestion, "Suggestion", 5, 1_000);
    const requestFingerprint = operationFingerprint([
      args.recommendationId,
      args.expectedVersion,
      "suggest",
      suggestion,
    ]);
    const context = await requireTriageContext(ctx, args, {
      clientOperationId,
      commandName: "operations.intelligence.recommendation.suggest",
      requestFingerprint,
    });
    if (context.prior) return { version: context.recommendation.version };
    const { event, person, recommendation, authorization } = context;
    const now = Date.now();
    const version = recommendation.version + 1;
    await ctx.db.patch(recommendation._id, {
      status: "superseded",
      decidedByPersonId: person._id,
      decidedAt: now,
      operatorNote: suggestion,
      version,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "operations.intelligence.recommendation.suggest",
      requestFingerprint,
      targetType: "intelligence_recommendation",
      targetId: recommendation._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: authorization.permissionKey,
      grantIds: authorization.grantIds,
      scopeType: authorization.scopeType,
      ...(authorization.scopeId !== undefined ? { scopeId: authorization.scopeId } : {}),
      action: "operations.intelligence_recommendation_superseded",
      targetType: "intelligence_recommendation",
      targetId: recommendation._id,
      previousSummary: JSON.stringify({ status: "proposed", version: recommendation.version }),
      nextSummary: JSON.stringify({ status: "superseded", version }),
      reason: suggestion,
    });
    return { version };
  },
});
