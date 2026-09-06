import { paginationOptsValidator } from "convex/server";
import { type Infer, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { readAttendanceTeamAvailability } from "./lib/attendanceTeamAvailability";
import { applyInhibition, attentionClearDelayMs,
} from "./lib/operationsAttention";
import { appendOperationsAttentionReadFactById } from "./lib/operationsAutonomyReadFacts";
import {
  reviewPanelItems,
  reviewTeamItems,
  roundForecastItems,
  scorecardChaseItems,
  type ClockInStatus,
  type OutstandingScorecardProjection,
  type PanelMemberProjection,
  type PanelProjection,
  type ReviewProjection,
  type TeamProjection,
} from "./lib/operationsAttentionDetectors";
import type { AttentionProposal } from "./lib/operationsAttentionProposals";
import {
  defaultReviewScoringBufferSeconds,
  maximumReviewPanelsPerRound,
  maximumReviewersPerPanel,
  maximumReviewTeamsPerEvent,
} from "./lib/reviewLimits";
import { findReviewParticipantAvailabilityWaiver } from "./lib/reviewParticipantAvailability";
import {
  attentionDetectorKey,
  attentionProposal,
  attentionScopeType,
  attentionSeverity,
  attentionSubjectType,
  type AttentionDetectorKey,
  type StoredAttentionCommand,
} from "./values";

/** Minimum sample size for a useful review-duration median. */
const paceSampleLimit = 9;
/** Ignore older reviews when chasing outstanding scorecards. */
const scorecardChaseWindowMs = 4 * 60 * 60 * 1_000;
const activeTeamStates = ["queued", "called", "at_table", "in_review", "held",
] as const;
/** Review-domain keys reconciled by this sweep. */
const reviewDomainDetectorKeys: readonly AttentionDetectorKey[] = [
  "panel_seat_empty",
  "seat_at_risk",
  "review_overdue",
  "review_presence_incomplete",
  "team_below_minimum",
  "team_held",
  "team_call_overdue",
  "team_waiting_long",
  "round_finish_forecast",
  "panel_bottleneck",
  "scorecard_outstanding",
];
const liveItemStates = ["open", "acknowledged", "dismissed"] as const;
/** Leave enough proposal life for a client round trip before refreshing it. */
const proposalMinimumValidityMs = 60_000;
/** The event deployment contract and emergency-pack boundary allow ten current rounds. */
const maximumSweepRounds = 10;
const panelPageSize = 20;
const teamPageSize = 40;
const scorecardPageSize = 50;
const maximumDraftScorecardsPerRound = maximumReviewPanelsPerRound * maximumReviewersPerPanel;
const maximumReviewAttentionCandidates =
  maximumReviewPanelsPerRound * (maximumReviewersPerPanel + 2) +
  maximumReviewTeamsPerEvent * 6 +
  maximumDraftScorecardsPerRound;
/** After inhibition, this leaves room for both current rows and new recurrence lookups. */
const maximumReviewAttentionObservations = 1_000;
const maximumReviewAttentionPayloadBytes = 4 * 1_024 * 1_024;

const reviewSweepTarget = v.object({
  eventId: v.id("events"),
  roundId: v.id("reviewRounds"),
  expectedSweepVersion: v.optional(v.number()),
});
type ReviewSweepTarget = Infer<typeof reviewSweepTarget>;

const sweepObservationFields = {
  detectorKey: attentionDetectorKey,
  dedupeKey: v.string(),
  subjectType: attentionSubjectType,
  subjectId: v.string(),
  severity: attentionSeverity,
  statement: v.string(),
  route: v.string(),
  actionLabel: v.string(),
  visibility: v.object({
    permissionKey: v.string(),
    scopeType: attentionScopeType,
    scopeId: v.string(),
  }),
  evidenceJson: v.string(),
  proposal: v.optional(attentionProposal),
};
const sweepObservation = v.object(sweepObservationFields);
type SweepObservation = Infer<typeof sweepObservation>;

const sweepCandidate = v.object({
  ...sweepObservationFields,
  scopes: v.array(v.string()),
});
type SweepCandidate = Infer<typeof sweepCandidate>;

const sweepCandidatePage = v.object({
  continueCursor: v.string(),
  isDone: v.boolean(),
  valid: v.boolean(),
  scannedCount: v.number(),
  candidates: v.array(sweepCandidate),
});

const scorecardGap = v.object({
  reviewSessionId: v.id("reviewSessions"),
  teamName: v.string(),
  panelName: v.string(),
  completedAt: v.number(),
  reviewer: v.object({
    displayName: v.string(),
    clockInStatus: v.union(
      v.literal("not_clocked_in"),
      v.literal("present"),
      v.literal("temporarily_unavailable"),
      v.literal("clocked_out"),
      v.literal("no_show"),
    ),
    lastHeartbeatAt: v.optional(v.number()),
  }),
});
type ScorecardGap = Infer<typeof scorecardGap>;

const scorecardGapPage = v.object({
  continueCursor: v.string(),
  isDone: v.boolean(),
  valid: v.boolean(),
  scannedCount: v.number(),
  gaps: v.array(scorecardGap),
});

type SweepRoundContext = {
  scoringBufferSeconds: number;
  event: Doc<"events">;
  round: Doc<"reviewRounds">;
  isPaused: boolean;
};

async function readSweepRoundContext(
  ctx: QueryCtx,
  args: { eventId: Id<"events">; roundId: Id<"reviewRounds"> },
): Promise<SweepRoundContext | null> {
  const [event, round] = await Promise.all([ctx.db.get(args.eventId), ctx.db.get(args.roundId),
  ]);
  if (
    event === null ||
    event.status !== "live" ||
    round === null ||
    round.eventId !== event._id ||
    (round.status !== "open" && round.status !== "closing")
  ) {
    return null;
  }
  const pause = await ctx.db
    .query("reviewRoundPauses")
    .withIndex("by_round_state", (index) => index.eq("roundId", round._id).eq("state", "active"),
    )
    .first();
  const queuePolicy = await ctx.db
    .query("reviewQueuePolicies")
    .withIndex("by_round", (q) => q.eq("roundId", round._id))
    .unique();
  return { event, round, isPaused: pause !== null,
    scoringBufferSeconds: queuePolicy?.scoringBufferSeconds ?? defaultReviewScoringBufferSeconds,
  };
}

function detectorCandidate(
  ctx: QueryCtx,
  item: ReturnType<typeof reviewPanelItems>[number],
): SweepCandidate {
  return {
    detectorKey: item.detectorKey,
    dedupeKey: item.dedupeKey,
    subjectType: item.subjectType,
    subjectId: item.subjectId,
    severity: item.severity,
    statement: item.statement,
    route: item.route,
    actionLabel: item.actionLabel,
    visibility: item.visibility,
    evidenceJson: item.evidenceJson,
    scopes: [...item.scopes],
    ...proposalFields(ctx, item.proposal),
  };
}

function observationOf(candidate: SweepCandidate): SweepObservation {
  const { scopes: _scopes, ...observation } = candidate;
  return observation;
}

/** Finds active rounds and closed-round ledger work without reading the review floor. */
export const reviewDomainTargets = internalQuery({
  args: {},
  returns: v.array(reviewSweepTarget),
  handler: async (ctx) => {
    const byRound = new Map<Id<"reviewRounds">, ReviewSweepTarget>();
    const addTarget = (target: ReviewSweepTarget) => {
      const existing = byRound.get(target.roundId);
      if (existing !== undefined && existing.eventId !== target.eventId) {
        throw new Error("An attention sweep round cannot belong to two events.",
        );
      }
      const expectedSweepVersion = target.expectedSweepVersion ?? existing?.expectedSweepVersion;
      byRound.set(target.roundId, {
        eventId: target.eventId,
        roundId: target.roundId,
        ...(expectedSweepVersion === undefined ? {} : { expectedSweepVersion }),
      });
    };

    const events = await ctx.db.query("events").take(2);
    if (events.length > 1) {
      throw new Error("An attention sweep deployment cannot have more than one event.",
      );
    }
    for (const event of events.filter((row) => row.status === "live")) {
      for (const status of ["open", "closing"] as const) {
        const rounds = await ctx.db
          .query("reviewRounds")
          .withIndex("by_event_status_start", (index) =>
            index.eq("eventId", event._id).eq("status", status),
          )
          .take(maximumSweepRounds + 1);
        if (rounds.length > maximumSweepRounds) {
          throw new Error(
            `Attention sweep supports at most ${maximumSweepRounds} ${status} rounds.`,
          );
        }
        for (const round of rounds) {
          addTarget({ eventId: event._id, roundId: round._id });
        }
      }
    }

    const unsettled = await ctx.db
      .query("operationsAttentionSweepStates")
      .withIndex("by_state", (index) => index.eq("state", "active"))
      .take(maximumSweepRounds + 1);
    if (unsettled.length > maximumSweepRounds) {
      throw new Error(`Attention sweep supports at most ${maximumSweepRounds} unsettled rounds.`,
      );
    }
    for (const state of unsettled) {
      addTarget({
        eventId: state.eventId,
        roundId: state.roundId,
        expectedSweepVersion: state.version,
      });
    }
    if (byRound.size > maximumSweepRounds) {
      throw new Error(`Attention sweep supports at most ${maximumSweepRounds} current rounds.`,
      );
    }

    const targets = await Promise.all(
      [...byRound.values()].map(async (target) => {
        if (target.expectedSweepVersion !== undefined) return target;
        const state = await ctx.db
          .query("operationsAttentionSweepStates")
          .withIndex("by_round", (index) => index.eq("roundId", target.roundId))
          .unique();
        return state === null ? target : { ...target, expectedSweepVersion: state.version };
      }),
    );
    return targets.sort((left, right) => left.roundId.localeCompare(right.roundId),
    );
  },
});

/** Reads one bounded panel page and its complete detector inputs. */
export const reviewPanelSnapshotPage = internalQuery({
  args: {
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    now: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: sweepCandidatePage,
  handler: async (ctx, args) => {
    if (args.paginationOpts.numItems !== panelPageSize) {
      throw new Error(`Attention panel pages contain exactly ${panelPageSize} panels.`,
      );
    }
    const context = await readSweepRoundContext(ctx, args);
    if (context === null) {
      return {
        continueCursor: "",
        isDone: true,
        valid: false,
        scannedCount: 0,
        candidates: [],
      };
    }
    const page = await ctx.db
      .query("reviewPanels")
      .withIndex("by_round_status", (index) => index.eq("roundId", context.round._id),
      )
      .paginate(args.paginationOpts);
    const states = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_state_priority_queued", (index) =>
        index.eq("roundId", context.round._id),
      )
      .take(maximumReviewTeamsPerEvent + 1);
    if (states.length > maximumReviewTeamsPerEvent) {
      throw new Error("A round exceeds the review-team limit.");
    }
    const queuedByPanelId = new Map<Id<"reviewPanels">, Doc<"teamRoundStates">[]>();
    for (const state of states) {
      if (state.state !== "queued" || state.panelId === undefined) continue;
      const queued = queuedByPanelId.get(state.panelId);
      if (queued === undefined) queuedByPanelId.set(state.panelId, [state]);
      else queued.push(state);
    }
    const panelViews: PanelProjection[] = [];
    for (const panel of page.page) {
      panelViews.push(
        await readPanelProjection(ctx, context, panel, queuedByPanelId.get(panel._id) ?? [],
        ),
      );
    }
    const input = floorInput(context, args.now, panelViews, []);
    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      valid: true,
      scannedCount: page.page.length,
      candidates: reviewPanelItems(input).map((item) => detectorCandidate(ctx, item),
      ),
    };
  },
});

/** Reads one bounded team page and its complete detector inputs. */
export const reviewTeamSnapshotPage = internalQuery({
  args: {
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    now: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: sweepCandidatePage,
  handler: async (ctx, args) => {
    if (args.paginationOpts.numItems !== teamPageSize) {
      throw new Error(`Attention team pages contain exactly ${teamPageSize} teams.`,
      );
    }
    const context = await readSweepRoundContext(ctx, args);
    if (context === null) {
      return {
        continueCursor: "",
        isDone: true,
        valid: false,
        scannedCount: 0,
        candidates: [],
      };
    }
    const page = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_state_priority_queued", (index) =>
        index.eq("roundId", context.round._id),
      )
      .paginate(args.paginationOpts);
    const teamViews: TeamProjection[] = [];
    for (const state of page.page) {
      if (!activeTeamStates.some((value) => value === state.state)) continue;
      teamViews.push(await readTeamProjection(ctx, context, state));
    }
    const input = floorInput(context, args.now, [], teamViews);
    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      valid: true,
      scannedCount: page.page.length,
      candidates: reviewTeamItems(input).map((item) => detectorCandidate(ctx, item),
      ),
    };
  },
});

/** Reads one bounded page of scorecards that are still not submitted. */
export const reviewScorecardGapPage = internalQuery({
  args: {
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    now: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: scorecardGapPage,
  handler: async (ctx, args) => {
    if (args.paginationOpts.numItems !== scorecardPageSize) {
      throw new Error(`Attention scorecard pages contain exactly ${scorecardPageSize} rows.`,
      );
    }
    const context = await readSweepRoundContext(ctx, args);
    if (context === null) {
      return {
        continueCursor: "",
        isDone: true,
        valid: false,
        scannedCount: 0,
        gaps: [],
      };
    }
    const page = await ctx.db
      .query("scorecards")
      .withIndex("by_round_status_updated", (index) =>
        index.eq("roundId", context.round._id).eq("status", "draft"),
      )
      .paginate(args.paginationOpts);
    const gaps: ScorecardGap[] = [];
    for (const scorecard of page.page) {
      const [session, assignment, reviewer, clockIn] = await Promise.all([
        ctx.db.get(scorecard.reviewSessionId),
        ctx.db.get(scorecard.assignmentId),
        ctx.db.get(scorecard.reviewerPersonId),
        ctx.db
          .query("reviewerClockIns")
          .withIndex("by_round_person", (index) =>
            index
              .eq("roundId", context.round._id)
              .eq("reviewerPersonId", scorecard.reviewerPersonId),
          )
          .unique(),
      ]);
      if (
        session === null ||
        assignment === null ||
        reviewer === null ||
        session.roundId !== context.round._id ||
        assignment.reviewSessionId !== session._id ||
        assignment.reviewerPersonId !== scorecard.reviewerPersonId
      ) {
        throw new Error("An outstanding scorecard has an invalid review context.",
        );
      }
      const completedAt = session.completedAt;
      if (
        assignment.status !== "assigned" ||
        session.status !== "completed" ||
        completedAt === undefined ||
        args.now - completedAt > scorecardChaseWindowMs
      ) {
        continue;
      }
      const [team, panel] = await Promise.all([
        ctx.db.get(session.teamId),
        ctx.db.get(session.panelId),
      ]);
      if (team === null || panel === null) {
        throw new Error("A completed review references a missing team or panel.",
        );
      }
      gaps.push({
        reviewSessionId: session._id,
        teamName: team.name,
        panelName: panel.name,
        completedAt,
        reviewer: {
          displayName: reviewer.displayName,
          clockInStatus: clockInStatusOf(clockIn),
          ...(clockIn === null ? {} : { lastHeartbeatAt: clockIn.lastHeartbeatAt }),
        },
      });
    }
    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      valid: true,
      scannedCount: page.page.length,
      gaps,
    };
  },
});

/** Detects round-wide forecast and scorecard conditions from bounded projections. */
export const reviewRoundAggregateSnapshot = internalQuery({
  args: {
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    now: v.number(),
  },
  returns: v.object({ valid: v.boolean(), candidates: v.array(sweepCandidate),
  }),
  handler: async (ctx, args) => {
    const context = await readSweepRoundContext(ctx, args);
    if (context === null) return { valid: false, candidates: [] };
    const [panels, states] = await Promise.all([
      ctx.db
        .query("reviewPanels")
        .withIndex("by_round_status", (index) => index.eq("roundId", context.round._id),
        )
        .take(maximumReviewPanelsPerRound + 1),
      ctx.db
        .query("teamRoundStates")
        .withIndex("by_round_state_priority_queued", (index) =>
          index.eq("roundId", context.round._id),
        )
        .take(maximumReviewTeamsPerEvent + 1),
    ]);
    if (panels.length > maximumReviewPanelsPerRound) {
      throw new Error("A round exceeds the review-panel limit.");
    }
    if (states.length > maximumReviewTeamsPerEvent) {
      throw new Error("A round exceeds the review-team limit.");
    }
    const queuedByPanelId = new Map<Id<"reviewPanels">, Doc<"teamRoundStates">[]>();
    for (const state of states) {
      if (state.state !== "queued" || state.panelId === undefined) continue;
      const queued = queuedByPanelId.get(state.panelId);
      if (queued === undefined) queuedByPanelId.set(state.panelId, [state]);
      else queued.push(state);
    }
    const panelViews: PanelProjection[] = [];
    for (const panel of panels) {
      panelViews.push(await readForecastPanelProjection(ctx, panel, queuedByPanelId),
      );
    }
    const input = floorInput(context, args.now, panelViews, []);
    return {
      valid: true,
      candidates: roundForecastItems(input).map((item) => detectorCandidate(ctx, item),
      ),
    };
  },
});

/** Converts already bounded scorecard gaps into one row per review. */
export const reviewScorecardSnapshot = internalQuery({
  args: {
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    now: v.number(),
    gaps: v.array(scorecardGap),
  },
  returns: v.array(sweepCandidate),
  handler: async (ctx, args) => {
    const context = await readSweepRoundContext(ctx, args);
    if (context === null) return [];
    const sessionsById = new Map<
      Id<"reviewSessions">,
      Omit<OutstandingScorecardProjection, "reviewers"> & {
        reviewers: ScorecardGap["reviewer"][];
      }
    >();
    for (const gap of args.gaps) {
      const existing = sessionsById.get(gap.reviewSessionId);
      if (existing === undefined) {
        sessionsById.set(gap.reviewSessionId, {
          reviewSessionId: gap.reviewSessionId,
          teamName: gap.teamName,
          panelName: gap.panelName,
          completedAt: gap.completedAt,
          reviewers: [gap.reviewer],
        });
        continue;
      }
      if (
        existing.teamName !== gap.teamName ||
        existing.panelName !== gap.panelName ||
        existing.completedAt !== gap.completedAt
      ) {
        throw new Error("One review produced inconsistent scorecard chase facts.",
        );
      }
      existing.reviewers.push(gap.reviewer);
    }
    return scorecardChaseItems({
      now: args.now,
      roundId: context.round._id,
      roundName: context.round.name,
      sessions: [...sessionsById.values()],
    }).map((item) => detectorCandidate(ctx, item));
  },
});

/** Reconciles one round without adding review-floor documents to the OCC read set. */
export const reconcileReviewRound = internalMutation({
  args: {
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    expectedSweepVersion: v.optional(v.number()),
    observed: v.array(sweepObservation),
    now: v.number(),
  },
  returns: v.union(v.literal("applied"), v.literal("stale")),
  handler: async (ctx, args) => {
    assertObservationPayload(args.observed);
    const sweepState = await ctx.db
      .query("operationsAttentionSweepStates")
      .withIndex("by_round", (index) => index.eq("roundId", args.roundId))
      .unique();
    if (
      (sweepState === null && args.expectedSweepVersion !== undefined) ||
      (sweepState !== null && sweepState.version !== args.expectedSweepVersion)
    ) {
      return "stale";
    }

    await reconcile(ctx, args);
    const liveRowsRemain = await hasLiveRoundRows(ctx, args.roundId);
    const state = liveRowsRemain || args.observed.length > 0 ? "active" : "settled";
    if (sweepState === null) {
      await ctx.db.insert("operationsAttentionSweepStates", {
        eventId: args.eventId,
        roundId: args.roundId,
        state,
        lastReconciledAt: args.now,
        version: 1,
      });
    } else {
      if (sweepState.eventId !== args.eventId) {
        throw new Error("An attention sweep state belongs to the wrong event.");
      }
      await ctx.db.patch(sweepState._id, {
        state,
        lastReconciledAt: args.now,
        version: sweepState.version + 1,
      });
    }
    return "applied";
  },
});

/** Dispatches per-round reads and narrow reconciliations from the cron action. */
export const sweepReviewDomain = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const targets: ReviewSweepTarget[] = await ctx.runQuery(
      internal.operationsAttentionSweep.reviewDomainTargets,
      {},
    );
    for (const target of targets) {
      const observed = await readBoundedRoundSnapshot(ctx, target, now);
      await ctx.runMutation(internal.operationsAttentionSweep.reconcileReviewRound, {
        ...target,
        observed,
        now,
      },
      );
    }
    return null;
  },
});

async function readBoundedRoundSnapshot(ctx: ActionCtx, target: ReviewSweepTarget, now: number,
) {
  const panelCandidates: SweepCandidate[] = [];
  const teamCandidates: SweepCandidate[] = [];
  const [panelCount, teamCount, gapReading] = await Promise.all([
    readCandidatePages(
      ctx,
      internal.operationsAttentionSweep.reviewPanelSnapshotPage,
      target,
      now,
      panelPageSize,
      maximumReviewPanelsPerRound,
      panelCandidates,
    ),
    readCandidatePages(
      ctx,
      internal.operationsAttentionSweep.reviewTeamSnapshotPage,
      target,
      now,
      teamPageSize,
      maximumReviewTeamsPerEvent,
      teamCandidates,
    ),
    readScorecardGaps(ctx, target, now),
  ]);
  if (panelCount > maximumReviewPanelsPerRound) {
    throw new Error("A round exceeds the review-panel limit.");
  }
  if (teamCount > maximumReviewTeamsPerEvent) {
    throw new Error("A round exceeds the review-team limit.");
  }
  if (gapReading === null) return [];
  const candidates = [...panelCandidates, ...teamCandidates];
  const { gaps } = gapReading;
  const [aggregate, scorecards] = await Promise.all([
    ctx.runQuery(internal.operationsAttentionSweep.reviewRoundAggregateSnapshot, {
      eventId: target.eventId,
      roundId: target.roundId,
      now,
    },
    ),
    ctx.runQuery(internal.operationsAttentionSweep.reviewScorecardSnapshot, {
      eventId: target.eventId,
      roundId: target.roundId,
      now,
      gaps,
    }),
  ]);
  if (!aggregate.valid) return [];
  candidates.push(...aggregate.candidates, ...scorecards);
  if (candidates.length > maximumReviewAttentionCandidates) {
    throw new Error("A round exceeds the attention-candidate limit.");
  }
  const detected = applyInhibition(candidates).map(observationOf);
  assertObservationPayload(detected);
  return detected;
}

async function readScorecardGaps(ctx: ActionCtx, target: ReviewSweepTarget, now: number,
) {
  const gaps: ScorecardGap[] = [];
  let scorecardCursor: string | null = null;
  let scorecardCount = 0;
  while (true) {
    const page: Infer<typeof scorecardGapPage> = await ctx.runQuery(
      internal.operationsAttentionSweep.reviewScorecardGapPage,
      {
        eventId: target.eventId,
        roundId: target.roundId,
        now,
        paginationOpts: { cursor: scorecardCursor, numItems: scorecardPageSize,
        },
      },
    );
    if (!page.valid) return null;
    scorecardCount += page.scannedCount;
    if (scorecardCount > maximumDraftScorecardsPerRound) {
      throw new Error("A round exceeds the outstanding-scorecard projection limit.",
      );
    }
    gaps.push(...page.gaps);
    if (page.isDone) break;
    scorecardCursor = page.continueCursor;
  }
  return { gaps };
}

async function readCandidatePages(
  ctx: ActionCtx,
  queryReference:
    | typeof internal.operationsAttentionSweep.reviewPanelSnapshotPage
    | typeof internal.operationsAttentionSweep.reviewTeamSnapshotPage,
  target: ReviewSweepTarget,
  now: number,
  numItems: number,
  maximumRows: number,
  candidates: SweepCandidate[],
) {
  let cursor: string | null = null;
  let scannedCount = 0;
  while (true) {
    const page: Infer<typeof sweepCandidatePage> = await ctx.runQuery(queryReference, {
      eventId: target.eventId,
      roundId: target.roundId,
      now,
      paginationOpts: { cursor, numItems },
    },
    );
    if (!page.valid) return 0;
    scannedCount += page.scannedCount;
    if (scannedCount > maximumRows) return scannedCount;
    candidates.push(...page.candidates);
    if (page.isDone) return scannedCount;
    cursor = page.continueCursor;
  }
}

function assertObservationPayload(observed: readonly SweepObservation[]) {
  if (observed.length > maximumReviewAttentionObservations) {
    throw new Error("A round exceeds the attention-observation limit.");
  }
  if (
    new TextEncoder().encode(JSON.stringify(observed)).byteLength >
    maximumReviewAttentionPayloadBytes
  ) {
    throw new Error("A round exceeds the attention-payload limit.");
  }
}

function floorInput(
  context: SweepRoundContext,
  now: number,
  panels: readonly PanelProjection[],
  teams: readonly TeamProjection[],
) {
  const { round, isPaused, scoringBufferSeconds } = context;
  return {
    now,
    scoringBufferSeconds,
    roundId: round._id,
    roundName: round.name,
    roundEndsAt: round.endsAt,
    reviewerReportAt: round.reviewerReportAt,
    reviewerNoShowGraceSeconds: round.noShowGraceSeconds,
    requiredPanelSize: round.requiredPanelSize,
    reviewDurationSeconds: round.reviewDurationSeconds,
    isPaused,
    panels,
    teams,
  };
}

async function readPanelProjection(
  ctx: QueryCtx,
  context: SweepRoundContext,
  panel: Doc<"reviewPanels">,
  queuedStates: readonly Doc<"teamRoundStates">[],
): Promise<PanelProjection> {
  const [members, activeChain, runningSessions, removedMembers] = await Promise.all([
    ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_panel_status", (index) =>
        index.eq("panelId", panel._id).eq("status", "active"),
      )
      .take(maximumReviewersPerPanel + 1),
    ctx.db
      .query("reviewerPageChains")
      .withIndex("by_panel_state", (index) => index.eq("panelId", panel._id).eq("state", "active"),
        )
      .first(),
    livePanelSessions(ctx, panel._id),
    panel.status === "needs_reviewer"
      ? ctx.db
          .query("reviewPanelMembers")
          .withIndex("by_panel_status_ended", (index) =>
            index.eq("panelId", panel._id).eq("status", "removed"),
          )
          .order("desc")
          .take(1)
      : Promise.resolve([]),
  ]);
  if (members.length > maximumReviewersPerPanel) {
    throw new Error("A review panel exceeds the published reviewer limit.");
  }
  const memberViews: PanelMemberProjection[] = [];
  for (const member of members) {
    const [clockIn, devices, person] = await Promise.all([
      ctx.db
        .query("reviewerClockIns")
        .withIndex("by_round_person", (index) =>
          index.eq("roundId", context.round._id).eq("reviewerPersonId", member.personId),
        )
        .unique(),
      ctx.db
        .query("reviewerDevices")
        .withIndex("by_event_person_status_seen", (index) =>
          index
            .eq("eventId", context.event._id)
            .eq("personId", member.personId)
            .eq("status", "active"),
        )
        .order("desc")
        .take(2),
      ctx.db.get(member.personId),
    ]);
    if (person === null) throw new Error("A panel member references a missing person.");
    const device = devices[0];
    memberViews.push({
      panelMemberId: member._id,
      personId: member.personId,
      displayName: person.displayName,
      clockInStatus: clockInStatusOf(clockIn),
      clockInVersion: clockIn?.version ?? 0,
      ...(clockIn?.expectedReturnAt === undefined
        ? {}
        : { expectedReturnAt: clockIn.expectedReturnAt }),
      ...(clockIn === null ? {} : { lastHeartbeatAt: clockIn.lastHeartbeatAt }),
      deviceCount: devices.length === 2 ? 2 : devices.length,
      ...(device === undefined
        ? {}
        : {
            pushTokenStatus: device.pushTokenStatus,
            ...(device.pushTokenInvalidatedAt === undefined
              ? {}
              : { pushTokenInvalidatedAt: device.pushTokenInvalidatedAt }),
          }),
    });
  }
  const running = runningSessions[0];
  return {
    panelId: panel._id,
    name: panel.name,
    status: panel.status,
    version: panel.version,
    statusSince: panel.updatedAt,
    ...(removedMembers[0] === undefined ? {} : { vacantPanelMemberId: removedMembers[0]._id }),
    hasActivePageChain: activeChain !== null,
    hasRunningReview: running !== undefined,
    members: memberViews,
    queuedTeams: queuedStates.map((state) => ({
      teamRoundStateId: state._id,
      version: state.version,
      teamName: "",
      queuedAt: state.queuedAt ?? state.updatedAt,
    })),
    ...(running?.plannedEndAt === undefined
      ? {}
      : { activeReviewPlannedEndAt: running.plannedEndAt }),
    completedDurationsSeconds: [],
  };
}

async function readTeamProjection(
  ctx: QueryCtx,
  context: SweepRoundContext,
  state: Doc<"teamRoundStates">,
) {
  const [team, availability, liveSessions] = await Promise.all([
    ctx.db.get(state.teamId),
    readAttendanceTeamAvailability(ctx, {
      eventId: context.event._id,
      teamId: state.teamId,
    }),
    liveTeamSessions(ctx, context.round._id, state.teamId),
  ]);
  if (team === null) throw new Error("A review queue state references a missing team.");
  const live = liveSessions[0] ?? null;
  let review: ReviewProjection | null = null;
  let availabilityWaived = false;
  if (live !== null) {
    const [assignments, presences, waiver] = await Promise.all([
      ctx.db
        .query("reviewAssignments")
        .withIndex("by_round_session", (index) =>
          index.eq("roundId", context.round._id).eq("reviewSessionId", live._id),
        )
        .take(maximumReviewersPerPanel + 1),
      ctx.db
        .query("reviewPresence")
        .withIndex("by_session_reviewer", (index) => index.eq("reviewSessionId", live._id),
        )
        .take(maximumReviewersPerPanel + 1),
      findReviewParticipantAvailabilityWaiver(ctx, live._id),
    ]);
    if (
      assignments.length > maximumReviewersPerPanel ||
      presences.length > maximumReviewersPerPanel
    ) {
      throw new Error("A live review exceeds the published reviewer limit.");
    }
    const assigned = assignments.filter((assignment) => assignment.status === "assigned",
    );
    review = {
      reviewSessionId: live._id,
      version: live.version,
      status: live.status,
      createdAt: live.createdAt,
      ...(live.plannedEndAt === undefined ? {} : { plannedEndAt: live.plannedEndAt }),
      reviewerPresenceCount: assigned.filter((assignment) =>
        presences.some((presence) => presence.reviewerPersonId === assignment.reviewerPersonId,
        ),
      ).length,
      reviewerCount: assigned.length,
      canExtend: live.extensionCount < context.round.maximumOrdinaryExtensions,
    };
    availabilityWaived = waiver !== null;
  }
  return teamProjection(state, team.name, review, availability, context.round, availabilityWaived,
  );
}

async function livePanelSessions(ctx: QueryCtx, panelId: Id<"reviewPanels">) {
  const rows = await Promise.all(
    (["awaiting_presence", "active", "scoring"] as const).map((status) =>
      ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (index) => index.eq("panelId", panelId).eq("status", status),
        )
        .take(2),
    ),
  );
  const sessions = rows.flat();
  if (sessions.length > 1) throw new Error("A panel has more than one live review.");
  return sessions;
}

async function liveTeamSessions(ctx: QueryCtx, roundId: Id<"reviewRounds">, teamId: Id<"teams">,
) {
  const rows = await Promise.all(
    (["awaiting_presence", "active", "scoring"] as const).map((status) =>
      ctx.db
        .query("reviewSessions")
        .withIndex("by_round_team_status", (index) =>
          index.eq("roundId", roundId).eq("teamId", teamId).eq("status", status),
        )
        .take(2),
    ),
  );
  const sessions = rows.flat();
  if (sessions.length > 1) throw new Error("A team has more than one live review.");
  return sessions;
}

async function readForecastPanelProjection(
  ctx: QueryCtx,
  panel: Doc<"reviewPanels">,
  queuedByPanelId: ReadonlyMap<Id<"reviewPanels">, readonly Doc<"teamRoundStates">[]>,
) {
  const [runningSessions, completedSessions] = await Promise.all([
    livePanelSessions(ctx, panel._id),
    ctx.db
      .query("reviewSessions")
      .withIndex("by_panel_status", (index) =>
        index.eq("panelId", panel._id).eq("status", "completed"),
      )
      .order("desc")
      .take(paceSampleLimit),
  ]);
  const queuedTeams = [];
  for (const state of queuedByPanelId.get(panel._id) ?? []) {
    const team = await ctx.db.get(state.teamId);
    if (team === null) throw new Error("A queued review state references a missing team.");
    queuedTeams.push({
      teamRoundStateId: state._id,
      version: state.version,
      teamName: team.name,
      queuedAt: state.queuedAt ?? state.updatedAt,
    });
  }
  const running = runningSessions[0];
  return {
    panelId: panel._id,
    name: panel.name,
    status: panel.status,
    version: panel.version,
    statusSince: panel.updatedAt,
    hasActivePageChain: false,
    hasRunningReview: running !== undefined,
    members: [],
    queuedTeams,
    ...(running?.plannedEndAt === undefined
      ? {}
      : { activeReviewPlannedEndAt: running.plannedEndAt }),
    completedDurationsSeconds: completedDurations(completedSessions),
  } satisfies PanelProjection;
}

function teamProjection(
  state: Doc<"teamRoundStates">,
  teamName: string,
  review: ReviewProjection | null,
  availability: Doc<"attendanceTeamAvailability">,
  round: Doc<"reviewRounds">,
  availabilityWaived: boolean,
): TeamProjection {
  const lastCallAt = state.lastCallAttemptAt ?? state.calledAt;
  return {
    teamRoundStateId: state._id,
    version: state.version,
    teamId: state.teamId,
    teamName,
    ...(state.panelId === undefined ? {} : { panelId: state.panelId }),
    state: state.state,
    ...(state.queuedAt === undefined ? {} : { queuedAt: state.queuedAt }),
    ...(state.calledAt === undefined ? {} : { calledAt: state.calledAt }),
    ...(state.heldAt === undefined ? {} : { heldAt: state.heldAt }),
    ...(state.holdReason === undefined ? {} : { holdReason: state.holdReason }),
    ...(lastCallAt === undefined
      ? {}
      : { missedEligibleAt: lastCallAt + round.missedCallGraceSeconds * 1_000,
        }),
    updatedAt: state.updatedAt,
    availableCount: availability.insideMemberCount,
    requiredCount: round.minimumPresentParticipants,
    availabilityWaived,
    review,
  };
}

function clockInStatusOf(clockIn: Doc<"reviewerClockIns"> | null,
): ClockInStatus {
  return clockIn === null ? "not_clocked_in" : clockIn.status;
}

/** Newest first so the median reflects current floor pace. */
function completedDurations(sessions: readonly Doc<"reviewSessions">[]) {
  return sessions
    .filter(
      (session) =>
        session.status === "completed" &&
        session.startedAt !== undefined &&
        session.completedAt !== undefined,
    )
    .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))
    .slice(0, paceSampleLimit)
    .map((session) => ((session.completedAt ?? 0) - (session.startedAt ?? 0)) / 1_000,
    );
}

/** Normalizes detector IDs; invalid targets remove the proposal shortcut. */
function resolvedProposal(ctx: QueryCtx, proposal: AttentionProposal | undefined,
) {
  if (proposal === undefined) return undefined;
  return storedProposal(ctx, proposal) ?? undefined;
}

/** Spread form, so an absent proposal is an absent key under exactOptionalPropertyTypes. */
function proposalFields(ctx: QueryCtx, proposal: AttentionProposal | undefined,
) {
  const resolved = resolvedProposal(ctx, proposal);
  return resolved === undefined ? {} : { proposal: resolved };
}

function storedProposal(
  ctx: QueryCtx,
  proposal: AttentionProposal,
): {
  permissionKey: string;
  scopeType: AttentionProposal["scopeType"];
  scopeId: string;
  expiresAt: number;
  command: StoredAttentionCommand;
} | null {
  const command = proposal.command;
  const stored = ((): StoredAttentionCommand | null => {
    switch (command.name) {
      case "reviewSubstitutions.startPageChain": {
        const target = ctx.db.normalizeId("reviewPanelMembers", command.missingPanelMemberId,
        );
        return target === null ? null : { ...command, missingPanelMemberId: target };
      }
      case "reviewSubstitutions.markNoShow": {
        const target = ctx.db.normalizeId("reviewPanelMembers", command.panelMemberId,
        );
        return target === null ? null : { ...command, panelMemberId: target };
      }
      case "reviewOperations.extendReview": {
        const target = ctx.db.normalizeId("reviewSessions", command.reviewSessionId,
        );
        return target === null ? null : { ...command, reviewSessionId: target };
      }
      case "reviewExceptions.resumeTeam":
      case "reviewExceptions.markMissed": {
        const target = ctx.db.normalizeId("teamRoundStates", command.teamRoundStateId,
        );
        return target === null ? null : { ...command, teamRoundStateId: target };
      }
      case "reviewExceptions.moveQueuedTeam": {
        const target = ctx.db.normalizeId("teamRoundStates", command.teamRoundStateId,
        );
        const panel = ctx.db.normalizeId("reviewPanels", command.targetPanelId);
        return target === null || panel === null
          ? null
          : { ...command, teamRoundStateId: target, targetPanelId: panel };
      }
    }
  })();
  if (stored === null) return null;
  return {
    permissionKey: proposal.permissionKey,
    scopeType: proposal.scopeType,
    scopeId: proposal.scopeId,
    expiresAt: proposal.expiresAt,
    command: stored,
  };
}

/** Updates live entries in place; a resolved condition returning gets a new identity. */
async function reconcile(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    roundId: Id<"reviewRounds">;
    observed: readonly SweepObservation[];
    now: number;
  },
) {
  const observedByDedupe = new Map<string, SweepObservation>();
  for (const item of args.observed) {
    if (observedByDedupe.has(item.dedupeKey)) {
      throw new Error(`Two detections share the dedupe key ${item.dedupeKey}.`);
    }
    observedByDedupe.set(item.dedupeKey, item);
  }

  const live: Doc<"operationsAttentionItems">[] = [];
  for (const state of liveItemStates) {
    const rows = await ctx.db
      .query("operationsAttentionItems")
      .withIndex("by_state_round", (index) => index.eq("state", state).eq("roundId", args.roundId),
      )
      .take(maximumReviewAttentionObservations + 1);
    if (rows.length > maximumReviewAttentionObservations) {
      throw new Error("A round exceeds the live attention-row limit.");
    }
    live.push(...rows.filter((row) => reviewDomainDetectorKeys.includes(row.detectorKey),
      ),
    );
    if (live.length > maximumReviewAttentionObservations) {
      throw new Error("A round exceeds the live attention-row limit.");
    }
  }

  for (const row of live) {
    const detection = observedByDedupe.get(row.dedupeKey);
    if (detection) {
      observedByDedupe.delete(row.dedupeKey);
      if (
        row.eventId !== args.eventId ||
        row.roundId !== args.roundId ||
        row.detectorKey !== detection.detectorKey ||
        row.subjectType !== detection.subjectType ||
        row.subjectId !== detection.subjectId
      ) {
        throw new Error("An attention dedupe key changed its owning subject.");
      }
      if (sameObservation(row, detection, args.now) && row.clearedSince === undefined) {
        continue;
      }
      await ctx.db.patch(row._id, {
        severity: detection.severity,
        statement: detection.statement,
        route: detection.route,
        actionLabel: detection.actionLabel,
        visibility: detection.visibility,
        evidenceJson: detection.evidenceJson,
        proposal: detection.proposal,
        lastObservedAt: args.now,
        clearedSince: undefined,
        version: row.version + 1,
      });
      await appendOperationsAttentionReadFactById(ctx, row._id, args.now);
      continue;
    }
    if (row.clearedSince === undefined) {
      await ctx.db.patch(row._id, {
        clearedSince: args.now,
        version: row.version + 1,
      });
      await appendOperationsAttentionReadFactById(ctx, row._id, args.now);
      continue;
    }
    if (args.now - row.clearedSince >= attentionClearDelayMs) {
      await ctx.db.patch(row._id, {
        state: "resolved",
        resolvedAt: args.now,
        clearedSince: undefined,
        version: row.version + 1,
      });
      await appendOperationsAttentionReadFactById(ctx, row._id, args.now);
    }
  }

  for (const detection of observedByDedupe.values()) {
    const previous = await ctx.db
      .query("operationsAttentionItems")
      .withIndex("by_event_dedupe", (index) =>
        index.eq("eventId", args.eventId).eq("dedupeKey", detection.dedupeKey),
      )
      .order("desc")
      .first();
    const itemId = await ctx.db.insert("operationsAttentionItems", {
      eventId: args.eventId,
      roundId: args.roundId,
      detectorKey: detection.detectorKey,
      dedupeKey: detection.dedupeKey,
      subjectType: detection.subjectType,
      subjectId: detection.subjectId,
      severity: detection.severity,
      statement: detection.statement,
      route: detection.route,
      actionLabel: detection.actionLabel,
      visibility: detection.visibility,
      evidenceJson: detection.evidenceJson,
      ...(detection.proposal === undefined ? {} : { proposal: detection.proposal }),
      state: "open",
      recurrenceCount: previous === null ? 1 : previous.recurrenceCount + 1,
      firstObservedAt: args.now,
      lastObservedAt: args.now,
      version: 1,
    });
    await appendOperationsAttentionReadFactById(ctx, itemId, args.now);
  }
}

async function hasLiveRoundRows(ctx: MutationCtx, roundId: Id<"reviewRounds">) {
  for (const state of liveItemStates) {
    const row = await ctx.db
      .query("operationsAttentionItems")
      .withIndex("by_state_round", (index) => index.eq("state", state).eq("roundId", roundId),
      )
      .first();
    if (row !== null) return true;
  }
  return false;
}

function sameObservation(
  row: Doc<"operationsAttentionItems">,
  observation: SweepObservation,
  now: number,
) {
  return (
    row.severity === observation.severity &&
    row.statement === observation.statement &&
    row.route === observation.route &&
    row.actionLabel === observation.actionLabel &&
    row.visibility.permissionKey === observation.visibility.permissionKey &&
    row.visibility.scopeType === observation.visibility.scopeType &&
    row.visibility.scopeId === observation.visibility.scopeId &&
    row.evidenceJson === observation.evidenceJson &&
    sameProposal(row.proposal, observation.proposal, now)
  );
}

type StoredProposal = NonNullable<SweepObservation["proposal"]>;

function sameProposal(
  stored: StoredProposal | undefined,
  observed: StoredProposal | undefined,
  now: number,
) {
  if (stored === undefined || observed === undefined) return stored === observed;
  return (
    stored.expiresAt > now + proposalMinimumValidityMs &&
    stored.permissionKey === observed.permissionKey &&
    stored.scopeType === observed.scopeType &&
    stored.scopeId === observed.scopeId &&
    sameCommand(stored.command, observed.command)
  );
}

function sameCommand(left: StoredAttentionCommand, right: StoredAttentionCommand,
) {
  if (left.name !== right.name) return false;
  switch (left.name) {
    case "reviewSubstitutions.startPageChain":
      return (
        right.name === left.name &&
        left.missingPanelMemberId === right.missingPanelMemberId &&
        left.expectedPanelVersion === right.expectedPanelVersion &&
        left.reason === right.reason
      );
    case "reviewSubstitutions.markNoShow":
      return (
        right.name === left.name &&
        left.panelMemberId === right.panelMemberId &&
        left.expectedPanelVersion === right.expectedPanelVersion &&
        left.expectedClockInVersion === right.expectedClockInVersion &&
        left.reason === right.reason
      );
    case "reviewOperations.extendReview":
      return (
        right.name === left.name &&
        left.reviewSessionId === right.reviewSessionId &&
        left.expectedVersion === right.expectedVersion &&
        left.reason === right.reason
      );
    case "reviewExceptions.resumeTeam":
    case "reviewExceptions.markMissed":
      return (
        right.name === left.name &&
        left.teamRoundStateId === right.teamRoundStateId &&
        left.expectedVersion === right.expectedVersion &&
        left.reason === right.reason
      );
    case "reviewExceptions.moveQueuedTeam":
      return (
        right.name === left.name &&
        left.teamRoundStateId === right.teamRoundStateId &&
        left.targetPanelId === right.targetPanelId &&
        left.expectedVersion === right.expectedVersion &&
        left.reason === right.reason
      );
  }
}
