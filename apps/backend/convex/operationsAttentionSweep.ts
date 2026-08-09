/**
 * The sweep that turns detector readings into a durable ledger.
 *
 * The Overview used to run these conditions inside the page query, so the list
 * existed only for as long as somebody was looking at it. Running them on a
 * cron and diffing against the open items gives the layer the three things a
 * recomputed list cannot have: an item that opens once and keeps its identity,
 * an acknowledgement that survives a refresh, and a resolution recorded when
 * the condition clears.
 *
 * `reviewOperations.markOverdue` and `reviewSubstitutions.expirePage` already
 * establish that deterministic server work runs on a schedule here. Nothing in
 * this file calls a model, and nothing in it executes an event command.
 */

import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { readAttendanceTeamAvailability } from "./lib/attendanceTeamAvailability";
import {
  applyInhibition,
  attentionClearDelayMs,
  type DetectedAttentionItem,
} from "./lib/operationsAttention";
import {
  reviewFloorItems,
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
import { findReviewParticipantAvailabilityWaiver } from "./lib/reviewParticipantAvailability";
import type { AttentionDetectorKey, StoredAttentionCommand } from "./values";

/** Enough completed reviews for a median, and few enough to track the floor. */
const paceSampleLimit = 9;
/** A review that finished this long ago is nobody's outstanding scorecard. */
const scorecardChaseWindowMs = 4 * 60 * 60 * 1_000;
/** Only states where a live board would still be looking at the team. */
const activeTeamStates = [
  "queued",
  "called",
  "at_table",
  "in_review",
  "held",
] as const;
/** Everything slice one detects. Later domains reconcile their own keys. */
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

/**
 * One pass over the review domain for every live event.
 *
 * All three detector families run together because inhibition crosses them: a
 * bottleneck panel silences the teams queued behind it, and that judgement only
 * holds if both were read from the same moment.
 */
export const sweepReviewDomain = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const events = await ctx.db
      .query("events")
      .withIndex("by_status", (index) => index.eq("status", "live"))
      .collect();
    for (const event of events) {
      const rounds = await ctx.db
        .query("reviewRounds")
        .withIndex("by_event_status_start", (index) => index.eq("eventId", event._id))
        .collect();
      const liveRounds = rounds.filter(
        (round) => round.status === "open" || round.status === "closing",
      );
      const observed: DetectedAttentionItem[] = [];
      for (const round of liveRounds) {
        const reading = await readRound(ctx, event, round, now);
        observed.push(...reviewFloorItems(reading.floor));
        observed.push(...roundForecastItems(reading.floor));
        observed.push(...scorecardChaseItems(reading.chase));
      }
      await reconcile(ctx, {
        eventId: event._id,
        detectorKeys: reviewDomainDetectorKeys,
        observed: applyInhibition(observed),
        now,
      });
    }
    return null;
  },
});

type RoundReading = {
  floor: Parameters<typeof reviewFloorItems>[0];
  chase: Parameters<typeof scorecardChaseItems>[0];
};

/**
 * Reads one round into the two projections the detectors take.
 *
 * Every read is indexed and bounded by the shape of a live round: its panels,
 * their seated reviewers, and the teams the queue is still holding. Teams with
 * no state in this round are not read at all, because a team nobody has queued
 * yet is not something the desk can act on.
 */
async function readRound(
  ctx: MutationCtx,
  event: Doc<"events">,
  round: Doc<"reviewRounds">,
  now: number,
): Promise<RoundReading> {
  const [panels, states, pause] = await Promise.all([
    ctx.db
      .query("reviewPanels")
      .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
      .collect(),
    ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_state_priority_queued", (index) =>
        index.eq("roundId", round._id),
      )
      .collect(),
    ctx.db
      .query("reviewRoundPauses")
      .withIndex("by_round_state", (index) =>
        index.eq("roundId", round._id).eq("state", "active"),
      )
      .first(),
  ]);
  const displayNames = new Map<Id<"people">, string>();
  const personName = async (personId: Id<"people">) => {
    const known = displayNames.get(personId);
    if (known !== undefined) return known;
    const person = await ctx.db.get(personId);
    if (!person) throw new Error("A live review record references a missing person.");
    displayNames.set(personId, person.displayName);
    return person.displayName;
  };

  const queuedByPanelId = new Map<Id<"reviewPanels">, Doc<"teamRoundStates">[]>();
  for (const state of states) {
    if (state.state !== "queued" || state.panelId === undefined) continue;
    const existing = queuedByPanelId.get(state.panelId);
    if (existing) existing.push(state);
    else queuedByPanelId.set(state.panelId, [state]);
  }

  const panelViews: PanelProjection[] = [];
  const panelNames = new Map<Id<"reviewPanels">, string>();
  const sessionsByTeamId = new Map<Id<"teams">, Doc<"reviewSessions">[]>();
  const completedSessions: {
    session: Doc<"reviewSessions">;
    panelName: string;
  }[] = [];

  for (const panel of panels) {
    panelNames.set(panel._id, panel.name);
    const [members, sessions, activeChain] = await Promise.all([
      ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", panel._id).eq("status", "active"),
        )
        .collect(),
      ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (index) => index.eq("panelId", panel._id))
        .collect(),
      ctx.db
        .query("reviewerPageChains")
        .withIndex("by_panel_state", (index) =>
          index.eq("panelId", panel._id).eq("state", "active"),
        )
        .first(),
    ]);
    for (const session of sessions) {
      const existing = sessionsByTeamId.get(session.teamId);
      if (existing) existing.push(session);
      else sessionsByTeamId.set(session.teamId, [session]);
      if (
        session.status === "completed" &&
        session.completedAt !== undefined &&
        now - session.completedAt <= scorecardChaseWindowMs
      ) {
        completedSessions.push({ session, panelName: panel.name });
      }
    }
    const memberViews: PanelMemberProjection[] = [];
    for (const member of members) {
      const [clockIn, devices, displayName] = await Promise.all([
        ctx.db
          .query("reviewerClockIns")
          .withIndex("by_round_person", (index) =>
            index.eq("roundId", round._id).eq("reviewerPersonId", member.personId),
          )
          .unique(),
        ctx.db
          .query("reviewerDevices")
          .withIndex("by_event_person_status", (index) =>
            index
              .eq("eventId", event._id)
              .eq("personId", member.personId)
              .eq("status", "active"),
          )
          .collect(),
        personName(member.personId),
      ]);
      const device = devices.sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0];
      memberViews.push({
        panelMemberId: member._id,
        personId: member.personId,
        displayName,
        clockInStatus: clockInStatusOf(clockIn),
        clockInVersion: clockIn?.version ?? 0,
        ...(clockIn?.expectedReturnAt === undefined
          ? {}
          : { expectedReturnAt: clockIn.expectedReturnAt }),
        ...(clockIn === null ? {} : { lastHeartbeatAt: clockIn.lastHeartbeatAt }),
        deviceCount: devices.length,
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
    const vacancy = await findVacantSeat(ctx, panel);
    const running = sessions.find(
      (session) => session.status === "active" || session.status === "overdue",
    );
    const queued = queuedByPanelId.get(panel._id) ?? [];
    const queuedTeams = await Promise.all(
      queued.map(async (state) => {
        const team = await ctx.db.get(state.teamId);
        if (!team) throw new Error("A queued review state references a missing team.");
        return {
          teamRoundStateId: state._id,
          version: state.version,
          teamName: team.name,
          queuedAt: state.queuedAt ?? state.updatedAt,
        };
      }),
    );
    panelViews.push({
      panelId: panel._id,
      name: panel.name,
      status: panel.status,
      version: panel.version,
      statusSince: panel.updatedAt,
      ...(vacancy === null ? {} : { vacantPanelMemberId: vacancy }),
      hasActivePageChain: activeChain !== null,
      hasRunningReview: running !== undefined,
      members: memberViews,
      queuedTeams,
      ...(running?.plannedEndAt === undefined
        ? {}
        : { activeReviewPlannedEndAt: running.plannedEndAt }),
      completedDurationsSeconds: completedDurations(sessions),
    });
  }

  const teamViews: TeamProjection[] = [];
  for (const state of states) {
    if (!activeTeamStates.some((value) => value === state.state)) continue;
    const [team, availability] = await Promise.all([
      ctx.db.get(state.teamId),
      readAttendanceTeamAvailability(ctx, { eventId: event._id, teamId: state.teamId }),
    ]);
    if (!team) throw new Error("A review queue state references a missing team.");
    const sessions = sessionsByTeamId.get(state.teamId) ?? [];
    const live =
      sessions.find(
        (session) =>
          session.status === "awaiting_presence" ||
          session.status === "active" ||
          session.status === "overdue",
      ) ?? null;
    let review: ReviewProjection | null = null;
    if (live) {
      const [assignments, presences, waiver] = await Promise.all([
        ctx.db
          .query("reviewAssignments")
          .withIndex("by_round_session", (index) =>
            index.eq("roundId", round._id).eq("reviewSessionId", live._id),
          )
          .collect(),
        ctx.db
          .query("reviewPresence")
          .withIndex("by_session_reviewer", (index) =>
            index.eq("reviewSessionId", live._id),
          )
          .collect(),
        findReviewParticipantAvailabilityWaiver(ctx, live._id),
      ]);
      const assigned = assignments.filter(
        (assignment) => assignment.status === "assigned",
      );
      review = {
        reviewSessionId: live._id,
        version: live.version,
        status: live.status,
        createdAt: live.createdAt,
        ...(live.plannedEndAt === undefined ? {} : { plannedEndAt: live.plannedEndAt }),
        reviewerPresenceCount: assigned.filter((assignment) =>
          presences.some(
            (presence) => presence.reviewerPersonId === assignment.reviewerPersonId,
          ),
        ).length,
        reviewerCount: assigned.length,
        canExtend: live.extensionCount < round.maximumOrdinaryExtensions,
      };
      teamViews.push(
        teamProjection(state, team.name, review, availability, round, waiver !== null),
      );
      continue;
    }
    teamViews.push(teamProjection(state, team.name, null, availability, round, false));
  }

  const chaseSessions: OutstandingScorecardProjection[] = [];
  for (const { session, panelName } of completedSessions) {
    const completedAt = session.completedAt;
    if (completedAt === undefined) continue;
    const [assignments, scorecards, team] = await Promise.all([
      ctx.db
        .query("reviewAssignments")
        .withIndex("by_round_session", (index) =>
          index.eq("roundId", round._id).eq("reviewSessionId", session._id),
        )
        .collect(),
      ctx.db
        .query("scorecards")
        .withIndex("by_session_status", (index) =>
          index.eq("reviewSessionId", session._id).eq("status", "submitted"),
        )
        .collect(),
      ctx.db.get(session.teamId),
    ]);
    if (!team) throw new Error("A completed review references a missing team.");
    const submitted = new Set(scorecards.map((scorecard) => scorecard.reviewerPersonId));
    const outstanding = assignments.filter(
      (assignment) =>
        assignment.status === "assigned" && !submitted.has(assignment.reviewerPersonId),
    );
    if (outstanding.length === 0) continue;
    const reviewers = await Promise.all(
      outstanding.map(async (assignment) => {
        const [clockIn, displayName] = await Promise.all([
          ctx.db
            .query("reviewerClockIns")
            .withIndex("by_round_person", (index) =>
              index
                .eq("roundId", round._id)
                .eq("reviewerPersonId", assignment.reviewerPersonId),
            )
            .unique(),
          personName(assignment.reviewerPersonId),
        ]);
        return {
          displayName,
          clockInStatus: clockInStatusOf(clockIn),
          ...(clockIn === null ? {} : { lastHeartbeatAt: clockIn.lastHeartbeatAt }),
        };
      }),
    );
    chaseSessions.push({
      reviewSessionId: session._id,
      teamName: team.name,
      panelName,
      completedAt,
      reviewers,
    });
  }

  return {
    floor: {
      now,
      roundId: round._id,
      roundName: round.name,
      roundEndsAt: round.endsAt,
      requiredPanelSize: round.requiredPanelSize,
      reviewDurationSeconds: round.reviewDurationSeconds,
      isPaused: pause !== null,
      panels: panelViews,
      teams: teamViews,
    },
    chase: {
      now,
      roundId: round._id,
      roundName: round.name,
      sessions: chaseSessions,
    },
  };
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
  const tableLabel = state.tableLabel;
  return {
    teamRoundStateId: state._id,
    version: state.version,
    teamId: state.teamId,
    teamName,
    ...(state.panelId === undefined ? {} : { panelId: state.panelId }),
    ...(tableLabel === undefined ? {} : { tableLabel }),
    state: state.state,
    ...(state.queuedAt === undefined ? {} : { queuedAt: state.queuedAt }),
    ...(state.calledAt === undefined ? {} : { calledAt: state.calledAt }),
    ...(state.heldAt === undefined ? {} : { heldAt: state.heldAt }),
    ...(state.holdReason === undefined ? {} : { holdReason: state.holdReason }),
    ...(lastCallAt === undefined
      ? {}
      : { missedEligibleAt: lastCallAt + round.missedCallGraceSeconds * 1_000 }),
    updatedAt: state.updatedAt,
    availableCount: availability.insideMemberCount,
    requiredCount: round.minimumPresentParticipants,
    availabilityWaived,
    review,
  };
}

function clockInStatusOf(clockIn: Doc<"reviewerClockIns"> | null): ClockInStatus {
  return clockIn === null ? "not_clocked_in" : clockIn.status;
}

/** Newest first, so the median tracks the pace the floor is running now. */
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
    .map((session) => ((session.completedAt ?? 0) - (session.startedAt ?? 0)) / 1_000);
}

/**
 * The seat a substitute page would fill. `startPageChain` takes the removed
 * member whose criteria the substitute has to cover, so a proposal is only
 * offered when exactly that record exists.
 */
async function findVacantSeat(ctx: MutationCtx, panel: Doc<"reviewPanels">) {
  if (panel.status !== "needs_reviewer") return null;
  const removed = await ctx.db
    .query("reviewPanelMembers")
    .withIndex("by_panel_status", (index) =>
      index.eq("panelId", panel._id).eq("status", "removed"),
    )
    .collect();
  const latest = removed.sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0))[0];
  return latest?._id ?? null;
}

/**
 * Turns a detector's proposal into the stored one.
 *
 * Detectors are pure functions over plain projections, so they carry ids as
 * strings. `normalizeId` is the only cast-free way back to a typed document id,
 * and a target that no longer parses means the row keeps its statement and
 * loses the shortcut rather than offering a command that cannot run.
 */
/** The resolved proposal, or nothing when its target no longer parses. */
function resolvedProposal(ctx: MutationCtx, proposal: AttentionProposal | undefined) {
  if (proposal === undefined) return undefined;
  return storedProposal(ctx, proposal) ?? undefined;
}

/** Spread form, so an absent proposal is an absent key under exactOptionalPropertyTypes. */
function proposalFields(ctx: MutationCtx, proposal: AttentionProposal | undefined) {
  const resolved = resolvedProposal(ctx, proposal);
  return resolved === undefined ? {} : { proposal: resolved };
}

function storedProposal(
  ctx: MutationCtx,
  proposal: AttentionProposal,
): { permissionKey: string; scopeType: AttentionProposal["scopeType"]; scopeId: string; expiresAt: number; command: StoredAttentionCommand } | null {
  const command = proposal.command;
  const stored = ((): StoredAttentionCommand | null => {
    switch (command.name) {
      case "reviewSubstitutions.startPageChain": {
        const target = ctx.db.normalizeId("reviewPanelMembers", command.missingPanelMemberId);
        return target === null ? null : { ...command, missingPanelMemberId: target };
      }
      case "reviewSubstitutions.markNoShow": {
        const target = ctx.db.normalizeId("reviewPanelMembers", command.panelMemberId);
        return target === null ? null : { ...command, panelMemberId: target };
      }
      case "reviewOperations.extendReview": {
        const target = ctx.db.normalizeId("reviewSessions", command.reviewSessionId);
        return target === null ? null : { ...command, reviewSessionId: target };
      }
      case "reviewExceptions.resumeTeam":
      case "reviewExceptions.markMissed": {
        const target = ctx.db.normalizeId("teamRoundStates", command.teamRoundStateId);
        return target === null ? null : { ...command, teamRoundStateId: target };
      }
      case "reviewExceptions.moveQueuedTeam": {
        const target = ctx.db.normalizeId("teamRoundStates", command.teamRoundStateId);
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

/* ------------------------------------------------------------------ *
 * Ledger reconciliation
 * ------------------------------------------------------------------ */

/**
 * Diffs one reading against the ledger.
 *
 * While an item is live, re-detection updates it in place and it keeps its
 * identity, its acknowledgement, and the time it was first seen. Once it
 * resolves, the same condition coming back opens a fresh item that counts the
 * recurrence, so "third time tonight" is a fact the ledger holds rather than
 * something an operator has to remember.
 */
async function reconcile(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    detectorKeys: readonly AttentionDetectorKey[];
    observed: readonly DetectedAttentionItem[];
    now: number;
  },
) {
  const observedByDedupe = new Map<string, DetectedAttentionItem>();
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
      .withIndex("by_event_state_severity_first", (index) =>
        index.eq("eventId", args.eventId).eq("state", state),
      )
      .collect();
    live.push(...rows.filter((row) => args.detectorKeys.includes(row.detectorKey)));
  }

  for (const row of live) {
    const detection = observedByDedupe.get(row.dedupeKey);
    if (detection) {
      observedByDedupe.delete(row.dedupeKey);
      await ctx.db.patch(row._id, {
        severity: detection.severity,
        statement: detection.statement,
        route: detection.route,
        actionLabel: detection.actionLabel,
        visibility: detection.visibility,
        evidenceJson: detection.evidenceJson,
        proposal: resolvedProposal(ctx, detection.proposal),
        lastObservedAt: args.now,
        clearedSince: undefined,
        version: row.version + 1,
      });
      continue;
    }
    if (row.clearedSince === undefined) {
      await ctx.db.patch(row._id, {
        clearedSince: args.now,
        version: row.version + 1,
      });
      continue;
    }
    if (args.now - row.clearedSince >= attentionClearDelayMs) {
      await ctx.db.patch(row._id, {
        state: "resolved",
        resolvedAt: args.now,
        clearedSince: undefined,
        version: row.version + 1,
      });
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
    await ctx.db.insert("operationsAttentionItems", {
      eventId: args.eventId,
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
      ...proposalFields(ctx, detection.proposal),
      state: "open",
      recurrenceCount: previous === null ? 1 : previous.recurrenceCount + 1,
      firstObservedAt: args.now,
      lastObservedAt: args.now,
      version: 1,
    });
  }
}
