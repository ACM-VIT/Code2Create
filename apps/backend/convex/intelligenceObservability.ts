/** Projects agent lifecycle records without copying Durable Object content. */

import { paginationOptsValidator, paginationResultValidator } from "convex/server";

import { ConvexError, v, type Infer } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, query, type QueryCtx } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requirePermission } from "./lib/permissions";

const maximumBriefPageSize = 20;
const maximumAgentRunPageSize = 30;

const intelligenceAgentId = v.union(
  v.literal("idea-submission"),
  v.literal("operations-episode"),
  v.literal("operations-brief"),
  v.literal("operations-copilot"),
  v.literal("operations-autopilot"),
);

const agentRunTone = v.union(
  v.literal("live"),
  v.literal("success"),
  v.literal("attention"),
  v.literal("failure"),
  v.literal("idle"),
);

const agentRunView = v.object({
  id: v.string(),
  agent: intelligenceAgentId,
  state: v.string(),
  tone: agentRunTone,
  title: v.string(),
  summary: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  agentVersion: v.optional(v.string()),
  model: v.optional(v.string()),
  instanceId: v.optional(v.string()),
  operationId: v.optional(v.string()),
  href: v.optional(v.string()),
  metadata: v.array(v.object({ label: v.string(), value: v.string() })),
});
const agentRunPage = paginationResultValidator(agentRunView);
type AgentRunPage = Infer<typeof agentRunPage>;

const fleetAgentStatus = v.object({
  agent: intelligenceAgentId,
  state: v.union(
    v.literal("running"),
    v.literal("attention"),
    v.literal("ready"),
    v.literal("never_run"),
  ),
  stateLabel: v.string(),
  lastActivityAt: v.optional(v.number()),
  activeRuns: v.number(),
  activeRunsAtLeast: v.boolean(),
});
type FleetAgentStatus = Infer<typeof fleetAgentStatus>;

async function requireIntelligenceRead(ctx: QueryCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "operations.intelligence.read",
    scopeType: "event",
  });
  return { event, subject };
}

const copilotAuthorization = v.object({
  eventId: v.id("events"),
  eventSlug: v.string(),
  eventAccessSubjectId: v.id("eventAccessSubjects"),
});

/** Resolves the private copilot identity only after checking the exact permission. */
export const authorizeCopilot = internalQuery({
  args: {
    eventSlug: v.string(),
    permission: v.union(
      v.literal("operations.intelligence.generate"),
      v.literal("operations.intelligence.read"),
    ),
  },
  returns: copilotAuthorization,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: args.permission,
      scopeType: "event",
    });
    return {
      eventId: event._id,
      eventSlug: event.slug,
      eventAccessSubjectId: subject._id,
    };
  },
});

/** Creates the durable ingress record before a copilot turn crosses the Worker boundary. */
export const beginCopilotTurn = internalMutation({
  args: {
    eventId: v.id("events"),
    eventAccessSubjectId: v.id("eventAccessSubjects"),
    conversationId: v.string(),
    turnId: v.string(),
    message: v.string(),
  },
  returns: v.id("operationsCopilotTurns"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("operationsCopilotTurns")
      .withIndex("by_subject_turn", (index) =>
        index.eq("eventAccessSubjectId", args.eventAccessSubjectId).eq("turnId", args.turnId),
      )
      .unique();
    if (existing) {
      if (
        existing.eventId !== args.eventId ||
        existing.conversationId !== args.conversationId ||
        existing.message !== args.message
      ) {
        throw new ConvexError({
          code: "COPILOT_TURN_CONFLICT",
          message: "That turn ID was already used for different content.",
        });
      }
      return existing._id;
    }
    const now = Date.now();
    return ctx.db.insert("operationsCopilotTurns", {
      ...args,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Records the exact Worker receipt for one copilot turn. */
export const acceptCopilotTurn = internalMutation({
  args: {
    turnRecordId: v.id("operationsCopilotTurns"),
    submissionId: v.string(),
    acceptedAt: v.number(),
    deduplicated: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnRecordId);
    if (!turn) throw new Error("The copilot turn ingress record disappeared.");
    if (turn.state === "accepted" && turn.submissionId !== args.submissionId) {
      throw new Error("The copilot turn was accepted under a different submission.");
    }
    await ctx.db.patch(turn._id, {
      state: "accepted",
      submissionId: args.submissionId,
      acceptedAt: args.acceptedAt,
      deduplicated: args.deduplicated,
      failureDetail: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Preserves uncertainty when transport failed after dispatch may have committed. */
export const markCopilotTurnDeliveryUnknown = internalMutation({
  args: {
    turnRecordId: v.id("operationsCopilotTurns"),
    state: v.union(v.literal("delivery_unknown"), v.literal("conflict")),
    failureDetail: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnRecordId);
    if (!turn || turn.state === "accepted") return null;
    await ctx.db.patch(turn._id, {
      state: args.state,
      failureDetail: args.failureDetail,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Binds a brief stream ticket to one authorized event-owned run. */
export const authorizeBriefStream = internalQuery({
  args: {
    eventSlug: v.string(),
    briefId: v.id("operationsIntelligenceBriefs"),
  },
  returns: v.object({ eventSlug: v.string(), briefId: v.id("operationsIntelligenceBriefs") }),
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
    const brief = await ctx.db.get(args.briefId);
    if (!brief || brief.eventId !== event._id) {
      throw new ConvexError({
        code: "INTELLIGENCE_BRIEF_NOT_FOUND",
        message: "That intelligence run is unavailable.",
      });
    }
    return { eventSlug: event.slug, briefId: brief._id };
  },
});

const briefRunView = v.object({
  id: v.id("operationsIntelligenceBriefs"),
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

function briefRun(brief: Doc<"operationsIntelligenceBriefs">) {
  return {
    id: brief._id,
    state: brief.state,
    ...(brief.failureCode !== undefined ? { failureCode: brief.failureCode } : {}),
    ...(brief.headline !== undefined ? { headline: brief.headline } : {}),
    ...(brief.agentVersion !== undefined ? { agentVersion: brief.agentVersion } : {}),
    ...(brief.model !== undefined ? { model: brief.model } : {}),
    requestedAt: brief.requestedAt,
    ...(brief.workerAcceptedAt !== undefined ? { workerAcceptedAt: brief.workerAcceptedAt } : {}),
    ...(brief.completedAt !== undefined ? { completedAt: brief.completedAt } : {}),
  };
}

function requireBriefPageSize(numItems: number) {
  if (numItems < 1 || numItems > maximumBriefPageSize) {
    throw new ConvexError({
      code: "INVALID_PAGE_SIZE",
      message: `Brief history pages must contain between 1 and ${maximumBriefPageSize} rows.`,
    });
  }
}

/** Newest-first manual brief history; older runs always remain reachable. */
export const briefHistory = query({
  args: {
    eventSlug: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(briefRunView),
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

    requireBriefPageSize(args.paginationOpts.numItems);
    const page = await ctx.db
      .query("operationsIntelligenceBriefs")
      .withIndex("by_event_requested", (index) => index.eq("eventId", event._id))
      .order("desc")
      .paginate(args.paginationOpts);

    return { ...page, page: page.page.map(briefRun) };
  },
});

function requireAgentRunPageSize(numItems: number) {
  if (numItems < 1 || numItems > maximumAgentRunPageSize) {
    throw new ConvexError({
      code: "INVALID_PAGE_SIZE",
      message: `Agent run pages must contain between 1 and ${maximumAgentRunPageSize} rows.`,
    });
  }
}

function admissionRunTone(
  state: Doc<"admissionAIRecommendations">["state"],
): "live" | "success" | "attention" | "failure" | "idle" {
  if (state === "pending" || state === "running") return "live";
  if (state === "succeeded") return "success";
  if (state === "stale" || state === "disabled") return "idle";
  if (state === "rate_limited") return "attention";
  return "failure";
}

function autonomyCompletion(
  state: Doc<"operationsAutonomyRuns">["lifecycle"],
): { completedAt: number } | Record<string, never> {
  if (
    state.kind === "succeeded" ||
    state.kind === "no_op" ||
    state.kind === "escalated" ||
    state.kind === "failed" ||
    state.kind === "canceled"
  )
    return { completedAt: state.completedAt };
  return {};
}

/** One newest-first, exhaustively pageable ledger across every deployed agent type. */
export const agentRunHistory = query({
  args: {
    eventSlug: v.string(),
    agent: intelligenceAgentId,
    paginationOpts: paginationOptsValidator,
  },
  returns: agentRunPage,
  handler: async (ctx, args): Promise<AgentRunPage> => {
    const { event } = await requireIntelligenceRead(ctx, args.eventSlug);
    requireAgentRunPageSize(args.paginationOpts.numItems);

    if (args.agent === "idea-submission") {
      const result = await ctx.db
        .query("admissionAIRecommendations")
        .withIndex("by_event_created", (index) => index.eq("eventId", event._id))
        .order("desc")
        .paginate(args.paginationOpts);
      const page = await Promise.all(
        result.page.map(async (run) => {
          const team = await ctx.db.get(run.teamId);
          return {
            id: run._id,
            agent: args.agent,
            state: run.state,
            tone: admissionRunTone(run.state),
            title: team?.name ?? "Submitted idea",
            summary:
              run.recommendation === undefined
                ? (run.failureCategory ?? "Awaiting an advisory recommendation")
                : `Advisory result: ${run.recommendation.replaceAll("_", " ")}`,
            createdAt: run.createdAt,
            updatedAt: run.completedAt ?? run.agentAcceptedAt ?? run.createdAt,
            ...(run.agentAcceptedAt !== undefined ? { startedAt: run.agentAcceptedAt } : {}),
            ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
            ...(run.agentVersion !== undefined ? { agentVersion: run.agentVersion } : {}),
            ...(run.agentModel !== undefined ? { model: run.agentModel } : {}),
            instanceId: run._id,
            ...(run.agentOperationId !== undefined ? { operationId: run.agentOperationId } : {}),
            href: `/admissions/${run.applicationId}`,
            metadata: [
              { label: "Application content", value: `v${run.applicationContentVersion}` },
              { label: "Experience band", value: run.experienceBand.replaceAll("_", " ") },
              { label: "Criteria", value: String(run.criterionAssessments.length) },
              ...(run.confidence === undefined
                ? []
                : [{ label: "Confidence", value: run.confidence }]),
              ...(run.agentSubmissionId === undefined
                ? []
                : [{ label: "Submission", value: run.agentSubmissionId }]),
            ],
          };
        }),
      );
      return { ...result, page };
    }

    if (args.agent === "operations-episode") {
      const result = await ctx.db
        .query("operationsIntelligenceEpisodes")
        .withIndex("by_event_updated_at", (index) => index.eq("eventId", event._id))
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        ...result,
        page: result.page.map((run) => ({
          id: run._id,
          agent: args.agent,
          state: run.analysisState.kind,
          tone:
            run.analysisState.kind === "pending" ||
            run.analysisState.kind === "dispatching" ||
            run.analysisState.kind === "accepted"
              ? ("live" as const)
              : run.analysisState.kind === "ready"
                ? ("success" as const)
                : ("failure" as const),
          title: run.title,
          summary: run.analysisSummary ?? run.summary,
          createdAt: run.firstObservedAt,
          updatedAt: run.updatedAt,
          ...("startedAt" in run.analysisState ? { startedAt: run.analysisState.startedAt } : {}),
          ...(run.resolvedAt !== undefined ? { completedAt: run.resolvedAt } : {}),
          ...(run.analysisAgentVersion !== undefined
            ? { agentVersion: run.analysisAgentVersion }
            : {}),
          ...(run.analysisModel !== undefined ? { model: run.analysisModel } : {}),
          instanceId: run._id,
          ...(run.analysisOperationId !== undefined
            ? { operationId: run.analysisOperationId }
            : {}),
          metadata: [
            { label: "Revision", value: String(run.revision) },
            { label: "Episode state", value: run.state },
            { label: "Severity", value: run.severity },
            { label: "Facts", value: String(run.factCount) },
            { label: "Signals", value: String(run.signalCount) },
          ],
        })),
      };
    }

    if (args.agent === "operations-brief") {
      const result = await ctx.db
        .query("operationsIntelligenceBriefs")
        .withIndex("by_event_requested", (index) => index.eq("eventId", event._id))
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        ...result,
        page: result.page.map((run) => ({
          id: run._id,
          agent: args.agent,
          state: run.state,
          tone:
            run.state === "pending" || run.state === "dispatching" || run.state === "accepted"
              ? ("live" as const)
              : run.state === "succeeded"
                ? ("success" as const)
                : ("failure" as const),
          title: run.headline ?? "Manual operations brief",
          summary: run.summary ?? run.failureCode?.replaceAll("_", " ") ?? "Waiting for the agent",
          createdAt: run.requestedAt,
          updatedAt: run.updatedAt,
          ...(run.workerAcceptedAt !== undefined ? { startedAt: run.workerAcceptedAt } : {}),
          ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
          ...(run.agentVersion !== undefined ? { agentVersion: run.agentVersion } : {}),
          ...(run.model !== undefined ? { model: run.model } : {}),
          instanceId: run._id,
          ...(run.workId !== undefined ? { operationId: run.workId } : {}),
          metadata: [
            { label: "Snapshot", value: run.sourceChecksum.slice(0, 12) },
            { label: "Record version", value: String(run.version) },
            ...(run.workerSubmissionId === undefined
              ? []
              : [{ label: "Submission", value: run.workerSubmissionId }]),
          ],
        })),
      };
    }

    if (args.agent === "operations-copilot") {
      const result = await ctx.db
        .query("operationsCopilotTurns")
        .withIndex("by_event_created", (index) => index.eq("eventId", event._id))
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        ...result,
        page: result.page.map((run) => ({
          id: run._id,
          agent: args.agent,
          state: run.state,
          tone:
            run.state === "accepted"
              ? ("success" as const)
              : run.state === "pending"
                ? ("live" as const)
                : run.state === "delivery_unknown"
                  ? ("attention" as const)
                  : ("failure" as const),
          title: run.message,
          summary:
            run.state === "accepted"
              ? "Accepted by the private copilot conversation; the complete response trace remains in its Flue stream."
              : (run.failureDetail ?? "Waiting for a verifiable Worker receipt."),
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          ...(run.acceptedAt !== undefined ? { startedAt: run.acceptedAt } : {}),
          instanceId: run.conversationId,
          operationId: run.turnId,
          metadata: [
            ...(run.submissionId === undefined
              ? []
              : [{ label: "Submission", value: run.submissionId }]),
            ...(run.deduplicated === undefined
              ? []
              : [{ label: "Deduplicated", value: run.deduplicated ? "yes" : "no" }]),
          ],
        })),
      };
    }

    const result = await ctx.db
      .query("operationsAutonomyRuns")
      .withIndex("by_event_created_at", (index) => index.eq("eventId", event._id))
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((run) => ({
        id: run._id,
        agent: args.agent,
        state: run.lifecycle.kind,
        tone:
          run.lifecycle.kind === "pending" || run.lifecycle.kind === "active"
            ? ("live" as const)
            : run.lifecycle.kind === "succeeded" ||
                run.lifecycle.kind === "no_op" ||
                run.lifecycle.kind === "escalated"
              ? ("success" as const)
              : ("failure" as const),
        title: `${run.trigger.kind.replaceAll("_", " ")} operations review`,
        summary:
          run.lifecycle.kind === "failed"
            ? run.lifecycle.failureCode.replaceAll("_", " ")
            : run.lifecycle.kind === "canceled"
              ? run.lifecycle.reason.replaceAll("_", " ")
              : `${run.mode === "recommend" ? "Observe and recommend" : "Observe only"} under policy v${run.policyVersion}`,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        ...(run.admission.kind === "accepted" ? { startedAt: run.admission.acceptedAt } : {}),
        ...autonomyCompletion(run.lifecycle),
        ...(run.executor.kind === "known"
          ? {
              agentVersion: run.executor.agentVersion,
              model: run.executor.model,
            }
          : {}),
        instanceId: run._id,
        operationId: run.operationKey,
        metadata: [
          { label: "Policy", value: `v${run.policyVersion}` },
          { label: "Attempt", value: String(run.attemptCount) },
          { label: "Reads allowed", value: String(run.allowedReadTools.length) },
          {
            label: "Recommendations allowed",
            value: String(run.allowedRecommendationKinds.length),
          },
          ...(run.admission.kind === "accepted"
            ? [{ label: "Submission", value: run.admission.currentSubmissionId }]
            : []),
        ],
      })),
    };
  },
});

/** Compact live/last-seen state for the five-agent fleet rail. */
export const agentFleetStatus = query({
  args: { eventSlug: v.string() },
  returns: v.array(fleetAgentStatus),
  handler: async (ctx, args): Promise<FleetAgentStatus[]> => {
    const { event } = await requireIntelligenceRead(ctx, args.eventSlug);
    const [ideaLatest, ideaPending, ideaRunning, episodes, briefs, autonomy, copilot] =
      await Promise.all([
        ctx.db
          .query("admissionAIRecommendations")
          .withIndex("by_event_created", (index) => index.eq("eventId", event._id))
          .order("desc")
          .take(1),
        ctx.db
          .query("admissionAIRecommendations")
          .withIndex("by_event_state_created", (index) =>
            index.eq("eventId", event._id).eq("state", "pending"),
          )
          .order("desc")
          .take(21),
        ctx.db
          .query("admissionAIRecommendations")
          .withIndex("by_event_state_created", (index) =>
            index.eq("eventId", event._id).eq("state", "running"),
          )
          .order("desc")
          .take(21),
        ctx.db
          .query("operationsIntelligenceEpisodes")
          .withIndex("by_event_updated_at", (index) => index.eq("eventId", event._id))
          .order("desc")
          .take(21),
        ctx.db
          .query("operationsIntelligenceBriefs")
          .withIndex("by_event_requested", (index) => index.eq("eventId", event._id))
          .order("desc")
          .take(21),
        ctx.db
          .query("operationsAutonomyRuns")
          .withIndex("by_event_created_at", (index) => index.eq("eventId", event._id))
          .order("desc")
          .take(21),
        ctx.db
          .query("operationsCopilotTurns")
          .withIndex("by_event_created", (index) => index.eq("eventId", event._id))
          .order("desc")
          .take(21),
      ]);
    const activeEpisodes = episodes.filter(
      (run) =>
        run.analysisState.kind === "pending" ||
        run.analysisState.kind === "dispatching" ||
        run.analysisState.kind === "accepted",
    );
    const activeBriefs = briefs.filter(
      (run) => run.state === "pending" || run.state === "dispatching" || run.state === "accepted",
    );
    const activeAutonomy = autonomy.filter(
      (run) => run.lifecycle.kind === "pending" || run.lifecycle.kind === "active",
    );
    const pendingCopilot = copilot.filter((run) => run.state === "pending");
    const uncertainCopilot = copilot.filter(
      (run) => run.state === "delivery_unknown" || run.state === "conflict",
    );
    return [
      fleetStatus(
        "idea-submission",
        ideaLatest[0]?.createdAt,
        Math.min(20, ideaPending.length + ideaRunning.length),
        ideaLatest[0] !== undefined && admissionRunTone(ideaLatest[0].state) === "failure",
        ideaPending.length + ideaRunning.length > 20,
      ),
      fleetStatus(
        "operations-episode",
        episodes[0]?.updatedAt,
        Math.min(20, activeEpisodes.length),
        episodes[0]?.analysisState.kind === "failed",
        activeEpisodes.length > 20,
      ),
      fleetStatus(
        "operations-brief",
        briefs[0]?.updatedAt,
        Math.min(20, activeBriefs.length),
        briefs[0]?.state === "failed",
        activeBriefs.length > 20,
      ),
      fleetStatus(
        "operations-copilot",
        copilot[0]?.updatedAt,
        Math.min(20, pendingCopilot.length),
        uncertainCopilot.length > 0,
        pendingCopilot.length > 20,
      ),
      fleetStatus(
        "operations-autopilot",
        autonomy[0]?.updatedAt,
        Math.min(20, activeAutonomy.length),
        autonomy[0]?.lifecycle.kind === "failed",
        activeAutonomy.length > 20,
      ),
    ];
  },
});

function fleetStatus(
  agent:
    | "idea-submission"
    | "operations-episode"
    | "operations-brief"
    | "operations-copilot"
    | "operations-autopilot",
  lastActivityAt: number | undefined,
  activeRuns: number,
  attention: boolean,
  activeRunsAtLeast: boolean,
): FleetAgentStatus {
  const activity = lastActivityAt === undefined ? {} : { lastActivityAt };
  if (activeRuns > 0) {
    return {
      agent,
      state: "running" as const,
      stateLabel: `${activeRuns}${activeRunsAtLeast ? "+" : ""} active`,
      ...activity,
      activeRuns,
      activeRunsAtLeast,
    };
  }
  if (attention) {
    return {
      agent,
      state: "attention" as const,
      stateLabel: "Needs attention",
      ...activity,
      activeRuns,
      activeRunsAtLeast,
    };
  }
  if (lastActivityAt === undefined) {
    return {
      agent,
      state: "never_run" as const,
      stateLabel: "No runs yet",
      activeRuns,
      activeRunsAtLeast,
    };
  }
  return {
    agent,
    state: "ready" as const,
    stateLabel: "Ready",
    lastActivityAt,
    activeRuns,
    activeRunsAtLeast,
  };
}
