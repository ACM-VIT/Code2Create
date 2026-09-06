import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { advanceAccessVersion } from "./accessVersion";
import { insertPermissionGrant } from "./permissions";
import { scheduleShiftReminders } from "./reviewConfirmation";

export async function isRoundReviewer(
  ctx: QueryCtx | MutationCtx,
  roundId: Id<"reviewRounds">,
  personId: Id<"people">,
) {
  const [seat, reserve] = await Promise.all([
    ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_round_person_status", (q) =>
        q
          .eq("roundId", roundId)
          .eq("personId", personId)
          .eq("status", "active"),
      )
      .first(),
    ctx.db
      .query("reviewRoundReserves")
      .withIndex("by_round_person", (q) =>
        q.eq("roundId", roundId).eq("personId", personId),
      )
      .unique(),
  ]);
  return (
    !!seat || (!!reserve && ["available", "paged"].includes(reserve.status))
  );
}

/** Planning changes preserve responses; a newly added person must answer for themselves. */
export async function ensureRoundConfirmation(
  ctx: MutationCtx,
  round: Doc<"reviewRounds">,
  personId: Id<"people">,
  now: number,
) {
  const existing = await ctx.db
    .query("reviewerRoundConfirmations")
    .withIndex("by_roundId_and_personId", (q) =>
      q.eq("roundId", round._id).eq("personId", personId),
    )
    .unique();
  if (existing?.status === "confirmed") {
    await scheduleShiftReminders(ctx, existing, round, now);
    return;
  }
  if (existing?.status === "unavailable") return;
  const confirmationId =
    existing?._id ??
    (await ctx.db.insert("reviewerRoundConfirmations", {
      eventId: round.eventId,
      roundId: round._id,
      personId,
      status: "pending",
      windows: [],
      version: 1,
      updatedAt: now,
    }));
  const request = await ctx.db
    .query("reviewConfirmationRequests")
    .withIndex("by_roundId", (q) => q.eq("roundId", round._id))
    .unique();
  if (
    request?.state === "open" &&
    request.opensAt <= now &&
    now < request.closesAt
  ) {
    const prior = await ctx.db
      .query("reviewConfirmationNotifications")
      .withIndex("by_confirmation_purpose_shift", (q) =>
        q.eq("confirmationId", confirmationId).eq("purpose", "availability"),
      )
      .order("desc")
      .first();
    if (prior && ["pending", "sending", "sent"].includes(prior.state)) return;
    const notificationId = await ctx.db.insert(
      "reviewConfirmationNotifications",
      {
        confirmationId,
        purpose: "availability",
        confirmationVersion: existing?.version ?? 1,
        state: "pending",
        attempts: 0,
        updatedAt: now,
      },
    );
    await ctx.scheduler.runAfter(0, internal.reviewConfirmationPush.deliver, {
      notificationId,
    });
  }
}

/** Manual roster edits do not count as pages or completed reviews. */
export async function putInRoundReserve(
  ctx: MutationCtx,
  args: {
    round: Doc<"reviewRounds">;
    personId: Id<"people">;
    subjectId: Id<"eventAccessSubjects">;
    actorId: Id<"people">;
    reason: string;
    now: number;
  },
) {
  const { round, personId, subjectId, actorId, reason, now } = args;
  const reserves = await ctx.db
    .query("reviewRoundReserves")
    .withIndex("by_round_person", (q) => q.eq("roundId", round._id))
    .take(501);
  const members = await ctx.db
    .query("reviewPanelMembers")
    .withIndex("by_round_person_status", (q) => q.eq("roundId", round._id))
    .collect();
  const current = reserves.find((r) => r.personId === personId);
  if (current?.status === "paged")
    throw new ConvexError({
      code: "SUBSTITUTE_PAGE_ACTIVE",
      message:
        "This reviewer has a pending page. Wait for its response before changing the roster.",
    });
  const pool = new Set([
    ...members.filter((m) => m.status === "active").map((m) => m.personId),
    ...reserves
      .filter((r) => ["available", "paged"].includes(r.status))
      .map((r) => r.personId),
    personId,
  ]);
  if (
    reserves.length > 500 ||
    pool.size > (round.staffing.automaticReplacement ? 100 : 500) ||
    reserves.filter(
      (r) =>
        r.personId !== personId && ["available", "paged"].includes(r.status),
    ).length >= 100
  )
    throw new ConvexError({
      code: "REVIEWER_POOL_TOO_LARGE",
      message: "This round has reached its reviewer pool limit.",
    });
  const fields = {
    status: "available" as const,
    version: (current?.version ?? 0) + 1,
    updatedAt: now,
  };
  const reserveId =
    current?._id ??
    (await ctx.db.insert("reviewRoundReserves", {
      eventId: round.eventId,
      roundId: round._id,
      personId,
      eventAccessSubjectId: subjectId,
      pageCount: 0,
      createdAt: now,
      ...fields,
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
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey,
      scopeType: self ? "self" : "round",
      scopeId: self ? subjectId : round._id,
      sourceType: "reserve_assignment",
      sourceId: reserveId,
      grantedByPersonId: actorId,
      reason,
    });
    changed ||= grant.created;
  }
  if (changed) await advanceAccessVersion(ctx, subjectId, now);
  await ensureRoundConfirmation(ctx, round, personId, now);
  return { reserveId, version: fields.version };
}
