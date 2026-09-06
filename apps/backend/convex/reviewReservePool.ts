import type { Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  matchingPermissionGrantIds,
  requirePermission,
  revokeSourceGrants,
} from "./lib/permissions";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { writeAuditEvent } from "./lib/audit";
import { normalizedText } from "./lib/strings";
import { putInRoundReserve } from "./lib/reviewRoster";
import { reviewerParticipation } from "./lib/reviewerParticipation";
import { reviewRoundReserveStatus } from "./values";

export const candidates = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.union(
    v.null(),
    v.object({
      canEdit: v.boolean(),
      reviewers: v.array(
        v.object({
          personId: v.id("people"),
          name: v.string(),
          seniority: v.union(
            v.literal("board"),
            v.literal("sc"),
            v.literal("jc"),
          ),

          canAdd: v.boolean(),
          seated: v.boolean(),
          reserveStatus: v.union(v.null(), reviewRoundReserveStatus),
          reserveVersion: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grants = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.publish",
      scopeType: "event",
    });
    if (!grants.length) return null;
    const round = await ctx.db.get(args.roundId);
    if (!round || round.eventId !== event._id)
      throw new ConvexError({
        code: "ROUND_NOT_FOUND",
        message: "That review round is unavailable.",
      });
    const [profiles, reserves, members] = await Promise.all([
      ctx.db
        .query("reviewerProfiles")
        .withIndex("by_event_person", (q) => q.eq("eventId", event._id))
        .take(501),
      ctx.db
        .query("reviewRoundReserves")
        .withIndex("by_round_person", (q) => q.eq("roundId", round._id))
        .take(501),
      ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_round_person_status", (q) => q.eq("roundId", round._id))
        .collect(),
    ]);
    if (profiles.length > 500 || reserves.length > 500)
      throw new Error("Reviewer pool limit exceeded.");
    const seated = new Set(
      members.filter((m) => m.status === "active").map((m) => m.personId),
    );
    const rows = await Promise.all(
      profiles.map(async (profile) => {
        const [account, access] = await Promise.all([
          ctx.db.get(profile.personId),
          ctx.db
            .query("eventAccessSubjects")
            .withIndex("by_event_person", (q) =>
              q.eq("eventId", event._id).eq("personId", profile.personId),
            )
            .unique(),
        ]);
        if (!account || !access) return null;
        const reserve = reserves.find((r) => r.personId === profile.personId);
        return {
          personId: profile.personId,
          name: access.displayName,
          seniority: profile.seniority,

          canAdd:
            account.status === "active" &&
            access.status === "active" &&
            profile.status === "active",
          seated: seated.has(profile.personId),
          reserveStatus: reserve?.status ?? null,
          reserveVersion: reserve?.version ?? 0,
        };
      }),
    );
    return {
      canEdit: ["published", "open"].includes(round.status),
      reviewers: rows
        .filter((r) => r !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

export const setMembership = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    personId: v.id("people"),
    included: v.boolean(),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person: actor } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, actor._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.publish",
      scopeType: "event",
    });
    const reason = normalizedText(args.reason, "Roster change reason", 5, 500);
    const operation = {
      eventId: event._id,
      actorPersonId: actor._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.reserve.membership",
      requestFingerprint: operationFingerprint([
        args.roundId,
        args.personId,
        args.included,
        args.expectedVersion,
        reason,
      ]),
    };
    const prior = await findOperation(ctx, operation);
    if (prior)
      return {
        version: storedOperationVersion(prior.resultJson, "reserve membership"),
      };
    const [round, account, access, profile, reserve, seat, participation] =
      await Promise.all([
        ctx.db.get(args.roundId),
        ctx.db.get(args.personId),
        ctx.db
          .query("eventAccessSubjects")
          .withIndex("by_event_person", (q) =>
            q.eq("eventId", event._id).eq("personId", args.personId),
          )
          .unique(),
        ctx.db
          .query("reviewerProfiles")
          .withIndex("by_event_person", (q) =>
            q.eq("eventId", event._id).eq("personId", args.personId),
          )
          .unique(),
        ctx.db
          .query("reviewRoundReserves")
          .withIndex("by_round_person", (q) =>
            q.eq("roundId", args.roundId).eq("personId", args.personId),
          )
          .unique(),
        ctx.db
          .query("reviewPanelMembers")
          .withIndex("by_round_person_status", (q) =>
            q
              .eq("roundId", args.roundId)
              .eq("personId", args.personId)
              .eq("status", "active"),
          )
          .first(),
        reviewerParticipation(ctx, event._id, args.personId),
      ]);
    if (
      !round ||
      round.eventId !== event._id ||
      !["published", "open"].includes(round.status)
    )
      throw new ConvexError({
        code: "ROUND_NOT_FOUND",
        message: "Edit the roster of a published or open round.",
      });
    if ((reserve?.version ?? 0) !== args.expectedVersion)
      throw new ConvexError({
        code: "ROSTER_CHANGED",
        message: "The reserve roster changed. Refresh before continuing.",
      });
    if (seat || reserve?.status === "paged" || participation.hasLiveReview)
      throw new ConvexError({
        code: "REVIEWER_BUSY",
        message:
          "Move this reviewer off their panel first, and wait for any live review or pending page to finish.",
      });
    if (
      args.included &&
      (!account ||
        account.status !== "active" ||
        !access ||
        access.status !== "active" ||
        !profile ||
        profile.status !== "active")
    )
      throw new ConvexError({
        code: "REVIEWER_NOT_READY",
        message:
          "Set up an active, active reviewer profile before adding this person.",
      });
    const now = Date.now();
    let result: { version: number };
    let reserveId: Id<"reviewRoundReserves">;
    if (args.included) {
      if (!access) throw new Error("Validated reviewer access is missing.");
      const added = await putInRoundReserve(ctx, {
        round,
        personId: args.personId,
        subjectId: access._id,
        actorId: actor._id,
        reason,
        now,
      });
      reserveId = added.reserveId;
      result = { version: added.version };
    } else {
      if (!reserve || reserve.status !== "available")
        throw new ConvexError({
          code: "RESERVE_UNAVAILABLE",
          message:
            "This reviewer is not currently available in the reserve pool.",
        });
      reserveId = reserve._id;
      result = { version: reserve.version + 1 };
      await ctx.db.patch(reserve._id, {
        status: "removed",
        version: result.version,
        updatedAt: now,
      });
      await revokeSourceGrants(ctx, {
        eventId: event._id,
        sourceType: "reserve_assignment",
        sourceId: reserve._id,
        revokedByPersonId: actor._id,
        reason,
      });
      const clockIn = await ctx.db
        .query("reviewerClockIns")
        .withIndex("by_round_person", (q) =>
          q.eq("roundId", round._id).eq("reviewerPersonId", args.personId),
        )
        .unique();
      if (clockIn && clockIn.status !== "clocked_out")
        await ctx.db.patch(clockIn._id, {
          status: "clocked_out",
          clockedOutAt: now,
          expectedReturnAt: undefined,
          unavailableReason: undefined,
          version: clockIn.version + 1,
        });
    }
    await recordOperation(ctx, {
      ...operation,
      targetType: "review_round_reserve",
      targetId: reserveId,
      resultJson: String(result.version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: actor._id,
      permissionKey: "review.configuration.publish",
      grantIds,
      scopeType: "event",
      action: "review.reserve_membership_changed",
      targetType: "review_round_reserve",
      targetId: reserveId,
      previousSummary: JSON.stringify({
        status: reserve?.status ?? null,
        version: args.expectedVersion,
      }),
      nextSummary: JSON.stringify({
        personId: args.personId,
        roundId: round._id,
        status: args.included ? "available" : "removed",
        version: result.version,
      }),
      reason,
    });
    return result;
  },
});
