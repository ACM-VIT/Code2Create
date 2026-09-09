import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { normalizedText } from "./lib/strings";
import { writeAuditEvent } from "./lib/audit";
import {
  maximumReviewPanelsPerRound,
  maximumReviewRoundsPerEvent,
} from "./lib/reviewLimits";

import { isRoundReviewer } from "./lib/reviewRoster";

export const settings = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.object({
    version: v.number(),
    startsAt: v.number(),
    endsAt: v.number(),
    canExtend: v.boolean(),
    confirmedThroughEnd: v.number(),
    confirmedReviewers: v.number(),
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
        message: "Round unavailable.",
      });
    const grants = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.manage",
      scopeType: "round",
      scopeId: round._id,
    });
    const confirmations = await ctx.db
      .query("reviewerRoundConfirmations")
      .withIndex("by_roundId_and_personId", (q) => q.eq("roundId", round._id))
      .take(501);
    if (confirmations.length > 500)
      throw new Error("Reviewer pool limit exceeded.");
    const current = await Promise.all(
      confirmations.map(async (c) =>
        c.status === "confirmed" &&
        (await isRoundReviewer(ctx, round._id, c.personId))
          ? c
          : null,
      ),
    );
    const confirmed = current.filter((c) => c !== null);
    return {
      version: round.version,
      startsAt: round.startsAt,
      endsAt: round.endsAt,
      canExtend:
        grants.length > 0 && ["published", "open"].includes(round.status),
      confirmedReviewers: confirmed.length,
      confirmedThroughEnd: confirmed.filter((c) =>
        c.windows.some((w) => w.endsAt >= round.endsAt),
      ).length,
    };
  },
});

export const extend = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    endsAt: v.number(),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.manage",
      scopeType: "round",
      scopeId: args.roundId,
    });
    const reason = normalizedText(args.reason, "Reason", 5, 500);
    const operation = {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round.extend",
      requestFingerprint: operationFingerprint([
        args.roundId,
        args.endsAt,
        args.expectedVersion,
        reason,
      ]),
    };
    const prior = await findOperation(ctx, operation);
    if (prior)
      return {
        version: storedOperationVersion(prior.resultJson, "round extension"),
      };
    const round = await ctx.db.get(args.roundId);
    if (
      !round ||
      round.eventId !== event._id ||
      round.version !== args.expectedVersion ||
      !["published", "open"].includes(round.status)
    )
      throw new ConvexError({
        code: "ROUND_CHANGED",
        message: "Only the current published or open round can be extended.",
      });
    if (
      !Number.isSafeInteger(args.endsAt) ||
      args.endsAt <= Math.max(Date.now(), round.endsAt) ||
      args.endsAt - round.startsAt > 24 * 3_600_000
    )
      throw new ConvexError({
        code: "INVALID_ROUND_END",
        message: "Choose a later finish within 24 hours of this round's start.",
      });
    const rounds = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_status_start", (q) => q.eq("eventId", event._id))
      .take(maximumReviewRoundsPerEvent + 1);
    if (rounds.length > maximumReviewRoundsPerEvent)
      throw new Error("Review round limit exceeded.");
    const overlap = rounds.find(
      (r) =>
        r._id !== round._id &&
        ["published", "open"].includes(r.status) &&
        r.startsAt < args.endsAt &&
        r.endsAt > round.endsAt,
    );
    if (overlap)
      throw new ConvexError({
        code: "ROUND_OVERLAP",
        message: `The extension overlaps ${overlap.name}. Adjust that round first.`,
      });
    const version = round.version + 1;
    const now = Date.now();
    await ctx.db.patch(round._id, {
      endsAt: args.endsAt,
      version,
      correctionRequestsCloseAt: Math.max(
        round.correctionRequestsCloseAt,
        args.endsAt + (round.correctionRequestsCloseAt - round.endsAt),
      ),
      configurationChecksum: operationFingerprint([
        round.configurationChecksum,
        "endsAt",
        args.endsAt,
      ]),
    });
    const request = await ctx.db
      .query("reviewConfirmationRequests")
      .withIndex("by_roundId", (q) => q.eq("roundId", round._id))
      .unique();
    // A reviewer who confirmed through the round's end stays confirmed through the new end;
    // anyone who confirmed shorter hours keeps them and can extend in the app.
    const confirmations = await ctx.db
      .query("reviewerRoundConfirmations")
      .withIndex("by_roundId_and_personId", (q) => q.eq("roundId", round._id))
      .take(501);
    if (confirmations.length > 500) throw new Error("Reviewer confirmation limit exceeded.");
    for (const confirmation of confirmations) {
      if (confirmation.status !== "confirmed") continue;
      if (!confirmation.windows.some((window) => window.endsAt === round.endsAt)) continue;
      await ctx.db.patch(confirmation._id, {
        windows: confirmation.windows.map((window) =>
          window.endsAt === round.endsAt ? { ...window, endsAt: args.endsAt } : window,
        ),
        version: confirmation.version + 1,
        updatedAt: now,
      });
    }
    if (request && request.opensAt <= now) {
      await ctx.db.patch(request._id, {
        closesAt: args.endsAt,
        // The first opening must pass through openRequest to enqueue notifications.
        state: request.state === "scheduled" ? "scheduled" : "open",
        version: request.version + 1,
      });
      await ctx.scheduler.runAt(
        args.endsAt,
        internal.reviewConfirmations.closeRequest,
        { requestId: request._id },
      );
    }
    const panels = await ctx.db
      .query("reviewPanels")
      .withIndex("by_round_status", (q) => q.eq("roundId", round._id))
      .take(maximumReviewPanelsPerRound + 1);
    if (panels.length > maximumReviewPanelsPerRound)
      throw new Error("Panel limit exceeded.");
    for (const panel of panels)
      if (panel.status !== "closed")
        await ctx.scheduler.runAfter(
          0,
          internal.reviewQueueAutomation.advance,
          { panelId: panel._id },
        );
    await recordOperation(ctx, {
      ...operation,
      targetType: "review_round",
      targetId: round._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "round.manage",
      grantIds,
      scopeType: "round",
      scopeId: round._id,
      action: "review.round_extended",
      targetType: "review_round",
      targetId: round._id,
      previousSummary: JSON.stringify({
        endsAt: round.endsAt,
        version: round.version,
      }),
      nextSummary: JSON.stringify({ endsAt: args.endsAt, version }),
      reason,
    });
    return { version };
  },
});
