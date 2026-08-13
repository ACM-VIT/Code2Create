import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { internalQuery, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  enqueueOperationsAutonomyManual,
} from "./lib/operationsAutonomyInbox";
import {
  activateOperationsAutonomyRun,
  materializeOperationsAutonomyInboxRun,
} from "./lib/operationsAutonomyRunCreation";
import {
  operationsAutonomyFailureCode,
  operationsAutonomyReadTool,
  operationsAutonomyRunPhase,
} from "./lib/operationsAutonomyValidators";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import { eventStatus } from "./values";

const maximumPublicPageSize = 20;

const triggerView = v.union(
  v.object({
    kind: v.literal("manual"),
    requestedByPersonId: v.id("people"),
    clientOperationId: v.string(),
  }),
  v.object({ kind: v.literal("schedule"), scheduledFor: v.number() }),
  v.object({
    kind: v.literal("signal"),
    fingerprint: v.string(),
    signalKeys: v.array(v.string()),
  }),
);

const runView = v.object({
  runId: v.id("operationsAutonomyRuns"),
  trigger: triggerView,
  state: v.union(
    v.literal("pending"),
    v.literal("leased"),
    v.literal("accepted"),
    v.literal("running"),
    v.literal("succeeded"),
    v.literal("no_op"),
    v.literal("escalated"),
    v.literal("failed"),
    v.literal("canceled"),
  ),
  phase: operationsAutonomyRunPhase,
  telemetry: v.object({
    toolCalls: v.number(),
    delegations: v.number(),
    readBytes: v.number(),
    recommendations: v.number(),
  }),
  policyVersion: v.number(),
  policyChecksum: v.string(),
  mode: v.union(v.literal("observe"), v.literal("recommend")),
  sourceGeneratedAt: v.number(),
  sourceChecksum: v.string(),
  sourceFactHighWatermarks: v.array(
    v.object({ read: operationsAutonomyReadTool, sequence: v.number() }),
  ),
  createdAt: v.number(),
  updatedAt: v.number(),
  acceptedAt: v.optional(v.number()),
  agentVersion: v.optional(v.string()),
  model: v.optional(v.string()),
  cancellationReason: v.optional(
    v.union(
      v.literal("kill_switch"),
      v.literal("policy_superseded"),
      v.literal("owner_revoked"),
      v.literal("event_not_live"),
    ),
  ),
  failureCode: v.optional(v.union(operationsAutonomyFailureCode, v.literal("dispatch_failed"))),
  shutdownState: v.union(
    v.literal("not_required"),
    v.literal("pending"),
    v.literal("abort_recorded"),
  ),
  hasStream: v.boolean(),
});

function publicRunState(run: Doc<"operationsAutonomyRuns">) {
  if (run.lifecycle.kind !== "active") return run.lifecycle.kind;
  if (run.admission.kind !== "accepted") return "leased" as const;
  return run.executor.kind === "known" ? "running" as const : "accepted" as const;
}

function runProjection(
  run: Doc<"operationsAutonomyRuns">,
  checkpoint: Doc<"operationsAutonomyRunCheckpoints">,
  supervision: Doc<"operationsAutonomyRunSupervision"> | null,
) {
  if (
    supervision === null &&
    !(
      run.lifecycle.kind === "canceled" &&
      run.lifecycle.reason === "event_not_live" &&
      run.admission.kind === "not_accepted" &&
      run.executor.kind === "unknown" &&
      run.attemptCount === 0
    )
  ) {
    throw new Error("An activated autonomy run is missing supervision state.");
  }
  return {
    runId: run._id,
    trigger: run.trigger,
    state: publicRunState(run),
    phase: checkpoint.phase,
    telemetry: {
      toolCalls: checkpoint.toolCallsUsed,
      delegations: checkpoint.delegationsUsed,
      readBytes: checkpoint.readBytesUsed,
      recommendations: checkpoint.recommendationsProposed,
    },
    policyVersion: run.policyVersion,
    policyChecksum: run.policyChecksum,
    mode: run.mode,
    sourceGeneratedAt: run.sourceSnapshot.generatedAt,
    sourceChecksum: run.sourceChecksum,
    sourceFactHighWatermarks: run.sourceFactHighWatermarks,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.admission.kind === "accepted" ? { acceptedAt: run.admission.acceptedAt } : {}),
    ...(run.executor.kind === "known"
      ? { agentVersion: run.executor.agentVersion, model: run.executor.model }
      : {}),
    ...(run.lifecycle.kind === "canceled"
      ? { cancellationReason: run.lifecycle.reason }
      : {}),
    ...(run.lifecycle.kind === "failed" ? { failureCode: run.lifecycle.failureCode } : {}),
    shutdownState:
      supervision?.lifecycle.kind === "abort_pending"
        ? "pending" as const
        : supervision !== null && run.lifecycle.kind === "canceled"
          ? "abort_recorded" as const
          : "not_required" as const,
    hasStream: run.admission.kind === "accepted",
  };
}

async function authorizedEvent(ctx: Parameters<typeof requireEventBySlug>[0], eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "operations.intelligence.read",
    scopeType: "event",
  });
  return { event, person, subject };
}

const startResult = v.union(
  v.object({
    state: v.literal("queued"),
    workItemId: v.id("operationsAutonomyInbox"),
    createdAt: v.number(),
  }),
  v.object({
    state: v.literal("started"),
    workItemId: v.id("operationsAutonomyInbox"),
    runId: v.id("operationsAutonomyRuns"),
    instanceId: v.string(),
    createdAt: v.number(),
  }),
);

function parsedStartResult(
  ctx: Parameters<typeof requireEventBySlug>[0],
  resultJson: string | undefined,
) {
  if (resultJson === undefined) throw new Error("The prior manual autonomy result is missing.");
  const value: unknown = JSON.parse(resultJson);
  if (typeof value !== "object" || value === null || !("state" in value)) {
    throw new Error("The prior manual autonomy result is invalid.");
  }
  if (
    !("workItemId" in value) || typeof value.workItemId !== "string" ||
    !("createdAt" in value) || typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt)
  ) {
    throw new Error("The prior manual autonomy result is invalid.");
  }
  const workItemId = ctx.db.normalizeId("operationsAutonomyInbox", value.workItemId);
  if (!workItemId) throw new Error("The prior manual autonomy work item ID is invalid.");
  if (value.state === "queued") {
    return { state: "queued" as const, workItemId, createdAt: value.createdAt };
  }
  if (
    value.state !== "started" || !("runId" in value) || typeof value.runId !== "string" ||
    !("instanceId" in value) || typeof value.instanceId !== "string"
  ) {
    throw new Error("The prior manual autonomy result is invalid.");
  }
  const runId = ctx.db.normalizeId("operationsAutonomyRuns", value.runId);
  if (!runId || value.instanceId !== runId) {
    throw new Error("The prior manual autonomy run coordinates are invalid.");
  }
  return {
    state: "started" as const,
    workItemId,
    runId,
    instanceId: runId,
    createdAt: value.createdAt,
  };
}

export const startManual = mutation({
  args: { eventSlug: v.string(), clientOperationId: v.string() },
  returns: startResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "operations.intelligence.generate",
      scopeType: "event",
    });
    const clientOperationId = normalizedText(args.clientOperationId, "Operation ID", 8, 120);
    const requestFingerprint = operationFingerprint([event._id, "manual"]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "operations.autonomy.start_manual",
      requestFingerprint,
    });
    if (prior) {
      return parsedStartResult(ctx, prior.resultJson);
    }
    if (event.status !== "live") {
      throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_EVENT_NOT_LIVE",
        message: "Autonomous operations can run only while the event is live.",
      });
    }
    const [policy, source] = await Promise.all([
      ctx.db
        .query("operationsAutonomyPolicyVersions")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", event._id).eq("status", "published"),
        )
        .unique(),
      ctx.db
        .query("operationsHealthSnapshots")
        .withIndex("by_event", (index) => index.eq("eventId", event._id))
        .unique(),
    ]);
    if (!policy || !policy.enabled) {
      throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_DISABLED",
        message: "Autonomous operations are disabled for this event.",
      });
    }
    if (!source) {
      throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_SOURCE_MISSING",
        message: "Generate operations health before starting autonomous work.",
      });
    }
    const now = Date.now();
    const inbox = await enqueueOperationsAutonomyManual(ctx, {
      eventId: event._id,
      policy,
      snapshot: source.snapshot,
      requestedByPersonId: person._id,
      clientOperationId,
      now,
    });
    if (!inbox) {
      throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_DISABLED",
        message: "Autonomous operations were disabled before this work could be queued.",
      });
    }
    const occupied = await Promise.all([
      ctx.db
        .query("operationsAutonomyRuns")
        .withIndex("by_event_policy_lifecycle", (index) =>
          index
            .eq("eventId", event._id)
            .eq("policyVersionId", policy._id)
            .eq("lifecycle.kind", "active"),
        )
        .first(),
      ctx.db
        .query("operationsAutonomyRuns")
        .withIndex("by_event_policy_lifecycle", (index) =>
          index
            .eq("eventId", event._id)
            .eq("policyVersionId", policy._id)
            .eq("lifecycle.kind", "pending"),
        )
        .first(),
    ]);
    const run = occupied.some((candidate) => candidate !== null)
      ? null
      : await materializeOperationsAutonomyInboxRun(ctx, inbox, now);
    const started = run ? await activateOperationsAutonomyRun(ctx, run, now) : false;
    const result = started && run
      ? {
          state: "started" as const,
          workItemId: inbox._id,
          runId: run._id,
          instanceId: run._id,
          createdAt: run.createdAt,
        }
      : { state: "queued" as const, workItemId: inbox._id, createdAt: inbox.createdAt };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "operations.autonomy.start_manual",
      requestFingerprint,
      targetType: "operations_autonomy_work_item",
      targetId: inbox._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "operations.intelligence.generate",
      grantIds,
      scopeType: "event",
      action: "operations.autonomy_manual_work_queued",
      targetType: "operations_autonomy_work_item",
      targetId: inbox._id,
      nextSummary: JSON.stringify({ state: result.state, policyVersionId: policy._id }),
      reason: "Operator requested an autonomous operations cycle.",
    });
    return result;
  },
});

export const status = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    eventStatus,
    canStart: v.boolean(),
    policy: v.object({
      policyVersionId: v.id("operationsAutonomyPolicyVersions"),
      policyVersion: v.number(),
      checksum: v.string(),
      enabled: v.boolean(),
      mode: v.union(v.literal("observe"), v.literal("recommend")),
    }),
    scheduler: v.object({
      lifecycle: v.union(v.literal("active"), v.literal("disabled")),
      version: v.number(),
      nextEvaluationAt: v.number(),
      queuedWorkCount: v.number(),
    }),
    activeRun: v.union(v.null(), runView),
  }),
  handler: async (ctx, args) => {
    const { event } = await authorizedEvent(ctx, args.eventSlug);
    const policy = await ctx.db
      .query("operationsAutonomyPolicyVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "published"),
      )
      .unique();
    if (!policy) throw new Error("The event has no published autonomy policy.");
    const state = await ctx.db
      .query("operationsAutonomyStates")
      .withIndex("by_policy", (index) => index.eq("policyVersionId", policy._id))
      .unique();
    if (!state || state.lifecycle.kind === "superseded") {
      throw new Error("The event's autonomy scheduler state is invalid.");
    }
    const activeRows = await ctx.db
      .query("operationsAutonomyRuns")
      .withIndex("by_event_policy_lifecycle", (index) =>
        index
          .eq("eventId", event._id)
          .eq("policyVersionId", policy._id)
          .eq("lifecycle.kind", "active"),
      )
      .take(2);
    if (activeRows.length > 1) throw new Error("The event has multiple active autonomy runs.");
    const active = activeRows[0];
    const [checkpoint, supervision] = active
      ? await Promise.all([
          ctx.db
            .query("operationsAutonomyRunCheckpoints")
            .withIndex("by_run", (index) => index.eq("runId", active._id))
            .unique(),
          ctx.db
            .query("operationsAutonomyRunSupervision")
            .withIndex("by_run", (index) => index.eq("runId", active._id))
            .unique(),
        ])
      : [null, null];
    if (active && (!checkpoint || !supervision)) {
      throw new Error("The active autonomy run state is incomplete.");
    }
    return {
      eventStatus: event.status,
      canStart:
        event.status === "live" && policy.enabled && state.lifecycle.kind === "active",
      policy: {
        policyVersionId: policy._id,
        policyVersion: policy.version,
        checksum: policy.checksum,
        enabled: policy.enabled,
        mode: policy.mode,
      },
      scheduler: {
        lifecycle: state.lifecycle.kind,
        version: state.version,
        nextEvaluationAt: state.nextEvaluationAt,
        queuedWorkCount: state.pendingWorkCount,
      },
      activeRun: active && checkpoint && supervision
        ? runProjection(active, checkpoint, supervision)
        : null,
    };
  },
});

export const history = query({
  args: { eventSlug: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(runView),
  handler: async (ctx, args) => {
    if (args.paginationOpts.numItems > maximumPublicPageSize) {
      throw new ConvexError({
        code: "PAGINATION_LIMIT_EXCEEDED",
        message: `Autonomy history pages may contain at most ${maximumPublicPageSize} runs.`,
      });
    }
    const { event } = await authorizedEvent(ctx, args.eventSlug);
    const page = await ctx.db
      .query("operationsAutonomyRuns")
      .withIndex("by_event_created_at", (index) => index.eq("eventId", event._id))
      .order("desc")
      .paginate(args.paginationOpts);
    const projected = await Promise.all(page.page.map(async (run) => {
      const [checkpoint, supervision] = await Promise.all([
        ctx.db
          .query("operationsAutonomyRunCheckpoints")
          .withIndex("by_run", (index) => index.eq("runId", run._id))
          .unique(),
        ctx.db
          .query("operationsAutonomyRunSupervision")
          .withIndex("by_run", (index) => index.eq("runId", run._id))
          .unique(),
      ]);
      if (!checkpoint) throw new Error("An autonomy run checkpoint is missing.");
      return runProjection(run, checkpoint, supervision);
    }));
    return { ...page, page: projected };
  },
});

const queuedWorkView = v.object({
  id: v.id("operationsAutonomyInbox"),
  trigger: triggerView,
  sourceGeneratedAt: v.number(),
  createdAt: v.number(),
});

export const queuedWork = query({
  args: { eventSlug: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(queuedWorkView),
  handler: async (ctx, args) => {
    if (args.paginationOpts.numItems > maximumPublicPageSize) {
      throw new ConvexError({
        code: "PAGINATION_LIMIT_EXCEEDED",
        message: `Autonomy queue pages may contain at most ${maximumPublicPageSize} items.`,
      });
    }
    const { event } = await authorizedEvent(ctx, args.eventSlug);
    const policy = await ctx.db
      .query("operationsAutonomyPolicyVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "published"),
      )
      .unique();
    if (!policy) throw new Error("The event has no published autonomy policy.");
    const page = await ctx.db
      .query("operationsAutonomyInbox")
      .withIndex("by_policy_lifecycle", (index) =>
        index.eq("policyVersionId", policy._id).eq("lifecycle.kind", "pending"),
      )
      .order("asc")
      .paginate(args.paginationOpts);
    return {
      ...page,
      page: page.page.map((item) => ({
        id: item._id,
        trigger: item.trigger,
        sourceGeneratedAt: item.sourceSnapshot.generatedAt,
        createdAt: item.createdAt,
      })),
    };
  },
});

export const authorizeRunStream = internalQuery({
  args: { eventSlug: v.string(), runId: v.id("operationsAutonomyRuns") },
  returns: v.object({ eventSlug: v.string(), runId: v.id("operationsAutonomyRuns") }),
  handler: async (ctx, args) => {
    const { event } = await authorizedEvent(ctx, args.eventSlug);
    const run = await ctx.db.get(args.runId);
    if (!run || run.eventId !== event._id || run.admission.kind !== "accepted") {
      throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_STREAM_UNAVAILABLE",
        message: "That autonomous run has not been accepted by the intelligence service.",
      });
    }
    return { eventSlug: event.slug, runId: run._id };
  },
});
