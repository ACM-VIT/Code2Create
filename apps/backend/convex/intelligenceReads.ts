/**
 * The signed, whitelisted read surface the operations copilot sees the event
 * through. The Worker names one of the reads declared in the domain package
 * and Convex runs its own projection; nothing here accepts a query, a filter,
 * or a table name from the caller.
 *
 * Redaction is enforced by the `returns` validators on the internal queries
 * below, exactly the way the operations-brief snapshot is redacted: aggregate
 * counts, operational labels (round, panel, zone, session names), statuses,
 * document ids, and timestamps. No participant name, email, or membership
 * detail, no reviewer identity, and never a scorecard, evaluation, or any
 * per-reviewer number. Convex validates returned values strictly, so a field
 * this file does not name cannot leave the deployment.
 */

import {
  operationsIntelligenceProtocolVersion,
  operationsIntelligenceReadNames,
  operationsIntelligenceReadSignatureContext,
  verifyServiceBody,
} from "@code2create/domain";
import { v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalQuery, type QueryCtx } from "./_generated/server";
import {
  intelligenceRecommendationStatus,
} from "./lib/intelligenceRecommendationValidators";
import {
  attentionDetectorKey,
  attentionSeverity,
  attentionSubjectType,
  floorMappingState,
  reviewPanelStatus,
  reviewRoundStatus,
  supportCaseCategory,
  teamRoundState,
} from "./values";

const maximumBodyBytes = 4 * 1_024;
const maximumSignatureAgeMs = 5 * 60 * 1_000;
/**
 * The same projection bound the health snapshot uses: reads take one more row
 * than they report so a truncated count says "at least" instead of lying.
 */
const queryLimit = 101;

const readRequest = z
  .object({
    protocolVersion: z.literal(operationsIntelligenceProtocolVersion),
    read: z.enum(operationsIntelligenceReadNames),
    eventSlug: z.string().min(1).max(120),
  })
  .strict();

function readSecret() {
  const value = process.env.INTELLIGENCE_READ_SECRET?.trim();
  if (!value) throw new Error("INTELLIGENCE_READ_SECRET is not configured.");
  return value;
}

export const intelligenceReadEndpoint = httpAction(async (ctx, request) => {
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
      context: operationsIntelligenceReadSignatureContext,
      secret: readSecret(),
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
  const read = parsed.data.read;
  // A switch over the whitelist, not a lookup into anything dynamic: adding a
  // read is a code change reviewed against the redaction rule above.
  const data =
    read === "operations_health"
      ? await ctx.runQuery(internal.operationsHealth.internalOverview, { eventId })
      : read === "operations_attention"
        ? await ctx.runQuery(internal.intelligenceReads.operationsAttentionRead, { eventId })
        : read === "review_rounds"
          ? await ctx.runQuery(internal.intelligenceReads.reviewRoundsRead, { eventId })
          : read === "review_exceptions"
            ? await ctx.runQuery(internal.intelligenceReads.reviewExceptionsRead, { eventId })
            : read === "attendance_counts"
              ? await ctx.runQuery(internal.intelligenceReads.attendanceCountsRead, { eventId })
              : read === "floor_mapping_progress"
                ? await ctx.runQuery(internal.intelligenceReads.floorMappingProgressRead, {
                    eventId,
                  })
                : read === "support_load"
                  ? await ctx.runQuery(internal.intelligenceReads.supportLoadRead, { eventId })
                  : await ctx.runQuery(internal.intelligenceReads.recommendationHistoryRead, {
                      eventId,
                    });
  return Response.json({ read, data }, { status: 200 });
});

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

/**
 * The reviewable-team rule the review overview applies, restated here because
 * the exported overview builder authenticates a person and this projection
 * has none. A drift between the two shows up as a wrong "unassigned" count,
 * never as a leak.
 */
function isReviewableTeam(team: Doc<"teams">) {
  return (
    ["confirmed", "checked_in", "active"].includes(team.status) &&
    team.membershipLocked &&
    team.trackLocked &&
    team.lockedProjectVersionId !== undefined
  );
}

function isLiveReviewStatus(status: Doc<"reviewSessions">["status"]) {
  return status === "awaiting_presence" || status === "active" || status === "overdue";
}

async function activeRoundPauseExists(ctx: QueryCtx, roundId: Id<"reviewRounds">) {
  const pause = await ctx.db
    .query("reviewRoundPauses")
    .withIndex("by_round_state", (index) => index.eq("roundId", roundId).eq("state", "active"))
    .unique();
  return pause !== null;
}

export const reviewRoundsRead = internalQuery({
  args: { eventId: v.id("events") },
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
    const generatedAt = Date.now();
    const [rounds, eventTeams] = await Promise.all([
      ctx.db
        .query("reviewRounds")
        .withIndex("by_event_status_start", (index) => index.eq("eventId", args.eventId))
        .collect(),
      ctx.db
        .query("teams")
        .withIndex("by_event_status", (index) => index.eq("eventId", args.eventId))
        .collect(),
    ]);
    const reviewableTeams = eventTeams.filter(isReviewableTeam);
    const views = [];
    for (const round of rounds.sort((left, right) => left.startsAt - right.startsAt)) {
      const [panels, states, isPaused] = await Promise.all([
        ctx.db
          .query("reviewPanels")
          .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
          .collect(),
        ctx.db
          .query("teamRoundStates")
          .withIndex("by_round_state_priority_queued", (index) => index.eq("roundId", round._id))
          .collect(),
        activeRoundPauseExists(ctx, round._id),
      ]);
      const panelRows = await Promise.all(
        panels.map(async (panel) => {
          const [queued, sessions] = await Promise.all([
            ctx.db
              .query("teamRoundStates")
              .withIndex("by_panel_state_priority_queued", (index) =>
                index.eq("panelId", panel._id),
              )
              .collect(),
            ctx.db
              .query("reviewSessions")
              .withIndex("by_panel_status", (index) => index.eq("panelId", panel._id))
              .collect(),
          ]);
          return {
            panelId: panel._id,
            name: panel.name,
            status: panel.status,
            queuedCount: queued.filter((state) => state.state === "queued").length,
            activeReviewCount: sessions.filter((session) => isLiveReviewStatus(session.status))
              .length,
          };
        }),
      );
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
    return { generatedAt, rounds: views };
  },
});

export const reviewExceptionsRead = internalQuery({
  args: { eventId: v.id("events") },
  returns: v.object({
    generatedAt: v.number(),
    /**
     * Seats that `startPageChain` could fill right now: a removed member on a
     * panel that still needs a reviewer. The member id names the vacancy, not
     * the person; who held the seat stays out of this projection.
     */
    vacancies: v.array(
      v.object({
        missingPanelMemberId: v.id("reviewPanelMembers"),
        panelId: v.id("reviewPanels"),
        panelName: v.string(),
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
        callAttemptCount: v.number(),
        queuedAt: v.optional(v.number()),
        heldAt: v.optional(v.number()),
        missedAt: v.optional(v.number()),
        tableLabel: v.optional(v.string()),
      }),
    ),
    atLeast: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const generatedAt = Date.now();
    const shortPanels = await ctx.db
      .query("reviewPanels")
      .withIndex("by_event_status_updated", (index) =>
        index.eq("eventId", args.eventId).eq("status", "needs_reviewer"),
      )
      .take(queryLimit);
    const vacancies = [];
    for (const panel of shortPanels) {
      const [round, removedMembers] = await Promise.all([
        ctx.db.get(panel.roundId),
        ctx.db
          .query("reviewPanelMembers")
          .withIndex("by_panel_status", (index) =>
            index.eq("panelId", panel._id).eq("status", "removed"),
          )
          .take(queryLimit),
      ]);
      if (!round || round.eventId !== args.eventId) continue;
      for (const member of removedMembers) {
        vacancies.push({
          missingPanelMemberId: member._id,
          panelId: panel._id,
          panelName: panel.name,
          roundId: round._id,
          roundName: round.name,
          ...(member.endedAt !== undefined ? { vacantSince: member.endedAt } : {}),
        });
      }
    }
    const rounds = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_status_start", (index) =>
        index.eq("eventId", args.eventId).eq("status", "open"),
      )
      .take(queryLimit);
    const exceptionStates = ["queued", "called", "at_table", "held", "missed"] as const;
    const teams = [];
    for (const round of rounds) {
      for (const state of exceptionStates) {
        const rows = await ctx.db
          .query("teamRoundStates")
          .withIndex("by_round_state_priority_queued", (index) =>
            index.eq("roundId", round._id).eq("state", state),
          )
          .take(queryLimit);
        for (const row of rows) {
          teams.push({
            teamRoundStateId: row._id,
            roundId: round._id,
            state: row.state,
            callAttemptCount: row.callAttemptCount,
            ...(row.queuedAt !== undefined ? { queuedAt: row.queuedAt } : {}),
            ...(row.heldAt !== undefined ? { heldAt: row.heldAt } : {}),
            ...(row.missedAt !== undefined ? { missedAt: row.missedAt } : {}),
            ...(row.tableLabel !== undefined ? { tableLabel: row.tableLabel } : {}),
          });
        }
      }
    }
    const atLeast = teams.length > queryLimit - 1 || vacancies.length > queryLimit - 1;
    return {
      generatedAt,
      vacancies: vacancies.slice(0, queryLimit - 1),
      teams: teams.slice(0, queryLimit - 1),
      atLeast,
    };
  },
});

export const operationsAttentionRead = internalQuery({
  args: { eventId: v.id("events") },
  returns: v.object({
    generatedAt: v.number(),
    items: v.array(
      v.object({
        itemId: v.id("operationsAttentionItems"),
        detectorKey: attentionDetectorKey,
        subjectType: attentionSubjectType,
        severity: attentionSeverity,
        /** Detector prose about panels, teams, and stations; never a person. */
        statement: v.string(),
        state: v.union(v.literal("open"), v.literal("acknowledged")),
        recurrenceCount: v.number(),
        firstObservedAt: v.number(),
        lastObservedAt: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const generatedAt = Date.now();
    const items = [];
    for (const state of ["open", "acknowledged"] as const) {
      const rows = await ctx.db
        .query("operationsAttentionItems")
        .withIndex("by_event_state_severity_first", (index) =>
          index.eq("eventId", args.eventId).eq("state", state),
        )
        .take(queryLimit);
      for (const item of rows) {
        items.push({
          itemId: item._id,
          detectorKey: item.detectorKey,
          subjectType: item.subjectType,
          severity: item.severity,
          statement: item.statement,
          state,
          recurrenceCount: item.recurrenceCount,
          firstObservedAt: item.firstObservedAt,
          lastObservedAt: item.lastObservedAt,
        });
      }
    }
    return { generatedAt, items };
  },
});

export const attendanceCountsRead = internalQuery({
  args: { eventId: v.id("events") },
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
    const generatedAt = Date.now();
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("The intelligence read event no longer exists.");
    const venueShards = await ctx.db
      .query("venueCheckInCounterShards")
      .withIndex("by_event_shard", (index) => index.eq("eventId", args.eventId))
      .collect();
    const venueCheckedIn = venueShards.reduce((total, shard) => total + shard.checkedIn, 0);
    const planId = event.publishedAttendancePlanVersionId;
    const plan = planId ? await ctx.db.get(planId) : null;
    if (!plan || plan.eventId !== event._id || plan.status !== "published") {
      return { generatedAt, venueCheckedIn, sessions: [] };
    }
    const sessions = await ctx.db
      .query("attendanceSessions")
      .withIndex("by_plan_key", (index) => index.eq("planVersionId", plan._id))
      .collect();
    const views = await Promise.all(
      sessions
        .sort((left, right) => left.startsAt - right.startsAt)
        .map(async (session) => {
          const shards = await ctx.db
            .query("attendanceSessionCounterShards")
            .withIndex("by_session_shard", (index) => index.eq("sessionId", session._id))
            .collect();
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
    return { generatedAt, venueCheckedIn, sessions: views };
  },
});

export const floorMappingProgressRead = internalQuery({
  args: { eventId: v.id("events") },
  returns: v.object({
    generatedAt: v.number(),
    plan: v.union(
      v.null(),
      v.object({
        name: v.string(),
        planNumber: v.number(),
        mappingState: floorMappingState,
      }),
    ),
    eligibleTeamCount: v.number(),
    mappedTeamCount: v.number(),
    unmappedTeamCount: v.number(),
    lastMappedAt: v.optional(v.number()),
    zones: v.array(
      v.object({
        zoneId: v.id("floorZones"),
        name: v.string(),
        mappedTeamCount: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const generatedAt = Date.now();
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("The intelligence read event no longer exists.");
    const planId = event.publishedFloorPlanVersionId;
    const plan = planId ? await ctx.db.get(planId) : null;
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_event_status", (index) => index.eq("eventId", args.eventId))
      .collect();
    const eligibleTeams = teams.filter(
      (team) =>
        team.status === "confirmed" || team.status === "checked_in" || team.status === "active",
    );
    if (!plan || plan.eventId !== event._id || plan.status !== "published") {
      return {
        generatedAt,
        plan: null,
        eligibleTeamCount: eligibleTeams.length,
        mappedTeamCount: 0,
        unmappedTeamCount: eligibleTeams.length,
        zones: [],
      };
    }
    const [zones, locations] = await Promise.all([
      ctx.db
        .query("floorZones")
        .withIndex("by_plan_order", (index) => index.eq("planVersionId", plan._id))
        .collect(),
      ctx.db
        .query("teamFloorLocations")
        .withIndex("by_plan_state", (index) =>
          index.eq("planVersionId", plan._id).eq("state", "active"),
        )
        .collect(),
    ]);
    const mappedTeamIds = new Set(locations.map((location) => location.teamId));
    return {
      generatedAt,
      plan: { name: plan.name, planNumber: plan.planNumber, mappingState: plan.mappingState },
      eligibleTeamCount: eligibleTeams.length,
      mappedTeamCount: locations.length,
      unmappedTeamCount: eligibleTeams.filter((team) => !mappedTeamIds.has(team._id)).length,
      ...(locations.length > 0
        ? { lastMappedAt: Math.max(...locations.map((location) => location.mappedAt)) }
        : {}),
      zones: zones.map((zone) => ({
        zoneId: zone._id,
        name: zone.name,
        mappedTeamCount: locations.filter((location) => location.zoneId === zone._id).length,
      })),
    };
  },
});

export const supportLoadRead = internalQuery({
  args: { eventId: v.id("events") },
  returns: v.object({
    generatedAt: v.number(),
    byState: v.object({
      open: v.number(),
      investigating: v.number(),
      waiting: v.number(),
      resolved: v.number(),
      closed: v.number(),
    }),
    openByCategory: v.array(
      v.object({ category: supportCaseCategory, count: v.number() }),
    ),
    unassignedOpenCount: v.number(),
    oldestOpenAt: v.optional(v.number()),
    atLeast: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const generatedAt = Date.now();
    const states = ["open", "investigating", "waiting", "resolved", "closed"] as const;
    const rowsByState = await Promise.all(
      states.map((state) =>
        ctx.db
          .query("supportCases")
          .withIndex("by_event_state_updated", (index) =>
            index.eq("eventId", args.eventId).eq("state", state),
          )
          .take(queryLimit),
      ),
    );
    const bounded = (rows: readonly unknown[]) => Math.min(rows.length, queryLimit - 1);
    const liveRows = [...(rowsByState[0] ?? []), ...(rowsByState[1] ?? []), ...(rowsByState[2] ?? [])];
    const categoryCounts = new Map<Doc<"supportCases">["category"], number>();
    for (const row of liveRows) {
      categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1);
    }
    const openRows = rowsByState[0] ?? [];
    return {
      generatedAt,
      byState: {
        open: bounded(rowsByState[0] ?? []),
        investigating: bounded(rowsByState[1] ?? []),
        waiting: bounded(rowsByState[2] ?? []),
        resolved: bounded(rowsByState[3] ?? []),
        closed: bounded(rowsByState[4] ?? []),
      },
      openByCategory: [...categoryCounts.entries()].map(([category, count]) => ({
        category,
        count,
      })),
      unassignedOpenCount: liveRows.filter((row) => row.ownerPersonId === undefined).length,
      ...(openRows.length > 0
        ? { oldestOpenAt: Math.min(...openRows.map((row) => row.createdAt)) }
        : {}),
      atLeast: rowsByState.some((rows) => rows.length === queryLimit),
    };
  },
});

export const recommendationHistoryRead = internalQuery({
  args: { eventId: v.id("events") },
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
        /**
         * The operator's rejection reason or revision suggestion, returned
         * verbatim: it is the human half of the propose-and-revise loop. Who
         * decided stays out; the agent learns from outcomes, not identities.
         */
        operatorNote: v.optional(v.string()),
        proposedAt: v.number(),
        decidedAt: v.optional(v.number()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const generatedAt = Date.now();
    const rows = await ctx.db
      .query("intelligenceRecommendations")
      .withIndex("by_event_proposed", (index) => index.eq("eventId", args.eventId))
      .order("desc")
      .take(50);
    return {
      generatedAt,
      recommendations: rows.map((row) => ({
        proposalKey: row.proposalKey,
        kind: row.arguments.kind,
        statement: row.statement,
        status: row.status,
        ...(row.operatorNote !== undefined ? { operatorNote: row.operatorNote } : {}),
        proposedAt: row.proposedAt,
        ...(row.decidedAt !== undefined ? { decidedAt: row.decidedAt } : {}),
      })),
    };
  },
});
