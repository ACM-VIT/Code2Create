import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { appendReviewPanelVacancyReadFactById } from "./lib/operationsAutonomyReadFacts";
import { requirePermission, revokeSourceGrants } from "./lib/permissions";
import { grantPanelMemberAccess } from "./lib/reviewAccess";
import { reviewerCoversStaffingWindow } from "./lib/reviewerAvailability";
import { normalizedText } from "./lib/strings";
import { reviewPanelStatus } from "./values";

const liveReviewStatuses = ["awaiting_presence", "active", "overdue"] as const;

type JoiningReviewer = {
  person: Doc<"people">;
  subject: Doc<"eventAccessSubjects">;
  reserve: Doc<"reviewRoundReserves">;
  /** The seat whose criteria and coordinator duty the new member takes over. */
  seat: Doc<"reviewPanelMembers">;
};

/**
 * Resolve the reserve who takes a seat: the seat freed inside this command, or
 * the most recent seat a no-show left behind.
 */
async function resolveJoiningReviewer(
  ctx: MutationCtx,
  args: {
    round: Doc<"reviewRounds">;
    personId: Id<"people">;
    leaving: Doc<"reviewPanelMembers"> | undefined;
    panelMembers: Doc<"reviewPanelMembers">[];
  },
): Promise<JoiningReviewer> {
  const seat =
    args.leaving ??
    args.panelMembers
      .filter((member) => member.status === "removed")
      .sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0))[0];
  if (!seat) {
    throw new ConvexError({
      code: "PANEL_HAS_NO_EMPTY_SEAT",
      message: "This panel has no empty seat. Take a reviewer off it in the same change.",
    });
  }
  const seated = await ctx.db
    .query("reviewPanelMembers")
    .withIndex("by_round_person_status", (index) =>
      index
        .eq("roundId", args.round._id)
        .eq("personId", args.personId)
        .eq("status", "active"),
    )
    .unique();
  if (seated) {
    throw new ConvexError({
      code: "REVIEWER_ALREADY_SEATED",
      message: "That reviewer already sits on a panel in this round.",
    });
  }
  const reserve = await ctx.db
    .query("reviewRoundReserves")
    .withIndex("by_round_person", (index) =>
      index.eq("roundId", args.round._id).eq("personId", args.personId),
    )
    .unique();
  if (!reserve || reserve.status !== "available") {
    throw new ConvexError({
      code: "RESERVE_UNAVAILABLE",
      message: "Only a reserve reviewer who is free for this round can take a seat.",
    });
  }
  const [person, subject, profile] = await Promise.all([
    ctx.db.get(reserve.personId),
    ctx.db.get(reserve.eventAccessSubjectId),
    ctx.db
      .query("reviewerProfiles")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", args.round.eventId).eq("personId", args.personId),
      )
      .unique(),
  ]);
  if (!person || !subject) {
    throw new Error("A round reserve no longer resolves to an event account.");
  }
  if (
    person.status !== "active" ||
    subject.status !== "active" ||
    !profile ||
    profile.status !== "active" ||
    profile.trainingStatus !== "complete"
  ) {
    throw new ConvexError({
      code: "REVIEWER_NOT_AVAILABLE",
      message: "That reviewer is not an active, trained reviewer in this event.",
    });
  }
  if (!reviewerCoversStaffingWindow(profile.availabilityWindows, args.round)) {
    throw new ConvexError({
      code: "REVIEWER_UNAVAILABLE_FOR_ROUND",
      message: "That reviewer's declared availability does not cover this round.",
    });
  }
  const qualifiedKeys = new Set(profile.criterionKeys);
  for (const criterionId of seat.assignedCriterionIds) {
    const criterion = await ctx.db.get(criterionId);
    if (!criterion) throw new Error("A panel seat references a missing criterion.");
    if (!qualifiedKeys.has(criterion.stableKey)) {
      throw new ConvexError({
        code: "REVIEWER_NOT_QUALIFIED",
        message: `That reviewer is not qualified to score ${criterion.label}.`,
      });
    }
  }
  return { person, subject, reserve, seat };
}

export const swapPanelMember = mutation({
  args: {
    eventSlug: v.string(),
    panelId: v.id("reviewPanels"),
    leavingPersonId: v.optional(v.id("people")),
    joiningPersonId: v.optional(v.id("people")),
    expectedPanelVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    panelId: v.id("reviewPanels"),
    status: reviewPanelStatus,
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Panel membership reason", 5, 500);
    if (args.leavingPersonId === undefined && args.joiningPersonId === undefined) {
      throw new ConvexError({
        code: "INVALID_PANEL_CHANGE",
        message: "Name the reviewer leaving, the reviewer joining, or both.",
      });
    }
    if (args.leavingPersonId === args.joiningPersonId) {
      throw new ConvexError({
        code: "INVALID_PANEL_CHANGE",
        message: "One reviewer cannot leave and join the same panel.",
      });
    }
    const requestFingerprint = operationFingerprint([
      args.panelId,
      args.leavingPersonId ?? null,
      args.joiningPersonId ?? null,
      args.expectedPanelVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.panel.membership",
      requestFingerprint,
    });
    if (prior) {
      const panelId = ctx.db.normalizeId("reviewPanels", prior.targetId);
      if (!panelId) throw new Error("Prior panel-membership result is invalid.");
      const saved = await ctx.db.get(panelId);
      if (!saved) throw new Error("Prior panel-membership result no longer resolves.");
      return { panelId, status: saved.status, version: saved.version };
    }
    const panel = await ctx.db.get(args.panelId);
    if (!panel || panel.eventId !== event._id) {
      throw new ConvexError({
        code: "PANEL_NOT_FOUND",
        message: "That review panel is unavailable.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.substitute.assign",
      scopeType: "panel",
      scopeId: panel._id,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const round = await ctx.db.get(panel.roundId);
    if (!round) throw new Error("A review panel no longer resolves to its round.");
    if (
      panel.version !== args.expectedPanelVersion ||
      !["ready", "needs_reviewer", "paused"].includes(panel.status) ||
      !["published", "open"].includes(round.status)
    ) {
      throw new ConvexError({
        code: "PANEL_CHANGED",
        message: "The panel, round, or expected version changed. Refresh before continuing.",
      });
    }
    const [sessions, activeChain, panelMembers] = await Promise.all([
      ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (index) => index.eq("panelId", panel._id))
        .collect(),
      ctx.db
        .query("reviewerPageChains")
        .withIndex("by_panel_state", (index) =>
          index.eq("panelId", panel._id).eq("state", "active"),
        )
        .unique(),
      ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) => index.eq("panelId", panel._id))
        .collect(),
    ]);
    if (
      sessions.some((session) =>
        liveReviewStatuses.some((status) => status === session.status),
      )
    ) {
      throw new ConvexError({
        code: "REVIEW_IN_PROGRESS",
        message:
          "A review is live at this panel. Finish or cancel it before changing who sits here.",
      });
    }
    if (activeChain) {
      throw new ConvexError({
        code: "SUBSTITUTE_PAGE_ACTIVE",
        message: "A substitute page is out for this panel. Wait for it before changing the panel by hand.",
      });
    }
    const activeMembers = panelMembers.filter((member) => member.status === "active");
    const leavingPersonId = args.leavingPersonId;
    const leaving =
      leavingPersonId === undefined
        ? undefined
        : activeMembers.find((member) => member.personId === leavingPersonId);
    if (leavingPersonId !== undefined && !leaving) {
      throw new ConvexError({
        code: "PANEL_MEMBER_NOT_SEATED",
        message: "That reviewer is not on this panel.",
      });
    }
    if (leaving?.isCoordinator && args.joiningPersonId === undefined) {
      throw new ConvexError({
        code: "PANEL_COORDINATOR_REQUIRED",
        message: "A panel cannot lose the reviewer who runs it. Name someone to take the seat.",
      });
    }
    const joining =
      args.joiningPersonId === undefined
        ? undefined
        : await resolveJoiningReviewer(ctx, {
            round,
            personId: args.joiningPersonId,
            leaving,
            panelMembers,
          });
    const now = Date.now();
    const nextVersion = panel.version + 1;
    if (joining) {
      const panelMemberId = await ctx.db.insert("reviewPanelMembers", {
        eventId: event._id,
        roundId: round._id,
        panelId: panel._id,
        personId: joining.person._id,
        eventAccessSubjectId: joining.subject._id,
        assignedCriterionIds: joining.seat.assignedCriterionIds,
        isCoordinator: joining.seat.isCoordinator,
        status: "active",
        assignedAt: now,
      });
      await grantPanelMemberAccess(ctx, {
        eventId: event._id,
        roundId: round._id,
        panelId: panel._id,
        panelMemberId,
        reviewerPersonId: joining.person._id,
        eventAccessSubjectId: joining.subject._id,
        grantedByPersonId: person._id,
        isCoordinator: joining.seat.isCoordinator,
        reason,
      });
      await ctx.db.patch(joining.seat._id, {
        status: "replaced",
        endedAt: joining.seat.endedAt ?? now,
      });
      await ctx.db.patch(joining.reserve._id, {
        status: "assigned",
        version: joining.reserve.version + 1,
        updatedAt: now,
      });
      await revokeSourceGrants(ctx, {
        eventId: event._id,
        sourceType: "reserve_assignment",
        sourceId: joining.reserve._id,
        revokedByPersonId: person._id,
        reason: "Reserve took a fixed panel seat",
      });
    }
    if (leaving) {
      if (leaving._id !== joining?.seat._id) {
        await ctx.db.patch(leaving._id, { status: "removed", endedAt: now });
      }
      await revokeSourceGrants(ctx, {
        eventId: event._id,
        sourceType: "panel_assignment",
        sourceId: leaving._id,
        revokedByPersonId: person._id,
        reason,
      });
    }
    const nextMemberPersonIds = [
      ...activeMembers
        .filter((member) => member._id !== leaving?._id)
        .map((member) => member.personId),
      ...(joining ? [joining.person._id] : []),
    ];
    const nextStatus: Doc<"reviewPanels">["status"] =
      panel.status === "paused"
        ? "paused"
        : nextMemberPersonIds.length === round.requiredPanelSize
          ? "ready"
          : "needs_reviewer";
    const nextCoordinatorPersonId = joining?.seat.isCoordinator
      ? joining.person._id
      : panel.coordinatorPersonId;
    await ctx.db.patch(panel._id, {
      coordinatorPersonId: nextCoordinatorPersonId,
      status: nextStatus,
      version: nextVersion,
      updatedAt: now,
    });
    await appendReviewPanelVacancyReadFactById(ctx, panel._id, now);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.panel.membership",
      requestFingerprint,
      targetType: "review_panel",
      targetId: panel._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.substitute.assign",
      grantIds,
      scopeType: "panel",
      scopeId: panel._id,
      action: "review.panel_membership_changed",
      targetType: "review_panel",
      targetId: panel._id,
      previousSummary: JSON.stringify({
        status: panel.status,
        version: panel.version,
        coordinatorPersonId: panel.coordinatorPersonId,
        memberPersonIds: activeMembers.map((member) => member.personId),
      }),
      nextSummary: JSON.stringify({
        status: nextStatus,
        version: nextVersion,
        coordinatorPersonId: nextCoordinatorPersonId,
        memberPersonIds: nextMemberPersonIds,
        leavingPersonId: leaving?.personId ?? null,
        joiningPersonId: joining?.person._id ?? null,
      }),
      reason,
    });
    return { panelId: panel._id, status: nextStatus, version: nextVersion };
  },
});
