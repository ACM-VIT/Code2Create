import { isRoundReviewer } from "./lib/reviewRoster";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import {
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import { confirmedReviewWindows } from "./lib/reviewConfirmation";
import { maximumReviewRoundsPerEvent } from "./lib/reviewLimits";
import { normalizedText } from "./lib/strings";


const windowInput = v.object({ startsAt: v.number(), endsAt: v.number() });

const responseView = v.object({
  status: v.union(
    v.literal("pending"),
    v.literal("confirmed"),
    v.literal("unavailable"),
  ),
  windows: v.array(windowInput),
  version: v.number(),
  respondedAt: v.optional(v.number()),
});
const roundView = v.object({
  roundId: v.id("reviewRounds"),
  name: v.string(),
  startsAt: v.number(),
  endsAt: v.number(),
  reviewDurationSeconds: v.number(),
  assignmentReminderSeconds: v.number(),
  opensAt: v.number(),
  closesAt: v.number(),
  state: v.union(
    v.literal("scheduled"),
    v.literal("open"),
    v.literal("closed"),
  ),
  response: responseView,
});

export async function createRoundConfirmationRequest(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    roundId: Id<"reviewRounds">;
    opensAt: number;
    closesAt: number;
    personIds: Id<"people">[];
    now: number;
  },
) {
  const requestId = await ctx.db.insert("reviewConfirmationRequests", {
    eventId: args.eventId,
    roundId: args.roundId,
    opensAt: args.opensAt,
    closesAt: args.closesAt,
    state: "scheduled",
    version: 1,
    createdAt: args.now,
  });
  for (const personId of args.personIds) {
    await ctx.db.insert("reviewerRoundConfirmations", {
      eventId: args.eventId,
      roundId: args.roundId,
      personId,
      status: "pending",
      windows: [],
      version: 1,
      updatedAt: args.now,
    });
  }
  await ctx.scheduler.runAt(
    Math.max(args.now, args.opensAt),
    internal.reviewConfirmations.openRequest,
    { requestId },
  );
  await ctx.scheduler.runAt(
    args.closesAt,
    internal.reviewConfirmations.closeRequest,
    { requestId },
  );
}

export const openRequest = internalMutation({
  args: { requestId: v.id("reviewConfirmationRequests") },
  returns: v.null(),
  handler: async (ctx, { requestId }) => {
    const request = await ctx.db.get(requestId);
    if (
      !request ||
      request.state !== "scheduled" ||
      request.opensAt > Date.now()
    )
      return null;
    const round = await ctx.db.get(request.roundId);
    if (
      !round ||
      !["published", "open"].includes(round.status) ||
      round.endsAt <= Date.now() || request.closesAt <= Date.now()
    ) {
      await ctx.db.patch(requestId, {
        state: "closed",
        version: request.version + 1,
      });
      return null;
    }
    await ctx.db.patch(requestId, {
      state: "open",
      version: request.version + 1,
    });
    const confirmations = await ctx.db
      .query("reviewerRoundConfirmations")
      .withIndex("by_roundId_and_personId", (q) => q.eq("roundId", round._id))
      .take(501);
    if (confirmations.length > 500)
      throw new Error("Reviewer pool limit exceeded.");
    for (const confirmation of confirmations) {
      if (confirmation.status !== "pending" || !(await isRoundReviewer(ctx, round._id, confirmation.personId))) continue;
      const notificationId = await ctx.db.insert(
        "reviewConfirmationNotifications",
        {
          confirmationId: confirmation._id,
          purpose: "availability",
          confirmationVersion: confirmation.version,
          state: "pending",
          attempts: 0,
          updatedAt: Date.now(),
        },
      );
      await ctx.scheduler.runAfter(0, internal.reviewConfirmationPush.deliver, {
        notificationId,
      });
    }
    return null;
  },
});

export const closeRequest = internalMutation({
  args: { requestId: v.id("reviewConfirmationRequests") },
  returns: v.null(),
  handler: async (ctx, { requestId }) => {
    const request = await ctx.db.get(requestId);
    if (request && request.state !== "closed" && Date.now() >= request.closesAt) {
      await ctx.db.patch(requestId, {
        state: "closed",
        version: request.version + 1,
      });
    }
    return null;
  },
});

export const mine = query({
  args: { eventSlug: v.string() },
  returns: v.array(roundView),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    await requireEventSubject(ctx, event._id, person._id);
    const confirmations = await ctx.db
      .query("reviewerRoundConfirmations")
      .withIndex("by_eventId_and_personId", (q) =>
        q.eq("eventId", event._id).eq("personId", person._id),
      )
      .take(maximumReviewRoundsPerEvent + 1);
    if (confirmations.length > maximumReviewRoundsPerEvent)
      throw new Error("Reviewer round limit exceeded.");
    const rows = await Promise.all(
      confirmations.map(async (confirmation) => {
        const [round, request] = await Promise.all([
          ctx.db.get(confirmation.roundId),
          ctx.db
            .query("reviewConfirmationRequests")
            .withIndex("by_roundId", (q) =>
              q.eq("roundId", confirmation.roundId),
            )
            .unique(),
        ]);
        if (
          !round ||
          !request ||
          !["published", "open"].includes(round.status) ||
          !(await isRoundReviewer(ctx, round._id, confirmation.personId))
        )
          return null;
        return {
          roundId: round._id,
          name: round.name,
          startsAt: round.startsAt,
          endsAt: round.endsAt,
          reviewDurationSeconds: round.reviewDurationSeconds,
          assignmentReminderSeconds: round.staffing.assignmentReminderSeconds,
          opensAt: request.opensAt,
          closesAt: request.closesAt,
          state: Date.now() >= request.closesAt ? "closed" as const : request.state,
          response: {
            status: confirmation.status,
            windows: confirmation.windows,
            version: confirmation.version,
            ...(confirmation.respondedAt === undefined
              ? {}
              : { respondedAt: confirmation.respondedAt }),
          },
        };
      }),
    );
    return rows
      .filter((row) => row !== null)
      .sort((a, b) => a.startsAt - b.startsAt);
  },
});

const confirmationInput = {
  eventSlug: v.string(),
  roundId: v.id("reviewRounds"),
  windows: v.array(windowInput),
  expectedVersion: v.number(),
  clientOperationId: v.string(),
};

type ConfirmationInput = {
  eventSlug: string;
  roundId: Id<"reviewRounds">;
  windows: { startsAt: number; endsAt: number }[];
  expectedVersion: number;
  clientOperationId: string;
};

export const respond = mutation({
  args: confirmationInput,
  returns: v.object({ version: v.number() }),
  handler: (ctx, args) => recordConfirmation(ctx, args),
});

export const recordForReviewer = mutation({
  args: { ...confirmationInput, reviewerPersonId: v.id("people"), reason: v.string() },
  returns: v.object({ version: v.number() }),
  handler: (ctx, args) => recordConfirmation(ctx, args, {
    reviewerPersonId: args.reviewerPersonId,
    reason: args.reason,
  }),
});

async function recordConfirmation(
  ctx: MutationCtx,
  args: ConfirmationInput,
  organizer?: { reviewerPersonId: Id<"people">; reason: string },
): Promise<{ version: number }> {
  const event = await requireEventBySlug(ctx, args.eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const reviewerPersonId = organizer?.reviewerPersonId ?? person._id;
  const reason = organizer
    ? normalizedText(organizer.reason, "Reason", 3, 300)
    : "Reviewer confirmed their actual hours in the app.";
  const commandName = organizer ? "reviewer.round.confirm_for_reviewer" : "reviewer.round.confirm";
  const fingerprint = operationFingerprint([
    args.roundId,
    args.expectedVersion,
    JSON.stringify(args.windows),
    ...(organizer ? [reviewerPersonId, reason] : []),
  ]);
  const prior = await findOperation(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    clientOperationId: args.clientOperationId,
    commandName,
    requestFingerprint: fingerprint,
  });
  if (prior)
    return {
      version: storedOperationVersion(
        prior.resultJson,
        "review confirmation",
      ),
    };
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    ...(organizer
      ? { permissionKey: "review.configuration.publish", scopeType: "event" }
      : { permissionKey: "reviewer.clock_in", scopeType: "round", scopeId: args.roundId }),
  });
  if (organizer) {
    const reviewer = await ctx.db.get(reviewerPersonId);
    if (!reviewer || reviewer.status !== "active") {
      throw new ConvexError({ code: "REVIEWER_INACTIVE", message: "Choose an active reviewer." });
    }
    const reviewerSubject = await requireEventSubject(ctx, event._id, reviewerPersonId);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: reviewerSubject._id,
      permissionKey: "reviewer.clock_in",
      scopeType: "round",
      scopeId: args.roundId,
    });
  }
  const [round, request, confirmation] = await Promise.all([
    ctx.db.get(args.roundId),
    ctx.db
      .query("reviewConfirmationRequests")
      .withIndex("by_roundId", (q) => q.eq("roundId", args.roundId))
      .unique(),
    ctx.db
      .query("reviewerRoundConfirmations")
      .withIndex("by_roundId_and_personId", (q) =>
        q.eq("roundId", args.roundId).eq("personId", reviewerPersonId),
      )
      .unique(),
  ]);
  if (!(await isRoundReviewer(ctx, args.roundId, reviewerPersonId))) throw new ConvexError({ code: "REVIEWER_NOT_ROSTERED", message: "You are not on this round's reviewer roster." });
  const now = Date.now();
  if (
    !round ||
    round.eventId !== event._id ||
    !["published", "open"].includes(round.status) ||
    !request ||
    (!organizer && (request.state === "closed" || request.opensAt > now || request.closesAt <= now)) ||
    round.endsAt <= now ||
    !confirmation
  ) {
    throw new ConvexError({
      code: "CONFIRMATION_NOT_OPEN",
      message: "Availability confirmation is not open for this round.",
    });
  }
  if (confirmation.version !== args.expectedVersion) {
    throw new ConvexError({
      code: "CONFIRMATION_CHANGED",
      message: "Your availability changed. Refresh before saving.",
    });
  }
  const windows = confirmedReviewWindows(args.windows, round);
  const assignments = await ctx.db
    .query("reviewAssignments")
    .withIndex("by_event_person_status", (q) =>
      q
        .eq("eventId", event._id)
        .eq("reviewerPersonId", reviewerPersonId)
        .eq("status", "assigned"),
    )
    .take(101);
  if (assignments.length > 100)
    throw new Error("Reviewer assignment limit exceeded.");
  for (const assignment of assignments.filter(
    (assignment) => assignment.roundId === round._id,
  )) {
    const session = await ctx.db.get(assignment.reviewSessionId);
    if (
      session &&
      (session.status === "active" || session.status === "scoring")
    )
      throw new ConvexError({
        code: "ACTIVE_REVIEW_ASSIGNED",
        message: "Finish your active review before changing availability.",
      });
  }
  if (windows.length > 0 && !windows.some((window) => window.endsAt > now)) {
    throw new ConvexError({
      code: "AVAILABILITY_ENDED",
      message: "Choose availability that has not already ended.",
    });
  }
  const status =
    windows.length === 0 ? ("unavailable" as const) : ("confirmed" as const);
  const version = confirmation.version + 1;
  await ctx.db.patch(confirmation._id, {
    status,
    windows,
    version,
    respondedAt: now,
    updatedAt: now,
  });
  await recordOperation(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    clientOperationId: args.clientOperationId,
    commandName,
    requestFingerprint: fingerprint,
    targetType: "reviewer_round_confirmation",
    targetId: confirmation._id,
    resultJson: String(version),
    createdAt: now,
  });
  await writeAuditEvent(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    grantIds,
    ...(organizer
      ? { permissionKey: "review.configuration.publish", scopeType: "event" }
      : { permissionKey: "reviewer.clock_in", scopeType: "round", scopeId: round._id }),
    action: organizer ? "reviewer.round_confirmation_recorded_by_organizer" : "reviewer.round_confirmed",
    targetType: "reviewer_round_confirmation",
    targetId: confirmation._id,
    previousSummary: JSON.stringify({
      status: confirmation.status,
      windows: confirmation.windows,
    }),
    nextSummary: JSON.stringify({ reviewerPersonId, status, windows }),
    reason,
  });
  return { version };
}

export const reschedule = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    opensAt: v.number(),
  closesAt: v.number(),
    expectedVersion: v.number(),
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
      args.opensAt,
      args.closesAt,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.confirmation.reschedule",
      requestFingerprint,
    });
    if (prior)
      return {
        version: storedOperationVersion(
          prior.resultJson,
          "confirmation schedule",
        ),
      };
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.publish",
      scopeType: "event",
    });
    const [round, request] = await Promise.all([
      ctx.db.get(args.roundId),
      ctx.db
        .query("reviewConfirmationRequests")
        .withIndex("by_roundId", (q) => q.eq("roundId", args.roundId))
        .unique(),
    ]);
    const now = Date.now();
    if (
      !round ||
      round.eventId !== event._id ||
      !request ||
      request.eventId !== event._id
    ) {
      throw new ConvexError({
        code: "ROUND_NOT_FOUND",
        message: "That review round is unavailable.",
      });
    }
    if (request.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "CONFIRMATION_CHANGED",
        message: "The confirmation schedule changed. Refresh before saving.",
      });
    }
    if (
      ((request.state !== "scheduled" || request.opensAt <= now) && args.opensAt !== request.opensAt) ||
      !["published", "open"].includes(round.status)
    ) {
      throw new ConvexError({
        code: "CONFIRMATION_ALREADY_OPEN",
        message: "Keep the original opening time when extending or reopening confirmations.",
      });
    }
    if (
      !Number.isSafeInteger(args.opensAt) ||
      args.opensAt > round.reviewerReportAt ||
      !Number.isSafeInteger(args.closesAt) ||
      args.closesAt <= Math.max(now, args.opensAt) ||
      args.closesAt > round.endsAt
    ) {
      throw new ConvexError({
        code: "INVALID_CONFIRMATION_TIME",
        message:
          "Confirmation must open by the reviewer report time and close later, within the round. The closing time must be in the future.",
      });
    }
    const version = request.version + 1;
    await ctx.db.patch(request._id, {
      opensAt: args.opensAt,
      closesAt: args.closesAt,
      // The first opening must pass through openRequest to enqueue notifications.
      state: request.state === "scheduled" ? "scheduled" : "open",
      version,
    });
    await ctx.scheduler.runAt(args.closesAt, internal.reviewConfirmations.closeRequest, { requestId: request._id });
    await ctx.scheduler.runAt(
      Math.max(now, args.opensAt),
      internal.reviewConfirmations.openRequest,
      {
        requestId: request._id,
      },
    );
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.confirmation.reschedule",
      requestFingerprint,
      targetType: "review_confirmation_request",
      targetId: request._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.configuration.publish",
      grantIds,
      scopeType: "event",
      action: "review.confirmation_rescheduled",
      targetType: "review_confirmation_request",
      targetId: request._id,
      previousSummary: JSON.stringify({
        opensAt: request.opensAt,
        closesAt: request.closesAt,
        version: request.version,
      }),
      nextSummary: JSON.stringify({ opensAt: args.opensAt, closesAt: args.closesAt, version }),
      reason,
    });
    return { version };
  },
});

export const overview = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.object({
    opensAt: v.number(),
  closesAt: v.number(),
    state: v.string(),
    version: v.number(),
    canConfigure: v.boolean(),
    people: v.array(
      v.object({
        personId: v.id("people"),
        displayName: v.string(),
        response: responseView,
      }),
    ),
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
    const request = await ctx.db
      .query("reviewConfirmationRequests")
      .withIndex("by_roundId", (q) => q.eq("roundId", args.roundId))
      .unique();
    if (!request || request.eventId !== event._id)
      throw new ConvexError({
        code: "CONFIRMATION_REQUEST_MISSING",
        message: "No availability request exists for this round.",
      });
    const confirmations = await ctx.db
      .query("reviewerRoundConfirmations")
      .withIndex("by_roundId_and_personId", (q) =>
        q.eq("roundId", args.roundId),
      )
      .take(501);
    if (confirmations.length > 500)
      throw new Error("Reviewer pool limit exceeded.");
    const configureGrants = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.publish",
      scopeType: "event",
    });
    const people = await Promise.all(
      confirmations.map(async (response) => {
        if (!(await isRoundReviewer(ctx, args.roundId, response.personId))) return null;
        const reviewer = await ctx.db.get(response.personId);
        if (!reviewer) throw new Error("Confirmed reviewer is missing.");
        return {
          personId: reviewer._id,
          displayName: reviewer.displayName,
          response: {
            status: response.status,
            windows: response.windows,
            version: response.version,
            ...(response.respondedAt === undefined
              ? {}
              : { respondedAt: response.respondedAt }),
          },
        };
      }),
    );
    return {
      opensAt: request.opensAt,
      closesAt: request.closesAt,
      state: Date.now() >= request.closesAt ? "closed" : request.state,
      version: request.version,
      canConfigure: configureGrants.length > 0,
      people: people.filter(p => p !== null).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
  },
});
