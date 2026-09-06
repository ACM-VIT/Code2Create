import { ConvexError, v } from "convex/values";
import { reviewerSeatWarnings } from "@code2create/domain";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
} from "./lib/operations";
import { appendReviewPanelVacancyReadFactById } from "./lib/operationsAutonomyReadFacts";
import { requirePermission, revokeSourceGrants } from "./lib/permissions";
import { canManagePanelRoster, grantPanelMemberAccess } from "./lib/reviewAccess";
import { requireConfirmedReviewer } from "./lib/reviewConfirmation";
import { reviewerHasOverlappingPanel } from "./lib/reviewerParticipation";
import { putInRoundReserve } from "./lib/reviewRoster";
import { hasReviewConflict } from "./lib/reviewConflict";
import { normalizedText } from "./lib/strings";
import { reviewPanelStatus } from "./values";

const liveReviewStatuses = ["awaiting_presence", "active", "scoring"] as const;

const panelMembershipOperationResult = z
  .object({
    status: z.enum(["ready", "needs_reviewer", "paused"]),
    version: z.number().int().positive(),
  })
  .strict();

type JoiningReviewer = {
  person: Doc<"people">;
  subject: Doc<"eventAccessSubjects">;
  reserve: Doc<"reviewRoundReserves"> | null;
  /** The seat whose criteria and coordinator duty the new member takes over. */
  seat: Doc<"reviewPanelMembers">;
  warnings: string[];
};

/**
 * Resolve the reviewer who takes a seat: the seat freed inside this command, or
 * the most recent seat a no-show left behind.
 */
async function resolveJoiningReviewer(
  ctx: MutationCtx,
  args: {
    round: Doc<"reviewRounds">;
    personId: Id<"people">;
    leaving: Doc<"reviewPanelMembers"> | undefined;
    panelMembers: Doc<"reviewPanelMembers">[];
    sourceMember?: Doc<"reviewPanelMembers">;
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
      message:
        "This panel has no empty seat. Take a reviewer off it in the same change.",
    });
  }
  if (
    await reviewerHasOverlappingPanel(
      ctx,
      args.round.eventId,
      args.personId,
      args.round,
      args.sourceMember?.panelId,
    )
  ) {
    throw new ConvexError({
      code: "REVIEWER_ALREADY_SEATED",
      message:
        "That reviewer already sits on a panel whose round overlaps these review hours.",
    });
  }
  const reserve = await ctx.db
    .query("reviewRoundReserves")
    .withIndex("by_round_person", (index) =>
      index.eq("roundId", args.round._id).eq("personId", args.personId),
    )
    .unique();
  if (!args.sourceMember && (!reserve || reserve.status !== "available")) {
    throw new ConvexError({
      code: "RESERVE_UNAVAILABLE",
      message:
        "Only a reserve reviewer who is free for this round can take a seat.",
    });
  }
  const [person, subject, profile] = await Promise.all([
    ctx.db.get(args.personId),
    ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (q) =>
        q.eq("eventId", args.round.eventId).eq("personId", args.personId),
      )
      .unique(),
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
    profile.status !== "active"
  ) {
    throw new ConvexError({
      code: "REVIEWER_NOT_AVAILABLE",
      message: "Choose an reviewer with an active profile.",
    });
  }
  if (Date.now() >= args.round.startsAt || args.round.status !== "published") {
    await requireConfirmedReviewer(ctx, args.round, args.personId, Date.now());
  }
  const criteria = await Promise.all(seat.assignedCriterionIds.map(id => ctx.db.get(id)));
  const warnings = reviewerSeatWarnings(profile, {
    seniority: seat.seatSeniority,
    criterionKeys: criteria.map(criterion => {
      if (!criterion) throw new Error("A panel seat references a missing criterion.");
      return criterion.stableKey;
    }),
  }, args.round.staffing.allowSeniorLeadFallback);
  const plans = await ctx.db
    .query("reviewTeamPlans")
    .withIndex("by_round_team", (q) => q.eq("roundId", args.round._id))
    .collect();
  const queued = await ctx.db
    .query("teamRoundStates")
    .withIndex("by_round_state_priority_queued", (q) =>
      q.eq("roundId", args.round._id),
    )
    .collect();
  const teamIds = new Set([
    ...plans
      .filter(
        (p) =>
          (p.panelId === seat.panelId || p.backupPanelId === seat.panelId) &&
          !queued.some(
            (t) =>
              t.teamId === p.teamId &&
              ["skipped", "completed", "withdrawn"].includes(t.state),
          ),
      )
      .map((p) => p.teamId),
    ...queued
      .filter(
        (t) =>
          t.panelId === seat.panelId &&
          ["queued", "called", "at_table"].includes(t.state),
      )
      .map((t) => t.teamId),
  ]);
  for (const teamId of teamIds) {
    const team = await ctx.db.get(teamId);
    // A team can become OC before it ever gets a queue state; its old plan
    // must not reserve a competitive panel seat or block a replacement.
    if (team?.competitionCategory === "oc") continue;
    if (await hasReviewConflict(ctx, args.round.eventId, person._id, teamId)) {
      throw new ConvexError({
        code: "REVIEWER_CONFLICT",
        message: `This reviewer has a conflict with ${team?.name ?? "a team"} allocated to this panel. Reassign that team first.`,
      });
    }
  }
  return { person, subject, reserve, seat, warnings };
}

async function requireIdlePanel(
  ctx: MutationCtx,
  panel: Doc<"reviewPanels">,
  expectedVersion: number,
) {
  if (
    panel.version !== expectedVersion ||
    !["ready", "needs_reviewer", "paused"].includes(panel.status)
  )
    throw new ConvexError({
      code: "PANEL_CHANGED",
      message: "The panel changed. Refresh before continuing.",
    });
  const [sessions, chain] = await Promise.all([
    ctx.db
      .query("reviewSessions")
      .withIndex("by_panel_status", (q) => q.eq("panelId", panel._id))
      .collect(),
    ctx.db
      .query("reviewerPageChains")
      .withIndex("by_panel_state", (q) =>
        q.eq("panelId", panel._id).eq("state", "active"),
      )
      .unique(),
  ]);
  if (
    sessions.some((s) =>
      liveReviewStatuses.some((status) => s.status === status),
    )
  )
    throw new ConvexError({
      code: "REVIEW_IN_PROGRESS",
      message:
        "A review is live at this panel. Finish or cancel it before changing who sits here.",
    });
  if (chain)
    throw new ConvexError({
      code: "SUBSTITUTE_PAGE_ACTIVE",
      message:
        "A substitute page is out for this panel. Wait for it before changing the panel by hand.",
    });
}

async function removeSeat(
  ctx: MutationCtx,
  seat: Doc<"reviewPanelMembers">,
  actorId: Id<"people">,
  reason: string,
  now: number,
) {
  await ctx.db.patch(seat._id, { status: "removed", endedAt: now });
  await revokeSourceGrants(ctx, {
    eventId: seat.eventId,
    sourceType: "panel_assignment",
    sourceId: seat._id,
    revokedByPersonId: actorId,
    reason,
  });
}

async function fillSeat(
  ctx: MutationCtx,
  round: Doc<"reviewRounds">,
  joining: JoiningReviewer,
  actorId: Id<"people">,
  reason: string,
  now: number,
) {
  const seat = joining.seat;
  const panelMemberId = await ctx.db.insert("reviewPanelMembers", {
    eventId: round.eventId,
    roundId: round._id,
    panelId: seat.panelId,
    personId: joining.person._id,
    eventAccessSubjectId: joining.subject._id,
    assignedCriterionIds: seat.assignedCriterionIds,
    isCoordinator: seat.isCoordinator,
    seatSeniority: seat.seatSeniority,
    status: "active",
    assignedAt: now,
  });
  await grantPanelMemberAccess(ctx, {
    eventId: round.eventId,
    roundId: round._id,
    panelId: seat.panelId,
    panelMemberId,
    reviewerPersonId: joining.person._id,
    eventAccessSubjectId: joining.subject._id,
    grantedByPersonId: actorId,
    isCoordinator: seat.isCoordinator,
    reason,
  });
  await ctx.db.patch(seat._id, {
    status: "replaced",
    endedAt: seat.endedAt ?? now,
  });
  await revokeSourceGrants(ctx, {
    eventId: round.eventId,
    sourceType: "panel_assignment",
    sourceId: seat._id,
    revokedByPersonId: actorId,
    reason,
  });
  if (joining.reserve?.status === "available") {
    await ctx.db.patch(joining.reserve._id, {
      status: "assigned",
      version: joining.reserve.version + 1,
      updatedAt: now,
    });
    await revokeSourceGrants(ctx, {
      eventId: round.eventId,
      sourceType: "reserve_assignment",
      sourceId: joining.reserve._id,
      revokedByPersonId: actorId,
      reason,
    });
  }
}

export const swapPanelMember = mutation({
  args: {
    eventSlug: v.string(),
    panelId: v.id("reviewPanels"),
    leavingPersonId: v.optional(v.id("people")),
    joiningPersonId: v.optional(v.id("people")),
    expectedPanelVersion: v.number(),
    sourcePanel: v.optional(
      v.object({ panelId: v.id("reviewPanels"), expectedVersion: v.number() }),
    ),
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
    if (!(await canManagePanelRoster(ctx, event._id, person._id))) {
      throw new ConvexError({ code: "BOARD_REQUIRED", message: "Only Board members can change panel reviewers." });
    }
    const reason = normalizedText(
      args.reason,
      "Panel membership reason",
      5,
      500,
    );
    if (
      args.leavingPersonId === undefined &&
      args.joiningPersonId === undefined
    ) {
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
      args.sourcePanel?.panelId ?? null,
      args.sourcePanel?.expectedVersion ?? null,
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
      if (!panelId)
        throw new Error("Prior panel-membership result is invalid.");
      return {
        panelId,
        ...storedOperationResult(
          prior.resultJson,
          "panel-membership",
          panelMembershipOperationResult,
        ),
      };
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
    const round = await ctx.db.get(panel.roundId);
    if (!round)
      throw new Error("A review panel no longer resolves to its round.");
    if (
      panel.version !== args.expectedPanelVersion ||
      !["ready", "needs_reviewer", "paused"].includes(panel.status) ||
      !["published", "open"].includes(round.status)
    ) {
      throw new ConvexError({
        code: "PANEL_CHANGED",
        message:
          "The panel, round, or expected version changed. Refresh before continuing.",
      });
    }
    await requireIdlePanel(ctx, panel, args.expectedPanelVersion);
    const panelMembers = await ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_panel_status", (q) => q.eq("panelId", panel._id))
      .collect();
    const activeMembers = panelMembers.filter(
      (member) => member.status === "active",
    );
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
        message:
          "A panel cannot lose the reviewer who runs it. Name someone to take the seat.",
      });
    }
    const sourcePanel = args.sourcePanel
      ? await ctx.db.get(args.sourcePanel.panelId)
      : null;
    let sourceMember: Doc<"reviewPanelMembers"> | undefined;
    let sourceMembers: Doc<"reviewPanelMembers">[] = [];
    let sourceGrantIds: Id<"permissionGrants">[] = [];
    if (args.sourcePanel) {
      if (
        !sourcePanel ||
        sourcePanel.roundId !== round._id ||
        sourcePanel._id === panel._id ||
        !args.joiningPersonId
      )
        throw new ConvexError({
          code: "INVALID_PANEL_CHANGE",
          message:
            "Choose another panel in this round to transfer a reviewer from.",
        });
      sourceGrantIds = await requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "review.substitute.assign",
        scopeType: "panel",
        scopeId: sourcePanel._id,
      });
      await requireIdlePanel(
        ctx,
        sourcePanel,
        args.sourcePanel.expectedVersion,
      );
      sourceMembers = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (q) => q.eq("panelId", sourcePanel._id))
        .collect();
      sourceMember = sourceMembers.find(
        (m) => m.status === "active" && m.personId === args.joiningPersonId,
      );
      if (!sourceMember)
        throw new ConvexError({
          code: "PANEL_CHANGED",
          message:
            "That reviewer is no longer on the source panel. Refresh before continuing.",
        });
      if (sourceMember.isCoordinator && !leaving)
        throw new ConvexError({
          code: "PANEL_COORDINATOR_REQUIRED",
          message:
            "Choose a reviewer to take the source panel's coordinator seat.",
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
            ...(sourceMember ? { sourceMember } : {}),
          });
    const returning =
      sourceMember && leaving
        ? await resolveJoiningReviewer(ctx, {
            round,
            personId: leaving.personId,
            leaving: sourceMember,
            panelMembers: sourceMembers,
            sourceMember: leaving,
          })
        : null;
    const now = Date.now();
    const nextVersion = panel.version + 1;
    if (joining) await fillSeat(ctx, round, joining, person._id, reason, now);
    if (returning)
      await fillSeat(ctx, round, returning, person._id, reason, now);
    if (leaving && !joining)
      await removeSeat(ctx, leaving, person._id, reason, now);
    if (leaving && !sourceMember)
      await putInRoundReserve(ctx, {
        round,
        personId: leaving.personId,
        subjectId: leaving.eventAccessSubjectId,
        actorId: person._id,
        reason,
        now,
      });
    if (sourcePanel && sourceMember) {
      if (!returning)
        await removeSeat(ctx, sourceMember, person._id, reason, now);
      const sourcePeople = [
        ...sourceMembers
          .filter((m) => m.status === "active" && m._id !== sourceMember._id)
          .map((m) => m.personId),
        ...(returning ? [returning.person._id] : []),
      ];
      const sourceStatus =
        sourcePanel.status === "paused"
          ? "paused"
          : sourcePeople.length === round.requiredPanelSize
            ? "ready"
            : "needs_reviewer";
      await ctx.db.patch(sourcePanel._id, {
        coordinatorPersonId: returning?.seat.isCoordinator
          ? returning.person._id
          : sourcePanel.coordinatorPersonId,
        status: sourceStatus,
        version: sourcePanel.version + 1,
        updatedAt: now,
      });
      await appendReviewPanelVacancyReadFactById(ctx, sourcePanel._id, now);
      await writeAuditEvent(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        permissionKey: "review.substitute.assign",
        grantIds: sourceGrantIds,
        scopeType: "panel",
        scopeId: sourcePanel._id,
        action: "review.panel_membership_changed",
        targetType: "review_panel",
        targetId: sourcePanel._id,
        previousSummary: JSON.stringify({
          version: sourcePanel.version,
          memberPersonIds: sourceMembers
            .filter((m) => m.status === "active")
            .map((m) => m.personId),
        }),
        nextSummary: JSON.stringify({
          version: sourcePanel.version + 1,
          memberPersonIds: sourcePeople,
          transferredTo: panel._id,
          reviewerFitWarnings: returning?.warnings ?? [],
        }),
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
      resultJson: JSON.stringify({ status: nextStatus, version: nextVersion }),
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
        reviewerFitWarnings: joining?.warnings ?? [],
      }),
      reason,
    });
    return { panelId: panel._id, status: nextStatus, version: nextVersion };
  },
});
