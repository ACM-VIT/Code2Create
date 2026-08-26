/** Stores signed proposals; only authenticated operator mutations can settle them. */

import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import {
  operationsCopilotRecommendationSignatureContext,
  operationsIntelligenceProtocolVersion,
  operationsIntelligenceReadNames,
  type OperationsAutonomyRecommendationEvidenceSeal,
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
  type QueryCtx,
} from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requireIntelligenceHmacSecret } from "./lib/intelligenceServiceConfiguration";
import {
  intelligenceRecommendationArguments,
  intelligenceRecommendationCitation,
  intelligenceRecommendationStatus,
  operationsAutonomyRecommendationEvidenceSeal,
} from "./lib/intelligenceRecommendationValidators";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import type { PermissionKey } from "./lib/permissionCatalog";
import {
  assertPermissionKey,
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import {
  HttpBodyTooLargeError,
  readBoundedRequestText,
} from "./lib/boundedHttpBody";
import { normalizedLongText, normalizedText } from "./lib/strings";

const maximumBodyBytes = 24 * 1_024;
const maximumSignatureAgeMs = 5 * 60 * 1_000;
const maximumCitationAgeMs = 15 * 60 * 1_000;
const maximumCitationFutureSkewMs = 5_000;
const maximumRecommendationPageSize = 20;
const conversationId = z.string().regex(/^cv_[a-f0-9]{64}$/u);

const supportCategories = [
  "identity",
  "team",
  "project_intake",
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
      expectedTeamRoundStateVersion: z.number().int().positive(),
      reason: z.string().min(5).max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("page_reserve_reviewer"),
      missingPanelMemberId: z.string().min(1).max(64),
      expectedPanelVersion: z.number().int().positive(),
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
      expectedItemVersion: z.number().int().positive(),
      reason: z.string().min(5).max(500),
    })
    .strict(),
]);

const proposal = z
  .object({
    protocolVersion: z.literal(operationsIntelligenceProtocolVersion),
    proposalKey: z.string().min(8).max(200),
    conversationId,
    eventSlug: z.string().min(1).max(120),
    agentVersion: z.string().min(1).max(80),
    model: z.string().min(3).max(160),
    statement: z.string().min(10).max(300),
    reasoning: z.string().min(10).max(1_500),
    citations: z.array(citation).min(1).max(8),
    arguments: proposalArguments,
  })
  .strict();

export type IntelligenceRecommendationProposalInput = {
  proposalKey: string;
  agentVersion: string;
  model: string;
  statement: string;
  reasoning: string;
  citations: z.infer<typeof citation>[];
  arguments: z.infer<typeof proposalArguments>;
};

export const intelligenceRecommendationWebhook = httpAction(async (ctx, request) => {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return Response.json({ error: "unsupported_media_type" }, { status: 415 });
  }
  let body: string;
  try {
    body = await readBoundedRequestText(request, maximumBodyBytes);
  } catch (error) {
    if (error instanceof HttpBodyTooLargeError) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    throw error;
  }
  let verified = false;
  try {
    verified = await verifyServiceBody({
      context: operationsCopilotRecommendationSignatureContext,
      secret: requireIntelligenceHmacSecret("INTELLIGENCE_CALLBACK_SECRET"),
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
  if (result === "proposal_conflict") {
    return Response.json({ error: result }, { status: 409 });
  }
  return Response.json({ error: result }, { status: 422 });
});

type RecommendationCitation = z.infer<typeof citation>;

function sameBaseCitations(
  left: Array<{ read: string; generatedAt: number; keys: string[] }>,
  right: Array<{ read: string; generatedAt: number; keys: string[] }>,
) {
  return left.length === right.length && left.every((citation, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      citation.read === candidate.read &&
      citation.generatedAt === candidate.generatedAt &&
      citation.keys.length === candidate.keys.length &&
      citation.keys.every((key, keyIndex) => key === candidate.keys[keyIndex]);
  });
}

function sameAutonomyEvidenceSeal(
  left: OperationsAutonomyRecommendationEvidenceSeal,
  right: OperationsAutonomyRecommendationEvidenceSeal,
) {
  return left.evidenceSetId === right.evidenceSetId &&
    left.rootHash === right.rootHash &&
    left.leafCount === right.leafCount &&
    left.chunkCount === right.chunkCount &&
    left.sealedSequence === right.sealedSequence;
}

function sameRecommendationProvenance(
  left: Doc<"intelligenceRecommendations">["provenance"],
  right: Doc<"intelligenceRecommendations">["provenance"],
) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "copilot") {
    return right.kind === "copilot" &&
      left.conversationId === right.conversationId &&
      sameBaseCitations(left.citations, right.citations);
  }
  return right.kind === "autonomy" &&
    left.runId === right.runId &&
    sameAutonomyEvidenceSeal(left.evidenceSet, right.evidenceSet);
}

function sameArguments(
  left: Doc<"intelligenceRecommendations">["arguments"],
  right: ReturnType<typeof comparableArguments>,
) {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "hold_review_team":
      return right.kind === left.kind &&
        left.teamRoundStateId === right.teamRoundStateId &&
        left.expectedTeamRoundStateVersion === right.expectedTeamRoundStateVersion &&
        left.reason === right.reason;
    case "page_reserve_reviewer":
      return right.kind === left.kind &&
        left.missingPanelMemberId === right.missingPanelMemberId &&
        left.expectedPanelVersion === right.expectedPanelVersion &&
        left.reason === right.reason;
    case "dismiss_attention_item":
      return right.kind === left.kind &&
        left.itemId === right.itemId &&
        left.expectedItemVersion === right.expectedItemVersion &&
        left.reason === right.reason;
    case "open_support_case":
      return right.kind === left.kind &&
        left.category === right.category &&
        left.description === right.description &&
        left.roundId === right.roundId &&
        left.teamId === right.teamId;
  }
}

function sameRecommendationEffect(
  left: Doc<"intelligenceRecommendations">["arguments"],
  right: ReturnType<typeof comparableArguments>,
) {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "hold_review_team":
      return right.kind === left.kind &&
        left.teamRoundStateId === right.teamRoundStateId &&
        left.expectedTeamRoundStateVersion === right.expectedTeamRoundStateVersion;
    case "page_reserve_reviewer":
      return right.kind === left.kind &&
        left.missingPanelMemberId === right.missingPanelMemberId &&
        left.expectedPanelVersion === right.expectedPanelVersion;
    case "dismiss_attention_item":
      return right.kind === left.kind &&
        left.itemId === right.itemId &&
        left.expectedItemVersion === right.expectedItemVersion;
    case "open_support_case":
      return right.kind === left.kind &&
        left.category === right.category &&
        left.description === right.description &&
        left.roundId === right.roundId &&
        left.teamId === right.teamId;
  }
}

async function appendAutonomyObservation(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    recommendationId: Id<"intelligenceRecommendations">;
    runId: Id<"operationsAutonomyRuns">;
    evidenceSet: OperationsAutonomyRecommendationEvidenceSeal;
    statement: string;
    reasoning: string;
    agentVersion: string;
    model: string;
    observedAt: number;
  },
) {
  const existing = await ctx.db
    .query("intelligenceRecommendationAutonomyObservations")
    .withIndex("by_recommendation_run_set", (index) =>
      index
        .eq("recommendationId", args.recommendationId)
        .eq("runId", args.runId)
        .eq("evidenceSetId", args.evidenceSet.evidenceSetId),
    )
    .unique();
  if (existing) {
    return existing.eventId === args.eventId &&
      sameAutonomyEvidenceSeal(existing.evidenceSet, args.evidenceSet) &&
      existing.statement === args.statement &&
      existing.reasoning === args.reasoning &&
      existing.agentVersion === args.agentVersion &&
      existing.model === args.model;
  }
  await ctx.db.insert("intelligenceRecommendationAutonomyObservations", {
    eventId: args.eventId,
    recommendationId: args.recommendationId,
    runId: args.runId,
    evidenceSetId: args.evidenceSet.evidenceSetId,
    evidenceSet: args.evidenceSet,
    statement: args.statement,
    reasoning: args.reasoning,
    agentVersion: args.agentVersion,
    model: args.model,
    observedAt: args.observedAt,
  });
  return true;
}

function citationsSupportProposal(
  args: z.infer<typeof proposalArguments>,
  citations: Array<{ read: string; generatedAt: number; keys: string[] }>,
  now: number,
  requireRecentEvidence: boolean,
) {
  if (
    requireRecentEvidence &&
    citations.some(
      (entry) =>
        entry.generatedAt < now - maximumCitationAgeMs ||
        entry.generatedAt > now + maximumCitationFutureSkewMs,
    )
  ) return false;
  if (args.kind === "hold_review_team") {
    return citations.some(
      (entry) =>
        entry.read === "review_exceptions" && entry.keys.includes(args.teamRoundStateId),
    );
  }
  if (args.kind === "page_reserve_reviewer") {
    return citations.some(
      (entry) =>
        entry.read === "review_exceptions" && entry.keys.includes(args.missingPanelMemberId),
    );
  }
  if (args.kind === "dismiss_attention_item") {
    return citations.some(
      (entry) =>
        entry.read === "operations_attention" && entry.keys.includes(args.itemId),
    );
  }
  return true;
}

/** Trusts worker IDs only after table normalization and event ownership checks. */
async function normalizedArguments(
  ctx: MutationCtx,
  eventId: Id<"events">,
  args: z.infer<typeof proposalArguments>,
): Promise<Doc<"intelligenceRecommendations">["arguments"] | null> {
  if (args.kind === "hold_review_team") {
    const stateId = ctx.db.normalizeId("teamRoundStates", args.teamRoundStateId);
    const state = stateId ? await ctx.db.get(stateId) : null;
    const round = state ? await ctx.db.get(state.roundId) : null;
    if (
      !stateId ||
      !state ||
      state.eventId !== eventId ||
      !round ||
      round.eventId !== eventId ||
      round.status !== "open" ||
      !["unassigned", "queued", "called", "at_table"].includes(state.state) ||
      state.version !== args.expectedTeamRoundStateVersion
    ) return null;
    return {
      kind: "hold_review_team",
      teamRoundStateId: stateId,
      expectedTeamRoundStateVersion: args.expectedTeamRoundStateVersion,
      reason: normalizedText(args.reason, "Hold reason", 5, 500),
    };
  }
  if (args.kind === "page_reserve_reviewer") {
    const memberId = ctx.db.normalizeId("reviewPanelMembers", args.missingPanelMemberId);
    const member = memberId ? await ctx.db.get(memberId) : null;
    const panel = member ? await ctx.db.get(member.panelId) : null;
    const latestRemovedMember = member
      ? await ctx.db
          .query("reviewPanelMembers")
          .withIndex("by_panel_status_ended", (index) =>
            index.eq("panelId", member.panelId).eq("status", "removed"),
          )
          .order("desc")
          .first()
      : null;
    if (
      !memberId ||
      !member ||
      member.eventId !== eventId ||
      member.status !== "removed" ||
      !panel ||
      panel.eventId !== eventId ||
      panel.status !== "needs_reviewer" ||
      latestRemovedMember?._id !== memberId ||
      panel.version !== args.expectedPanelVersion
    ) return null;
    return {
      kind: "page_reserve_reviewer",
      missingPanelMemberId: memberId,
      expectedPanelVersion: args.expectedPanelVersion,
      reason: normalizedText(args.reason, "Paging reason", 5, 500),
    };
  }
  if (args.kind === "dismiss_attention_item") {
    const itemId = ctx.db.normalizeId("operationsAttentionItems", args.itemId);
    const item = itemId ? await ctx.db.get(itemId) : null;
    if (
      !itemId ||
      !item ||
      item.eventId !== eventId ||
      item.roundId === undefined ||
      (item.state !== "open" && item.state !== "acknowledged") ||
      item.version !== args.expectedItemVersion
    ) return null;
    return {
      kind: "dismiss_attention_item",
      itemId,
      expectedItemVersion: args.expectedItemVersion,
      reason: normalizedText(args.reason, "Dismissal reason", 5, 500),
    };
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
    description: normalizedLongText(args.description, "Support description", 10, 2_000),
    ...(roundId ? { roundId } : {}),
    ...(teamId ? { teamId } : {}),
  };
}

function comparableArguments(args: z.infer<typeof proposalArguments>) {
  switch (args.kind) {
    case "hold_review_team":
      return {
        kind: args.kind,
        teamRoundStateId: args.teamRoundStateId,
        expectedTeamRoundStateVersion: args.expectedTeamRoundStateVersion,
        reason: normalizedText(args.reason, "Hold reason", 5, 500),
      };
    case "page_reserve_reviewer":
      return {
        kind: args.kind,
        missingPanelMemberId: args.missingPanelMemberId,
        expectedPanelVersion: args.expectedPanelVersion,
        reason: normalizedText(args.reason, "Paging reason", 5, 500),
      };
    case "dismiss_attention_item":
      return {
        kind: args.kind,
        itemId: args.itemId,
        expectedItemVersion: args.expectedItemVersion,
        reason: normalizedText(args.reason, "Dismissal reason", 5, 500),
      };
    case "open_support_case":
      return {
        kind: args.kind,
        category: args.category,
        description: normalizedLongText(
          args.description,
          "Support description",
          10,
          2_000,
        ),
        ...(args.roundId !== undefined ? { roundId: args.roundId } : {}),
        ...(args.teamId !== undefined ? { teamId: args.teamId } : {}),
      };
  }
}

export async function insertIntelligenceRecommendation(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    provenance:
      | { kind: "copilot"; conversationId: string; citations: RecommendationCitation[] }
      | {
          kind: "autonomy";
          runId: Id<"operationsAutonomyRuns">;
          evidenceSet: OperationsAutonomyRecommendationEvidenceSeal;
        };
    proposal: Omit<IntelligenceRecommendationProposalInput, "citations">;
    now: number;
  },
) {
  if (
    args.provenance.kind === "copilot" &&
    (args.provenance.citations.length === 0 ||
      args.provenance.citations.some((entry) => entry.keys.length === 0))
  ) {
    return { state: "missing_citation" as const };
  }
  const proposalKey = normalizedText(args.proposal.proposalKey, "Proposal key", 8, 200);
  const statement = normalizedText(args.proposal.statement, "Statement", 10, 300);
  const reasoning = normalizedLongText(args.proposal.reasoning, "Reasoning", 10, 1_500);
  const agentVersion = normalizedText(args.proposal.agentVersion, "Agent version", 1, 80);
  const model = normalizedText(args.proposal.model, "Model", 3, 160);
  const comparable = comparableArguments(args.proposal.arguments);
  const existing = await ctx.db
    .query("intelligenceRecommendations")
    .withIndex("by_event_proposal", (index) =>
      index.eq("eventId", args.event._id).eq("proposalKey", proposalKey),
    )
    .unique();
  if (existing) {
    const exactReplay = sameRecommendationProvenance(existing.provenance, args.provenance) &&
      sameArguments(existing.arguments, comparable) &&
      existing.statement === statement &&
      existing.reasoning === reasoning &&
      existing.agentVersion === agentVersion &&
      existing.model === model;
    const repeatedAutonomyEffect =
      existing.provenance.kind === "autonomy" &&
      args.provenance.kind === "autonomy" &&
      sameRecommendationEffect(existing.arguments, comparable);
    if (exactReplay || repeatedAutonomyEffect) {
      if (args.provenance.kind === "autonomy") {
        const attached = await appendAutonomyObservation(ctx, {
          eventId: args.event._id,
          recommendationId: existing._id,
          runId: args.provenance.runId,
          evidenceSet: args.provenance.evidenceSet,
          statement,
          reasoning,
          agentVersion,
          model,
          observedAt: args.now,
        });
        if (!attached) return { state: "proposal_conflict" as const };
      }
      return { state: "already_exists" as const, recommendationId: existing._id };
    }
    return { state: "proposal_conflict" as const };
  }
  if (
    args.provenance.kind === "copilot" &&
    !citationsSupportProposal(
      args.proposal.arguments,
      args.provenance.citations,
      args.now,
      true,
    )
  ) {
    return { state: "invalid_citation" as const };
  }
  const normalized = await normalizedArguments(ctx, args.event._id, args.proposal.arguments);
  if (!normalized) return { state: "invalid_target" as const };
  const effectKey = operationFingerprint(recommendationEffectFingerprint(normalized));
  const existingEffect = await ctx.db
    .query("intelligenceRecommendations")
    .withIndex("by_event_effect_status", (index) =>
      index.eq("eventId", args.event._id).eq("effectKey", effectKey).eq("status", "proposed"),
    )
    .unique();
  if (existingEffect) {
    if (args.provenance.kind === "autonomy") {
      const attached = await appendAutonomyObservation(ctx, {
        eventId: args.event._id,
        recommendationId: existingEffect._id,
        runId: args.provenance.runId,
        evidenceSet: args.provenance.evidenceSet,
        statement,
        reasoning,
        agentVersion,
        model,
        observedAt: args.now,
      });
      if (!attached) return { state: "proposal_conflict" as const };
    }
    return { state: "already_exists" as const, recommendationId: existingEffect._id };
  }
  const recommendationId = await ctx.db.insert("intelligenceRecommendations", {
    eventId: args.event._id,
    proposalKey,
    effectKey,
    provenance: args.provenance,
    arguments: normalized,
    statement,
    reasoning,
    status: "proposed",
    agentVersion,
    model,
    proposedAt: args.now,
    version: 1,
    createdAt: args.now,
    updatedAt: args.now,
  });
  if (args.provenance.kind === "autonomy") {
    await appendAutonomyObservation(ctx, {
      eventId: args.event._id,
      recommendationId,
      runId: args.provenance.runId,
      evidenceSet: args.provenance.evidenceSet,
      statement,
      reasoning,
      agentVersion,
      model,
      observedAt: args.now,
    });
  }
  return { state: "accepted" as const, recommendationId };
}

function recommendationEffectFingerprint(
  args: Doc<"intelligenceRecommendations">["arguments"],
) {
  switch (args.kind) {
    case "hold_review_team":
      return [args.kind, args.teamRoundStateId, args.expectedTeamRoundStateVersion];
    case "page_reserve_reviewer":
      return [args.kind, args.missingPanelMemberId, args.expectedPanelVersion];
    case "dismiss_attention_item":
      return [args.kind, args.itemId, args.expectedItemVersion];
    case "open_support_case":
      return [args.kind, args.category, args.description, args.roundId ?? null, args.teamId ?? null];
  }
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
          expectedTeamRoundStateVersion: v.number(),
          reason: v.string(),
        }),
        v.object({
          kind: v.literal("page_reserve_reviewer"),
          missingPanelMemberId: v.string(),
          expectedPanelVersion: v.number(),
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
          expectedItemVersion: v.number(),
          reason: v.string(),
        }),
      ),
    }),
  },
  returns: v.union(
    v.literal("accepted"),
    v.literal("already_exists"),
    v.literal("proposal_conflict"),
    v.literal("event_not_found"),
    v.literal("invalid_target"),
    v.literal("missing_citation"),
    v.literal("invalid_citation"),
  ),
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) =>
        index.eq("slug", args.proposal.eventSlug.trim().toLowerCase()),
      )
      .unique();
    if (!event) return "event_not_found";
    const now = Date.now();
    const conversationId = normalizedText(
      args.proposal.conversationId,
      "Conversation ID",
      1,
      200,
    );
    const result = await insertIntelligenceRecommendation(ctx, {
      event,
      provenance: {
        kind: "copilot",
        conversationId,
        citations: args.proposal.citations,
      },
      proposal: {
        proposalKey: args.proposal.proposalKey,
        agentVersion: args.proposal.agentVersion,
        model: args.proposal.model,
        statement: args.proposal.statement,
        reasoning: args.proposal.reasoning,
        arguments: args.proposal.arguments,
      },
      now,
    });
    return result.state;
  },
});

const recommendationView = v.object({
  id: v.id("intelligenceRecommendations"),
  arguments: intelligenceRecommendationArguments,
  statement: v.string(),
  reasoning: v.string(),
  provenance: v.union(
    v.object({
      kind: v.literal("copilot"),
      conversationId: v.string(),
      citations: v.array(intelligenceRecommendationCitation),
    }),
    v.object({
      kind: v.literal("autonomy"),
      runId: v.id("operationsAutonomyRuns"),
      evidenceSet: operationsAutonomyRecommendationEvidenceSeal,
    }),
  ),
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

async function requireRecommendationReadAccess(ctx: QueryCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "operations.intelligence.read",
    scopeType: "event",
  });
  return event;
}

function requireRecommendationPageSize(numItems: number) {
  if (numItems < 1 || numItems > maximumRecommendationPageSize) {
    throw new ConvexError({
      code: "INVALID_PAGE_SIZE",
      message: `Recommendation pages must contain between 1 and ${maximumRecommendationPageSize} rows.`,
    });
  }
}

/** Oldest-first so every pending human decision remains reachable without starvation. */
export const proposed = query({
  args: {
    eventSlug: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(recommendationView),
  handler: async (ctx, args) => {
    const event = await requireRecommendationReadAccess(ctx, args.eventSlug);
    requireRecommendationPageSize(args.paginationOpts.numItems);
    const page = await ctx.db
      .query("intelligenceRecommendations")
      .withIndex("by_event_status_proposed", (index) =>
        index.eq("eventId", event._id).eq("status", "proposed"),
      )
      .order("asc")
      .paginate(args.paginationOpts);
    return { ...page, page: page.page.map(recommendationViewFromDocument) };
  },
});

/** Newest-first terminal history, independently paginated from pending work. */
export const settled = query({
  args: {
    eventSlug: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(recommendationView),
  handler: async (ctx, args) => {
    const event = await requireRecommendationReadAccess(ctx, args.eventSlug);
    requireRecommendationPageSize(args.paginationOpts.numItems);
    const page = await ctx.db
      .query("intelligenceRecommendations")
      .withIndex("by_event_decided_at", (index) =>
        index.eq("eventId", event._id).gt("decidedAt", 0),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...page, page: page.page.map(recommendationViewFromDocument) };
  },
});

export const detail = query({
  args: {
    eventSlug: v.string(),
    recommendationId: v.id("intelligenceRecommendations"),
  },
  returns: v.union(v.null(), recommendationView),
  handler: async (ctx, args) => {
    const event = await requireRecommendationReadAccess(ctx, args.eventSlug);
    const row = await ctx.db.get(args.recommendationId);
    if (!row || row.eventId !== event._id) return null;
    return recommendationViewFromDocument(row);
  },
});

function recommendationViewFromDocument(row: Doc<"intelligenceRecommendations">) {
  return {
    id: row._id,
    arguments: row.arguments,
    statement: row.statement,
    reasoning: row.reasoning,
    provenance: row.provenance,
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
  };
}

type KindAuthorization = {
  permissionKey: PermissionKey;
  grantIds: Id<"permissionGrants">[];
  scopeType: Doc<"permissionGrants">["scopeType"];
  scopeId?: string;
};

/** Proposal triage requires the same grant as the underlying command. */
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
  const item = await ctx.db.get(args.itemId);
  if (!item || item.eventId !== event._id || item.roundId === undefined) {
    throw new ConvexError({
      code: "RECOMMENDATION_TARGET_GONE",
      message: "The attention item this recommendation names is no longer available.",
    });
  }
  await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subjectId,
    permissionKey: assertPermissionKey(item.visibility.permissionKey),
    scopeType: item.visibility.scopeType,
    scopeId: item.visibility.scopeId,
  });
  return { permissionKey: "operations.attention.manage", grantIds, scopeType: "event" };
}

// Replays still require the current grant for the exact underlying command.
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
  const recommendation = await ctx.db.get(args.recommendationId);
  if (!recommendation || recommendation.eventId !== event._id) {
    throw new ConvexError({
      code: "RECOMMENDATION_NOT_FOUND",
      message: "That recommendation is unavailable.",
    });
  }
  const authorization = await requireKindAuthorization(ctx, event, subject._id, recommendation);
  const prior = await findOperation(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    ...operation,
  });
  if (prior) {
    return { event, person, recommendation, authorization, prior } as const;
  }
  if (recommendation.status !== "proposed" || recommendation.version !== args.expectedVersion) {
    throw new ConvexError({
      code: "RECOMMENDATION_CHANGED",
      message: "That recommendation was already decided or changed. Refresh before continuing.",
    });
  }
  return { event, person, recommendation, authorization, prior: null } as const;
}

/** Derives an idempotency key shared by all operators and retries. */
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
      expectedVersion: args.expectedTeamRoundStateVersion,
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
      expectedPanelVersion: args.expectedPanelVersion,
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
    expectedVersion: args.expectedItemVersion,
    reason: args.reason,
    clientOperationId,
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

/** Stores revision guidance on the superseded recommendation for later agent context. */
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
