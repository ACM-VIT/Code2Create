import { ConvexError, v } from "convex/values";

import type { OperationsBriefPriority, OperationsHealthSnapshot } from "@code2create/domain";

import { internal } from "./_generated/api";
import type { DataModel, Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import {
  operationsBriefPriority,
  operationsHealthSnapshot,
  operationsIntelligenceCallback,
} from "./lib/operationsIntelligenceValidators";
import { requirePermission } from "./lib/permissions";
import { settleAutomationSignal } from "./operationsIntelligenceAutomation";
import { normalizedText } from "./lib/strings";
import { intelligenceWorkpool } from "./workpools";

const agentCompletionWindowMs = 10 * 60 * 1_000;
const briefIdValidator = v.id("operationsIntelligenceBriefs");
const briefView = v.object({
  id: v.id("operationsIntelligenceBriefs"),
  origin: v.union(v.literal("manual"), v.literal("automation")),
  accountableOwner: v.optional(v.string()),
  relevanceExpiresAt: v.optional(v.number()),
  state: v.union(
    v.literal("pending"),
    v.literal("dispatching"),
    v.literal("accepted"),
    v.literal("succeeded"),
    v.literal("failed"),
  ),
  sourceGeneratedAt: v.optional(v.number()),
  headline: v.optional(v.string()),
  summary: v.optional(v.string()),
  priorities: v.array(operationsBriefPriority),
  failureCode: v.optional(
    v.union(
      v.literal("dispatch_failed"),
      v.literal("agent_timed_out"),
      v.literal("model_did_not_publish"),
      v.literal("callback_rejected"),
    ),
  ),
  requestedAt: v.number(),
  workerAcceptedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  agentVersion: v.optional(v.string()),
  model: v.optional(v.string()),
});

function isActiveBrief(state: Doc<"operationsIntelligenceBriefs">["state"]) {
  return state === "pending" || state === "dispatching" || state === "accepted";
}

function normalizedModelText(value: string, label: string, minimum: number, maximum: number) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ConvexError({
      code: "INTELLIGENCE_CALLBACK_INVALID",
      message: `${label} must be between ${minimum} and ${maximum} characters.`,
    });
  }
  return normalized;
}

function severityRank(value: OperationsBriefPriority["severity"]) {
  if (value === "critical") return 3;
  if (value === "attention") return 2;
  return 1;
}

function validatePriorities(
  priorities: OperationsBriefPriority[],
  snapshot: OperationsHealthSnapshot,
) {
  if (priorities.length > 3) {
    throw new ConvexError({
      code: "INTELLIGENCE_CALLBACK_INVALID",
      message: "An operations brief can contain at most three priorities.",
    });
  }
  const signals = new Map(snapshot.signals.map((signal) => [signal.key, signal]));
  const citedKeys = new Set<string>();
  return priorities.map((priority) => {
    if (priority.signalKeys.length === 0 || priority.signalKeys.length > 6) {
      throw new ConvexError({
        code: "INTELLIGENCE_CALLBACK_INVALID",
        message: "Each priority must cite between one and six current health signals.",
      });
    }
    const citedSignals = priority.signalKeys.map((key) => {
      if (citedKeys.has(key)) {
        throw new ConvexError({
          code: "INTELLIGENCE_CALLBACK_INVALID",
          message: "A current health signal can support only one brief priority.",
        });
      }
      const signal = signals.get(key);
      if (!signal) {
        throw new ConvexError({
          code: "INTELLIGENCE_CALLBACK_INVALID",
          message: "A priority cited a signal outside its frozen source snapshot.",
        });
      }
      citedKeys.add(key);
      return signal;
    });
    const highestSeverity = citedSignals.reduce(
      (current, signal) =>
        severityRank(signal.severity) > severityRank(current) ? signal.severity : current,
      citedSignals[0]?.severity ?? "watch",
    );
    if (priority.severity !== highestSeverity) {
      throw new ConvexError({
        code: "INTELLIGENCE_CALLBACK_INVALID",
        message: "A priority cannot downgrade or inflate the severity of its cited signals.",
      });
    }
    const owner = normalizedModelText(priority.owner, "Priority owner", 2, 80);
    if (!citedSignals.some((signal) => signal.owner === owner)) {
      throw new ConvexError({
        code: "INTELLIGENCE_CALLBACK_INVALID",
        message: "A priority owner must come from one of its cited health signals.",
      });
    }
    const nextAction = normalizedModelText(
      priority.nextAction,
      "Priority next action",
      4,
      240,
    );
    if (!citedSignals.some((signal) => signal.nextAction === nextAction)) {
      throw new ConvexError({
        code: "INTELLIGENCE_CALLBACK_INVALID",
        message: "A priority next action must come from one of its cited health signals.",
      });
    }
    return {
      severity: priority.severity,
      title: normalizedModelText(priority.title, "Priority title", 3, 120),
      why: normalizedModelText(priority.why, "Priority explanation", 8, 300),
      owner,
      nextAction,
      signalKeys: priority.signalKeys,
    };
  });
}

export const latest = query({
  args: { eventSlug: v.string() },
  returns: v.union(v.null(), briefView),
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
    const brief = await ctx.db
      .query("operationsIntelligenceBriefs")
      .withIndex("by_event_requested", (index) => index.eq("eventId", event._id))
      .order("desc")
      .first();
    if (!brief) return null;
    const automationPolicy = brief.automationPolicyVersionId
      ? await ctx.db.get(brief.automationPolicyVersionId)
      : null;
    if (
      brief.origin === "automation" &&
      (!automationPolicy || automationPolicy.eventId !== event._id)
    ) {
      throw new Error("The proactive intelligence brief has no valid policy provenance.");
    }
    return {
      id: brief._id,
      origin: brief.origin,
      ...(automationPolicy
        ? { accountableOwner: automationPolicy.accountableOwner }
        : {}),
      ...(brief.relevanceExpiresAt !== undefined
        ? { relevanceExpiresAt: brief.relevanceExpiresAt }
        : {}),
      state: brief.state,
      ...(brief.sourceSnapshot
        ? { sourceGeneratedAt: brief.sourceSnapshot.generatedAt }
        : {}),
      ...(brief.headline ? { headline: brief.headline } : {}),
      ...(brief.summary ? { summary: brief.summary } : {}),
      priorities: brief.priorities ?? [],
      ...(brief.failureCode ? { failureCode: brief.failureCode } : {}),
      requestedAt: brief.requestedAt,
      ...(brief.workerAcceptedAt ? { workerAcceptedAt: brief.workerAcceptedAt } : {}),
      ...(brief.completedAt ? { completedAt: brief.completedAt } : {}),
      ...(brief.agentVersion ? { agentVersion: brief.agentVersion } : {}),
      ...(brief.model ? { model: brief.model } : {}),
    };
  },
});

export const generationFinished = intelligenceWorkpool.defineOnComplete<
  DataModel,
  typeof briefIdValidator
>({
  context: briefIdValidator,
  handler: async (ctx, { context: briefId, result }) => {
    if (result.kind === "success") return;
    const brief = await ctx.db.get(briefId);
    if (!brief || !isActiveBrief(brief.state) || brief.state === "accepted") return;
    const now = Date.now();
    await ctx.db.patch(brief._id, {
      state: "failed",
      failureCode: "dispatch_failed",
      completedAt: now,
      updatedAt: now,
      version: brief.version + 1,
    });
    await settleAutomationSignal(ctx, brief, "failed", now);
  },
});

export const request = mutation({
  args: { eventSlug: v.string(), clientOperationId: v.string() },
  returns: v.object({ briefId: v.id("operationsIntelligenceBriefs") }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const clientOperationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      8,
      120,
    );
    const requestFingerprint = operationFingerprint([event._id]);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "operations.intelligence.generate",
      scopeType: "event",
    });
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "operations.intelligence.generate",
      requestFingerprint,
    });
    if (prior) {
      const briefId = ctx.db.normalizeId("operationsIntelligenceBriefs", prior.targetId);
      const brief = briefId ? await ctx.db.get(briefId) : null;
      if (!brief || brief.eventId !== event._id) {
        throw new Error("The prior operations-intelligence request no longer resolves.");
      }
      return { briefId: brief._id };
    }
    const latestBrief = await ctx.db
      .query("operationsIntelligenceBriefs")
      .withIndex("by_event_requested", (index) => index.eq("eventId", event._id))
      .order("desc")
      .first();
    if (latestBrief && isActiveBrief(latestBrief.state)) {
      throw new ConvexError({
        code: "INTELLIGENCE_BRIEF_IN_PROGRESS",
        message: "The current operations brief is still being prepared.",
      });
    }
    const now = Date.now();
    const briefId = await ctx.db.insert("operationsIntelligenceBriefs", {
      eventId: event._id,
      requestedByPersonId: person._id,
      origin: "manual",
      state: "pending",
      requestedAt: now,
      updatedAt: now,
      version: 1,
    });
    const workId = await intelligenceWorkpool.enqueueAction(
      ctx,
      internal.operationsIntelligenceActions.dispatchBrief,
      { briefId },
      {
        retry: true,
        onComplete: internal.operationsIntelligence.generationFinished,
        context: briefId,
      },
    );
    await ctx.db.patch(briefId, { workId });
    await ctx.scheduler.runAfter(
      agentCompletionWindowMs,
      internal.operationsIntelligence.expire,
      { briefId },
    );
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "operations.intelligence.generate",
      requestFingerprint,
      targetType: "operations_intelligence_brief",
      targetId: briefId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "operations.intelligence.generate",
      grantIds,
      scopeType: "event",
      action: "operations.intelligence_brief_requested",
      targetType: "operations_intelligence_brief",
      targetId: briefId,
      nextSummary: JSON.stringify({ state: "pending" }),
      reason: "Generate a bounded brief from the current operations-health projection",
    });
    return { briefId };
  },
});

export const beginDispatch = internalMutation({
  args: {
    briefId: v.id("operationsIntelligenceBriefs"),
    snapshot: operationsHealthSnapshot,
    sourceChecksum: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      briefId: v.id("operationsIntelligenceBriefs"),
      sourceChecksum: v.string(),
      snapshot: operationsHealthSnapshot,
    }),
  ),
  handler: async (ctx, args) => {
    const brief = await ctx.db.get(args.briefId);
    if (!brief || brief.state === "accepted" || !isActiveBrief(brief.state)) return null;
    if (brief.sourceSnapshot && brief.sourceChecksum) {
      if (brief.state === "pending") {
        await ctx.db.patch(brief._id, {
          state: "dispatching",
          updatedAt: Date.now(),
          version: brief.version + 1,
        });
      }
      return {
        briefId: brief._id,
        sourceChecksum: brief.sourceChecksum,
        snapshot: brief.sourceSnapshot,
      };
    }
    if (brief.sourceSnapshot || brief.sourceChecksum) {
      throw new Error("The intelligence source snapshot is incomplete.");
    }
    const now = Date.now();
    await ctx.db.patch(brief._id, {
      state: "dispatching",
      sourceSnapshot: args.snapshot,
      sourceChecksum: args.sourceChecksum,
      updatedAt: now,
      version: brief.version + 1,
    });
    return {
      briefId: brief._id,
      sourceChecksum: args.sourceChecksum,
      snapshot: args.snapshot,
    };
  },
});

export const dispatchContext = internalQuery({
  args: { briefId: v.id("operationsIntelligenceBriefs") },
  returns: v.union(
    v.null(),
    v.object({
      eventId: v.id("events"),
      sourceSnapshot: v.optional(operationsHealthSnapshot),
      sourceChecksum: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const brief = await ctx.db.get(args.briefId);
    if (!brief || brief.state === "accepted" || !isActiveBrief(brief.state)) return null;
    return {
      eventId: brief.eventId,
      ...(brief.sourceSnapshot ? { sourceSnapshot: brief.sourceSnapshot } : {}),
      ...(brief.sourceChecksum ? { sourceChecksum: brief.sourceChecksum } : {}),
    };
  },
});

export const markAccepted = internalMutation({
  args: {
    briefId: v.id("operationsIntelligenceBriefs"),
    workerSubmissionId: v.optional(v.string()),
    workerAcceptedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const brief = await ctx.db.get(args.briefId);
    if (!brief || brief.state !== "dispatching") return null;
    await ctx.db.patch(brief._id, {
      state: "accepted",
      ...(args.workerSubmissionId
        ? { workerSubmissionId: args.workerSubmissionId }
        : {}),
      workerAcceptedAt: args.workerAcceptedAt,
      updatedAt: Date.now(),
      version: brief.version + 1,
    });
    return null;
  },
});

export const completeFromWorker = internalMutation({
  args: { callback: operationsIntelligenceCallback },
  returns: v.union(
    v.literal("accepted"),
    v.literal("already_settled"),
    v.literal("not_found"),
    v.literal("stale"),
  ),
  handler: async (ctx, args) => {
    const briefId = ctx.db.normalizeId("operationsIntelligenceBriefs", args.callback.briefId);
    const brief = briefId ? await ctx.db.get(briefId) : null;
    if (!brief) return "not_found";
    if (!brief.sourceChecksum || brief.sourceChecksum !== args.callback.sourceChecksum) {
      return "stale";
    }
    if (brief.state === "succeeded" || brief.state === "failed") {
      return "already_settled";
    }
    if (!brief.sourceSnapshot) throw new Error("The intelligence brief has no frozen source.");
    const now = Date.now();
    const agentVersion = normalizedModelText(
      args.callback.agentVersion,
      "Agent version",
      1,
      80,
    );
    const model = normalizedModelText(args.callback.model, "Model", 3, 160);
    if (args.callback.status === "failed") {
      await ctx.db.patch(brief._id, {
        state: "failed",
        failureCode: args.callback.failureCode,
        agentVersion,
        model,
        completedAt: now,
        updatedAt: now,
        version: brief.version + 1,
      });
      await settleAutomationSignal(ctx, brief, "failed", now);
      return "accepted";
    }
    const priorities = validatePriorities(args.callback.priorities, brief.sourceSnapshot);
    await ctx.db.patch(brief._id, {
      state: "succeeded",
      headline: normalizedModelText(args.callback.headline, "Brief headline", 3, 100),
      summary: normalizedModelText(args.callback.summary, "Brief summary", 10, 600),
      priorities,
      agentVersion,
      model,
      completedAt: now,
      updatedAt: now,
      version: brief.version + 1,
    });
    await settleAutomationSignal(ctx, brief, "succeeded", now);
    return "accepted";
  },
});

export const expire = internalMutation({
  args: { briefId: v.id("operationsIntelligenceBriefs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const brief = await ctx.db.get(args.briefId);
    if (!brief || !isActiveBrief(brief.state)) return null;
    const now = Date.now();
    const expiresAt = brief.requestedAt + agentCompletionWindowMs;
    if (now < expiresAt) {
      await ctx.scheduler.runAfter(expiresAt - now, internal.operationsIntelligence.expire, args);
      return null;
    }
    await ctx.db.patch(brief._id, {
      state: "failed",
      failureCode: brief.state === "accepted" ? "agent_timed_out" : "dispatch_failed",
      completedAt: now,
      updatedAt: now,
      version: brief.version + 1,
    });
    await settleAutomationSignal(ctx, brief, "failed", now);
    return null;
  },
});
