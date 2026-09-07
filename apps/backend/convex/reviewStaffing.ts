import { ConvexError, v } from "convex/values";
import {mutation, query} from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {matchingPermissionGrantIds, requirePermission} from "./lib/permissions";
import { reviewerConfirmedForReview } from "./lib/reviewConfirmation";
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
    return {
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
        const [reviewer, participation, seat, reserve] =
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

