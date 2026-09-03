import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { teamTableLabel } from "./lib/floor";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
  storedOperationVersion,
} from "./lib/operations";
import { appendReviewPanelVacancyReadFactById } from "./lib/operationsAutonomyReadFacts";
import {
  matchingPermissionGrantIds,
  requirePermission,
  revokeSourceGrants,
} from "./lib/permissions";
import {
  createReviewParticipantAvailabilityWaiver,
  readReviewParticipantAvailability,
} from "./lib/reviewParticipantAvailability";
import { patchTeamRoundState } from "./lib/reviewQueueProjection";
import { normalizedText } from "./lib/strings";

type QueueExceptionPermission =
  | "review.queue.hold"
  | "review.queue.resume"
  | "review.queue.miss"
  | "review.queue.move";

const queueResumeOperationResult = z
  .object({
    state: z.enum(["unassigned", "queued"]),
    version: z.number().int().positive(),
  })
  .strict();

const callAttemptOperationResult = z
  .object({
    callAttemptCount: z.number().int().positive(),
    missedEligibleAt: z.number().int().nonnegative(),
    version: z.number().int().positive(),
  })
  .strict();

async function requireTeamRoundState(
  ctx: MutationCtx,
  eventId: Id<"events">,
  teamRoundStateId: Id<"teamRoundStates">,
) {
  const state = await ctx.db.get(teamRoundStateId);
  if (!state || state.eventId !== eventId) {
    throw new ConvexError({
      code: "QUEUE_STATE_NOT_FOUND",
      message: "That team queue state is unavailable.",
    });
  }
  const [round, team] = await Promise.all([ctx.db.get(state.roundId), ctx.db.get(state.teamId)]);
  if (!round || !team || round.eventId !== eventId || team.eventId !== eventId) {
    throw new Error("A team queue state has an invalid event context.");
  }
  return { state, round, team };
}

async function requireQueueExceptionPermission(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: QueueExceptionPermission;
    state: Doc<"teamRoundStates">;
  },
) {
  const teamGrantIds = await matchingPermissionGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: args.permissionKey,
    scopeType: "team",
    scopeId: args.state.teamId,
  });
  if (teamGrantIds.length > 0) {
    return { grantIds: teamGrantIds, scopeType: "team" as const, scopeId: args.state.teamId };
  }
  const roundGrantIds = await matchingPermissionGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: args.permissionKey,
    scopeType: "round",
    scopeId: args.state.roundId,
  });
  if (roundGrantIds.length > 0) {
    return { grantIds: roundGrantIds, scopeType: "round" as const, scopeId: args.state.roundId };
  }
  if (args.state.panelId) {
    const panelGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: args.eventId,
      eventAccessSubjectId: args.eventAccessSubjectId,
      permissionKey: args.permissionKey,
      scopeType: "panel",
      scopeId: args.state.panelId,
    });
    if (panelGrantIds.length > 0) {
      return { grantIds: panelGrantIds, scopeType: "panel" as const, scopeId: args.state.panelId };
    }
  }
  throw new ConvexError({
    code: "ACCESS_DENIED",
    message: "This account cannot apply that exception to the exact team, round, or panel.",
  });
}

async function requireParticipantAvailabilityWaiverPermission(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    reviewSessionId: Id<"reviewSessions">;
    teamId: Id<"teams">;
  },
) {
  const reviewGrantIds = await matchingPermissionGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: "review.participant_availability.waive",
    scopeType: "review",
    scopeId: args.reviewSessionId,
  });
  if (reviewGrantIds.length > 0) {
    return {
      grantIds: reviewGrantIds,
      scopeType: "review" as const,
      scopeId: args.reviewSessionId,
    };
  }
  const teamGrantIds = await matchingPermissionGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: "review.participant_availability.waive",
    scopeType: "team",
    scopeId: args.teamId,
  });
  if (teamGrantIds.length > 0) {
    return {
      grantIds: teamGrantIds,
      scopeType: "team" as const,
      scopeId: args.teamId,
    };
  }
  throw new ConvexError({
    code: "ACCESS_DENIED",
    message: "This account cannot waive availability for the exact team or review.",
  });
}

async function cancelPendingReview(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    roundId: Id<"reviewRounds">;
    teamId: Id<"teams">;
    actorPersonId: Id<"people">;
    reason: string;
    now: number;
  },
) {
  const sessions = await ctx.db
    .query("reviewSessions")
    .withIndex("by_round_team_status", (index) =>
      index.eq("roundId", args.roundId).eq("teamId", args.teamId),
    )
    .collect();
  const pending = sessions.filter((session) => session.status === "awaiting_presence");
  if (pending.length > 1) throw new Error("A team has more than one pending review session.");
  if (sessions.some((session) => session.status === "active" || session.status === "overdue")) {
    throw new ConvexError({
      code: "REVIEW_ALREADY_STARTED",
      message:
        "A started review must be completed or handled through the active-review exception path.",
    });
  }
  const session = pending[0];
  if (!session) return null;
  const [assignments, scorecards, tokens] = await Promise.all([
    ctx.db
      .query("reviewAssignments")
      .withIndex("by_session_person", (index) => index.eq("reviewSessionId", session._id))
      .collect(),
    ctx.db
      .query("scorecards")
      .withIndex("by_session_status", (index) => index.eq("reviewSessionId", session._id))
      .collect(),
    ctx.db
      .query("reviewTeamQrTokens")
      .withIndex("by_session_state", (index) => index.eq("reviewSessionId", session._id))
      .collect(),
  ]);
  for (const assignment of assignments.filter((row) => row.status === "assigned")) {
    await ctx.db.patch(assignment._id, { status: "removed", endedAt: args.now });
    await revokeSourceGrants(ctx, {
      eventId: args.eventId,
      sourceType: "panel_assignment",
      sourceId: assignment._id,
      revokedByPersonId: args.actorPersonId,
      reason: args.reason,
    });
  }
  for (const scorecard of scorecards) {
    if (scorecard.status !== "draft") {
      throw new Error("A pending review contains a non-draft scorecard.");
    }
    await ctx.db.patch(scorecard._id, {
      status: "void",
      version: scorecard.version + 1,
      updatedAt: args.now,
    });
  }
  for (const token of tokens.filter((row) => row.state === "active")) {
    await ctx.db.patch(token._id, { state: "superseded" });
  }
  await ctx.db.patch(session._id, {
    status: "cancelled",
    cancelledAt: args.now,
    version: session.version + 1,
    updatedAt: args.now,
  });
  return session._id;
}

export const holdTeam = mutation({
  args: {
    eventSlug: v.string(),
    teamRoundStateId: v.id("teamRoundStates"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ teamRoundStateId: v.id("teamRoundStates"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Hold reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.teamRoundStateId,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.queue.hold",
      requestFingerprint,
    });
    if (prior) {
      const stateId = ctx.db.normalizeId("teamRoundStates", prior.targetId);
      if (!stateId) throw new Error("Prior queue-hold result is invalid.");
      return {
        teamRoundStateId: stateId,
        version: storedOperationVersion(prior.resultJson, "queue hold"),
      };
    }
    const { state, round, team } = await requireTeamRoundState(
      ctx,
      event._id,
      args.teamRoundStateId,
    );
    if (
      round.status !== "open" ||
      state.version !== args.expectedVersion ||
      !["unassigned", "queued", "called", "at_table"].includes(state.state)
    ) {
      throw new ConvexError({
        code: "QUEUE_STATE_CHANGED",
        message: "Only an unassigned, queued, or called team can be held.",
      });
    }
    const permission = await requireQueueExceptionPermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.queue.hold",
      state,
    });
    const now = Date.now();
    const cancelledReviewSessionId = await cancelPendingReview(ctx, {
      eventId: event._id,
      roundId: round._id,
      teamId: team._id,
      actorPersonId: person._id,
      reason: `Pending review cancelled for team hold: ${reason}`,
      now,
    });
    const stateBeforeHold =
      state.state === "called" || state.state === "at_table" ? "queued" : state.state;
    await patchTeamRoundState(ctx, state, {
      state: "held",
      stateBeforeHold,
      holdReason: reason,
      heldAt: now,
      calledAt: undefined,
      version: state.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.queue.hold",
      requestFingerprint,
      targetType: "team_round_state",
      targetId: state._id,
      resultJson: String(state.version + 1),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.queue.hold",
      grantIds: permission.grantIds,
      scopeType: permission.scopeType,
      scopeId: permission.scopeId,
      action: "review.queue_team_held",
      targetType: "team_round_state",
      targetId: state._id,
      previousSummary: JSON.stringify({ state: state.state, version: state.version }),
      nextSummary: JSON.stringify({
        state: "held",
        stateBeforeHold,
        version: state.version + 1,
        cancelledReviewSessionId,
      }),
      reason,
    });
    return { teamRoundStateId: state._id, version: state.version + 1 };
  },
});

export const resumeTeam = mutation({
  args: {
    eventSlug: v.string(),
    teamRoundStateId: v.id("teamRoundStates"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    teamRoundStateId: v.id("teamRoundStates"),
    state: v.string(),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Resume reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.teamRoundStateId,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.queue.resume",
      requestFingerprint,
    });
    if (prior) {
      const stateId = ctx.db.normalizeId("teamRoundStates", prior.targetId);
      if (!stateId) throw new Error("Prior queue-resume result is invalid.");
      return {
        teamRoundStateId: stateId,
        ...storedOperationResult(prior.resultJson, "queue resume", queueResumeOperationResult),
      };
    }
    const { state, round } = await requireTeamRoundState(ctx, event._id, args.teamRoundStateId);
    if (
      round.status !== "open" ||
      state.version !== args.expectedVersion ||
      !["held", "missed"].includes(state.state)
    ) {
      throw new ConvexError({
        code: "QUEUE_STATE_CHANGED",
        message: "Only a current held or missed team can return to the queue.",
      });
    }
    const permission = await requireQueueExceptionPermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.queue.resume",
      state,
    });
    const panel = state.panelId ? await ctx.db.get(state.panelId) : null;
    const canReturnToPanel = Boolean(panel && panel.status === "ready");
    const resumedTableLabel = await teamTableLabel(ctx, state.teamId);
    const now = Date.now();
    let nextState: "unassigned" | "queued" = "unassigned";
    let preserveQueueTime = true;
    if (state.state === "held") {
      nextState = state.stateBeforeHold === "queued" && canReturnToPanel ? "queued" : "unassigned";
    } else if (round.missedReentryPolicy === "preserve_queue_time" && canReturnToPanel) {
      nextState = "queued";
    } else if (round.missedReentryPolicy === "queue_end" && canReturnToPanel) {
      nextState = "queued";
      preserveQueueTime = false;
    }
    await patchTeamRoundState(ctx, state, {
      state: nextState,
      ...(nextState === "queued" && state.panelId
        ? { panelId: state.panelId }
        : { panelId: undefined }),
      ...(nextState === "queued" ? { tableLabel: resumedTableLabel } : { tableLabel: undefined }),
      ...(nextState === "unassigned"
        ? { queuedAt: undefined }
        : preserveQueueTime
          ? {}
          : { queuedAt: now }),
      stateBeforeHold: undefined,
      holdReason: undefined,
      heldAt: undefined,
      missedAt: undefined,
      calledAt: undefined,
      callAttemptCount: 0,
      lastCallAttemptAt: undefined,
      version: state.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.queue.resume",
      requestFingerprint,
      targetType: "team_round_state",
      targetId: state._id,
      resultJson: JSON.stringify({ state: nextState, version: state.version + 1 }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.queue.resume",
      grantIds: permission.grantIds,
      scopeType: permission.scopeType,
      scopeId: permission.scopeId,
      action: "review.queue_team_resumed",
      targetType: "team_round_state",
      targetId: state._id,
      previousSummary: JSON.stringify({ state: state.state, version: state.version }),
      nextSummary: JSON.stringify({
        state: nextState,
        preservedQueueTime: preserveQueueTime,
        version: state.version + 1,
      }),
      reason,
    });
    return { teamRoundStateId: state._id, state: nextState, version: state.version + 1 };
  },
});

export const recordCallAttempt = mutation({
  args: {
    eventSlug: v.string(),
    teamRoundStateId: v.id("teamRoundStates"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    callAttemptCount: v.number(),
    missedEligibleAt: v.number(),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Call attempt note", 3, 300);
    const requestFingerprint = operationFingerprint([
      args.teamRoundStateId,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.queue.call_attempt",
      requestFingerprint,
    });
    if (prior) {
      const stateId = ctx.db.normalizeId("teamRoundStates", prior.targetId);
      if (!stateId) throw new Error("Prior call-attempt result is invalid.");
      return storedOperationResult(
        prior.resultJson,
        "queue call attempt",
        callAttemptOperationResult,
      );
    }
    const { state, round } = await requireTeamRoundState(ctx, event._id, args.teamRoundStateId);
    if (
      round.status !== "open" ||
      state.version !== args.expectedVersion ||
      !["called", "at_table"].includes(state.state)
    ) {
      throw new ConvexError({
        code: "QUEUE_STATE_CHANGED",
        message: "This team is no longer waiting on a call.",
      });
    }
    const permission = await requireQueueExceptionPermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.queue.miss",
      state,
    });
    const now = Date.now();
    await patchTeamRoundState(ctx, state, {
      callAttemptCount: state.callAttemptCount + 1,
      lastCallAttemptAt: now,
      version: state.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.queue.call_attempt",
      requestFingerprint,
      targetType: "team_round_state",
      targetId: state._id,
      resultJson: JSON.stringify({
        callAttemptCount: state.callAttemptCount + 1,
        missedEligibleAt: now + round.missedCallGraceSeconds * 1_000,
        version: state.version + 1,
      }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.queue.miss",
      grantIds: permission.grantIds,
      scopeType: permission.scopeType,
      scopeId: permission.scopeId,
      action: "review.queue_call_attempt_recorded",
      targetType: "team_round_state",
      targetId: state._id,
      previousSummary: JSON.stringify({
        callAttemptCount: state.callAttemptCount,
        version: state.version,
      }),
      nextSummary: JSON.stringify({
        callAttemptCount: state.callAttemptCount + 1,
        missedEligibleAt: now + round.missedCallGraceSeconds * 1_000,
        version: state.version + 1,
      }),
      reason,
    });
    return {
      callAttemptCount: state.callAttemptCount + 1,
      missedEligibleAt: now + round.missedCallGraceSeconds * 1_000,
      version: state.version + 1,
    };
  },
});

export const markMissed = mutation({
  args: {
    eventSlug: v.string(),
    teamRoundStateId: v.id("teamRoundStates"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ teamRoundStateId: v.id("teamRoundStates"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Missed-call reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.teamRoundStateId,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.queue.missed",
      requestFingerprint,
    });
    if (prior) {
      const stateId = ctx.db.normalizeId("teamRoundStates", prior.targetId);
      if (!stateId) throw new Error("Prior missed-team result is invalid.");
      return {
        teamRoundStateId: stateId,
        version: storedOperationVersion(prior.resultJson, "missed team"),
      };
    }
    const { state, round, team } = await requireTeamRoundState(
      ctx,
      event._id,
      args.teamRoundStateId,
    );
    const lastCallAttemptAt = state.lastCallAttemptAt ?? state.calledAt;
    const now = Date.now();
    if (
      round.status !== "open" ||
      state.version !== args.expectedVersion ||
      !["called", "at_table"].includes(state.state) ||
      state.callAttemptCount < round.requiredCallAttempts ||
      !lastCallAttemptAt ||
      now < lastCallAttemptAt + round.missedCallGraceSeconds * 1_000
    ) {
      throw new ConvexError({
        code: "MISSED_CALL_POLICY_NOT_MET",
        message: "The published call-attempt count or grace period has not been met.",
      });
    }
    const permission = await requireQueueExceptionPermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.queue.miss",
      state,
    });
    const cancelledReviewSessionId = await cancelPendingReview(ctx, {
      eventId: event._id,
      roundId: round._id,
      teamId: team._id,
      actorPersonId: person._id,
      reason: `Pending review cancelled after published missed-call policy: ${reason}`,
      now,
    });
    await patchTeamRoundState(ctx, state, {
      state: "missed",
      missedAt: now,
      calledAt: undefined,
      holdReason: reason,
      version: state.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.queue.missed",
      requestFingerprint,
      targetType: "team_round_state",
      targetId: state._id,
      resultJson: String(state.version + 1),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.queue.miss",
      grantIds: permission.grantIds,
      scopeType: permission.scopeType,
      scopeId: permission.scopeId,
      action: "review.queue_team_missed",
      targetType: "team_round_state",
      targetId: state._id,
      previousSummary: JSON.stringify({
        state: state.state,
        callAttemptCount: state.callAttemptCount,
        version: state.version,
      }),
      nextSummary: JSON.stringify({
        state: "missed",
        version: state.version + 1,
        cancelledReviewSessionId,
      }),
      reason,
    });
    return { teamRoundStateId: state._id, version: state.version + 1 };
  },
});

export const moveQueuedTeam = mutation({
  args: {
    eventSlug: v.string(),
    teamRoundStateId: v.id("teamRoundStates"),
    targetPanelId: v.id("reviewPanels"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ teamRoundStateId: v.id("teamRoundStates"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Move reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.teamRoundStateId,
      args.targetPanelId,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.queue.move",
      requestFingerprint,
    });
    if (prior) {
      const stateId = ctx.db.normalizeId("teamRoundStates", prior.targetId);
      if (!stateId) throw new Error("Prior queue-move result is invalid.");
      return {
        teamRoundStateId: stateId,
        version: storedOperationVersion(prior.resultJson, "queue move"),
      };
    }
    const { state, round } = await requireTeamRoundState(ctx, event._id, args.teamRoundStateId);
    const targetPanel = await ctx.db.get(args.targetPanelId);
    if (
      round.status !== "open" ||
      state.state !== "queued" ||
      state.version !== args.expectedVersion ||
      !state.panelId ||
      state.panelId === args.targetPanelId ||
      !targetPanel ||
      targetPanel.eventId !== event._id ||
      targetPanel.roundId !== round._id ||
      targetPanel.status !== "ready"
    ) {
      throw new ConvexError({
        code: "QUEUE_MOVE_UNAVAILABLE",
        message: "The queued team, source panel, target panel, or version changed.",
      });
    }
    const permission = await requireQueueExceptionPermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.queue.move",
      state,
    });
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "queue.manage",
      scopeType: "panel",
      scopeId: targetPanel._id,
    });
    const now = Date.now();
    const sourcePanelId = state.panelId;
    await patchTeamRoundState(ctx, state, {
      panelId: targetPanel._id,
      movedFromPanelId: sourcePanelId,
      lastMovedAt: now,
      version: state.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.queue.move",
      requestFingerprint,
      targetType: "team_round_state",
      targetId: state._id,
      resultJson: String(state.version + 1),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.queue.move",
      grantIds: permission.grantIds,
      scopeType: permission.scopeType,
      scopeId: permission.scopeId,
      action: "review.queue_team_moved",
      targetType: "team_round_state",
      targetId: state._id,
      previousSummary: JSON.stringify({ panelId: sourcePanelId, version: state.version }),
      nextSummary: JSON.stringify({
        panelId: targetPanel._id,
        version: state.version + 1,
      }),
      reason,
    });
    return { teamRoundStateId: state._id, version: state.version + 1 };
  },
});

export const setPanelAvailability = mutation({
  args: {
    eventSlug: v.string(),
    panelId: v.id("reviewPanels"),
    expectedVersion: v.number(),
    status: v.union(v.literal("paused"), v.literal("ready")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ panelId: v.id("reviewPanels"), status: v.string(), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Panel reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.panelId,
      args.expectedVersion,
      args.status,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.panel.availability",
      requestFingerprint,
    });
    if (prior) {
      const panelId = ctx.db.normalizeId("reviewPanels", prior.targetId);
      if (!panelId) throw new Error("Prior panel-availability result is invalid.");
      return {
        panelId,
        status: args.status,
        version: storedOperationVersion(prior.resultJson, "panel availability"),
      };
    }
    const panel = await ctx.db.get(args.panelId);
    if (
      !panel ||
      panel.eventId !== event._id ||
      panel.version !== args.expectedVersion ||
      (args.status === "paused" && !["ready", "needs_reviewer"].includes(panel.status)) ||
      (args.status === "ready" && panel.status !== "paused")
    ) {
      throw new ConvexError({
        code: "PANEL_CHANGED",
        message: "The panel state or version changed. Refresh before continuing.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.panel.pause",
      scopeType: "panel",
      scopeId: panel._id,
    });
    if (args.status === "ready") {
      const round = await ctx.db.get(panel.roundId);
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", panel._id).eq("status", "active"),
        )
        .collect();
      if (!round || members.length !== round.requiredPanelSize) {
        throw new ConvexError({
          code: "PANEL_NOT_READY",
          message: "Fill every published panel seat before resuming this panel.",
        });
      }
    }
    const now = Date.now();
    await ctx.db.patch(panel._id, {
      status: args.status,
      version: panel.version + 1,
      updatedAt: now,
    });
    await appendReviewPanelVacancyReadFactById(ctx, panel._id, now);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.panel.availability",
      requestFingerprint,
      targetType: "review_panel",
      targetId: panel._id,
      resultJson: String(panel.version + 1),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.panel.pause",
      grantIds,
      scopeType: "panel",
      scopeId: panel._id,
      action: args.status === "paused" ? "review.panel_paused" : "review.panel_resumed",
      targetType: "review_panel",
      targetId: panel._id,
      previousSummary: JSON.stringify({ status: panel.status, version: panel.version }),
      nextSummary: JSON.stringify({ status: args.status, version: panel.version + 1 }),
      reason,
    });
    return { panelId: panel._id, status: args.status, version: panel.version + 1 };
  },
});

export const waivePresence = mutation({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    reviewerPersonIds: v.array(v.id("people")),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ waivedCount: v.number(), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Presence-waiver reason", 5, 500);
    const uniqueReviewerIds = [...new Set(args.reviewerPersonIds)];
    if (
      uniqueReviewerIds.length === 0 ||
      uniqueReviewerIds.length !== args.reviewerPersonIds.length
    ) {
      throw new ConvexError({
        code: "INVALID_PRESENCE_WAIVER",
        message: "Choose one or more distinct assigned reviewers.",
      });
    }
    const requestFingerprint = operationFingerprint([
      args.reviewSessionId,
      JSON.stringify(uniqueReviewerIds),
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.presence.waive",
      requestFingerprint,
    });
    if (prior) {
      const sessionId = ctx.db.normalizeId("reviewSessions", prior.targetId);
      if (!sessionId) throw new Error("Prior presence-waiver result is invalid.");
      return {
        waivedCount: uniqueReviewerIds.length,
        version: storedOperationVersion(prior.resultJson, "presence waiver"),
      };
    }
    const session = await ctx.db.get(args.reviewSessionId);
    if (
      !session ||
      session.eventId !== event._id ||
      session.status !== "awaiting_presence" ||
      session.version !== args.expectedVersion
    ) {
      throw new ConvexError({
        code: "REVIEW_CHANGED",
        message: "Only the current pending review can receive a presence waiver.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.presence.waive",
      scopeType: "review",
      scopeId: session._id,
    });
    const assignments = await ctx.db
      .query("reviewAssignments")
      .withIndex("by_session_person", (index) => index.eq("reviewSessionId", session._id))
      .collect();
    const assignedReviewerIds = new Set(
      assignments
        .filter((assignment) => assignment.status === "assigned")
        .map((assignment) => assignment.reviewerPersonId),
    );
    const now = Date.now();
    for (const reviewerPersonId of uniqueReviewerIds) {
      if (!assignedReviewerIds.has(reviewerPersonId)) {
        throw new ConvexError({
          code: "REVIEWER_NOT_ASSIGNED",
          message: "A presence waiver can name only a current fixed reviewer.",
        });
      }
      const existing = await ctx.db
        .query("reviewPresence")
        .withIndex("by_session_reviewer", (index) =>
          index.eq("reviewSessionId", session._id).eq("reviewerPersonId", reviewerPersonId),
        )
        .unique();
      if (existing) {
        throw new ConvexError({
          code: "PRESENCE_ALREADY_CONFIRMED",
          message: "One selected reviewer already has a presence record.",
        });
      }
      await ctx.db.insert("reviewPresence", {
        eventId: event._id,
        reviewSessionId: session._id,
        reviewerPersonId,
        method: "board_override",
        tokenVersion: 0,
        confirmedAt: now,
        overrideByPersonId: person._id,
        overrideReason: reason,
      });
    }
    await ctx.db.patch(session._id, {
      version: session.version + 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.presence.waive",
      requestFingerprint,
      targetType: "review_session",
      targetId: session._id,
      resultJson: String(session.version + 1),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.presence.waive",
      grantIds,
      scopeType: "review",
      scopeId: session._id,
      action: "review.presence_waived",
      targetType: "review_session",
      targetId: session._id,
      previousSummary: JSON.stringify({ version: session.version }),
      nextSummary: JSON.stringify({
        waivedReviewerPersonIds: uniqueReviewerIds,
        version: session.version + 1,
      }),
      reason,
    });
    return { waivedCount: uniqueReviewerIds.length, version: session.version + 1 };
  },
});

export const waiveParticipantAvailability = mutation({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    waiverId: v.id("reviewParticipantAvailabilityWaivers"),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Participant-availability exception reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.reviewSessionId,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.participant_availability.waive",
      requestFingerprint,
    });
    if (prior) {
      const waiverId = ctx.db.normalizeId("reviewParticipantAvailabilityWaivers", prior.targetId);
      if (!waiverId) {
        throw new Error("Prior participant-availability waiver result is invalid.");
      }
      return {
        waiverId,
        version: storedOperationVersion(prior.resultJson, "participant-availability waiver"),
      };
    }
    const session = await ctx.db.get(args.reviewSessionId);
    if (
      !session ||
      session.eventId !== event._id ||
      session.status !== "awaiting_presence" ||
      session.version !== args.expectedVersion
    ) {
      throw new ConvexError({
        code: "REVIEW_CHANGED",
        message: "Only the current pending review can receive an availability exception.",
      });
    }
    const round = await ctx.db.get(session.roundId);
    if (!round || round.eventId !== event._id || round.status !== "open") {
      throw new ConvexError({
        code: "ROUND_NOT_OPEN",
        message: "This review round is not open.",
      });
    }
    if (!event.publishedAttendancePlanVersionId) {
      throw new ConvexError({
        code: "PARTICIPANT_PRESENCE_UNAVAILABLE",
        message: "Publish the attendance plan before recording an availability exception.",
      });
    }
    const permission = await requireParticipantAvailabilityWaiverPermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      reviewSessionId: session._id,
      teamId: session.teamId,
    });
    const participantAvailability = await readReviewParticipantAvailability(ctx, {
      eventId: event._id,
      teamId: session.teamId,
    });
    if (participantAvailability.availableCount >= round.minimumPresentParticipants) {
      throw new ConvexError({
        code: "PARTICIPANT_AVAILABILITY_EXCEPTION_NOT_NEEDED",
        message: "The team already meets this round's participant-availability rule.",
      });
    }
    const now = Date.now();
    const waiverId = await createReviewParticipantAvailabilityWaiver(ctx, {
      eventId: event._id,
      roundId: round._id,
      teamId: session.teamId,
      reviewSessionId: session._id,
      requiredCount: round.minimumPresentParticipants,
      observedCount: participantAvailability.availableCount,
      grantedByPersonId: person._id,
      grantIds: permission.grantIds,
      reason,
      createdAt: now,
    });
    await ctx.db.patch(session._id, {
      version: session.version + 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.participant_availability.waive",
      requestFingerprint,
      targetType: "review_participant_availability_waiver",
      targetId: waiverId,
      resultJson: String(session.version + 1),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.participant_availability.waive",
      grantIds: permission.grantIds,
      scopeType: permission.scopeType,
      scopeId: permission.scopeId,
      action: "review.participant_availability_waived",
      targetType: "review_session",
      targetId: session._id,
      previousSummary: JSON.stringify({ version: session.version }),
      nextSummary: JSON.stringify({
        requiredCount: round.minimumPresentParticipants,
        observedCount: participantAvailability.availableCount,
        version: session.version + 1,
      }),
      reason,
    });
    return { waiverId, version: session.version + 1 };
  },
});
