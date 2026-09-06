import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  insertPermissionGrant,
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import { advanceAccessVersion } from "./lib/accessVersion";
import {
  maximumReviewPanelsPerRound,
  maximumReviewersPerPanel,
  maximumReviewReservesPerRound,
} from "./lib/reviewLimits";
import {
  eligibleReserve,
  sendNextPage,
  substituteScope,
  vacatePanelSeat,
} from "./reviewSubstitutions";
import { reviewerConfirmedForReview, scheduleShiftReminders } from "./lib/reviewConfirmation";
import { activeRoundPause as findActiveRoundPause } from "./lib/reviewRoundPauses";
import { writeAuditEvent } from "./lib/audit";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { normalizedText } from "./lib/strings";
import { validateStaffingPolicy } from "./reviewConfiguration";
import { reviewStaffingPolicy } from "./values";
import { reviewerParticipation } from "./lib/reviewerParticipation";

export const settings = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.object({
    version: v.number(),
    canConfigure: v.boolean(),
    automationBlockedPanels: v.number(),
    staffing: reviewStaffingPolicy,
    substituteResponseSeconds: v.number(),
    noShowGraceSeconds: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.read",
      scopeType: "round",
      scopeId: args.roundId,
    });
    const round = await ctx.db.get(args.roundId);
    if (!round || round.eventId !== event._id)
      throw new ConvexError({
        code: "ROUND_NOT_FOUND",
        message: "That round is unavailable.",
      });
    const grants = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.publish",
      scopeType: "event",
    });
    const panels = await ctx.db
      .query("reviewPanels")
      .withIndex("by_round_status", (q) => q.eq("roundId", round._id))
      .take(maximumReviewPanelsPerRound + 1);
    if (panels.length > maximumReviewPanelsPerRound)
      throw new Error("Panel limit exceeded.");
    const operator = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (q) =>
        q.eq("eventId", event._id).eq("personId", round.createdByPersonId),
      )
      .unique();
    const authority = await Promise.all(
      panels.map(async (panel) =>
        operator?.status === "active"
          ? substituteScope(ctx, {
              eventId: event._id,
              eventAccessSubjectId: operator._id,
              panelId: panel._id,
            })
          : null,
      ),
    );
    return {
      automationBlockedPanels: authority.filter(
        (permission) => permission === null,
      ).length,
      version: round.version,
      canConfigure:
        grants.length > 0 && ["published", "open"].includes(round.status),
      staffing: round.staffing,
      substituteResponseSeconds: round.substituteResponseSeconds,
      noShowGraceSeconds: round.noShowGraceSeconds,
    };
  },
});

export const juniorParticipation = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.array(
    v.object({
      personId: v.id("people"),
      displayName: v.string(),
      completedReviews: v.number(),
      lastReviewedAt: v.optional(v.number()),
      status: v.union(
        v.literal("on_panel"),
        v.literal("paged"),
        v.literal("waiting"),
        v.literal("off_duty"),
        v.literal("outside_window"),
        v.literal("unconfirmed"),
        v.literal("profile_inactive"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.read",
      scopeType: "round",
      scopeId: args.roundId,
    });
    const round = await ctx.db.get(args.roundId);
    if (!round || round.eventId !== event._id)
      throw new ConvexError({
        code: "ROUND_NOT_FOUND",
        message: "That round is unavailable.",
      });
    const confirmations = await ctx.db
      .query("reviewerRoundConfirmations")
      .withIndex("by_roundId_and_personId", (q) => q.eq("roundId", round._id))
      .take(501);
    if (confirmations.length > 500)
      throw new Error("Reviewer pool limit exceeded.");
    const now = Date.now();
    const rows = await Promise.all(
      confirmations.map(async (confirmation) => {
        const profile = await ctx.db
          .query("reviewerProfiles")
          .withIndex("by_event_person", (q) =>
            q.eq("eventId", event._id).eq("personId", confirmation.personId),
          )
          .unique();
        if (!profile || profile.seniority !== "jc") return null;
        const [reviewer, participation, seat, clockIn, reserve] =
          await Promise.all([
            ctx.db.get(confirmation.personId),
            reviewerParticipation(ctx, event._id, confirmation.personId),
            ctx.db
              .query("reviewPanelMembers")
              .withIndex("by_round_person_status", (q) =>
                q
                  .eq("roundId", round._id)
                  .eq("personId", confirmation.personId)
                  .eq("status", "active"),
              )
              .unique(),
            ctx.db
              .query("reviewerClockIns")
              .withIndex("by_round_person", (q) =>
                q
                  .eq("roundId", round._id)
                  .eq("reviewerPersonId", confirmation.personId),
              )
              .unique(),
            ctx.db
              .query("reviewRoundReserves")
              .withIndex("by_round_person", (q) =>
                q
                  .eq("roundId", round._id)
                  .eq("personId", confirmation.personId),
              )
              .unique(),
          ]);
        if (!reviewer) throw new Error("Reviewer is missing.");
        const status = participation.hasLiveReview
          ? ("on_panel" as const)
          : profile.status !== "active"
            ? ("profile_inactive" as const)
            : confirmation.status !== "confirmed"
              ? ("unconfirmed" as const)
              : !(await reviewerConfirmedForReview(
                    ctx,
                    round,
                    confirmation.personId,
                    now,
                    round.substituteResponseSeconds,
                  ))
                ? ("outside_window" as const)
                : clockIn?.status !== "present"
                  ? ("off_duty" as const)
                  : seat
                    ? ("on_panel" as const)
                    : reserve?.status === "paged"
                      ? ("paged" as const)
                      : ("waiting" as const);
        return {
          personId: reviewer._id,
          displayName: reviewer.displayName,
          completedReviews: participation.completedReviews,
          ...(participation.lastReviewedAt === undefined
            ? {}
            : { lastReviewedAt: participation.lastReviewedAt }),
          status,
        };
      }),
    );
    return rows
      .filter((row) => row !== null)
      .sort(
        (a, b) =>
          a.completedReviews - b.completedReviews ||
          (a.lastReviewedAt ?? 0) - (b.lastReviewedAt ?? 0) ||
          a.displayName.localeCompare(b.displayName),
      );
  },
});

export const configure = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    expectedVersion: v.number(),
    staffing: reviewStaffingPolicy,
    substituteResponseSeconds: v.number(),
    noShowGraceSeconds: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 3, 300);
    const requestFingerprint = operationFingerprint([
      args.roundId,
      args.expectedVersion,
      JSON.stringify(args.staffing),
      args.substituteResponseSeconds,
      args.noShowGraceSeconds,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.staffing.configure",
      requestFingerprint,
    });
    if (prior)
      return {
        version: storedOperationVersion(prior.resultJson, "staffing settings"),
      };
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.publish",
      scopeType: "event",
    });
    const round = await ctx.db.get(args.roundId);
    if (
      !round ||
      round.eventId !== event._id ||
      round.version !== args.expectedVersion ||
      !["published", "open"].includes(round.status)
    )
      throw new ConvexError({
        code: "ROUND_CHANGED",
        message: "Round settings changed. Refresh before saving.",
      });
    validateStaffingPolicy(args.staffing, round.requiredPanelSize);
    if (
      args.staffing.seniorSeats !== round.staffing.seniorSeats ||
      args.staffing.juniorSeats !== round.staffing.juniorSeats
    )
      throw new ConvexError({
        code: "PANEL_COMPOSITION_PUBLISHED",
        message:
          "Seat counts are set when the panels are published. Use substitutions to change who fills them.",
      });
    for (const seconds of [
      args.substituteResponseSeconds,
      args.noShowGraceSeconds,
    ])
      if (!Number.isSafeInteger(seconds) || seconds < 15 || seconds > 1800)
        throw new ConvexError({
          code: "INVALID_STAFFING_TIMING",
          message:
            "Response and no-show windows must be whole seconds from 15 to 1800.",
        });
    if (
      !args.staffing.allowSeniorLeadFallback &&
      round.staffing.allowSeniorLeadFallback
    ) {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_round_person_status", (q) => q.eq("roundId", round._id))
        .take(101);
      if (members.length > 100)
        throw new ConvexError({
          code: "PANEL_REPLAN_REQUIRED",
          message: "Replan the panels before changing the lead composition.",
        });
      for (const member of members.filter(
        (row) => row.status === "active" && row.isCoordinator,
      )) {
        const profile = await ctx.db
          .query("reviewerProfiles")
          .withIndex("by_event_person", (q) =>
            q.eq("eventId", event._id).eq("personId", member.personId),
          )
          .unique();
        if (profile?.seniority !== "board")
          throw new ConvexError({
            code: "SENIOR_LEAD_SEATED",
            message:
              "Replace the SC leads with Board members before disabling the SC lead option.",
          });
      }
    }
    const version = round.version + 1;
    const now = Date.now();
    await ctx.db.patch(round._id, {
      staffing: args.staffing,
      substituteResponseSeconds: args.substituteResponseSeconds,
      noShowGraceSeconds: args.noShowGraceSeconds,
      version,
      configurationChecksum: operationFingerprint([
        round.configurationChecksum,
        requestFingerprint,
      ]),
    });
    if (
      args.staffing.assignmentReminderSeconds !==
      round.staffing.assignmentReminderSeconds ||
      args.staffing.assignmentReminderCalls !== round.staffing.assignmentReminderCalls
    ) {
      const confirmations = await ctx.db
        .query("reviewerRoundConfirmations")
        .withIndex("by_roundId_and_personId", (q) => q.eq("roundId", round._id))
        .take(501);
      if (confirmations.length > 500)
        throw new Error("Reviewer pool limit exceeded.");
      for (const confirmation of confirmations)
        await scheduleShiftReminders(
          ctx,
          confirmation,
          { ...round, staffing: args.staffing },
          now,
        );
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.staffing.configure",
      requestFingerprint,
      targetType: "review_round",
      targetId: round._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.configuration.publish",
      grantIds,
      scopeType: "event",
      action: "review.staffing_configured",
      targetType: "review_round",
      targetId: round._id,
      previousSummary: JSON.stringify({
        staffing: round.staffing,
        substituteResponseSeconds: round.substituteResponseSeconds,
        noShowGraceSeconds: round.noShowGraceSeconds,
      }),
      nextSummary: JSON.stringify({
        staffing: args.staffing,
        substituteResponseSeconds: args.substituteResponseSeconds,
        noShowGraceSeconds: args.noShowGraceSeconds,
        version,
      }),
      reason,
    });
    return { version };
  },
});

export const dispatch = internalMutation({
  args: {
    status: v.union(v.literal("published"), v.literal("open")),
    cursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rounds = await ctx.db
      .query("reviewRounds")
      .withIndex("by_status_start", (q) => q.eq("status", args.status))
      .paginate({ cursor: args.cursor ?? null, numItems: 20 });
    const now = Date.now();
    for (const round of rounds.page) {
      if (
        !round.staffing.automaticReplacement ||
        now < round.clockInOpensAt ||
        now >= round.endsAt
      )
        continue;
      const panels = await ctx.db
        .query("reviewPanels")
        .withIndex("by_round_status", (q) => q.eq("roundId", round._id))
        .take(maximumReviewPanelsPerRound + 1);
      if (panels.length > maximumReviewPanelsPerRound)
        throw new Error("Panel limit exceeded.");
      for (const panel of panels)
        if (panel.status === "ready" || panel.status === "needs_reviewer")
          await ctx.scheduler.runAfter(0, internal.reviewStaffing.checkPanel, {
            panelId: panel._id,
          });
    }
    if (!rounds.isDone)
      await ctx.scheduler.runAfter(0, internal.reviewStaffing.dispatch, {
        status: args.status,
        cursor: rounds.continueCursor,
      });
    return null;
  },
});

async function returnToReserve(
  ctx: MutationCtx,
  round: Doc<"reviewRounds">,
  member: Doc<"reviewPanelMembers">,
  now: number,
) {
  const current = await ctx.db
    .query("reviewRoundReserves")
    .withIndex("by_round_person", (q) =>
      q.eq("roundId", round._id).eq("personId", member.personId),
    )
    .unique();
  const fields = {
    status: "available" as const,
    pageCount: (current?.pageCount ?? 0) + 1,
    lastPagedAt: now,
    updatedAt: now,
    version: (current?.version ?? 0) + 1,
  };
  const reserveId =
    current?._id ??
    (await ctx.db.insert("reviewRoundReserves", {
      eventId: round.eventId,
      roundId: round._id,
      personId: member.personId,
      eventAccessSubjectId: member.eventAccessSubjectId,
      ...fields,
      createdAt: now,
    }));
  if (current) await ctx.db.patch(current._id, fields);
  let changed = false;
  for (const permissionKey of [
    "reviewer.device.register",
    "communications.call_consent.manage",
    "reviewer.clock_in",
    "round.read",
  ] as const) {
    const self =
      permissionKey === "reviewer.device.register" ||
      permissionKey === "communications.call_consent.manage";
    const grant = await insertPermissionGrant(ctx, {
      eventId: round.eventId,
      personId: member.personId,
      eventAccessSubjectId: member.eventAccessSubjectId,
      permissionKey,
      scopeType: self ? "self" : "round",
      scopeId: self ? member.eventAccessSubjectId : round._id,
      sourceType: "reserve_assignment",
      sourceId: reserveId,
      grantedByPersonId: round.createdByPersonId,
      reason: "Reviewer returned to the round reserve pool",
    });
    changed ||= grant.created;
  }
  if (changed)
    await advanceAccessVersion(ctx, member.eventAccessSubjectId, now);
}

async function availableReplacement(
  ctx: MutationCtx,
  round: Doc<"reviewRounds">,
  member: Doc<"reviewPanelMembers">,
  now: number,
  excluded: ReadonlySet<Id<"people">> = new Set(),
  teamId?: Id<"teams">,
) {
  const criteria = await Promise.all(
    member.assignedCriterionIds.map((id) => ctx.db.get(id)),
  );
  const requiredCriterionKeys = criteria.map((criterion) => {
    if (!criterion) throw new Error("Seat criterion is missing.");
    return criterion.stableKey;
  });
  const reserves = await ctx.db
    .query("reviewRoundReserves")
    .withIndex("by_round_status", (q) =>
      q.eq("roundId", round._id).eq("status", "available"),
    )
    .take(maximumReviewReservesPerRound + 1);
  if (reserves.length > maximumReviewReservesPerRound)
    throw new Error("Reserve limit exceeded.");
  for (const reserve of reserves) {
    if (reserve.personId === member.personId || excluded.has(reserve.personId))
      continue;
    if (
      await eligibleReserve(ctx, {
        reserve,
        round,
        seat: member,
        requiredCriterionKeys,
        now,
        status: "available",
        ...(teamId ? { teamId } : {}),
      })
    )
      return true;
  }
  return false;
}

export async function checkPanelStaffing(
  ctx: MutationCtx,
  args: { panelId: Id<"reviewPanels"> },
) {
  const panel = await ctx.db.get(args.panelId);
  if (!panel || (panel.status !== "ready" && panel.status !== "needs_reviewer"))
    return null;
  const round = await ctx.db.get(panel.roundId);
  const now = Date.now();
  if (
    !round ||
    !round.staffing.automaticReplacement ||
    !["published", "open"].includes(round.status) ||
    now < round.clockInOpensAt ||
    now >= round.endsAt ||
    (await findActiveRoundPause(ctx, round._id))
  )
    return null;
  const sessions = await Promise.all(
    (["awaiting_presence", "active", "scoring"] as const).map((status) =>
      ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (q) =>
          q.eq("panelId", panel._id).eq("status", status),
        )
        .take(2),
    ),
  );
  // No member leaves until the ongoing review and its scorecards are finished.
  if (sessions[1]?.length || sessions[2]?.length) return null;
  const pending = sessions.at(0)?.at(0);
  if ((sessions[0]?.length ?? 0) > 1)
    throw new Error("Panel has multiple pending reviews.");
  const actor = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_person", (q) =>
      q.eq("eventId", round.eventId).eq("personId", round.createdByPersonId),
    )
    .unique();
  if (!actor || actor.status !== "active") return null;
  const permission = await substituteScope(ctx, {
    eventId: round.eventId,
    eventAccessSubjectId: actor._id,
    panelId: panel._id,
    ...(pending ? { reviewSessionId: pending._id } : {}),
  });
  if (!permission) return null;
  const activeChain = await ctx.db
    .query("reviewerPageChains")
    .withIndex("by_panel_state", (q) =>
      q.eq("panelId", panel._id).eq("state", "active"),
    )
    .unique();
  if (activeChain) return null;
  let missing: Doc<"reviewPanelMembers"> | null = null;
  let reason = "An available replacement is needed before the next review";
  if (panel.status === "ready") {
    const members = await ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_panel_status", (q) =>
        q.eq("panelId", panel._id).eq("status", "active"),
      )
      .take(maximumReviewersPerPanel + 1);
    if (members.length !== round.requiredPanelSize)
      throw new Error("Ready panel has incomplete membership.");
    for (const member of members) {
      const [clockIn, confirmation, presence] = await Promise.all([
        ctx.db
          .query("reviewerClockIns")
          .withIndex("by_round_person", (q) =>
            q.eq("roundId", round._id).eq("reviewerPersonId", member.personId),
          )
          .unique(),
        ctx.db
          .query("reviewerRoundConfirmations")
          .withIndex("by_roundId_and_personId", (q) =>
            q.eq("roundId", round._id).eq("personId", member.personId),
          )
          .unique(),
        pending
          ? ctx.db
              .query("reviewPresence")
              .withIndex("by_session_reviewer", (q) =>
                q
                  .eq("reviewSessionId", pending._id)
                  .eq("reviewerPersonId", member.personId),
              )
              .unique()
          : null,
      ]);
      const confirmed = await reviewerConfirmedForReview(
        ctx,
        round,
        member.personId,
        now,
      );
      const shift = confirmation?.windows.find((window) => window.endsAt > now);
      const reportAt =
        shift && shift.startsAt > round.startsAt
          ? shift.startsAt
          : round.reviewerReportAt;
      const noShow =
        !clockIn && now >= reportAt + round.noShowGraceSeconds * 1000;
      const unavailable =
        Boolean(clockIn && clockIn.status !== "present") ||
        confirmation?.status === "unavailable" ||
        (now >= round.startsAt && !confirmed);
      const didNotArrive = Boolean(
        pending &&
        !presence &&
        now >=
          Math.max(pending.createdAt, member.assignedAt) +
            round.staffing.reviewerArrivalSeconds * 1000,
      );
      let rotate = false;
      if (
        !pending &&
        !noShow &&
        !unavailable &&
        member.seatSeniority === "jc" &&
        round.staffing.juniorRotationReviews > 0
      ) {
        const completed = await ctx.db
          .query("reviewSessions")
          .withIndex("by_panel_status", (q) =>
            q.eq("panelId", panel._id).eq("status", "completed"),
          )
          .order("desc")
          .take(round.staffing.juniorRotationReviews);
        rotate =
          completed.filter(
            (session) => (session.startedAt ?? 0) >= member.assignedAt,
          ).length >= round.staffing.juniorRotationReviews &&
          (await availableReplacement(ctx, round, member, now));
      }
      if (!noShow && !unavailable && !didNotArrive && !rotate) continue;
      reason = rotate
        ? "Scheduled JC rotation after the configured number of reviews"
        : didNotArrive
          ? "Reviewer did not scan at the review within the arrival window"
          : noShow
            ? "Reviewer did not clock in by their confirmed shift deadline"
            : "Reviewer is unavailable for another complete review";
      await vacatePanelSeat(ctx, {
        round,
        panel,
        member,
        clockIn,
        actorPersonId: round.createdByPersonId,
        reason,
        now,
        markAbsent: noShow || didNotArrive,
      });
      await returnToReserve(ctx, round, member, now);
      missing = member;
      break;
    }
  } else {
    missing = await ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_panel_status_ended", (q) =>
        q.eq("panelId", panel._id).eq("status", "removed"),
      )
      .order("desc")
      .first();
  }
  if (!missing) return null;
  const latestChain = await ctx.db
    .query("reviewerPageChains")
    .withIndex("by_panel_created", (q) => q.eq("panelId", panel._id))
    .order("desc")
    .first();
  if (
    latestChain?.missingPanelMemberId === missing._id &&
    latestChain.state === "exhausted"
  ) {
    const pages = await ctx.db
      .query("reviewerPages")
      .withIndex("by_chain_state_rank", (q) =>
        q.eq("pageChainId", latestChain._id),
      )
      .take(maximumReviewReservesPerRound + 1);
    if (pages.length > maximumReviewReservesPerRound)
      throw new Error("Page chain limit exceeded.");
    if (
      await availableReplacement(
        ctx,
        round,
        missing,
        now,
        new Set(pages.map((page) => page.targetPersonId)),
        pending?.teamId,
      )
    ) {
      await ctx.db.patch(latestChain._id, {
        state: "active",
        version: latestChain.version + 1,
        completedAt: undefined,
      });
      await sendNextPage(ctx, latestChain._id, now);
    }
    return null;
  }
  const chainId = await ctx.db.insert("reviewerPageChains", {
    eventId: round.eventId,
    roundId: round._id,
    panelId: panel._id,
    ...(pending ? { reviewSessionId: pending._id } : {}),
    missingPanelMemberId: missing._id,
    requiredCriterionIds: missing.assignedCriterionIds,
    reason,
    responseWindowSeconds: round.substituteResponseSeconds,
    state: "active",
    currentRank: 0,
    version: 1,
    createdByPersonId: round.createdByPersonId,
    pageGrantIds: permission.pageGrantIds,
    assignmentGrantIds: permission.assignmentGrantIds,
    resolvedScopeType: permission.scopeType,
    resolvedScopeId: permission.scopeId,
    createdAt: now,
  });
  const sent = await sendNextPage(ctx, chainId, now);
  await writeAuditEvent(ctx, {
    eventId: round.eventId,
    actorPersonId: round.createdByPersonId,
    permissionKey: "review.substitute.page",
    grantIds: permission.pageGrantIds,
    scopeType: permission.scopeType,
    scopeId: permission.scopeId,
    action: "review.automatic_substitution_started",
    targetType: "review_panel_member",
    targetId: missing._id,
    nextSummary: JSON.stringify({
      chainId,
      pageId: sent?.pageId ?? null,
      staffing: round.staffing,
    }),
    reason,
  });
  return null;
}
export const checkPanel = internalMutation({
  args: { panelId: v.id("reviewPanels") },
  returns: v.null(),
  handler: checkPanelStaffing,
});
