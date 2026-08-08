import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { moveSessionCounter } from "./attendanceCounters";

export type SessionTransition = "session_confirm" | "zone_entry" | "zone_exit";
export type AttendanceTransitionOutcome =
  | "accepted"
  | "duplicate"
  | "rejected"
  | "needs_review";
type SessionState = Doc<"attendanceSessionParticipants">["state"];

export type SessionTransitionDecision = {
  outcome: AttendanceTransitionOutcome;
  reasonCode: string;
  previousState: SessionState;
  nextState: SessionState;
};

export type PreparedSessionTransition = {
  decision: SessionTransitionDecision;
  openInterval: Doc<"attendancePresenceIntervals"> | null;
};

function decisionFor(
  state: SessionState,
  transition: SessionTransition,
): SessionTransitionDecision {
  if (transition === "session_confirm" || transition === "zone_entry") {
    if (state === "confirmation_due" || state === "temporarily_out") {
      return {
        outcome: "accepted",
        reasonCode: "session_presence_recorded",
        previousState: state,
        nextState: "present",
      };
    }
    if (state === "present") {
      return {
        outcome: "duplicate",
        reasonCode: "already_present",
        previousState: state,
        nextState: state,
      };
    }
    if (state === "needs_review") {
      return {
        outcome: "needs_review",
        reasonCode: "session_state_needs_review",
        previousState: state,
        nextState: state,
      };
    }
    return {
      outcome: "rejected",
      reasonCode: "session_not_available",
      previousState: state,
      nextState: state,
    };
  }
  if (state === "present") {
    return {
      outcome: "accepted",
      reasonCode: "temporary_exit_recorded",
      previousState: state,
      nextState: "temporarily_out",
    };
  }
  if (state === "temporarily_out") {
    return {
      outcome: "duplicate",
      reasonCode: "already_temporarily_out",
      previousState: state,
      nextState: state,
    };
  }
  return {
    outcome: "needs_review",
    reasonCode: "session_exit_without_entry",
    previousState: state,
    nextState: "needs_review",
  };
}

export async function prepareSessionTransition(
  ctx: MutationCtx,
  args: {
    participant: Doc<"attendanceSessionParticipants">;
    transition: SessionTransition;
  },
): Promise<PreparedSessionTransition> {
  let decision = decisionFor(args.participant.state, args.transition);
  let openInterval: Doc<"attendancePresenceIntervals"> | null = null;

  if (decision.outcome !== "accepted") return { decision, openInterval };
  if (args.transition === "zone_exit") {
    openInterval = args.participant.currentIntervalId
      ? await ctx.db.get(args.participant.currentIntervalId)
      : null;
    if (
      !openInterval ||
      openInterval.status !== "open" ||
      openInterval.sessionId !== args.participant.sessionId
    ) {
      decision = {
        outcome: "needs_review",
        reasonCode: "session_interval_missing",
        previousState: args.participant.state,
        nextState: "needs_review",
      };
    }
  } else if (args.participant.currentIntervalId !== undefined) {
    decision = {
      outcome: "needs_review",
      reasonCode: "session_interval_already_open",
      previousState: args.participant.state,
      nextState: "needs_review",
    };
  }
  return { decision, openInterval };
}

export async function applySessionTransitionProjection(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    session: Doc<"attendanceSessions">;
    participant: Doc<"attendanceSessionParticipants">;
    membershipId: Id<"eventMemberships">;
    zoneId: Id<"attendanceZones">;
    transition: SessionTransition;
    decision: SessionTransitionDecision;
    openInterval: Doc<"attendancePresenceIntervals"> | null;
    presenceEventId: Id<"attendancePresenceEvents">;
    effectiveAt: number;
    updatedAt: number;
  },
) {
  if (args.decision.outcome !== "accepted" && args.decision.outcome !== "needs_review") {
    throw new ConvexError({
      code: "TRANSITION_NOT_APPLICABLE",
      message: "Only an accepted or review transition can update attendance state.",
    });
  }

  let currentIntervalId = args.participant.currentIntervalId;
  if (args.decision.outcome === "accepted" && args.transition !== "zone_exit") {
    currentIntervalId = await ctx.db.insert("attendancePresenceIntervals", {
      eventId: args.eventId,
      membershipId: args.membershipId,
      zoneId: args.zoneId,
      sessionId: args.session._id,
      kind: "session",
      status: "open",
      openedByEventId: args.presenceEventId,
      openedAt: args.effectiveAt,
    });
  }
  if (
    args.decision.outcome === "accepted" &&
    args.transition === "zone_exit" &&
    args.openInterval
  ) {
    await ctx.db.patch(args.openInterval._id, {
      status: "closed",
      closedByEventId: args.presenceEventId,
      closedAt: args.effectiveAt,
    });
    currentIntervalId = undefined;
  }

  const isLate =
    args.participant.late ||
    (args.decision.nextState === "present" && args.effectiveAt > args.session.startsAt);
  await ctx.db.patch(args.participant._id, {
    state: args.decision.nextState,
    ...(args.participant.confirmedAt === undefined && args.decision.nextState === "present"
      ? { confirmedAt: args.effectiveAt }
      : {}),
    late: isLate,
    currentIntervalId,
    lastEventId: args.presenceEventId,
    version: args.participant.version + 1,
    updatedAt: args.updatedAt,
  });
  await moveSessionCounter(ctx, {
    eventId: args.eventId,
    sessionId: args.session._id,
    membershipId: args.membershipId,
    previousState: args.participant.state,
    nextState: args.decision.nextState,
    expectedDelta: 0,
    wasLate: args.participant.late,
    isLate,
    now: args.updatedAt,
  });
}
