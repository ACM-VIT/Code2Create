/** Signed whitelist of redacted operations reads; callers cannot compose queries. */

import {
  operationsIntelligenceProtocolVersion,
  operationsIntelligenceReadSignatureContext,
  type OperationsIntelligenceReadName,
  verifyServiceBody,
} from "@code2create/domain";
import { v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { HttpBodyTooLargeError, readBoundedRequestText } from "./lib/boundedHttpBody";
import { redactProjectText } from "./lib/projectText";
import { requireIntelligenceHmacSecret } from "./lib/intelligenceServiceConfiguration";
import { intelligenceRecommendationStatus } from "./lib/intelligenceRecommendationValidators";
import { operationsAttentionIntelligenceStatement } from "./lib/operationsAutonomyReadFacts";
import { maximumAttendanceSessionsPerPlan } from "./lib/attendancePlanLimits";
import { attendanceCounterShardCount } from "./lib/attendanceCounters";
import {
  maximumReviewPanelsPerRound,
  maximumReviewRoundsPerEvent,
  maximumReviewTeamsPerEvent,
} from "./lib/reviewLimits";
import {
  emptySupportCaseCounters,
  supportCaseCounterShardCount,
  type SupportCaseCounters,
} from "./lib/supportCases";
import {
  attentionDetectorKey,
  attentionSeverity,
  attentionSubjectType,
  reviewPanelStatus,
  reviewRoundStatus,
  supportCaseCategory,
  teamRoundState,
} from "./values";

const maximumBodyBytes = 4 * 1_024;
const maximumSignatureAgeMs = 5 * 60 * 1_000;
const conversationId = z.string().regex(/^cv_[a-f0-9]{64}$/u);
/** Reads one extra row so truncated counts can be reported as lower bounds. */
const queryLimit = 101;

const ordinaryReadNames = {
  operations_health: "operations_health",
  operations_attention: "operations_attention",
  review_rounds: "review_rounds",
  review_exceptions: "review_exceptions",
  attendance_counts: "attendance_counts",
  support_load: "support_load",
} satisfies {
  [Read in Exclude<OperationsIntelligenceReadName, "recommendation_history">]: Read;
};

const readRequest = z.discriminatedUnion("read", [
  z
    .object({
      protocolVersion: z.literal(operationsIntelligenceProtocolVersion),
      read: z.enum(ordinaryReadNames),
      eventSlug: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(operationsIntelligenceProtocolVersion),
      read: z.literal("recommendation_history"),
      eventSlug: z.string().min(1).max(120),
      conversationId,
    })
    .strict(),
]);

export const intelligenceReadEndpoint = httpAction(async (ctx, request) => {
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
      context: operationsIntelligenceReadSignatureContext,
      secret: requireIntelligenceHmacSecret("INTELLIGENCE_READ_SECRET"),
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
  const parsed = readRequest.safeParse(json);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  const resolved = await ctx.runQuery(internal.intelligenceReads.resolveEvent, {
    eventSlug: parsed.data.eventSlug,
  });
  if (!resolved) return Response.json({ error: "event_not_found" }, { status: 404 });
  const eventId = resolved.eventId;
  const now = Date.now();
  const data = await runIntelligenceRead(
    ctx,
    parsed.data.read === "recommendation_history"
      ? {
          read: parsed.data.read,
          eventId,
          now,
          conversationId: parsed.data.conversationId,
        }
      : { read: parsed.data.read, eventId, now },
  );
  if (data === null) {
    return Response.json({ error: "operations_health_unavailable" }, { status: 503 });
  }
  return Response.json({ read: parsed.data.read, data }, { status: 200 });
});

type IntelligenceReadDispatch =
  | {
      read: Exclude<OperationsIntelligenceReadName, "recommendation_history">;
      eventId: Id<"events">;
      now: number;
    }
  | {
      read: "recommendation_history";
      eventId: Id<"events">;
      now: number;
      conversationId: string;
    };

export async function runIntelligenceRead(
  ctx: ActionCtx,
  args: IntelligenceReadDispatch,
) {
  switch (args.read) {
    case "operations_health": {
      const health = await ctx.runQuery(internal.operationsHealth.materializedForEvent, {
        eventId: args.eventId,
        now: args.now,
      });
      return health.state === "ready" ? health.snapshot : null;
    }
    case "operations_attention":
      return ctx.runQuery(internal.intelligenceReads.operationsAttentionRead, {
        eventId: args.eventId,
        now: args.now,
      });
    case "review_rounds":
      return ctx.runQuery(internal.intelligenceReads.reviewRoundsRead, {
        eventId: args.eventId,
        now: args.now,
      });
    case "review_exceptions":
      return ctx.runQuery(internal.intelligenceReads.reviewExceptionsRead, {
        eventId: args.eventId,
        now: args.now,
      });
    case "attendance_counts":
      return ctx.runQuery(internal.intelligenceReads.attendanceCountsRead, {
        eventId: args.eventId,
        now: args.now,
      });
    case "support_load":
      return ctx.runQuery(internal.intelligenceReads.supportLoadRead, {
        eventId: args.eventId,
        now: args.now,
      });
    case "recommendation_history":
      return ctx.runQuery(internal.intelligenceReads.recommendationHistoryRead, {
        eventId: args.eventId,
        conversationId: args.conversationId,
        now: args.now,
      });
  }
}

export const resolveEvent = internalQuery({
  args: { eventSlug: v.string() },
  returns: v.union(v.null(), v.object({ eventId: v.id("events") })),
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", args.eventSlug.trim().toLowerCase()))
      .unique();
    return event ? { eventId: event._id } : null;
  },
});

/** Mirrors the review overview rule without requiring an authenticated person. */
function isReviewableTeam(team: Doc<"teams">) {
  return (
    ["confirmed", "checked_in", "active"].includes(team.status) &&
    team.membershipLocked &&
    team.lockedProjectVersionId !== undefined
  );
}

async function activeRoundPauseExists(ctx: QueryCtx, roundId: Id<"reviewRounds">) {
  const pause = await ctx.db
    .query("reviewRoundPauses")
    .withIndex("by_round_state", (index) => index.eq("roundId", roundId).eq("state", "active"))
    .unique();
  return pause !== null;
}

export const reviewRoundsRead = internalQuery({
  args: { eventId: v.id("events"), now: v.number() },
  returns: v.object({
    generatedAt: v.number(),
    rounds: v.array(
      v.object({
        roundId: v.id("reviewRounds"),
        name: v.string(),
        status: reviewRoundStatus,
        startsAt: v.number(),
        endsAt: v.number(),
        isPaused: v.boolean(),
        stateCounts: v.object({
          unassigned: v.number(),
          queued: v.number(),
          called: v.number(),
          inReview: v.number(),
          completed: v.number(),
          held: v.number(),
          missed: v.number(),
          withdrawn: v.number(),
        }),
        panels: v.array(
          v.object({
            panelId: v.id("reviewPanels"),
            name: v.string(),
            status: reviewPanelStatus,
            queuedCount: v.number(),
            activeReviewCount: v.number(),
          }),
        ),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const [rounds, confirmedTeams, checkedInTeams, activeTeams] = await Promise.all([
      ctx.db
        .query("reviewRounds")
        .withIndex("by_event_status_start", (index) => index.eq("eventId", args.eventId))
        .take(maximumReviewRoundsPerEvent + 1),
      ctx.db
        .query("teams")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", args.eventId).eq("status", "confirmed"),
        )
        .take(maximumReviewTeamsPerEvent + 1),
      ctx.db
        .query("teams")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", args.eventId).eq("status", "checked_in"),
        )
        .take(maximumReviewTeamsPerEvent + 1),
      ctx.db
        .query("teams")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", args.eventId).eq("status", "active"),
        )
        .take(maximumReviewTeamsPerEvent + 1),
    ]);
    if (rounds.length > maximumReviewRoundsPerEvent) {
      throw new Error("An event exceeds the published review-round limit.");
    }
    const eventTeams = [...confirmedTeams, ...checkedInTeams, ...activeTeams];
    if (eventTeams.length > maximumReviewTeamsPerEvent) {
      throw new Error("An event exceeds the review intelligence team limit.");
    }
    const reviewableTeams = eventTeams.filter(isReviewableTeam);
    const views = [];
    for (const round of rounds.sort((left, right) => left.startsAt - right.startsAt)) {
      const [panels, states, awaitingSessions, activeSessions, overdueSessions, isPaused] =
        await Promise.all([
          ctx.db
            .query("reviewPanels")
            .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
            .take(maximumReviewPanelsPerRound + 1),
          ctx.db
            .query("teamRoundStates")
            .withIndex("by_round_state_priority_queued", (index) => index.eq("roundId", round._id))
            .take(maximumReviewTeamsPerEvent + 1),
          ctx.db
            .query("reviewSessions")
            .withIndex("by_round_status_updated", (index) =>
              index.eq("roundId", round._id).eq("status", "awaiting_presence"),
            )
            .take(maximumReviewPanelsPerRound + 1),
          ctx.db
            .query("reviewSessions")
            .withIndex("by_round_status_updated", (index) =>
              index.eq("roundId", round._id).eq("status", "active"),
            )
            .take(maximumReviewPanelsPerRound + 1),
          ctx.db
            .query("reviewSessions")
            .withIndex("by_round_status_updated", (index) =>
              index.eq("roundId", round._id).eq("status", "overdue"),
            )
            .take(maximumReviewPanelsPerRound + 1),
          activeRoundPauseExists(ctx, round._id),
        ]);
      if (panels.length > maximumReviewPanelsPerRound) {
        throw new Error("A review round exceeds the published panel limit.");
      }
      if (states.length > maximumReviewTeamsPerEvent) {
        throw new Error("A review round exceeds the review intelligence team limit.");
      }
      const liveSessions = [...awaitingSessions, ...activeSessions, ...overdueSessions];
      if (liveSessions.length > maximumReviewPanelsPerRound) {
        throw new Error("A review round has more live reviews than published panels.");
      }
      const panelRows = panels.map((panel) => ({
        panelId: panel._id,
        name: panel.name,
        status: panel.status,
        queuedCount: states.filter(
          (state) => state.panelId === panel._id && state.state === "queued",
        ).length,
        activeReviewCount: liveSessions.filter((session) => session.panelId === panel._id).length,
      }));
      const stateTeamIds = new Set(states.map((state) => state.teamId));
      const count = (state: Doc<"teamRoundStates">["state"]) =>
        states.filter((row) => row.state === state).length;
      views.push({
        roundId: round._id,
        name: round.name,
        status: round.status,
        startsAt: round.startsAt,
        endsAt: round.endsAt,
        isPaused,
        stateCounts: {
          unassigned:
            count("unassigned") +
            reviewableTeams.filter((team) => !stateTeamIds.has(team._id)).length,
          queued: count("queued"),
          called: count("called") + count("at_table"),
          inReview: count("in_review"),
          completed: count("completed"),
          held: count("held"),
          missed: count("missed"),
          withdrawn: count("withdrawn"),
        },
        panels: panelRows,
      });
    }
    return { generatedAt: args.now, rounds: views };
  },
});

export const reviewExceptionsRead = internalQuery({
  args: { eventId: v.id("events"), now: v.number() },
  returns: v.object({
    generatedAt: v.number(),
    // Expose the vacant seat ID without the former reviewer's identity.
    vacancies: v.array(
      v.object({
        missingPanelMemberId: v.id("reviewPanelMembers"),
        panelId: v.id("reviewPanels"),
        panelName: v.string(),
        panelVersion: v.number(),
        roundId: v.id("reviewRounds"),
        roundName: v.string(),
        vacantSince: v.optional(v.number()),
      }),
    ),
    /** Teams in a state an operator may need to act on, as ids and states. */
    teams: v.array(
      v.object({
        teamRoundStateId: v.id("teamRoundStates"),
        roundId: v.id("reviewRounds"),
        state: teamRoundState,
        version: v.number(),
        callAttemptCount: v.number(),
        queuedAt: v.optional(v.number()),
        heldAt: v.optional(v.number()),
        missedAt: v.optional(v.number()),
      }),
    ),
    atLeast: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const shortPanels = await ctx.db
      .query("reviewPanels")
      .withIndex("by_event_status_updated", (index) =>
        index.eq("eventId", args.eventId).eq("status", "needs_reviewer"),
      )
      .take(queryLimit);
    const vacancies = [];
    for (const panel of shortPanels) {
      const [round, removedMember] = await Promise.all([
        ctx.db.get(panel.roundId),
        ctx.db
          .query("reviewPanelMembers")
          .withIndex("by_panel_status_ended", (index) =>
            index.eq("panelId", panel._id).eq("status", "removed"),
          )
          .order("desc")
          .first(),
      ]);
      if (!round || round.eventId !== args.eventId) continue;
      if (removedMember) {
        vacancies.push({
          missingPanelMemberId: removedMember._id,
          panelId: panel._id,
          panelName: panel.name,
          panelVersion: panel.version,
          roundId: round._id,
          roundName: round.name,
          ...(removedMember.endedAt !== undefined ? { vacantSince: removedMember.endedAt } : {}),
        });
      }
    }
    const rounds = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_status_start", (index) =>
        index.eq("eventId", args.eventId).eq("status", "open"),
      )
      .take(maximumReviewRoundsPerEvent + 1);
    if (rounds.length > maximumReviewRoundsPerEvent) {
      throw new Error("An event exceeds the published review-round limit.");
    }
    const exceptionStates = ["queued", "called", "at_table", "held", "missed"] as const;
    const teams = [];
    roundLoop: for (const round of rounds) {
      for (const state of exceptionStates) {
        const rows = await ctx.db
          .query("teamRoundStates")
          .withIndex("by_round_state_priority_queued", (index) =>
            index.eq("roundId", round._id).eq("state", state),
          )
          .take(queryLimit - teams.length);
        for (const row of rows) {
          teams.push({
            teamRoundStateId: row._id,
            roundId: round._id,
            state: row.state,
            version: row.version,
            callAttemptCount: row.callAttemptCount,
            ...(row.queuedAt !== undefined ? { queuedAt: row.queuedAt } : {}),
            ...(row.heldAt !== undefined ? { heldAt: row.heldAt } : {}),
            ...(row.missedAt !== undefined ? { missedAt: row.missedAt } : {}),
          });
        }
        if (teams.length >= queryLimit) break roundLoop;
      }
    }
    const atLeast = teams.length === queryLimit || shortPanels.length === queryLimit;
    return {
      generatedAt: args.now,
      vacancies: vacancies.slice(0, queryLimit - 1),
      teams: teams.slice(0, queryLimit - 1),
      atLeast,
    };
  },
});

export const operationsAttentionRead = internalQuery({
  args: { eventId: v.id("events"), now: v.number() },
  returns: v.object({
    generatedAt: v.number(),
    items: v.array(
      v.object({
        itemId: v.id("operationsAttentionItems"),
        detectorKey: attentionDetectorKey,
        subjectType: attentionSubjectType,
        severity: attentionSeverity,
        /** Fixed detector summary; human-entered and identity-bearing prose stays in Convex. */
        statement: v.string(),
        state: v.union(v.literal("open"), v.literal("acknowledged")),
        version: v.number(),
        recurrenceCount: v.number(),
        firstObservedAt: v.number(),
        lastObservedAt: v.number(),
      }),
    ),
    atLeast: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const items = [];
    for (const severity of ["critical", "attention", "watch"] as const) {
      for (const state of ["open", "acknowledged"] as const) {
        if (items.length >= queryLimit) break;
        const rows = await ctx.db
          .query("operationsAttentionItems")
          .withIndex("by_event_state_severity_round_first", (index) =>
            index
              .eq("eventId", args.eventId)
              .eq("state", state)
              .eq("severity", severity)
              .gt("roundId", undefined),
          )
          .take(queryLimit - items.length);
        for (const item of rows) {
          items.push({
            itemId: item._id,
            detectorKey: item.detectorKey,
            subjectType: item.subjectType,
            severity: item.severity,
            statement: operationsAttentionIntelligenceStatement(item.detectorKey),
            state,
            version: item.version,
            recurrenceCount: item.recurrenceCount,
            firstObservedAt: item.firstObservedAt,
            lastObservedAt: item.lastObservedAt,
          });
        }
      }
    }
    return {
      generatedAt: args.now,
      items: items.slice(0, queryLimit - 1),
      atLeast: items.length === queryLimit,
    };
  },
});

export const attendanceCountsRead = internalQuery({
  args: { eventId: v.id("events"), now: v.number() },
  returns: v.object({
    generatedAt: v.number(),
    venueCheckedIn: v.number(),
    sessions: v.array(
      v.object({
        sessionId: v.id("attendanceSessions"),
        name: v.string(),
        kind: v.union(
          v.literal("hacking"),
          v.literal("briefing"),
          v.literal("review_preparation"),
          v.literal("overnight_access"),
          v.literal("workshop"),
          v.literal("other"),
        ),
        status: v.union(
          v.literal("scheduled"),
          v.literal("preparing"),
          v.literal("ready"),
          v.literal("open"),
          v.literal("closing"),
          v.literal("closed"),
          v.literal("cancelled"),
        ),
        startsAt: v.number(),
        endsAt: v.number(),
        counts: v.object({
          expected: v.number(),
          confirmationDue: v.number(),
          present: v.number(),
          temporarilyOut: v.number(),
          complete: v.number(),
          excused: v.number(),
          needsReview: v.number(),
          late: v.number(),
        }),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("The intelligence read event no longer exists.");
    const venueShards = await ctx.db
      .query("venueCheckInCounterShards")
      .withIndex("by_event_shard", (index) => index.eq("eventId", args.eventId))
      .take(attendanceCounterShardCount + 1);
    if (venueShards.length > attendanceCounterShardCount) {
      throw new Error("Venue attendance counters exceed the configured shard count.");
    }
    const venueCheckedIn = venueShards.reduce((total, shard) => total + shard.checkedIn, 0);
    const planId = event.publishedAttendancePlanVersionId;
    const plan = planId ? await ctx.db.get(planId) : null;
    if (!plan || plan.eventId !== event._id || plan.status !== "published") {
      return { generatedAt: args.now, venueCheckedIn, sessions: [] };
    }
    const sessions = await ctx.db
      .query("attendanceSessions")
      .withIndex("by_plan_key", (index) => index.eq("planVersionId", plan._id))
      .take(maximumAttendanceSessionsPerPlan + 1);
    if (sessions.length > maximumAttendanceSessionsPerPlan) {
      throw new Error("An attendance plan exceeds the published session limit.");
    }
    const views = await Promise.all(
      sessions
        .sort((left, right) => left.startsAt - right.startsAt)
        .map(async (session) => {
          const shards = await ctx.db
            .query("attendanceSessionCounterShards")
            .withIndex("by_session_shard", (index) => index.eq("sessionId", session._id))
            .take(attendanceCounterShardCount + 1);
          if (shards.length > attendanceCounterShardCount) {
            throw new Error("Session attendance counters exceed the configured shard count.");
          }
          const counts = shards.reduce(
            (total, shard) => ({
              expected: total.expected + shard.expected,
              confirmationDue: total.confirmationDue + shard.confirmationDue,
              present: total.present + shard.present,
              temporarilyOut: total.temporarilyOut + shard.temporarilyOut,
              complete: total.complete + shard.complete,
              excused: total.excused + shard.excused,
              needsReview: total.needsReview + shard.needsReview,
              late: total.late + shard.late,
            }),
            {
              expected: 0,
              confirmationDue: 0,
              present: 0,
              temporarilyOut: 0,
              complete: 0,
              excused: 0,
              needsReview: 0,
              late: 0,
            },
          );
          return {
            sessionId: session._id,
            name: session.name,
            kind: session.kind,
            status: session.status,
            startsAt: session.startsAt,
            endsAt: session.endsAt,
            counts,
          };
        }),
    );
    return { generatedAt: args.now, venueCheckedIn, sessions: views };
  },
});

export const supportLoadRead = internalQuery({
  args: { eventId: v.id("events"), now: v.number() },
  returns: v.object({
    generatedAt: v.number(),
    byState: v.object({
      open: v.number(),
      investigating: v.number(),
      waiting: v.number(),
      resolved: v.number(),
      closed: v.number(),
    }),
    openByCategory: v.array(v.object({ category: supportCaseCategory, count: v.number() })),
    unassignedActiveCount: v.number(),
    oldestOpenAt: v.optional(v.number()),
    atLeast: v.boolean(),
    cases: v.array(
      v.object({
        caseId: v.id("supportCases"),
        category: supportCaseCategory,
        state: v.union(v.literal("open"), v.literal("investigating"), v.literal("waiting")),
        createdAt: v.number(),
        teamId: v.optional(v.id("teams")),
        roundId: v.optional(v.id("reviewRounds")),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const [statShards, openRows, investigatingRows, waitingRows, oldestOpen] = await Promise.all([
      ctx.db
        .query("supportCaseStatShards")
        .withIndex("by_event_shard", (index) => index.eq("eventId", args.eventId))
        .take(supportCaseCounterShardCount + 1),
      ctx.db
        .query("supportCases")
        .withIndex("by_event_state_updated", (index) =>
          index.eq("eventId", args.eventId).eq("state", "open"),
        )
        .take(queryLimit),
      ctx.db
        .query("supportCases")
        .withIndex("by_event_state_created", (index) =>
          index.eq("eventId", args.eventId).eq("state", "investigating"),
        )
        .take(queryLimit),
      ctx.db
        .query("supportCases")
        .withIndex("by_event_state_created", (index) =>
          index.eq("eventId", args.eventId).eq("state", "waiting"),
        )
        .take(queryLimit),
      ctx.db
        .query("supportCases")
        .withIndex("by_event_state_created", (index) =>
          index.eq("eventId", args.eventId).eq("state", "open"),
        )
        .order("asc")
        .first(),
    ]);
    if (statShards.length > supportCaseCounterShardCount) {
      throw new Error("Support statistics exceed the configured shard count.");
    }
    const totals = statShards.reduce<SupportCaseCounters>(
      (current, shard) => ({
        open: current.open + shard.open,
        investigating: current.investigating + shard.investigating,
        waiting: current.waiting + shard.waiting,
        resolved: current.resolved + shard.resolved,
        closed: current.closed + shard.closed,
        unowned: current.unowned + shard.unowned,
        awaitingStaffReply: current.awaitingStaffReply + shard.awaitingStaffReply,
        safety: current.safety + shard.safety,
      }),
      emptySupportCaseCounters(),
    );
    const boundedOpenRows = openRows.slice(0, queryLimit - 1);
    const categoryCounts = new Map<Doc<"supportCases">["category"], number>();
    for (const row of boundedOpenRows) {
      categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1);
    }
    const atLeast =
      openRows.length === queryLimit ||
      investigatingRows.length === queryLimit ||
      waitingRows.length === queryLimit;
    const supportCaseView = (
      row: Doc<"supportCases">,
      state: "open" | "investigating" | "waiting",
    ) => ({
      caseId: row._id,
      category: row.category,
      state,
      createdAt: row.createdAt,
      ...(row.teamId !== undefined ? { teamId: row.teamId } : {}),
      ...(row.roundId !== undefined ? { roundId: row.roundId } : {}),
    });
    const activeCases = [
      ...openRows.map((row) => supportCaseView(row, "open")),
      ...investigatingRows.map((row) => supportCaseView(row, "investigating")),
      ...waitingRows.map((row) => supportCaseView(row, "waiting")),
    ].slice(0, queryLimit - 1);
    return {
      generatedAt: args.now,
      byState: {
        open: totals.open,
        investigating: totals.investigating,
        waiting: totals.waiting,
        resolved: totals.resolved,
        closed: totals.closed,
      },
      openByCategory: [...categoryCounts.entries()].map(([category, count]) => ({
        category,
        count,
      })),
      unassignedActiveCount: totals.unowned,
      ...(oldestOpen ? { oldestOpenAt: oldestOpen.createdAt } : {}),
      atLeast,
      cases: activeCases,
    };
  },
});

export const recommendationHistoryRead = internalQuery({
  args: { eventId: v.id("events"), conversationId: v.string(), now: v.number() },
  returns: v.object({
    generatedAt: v.number(),
    recommendations: v.array(
      v.object({
        proposalKey: v.string(),
        kind: v.union(
          v.literal("hold_review_team"),
          v.literal("page_reserve_reviewer"),
          v.literal("open_support_case"),
          v.literal("dismiss_attention_item"),
        ),
        statement: v.string(),
        status: intelligenceRecommendationStatus,
        // Return operator guidance without operator identity.
        operatorNote: v.optional(v.string()),
        proposedAt: v.number(),
        decidedAt: v.optional(v.number()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("intelligenceRecommendations")
      .withIndex("by_event_copilot_conversation_proposed", (index) =>
        index
          .eq("eventId", args.eventId)
          .eq("provenance.kind", "copilot")
          .eq("provenance.conversationId", args.conversationId),
      )
      .order("desc")
      .take(50);
    return {
      generatedAt: args.now,
      recommendations: rows.flatMap((row) => {
        if (row.arguments.kind === "set_admission_minimum_human_reviews") return [];
        return [
          {
            proposalKey: row.proposalKey,
            kind: row.arguments.kind,
            statement: redactProjectText(row.statement),
            status: row.status,
            ...(row.operatorNote !== undefined
              ? { operatorNote: redactProjectText(row.operatorNote) }
              : {}),
            proposedAt: row.proposedAt,
            ...(row.decidedAt !== undefined ? { decidedAt: row.decidedAt } : {}),
          },
        ];
      }),
    };
  },
});
