import type { OperationsAutonomyCancellationReason } from "@code2create/domain";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { cancelAutonomyRun } from "./operationsAutonomyCancellation";

const inboxCancellationPageSize = 32;

/**
 * Revokes the currently executable run for one policy. Pending inbox rows are
 * invalidated by the scheduler lifecycle itself and can be cleaned in pages.
 */
export async function revokeOperationsAutonomyPolicy(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    policyVersionId: Id<"operationsAutonomyPolicyVersions">;
    reason: OperationsAutonomyCancellationReason;
    now: number;
  },
) {
  const active = await ctx.db
    .query("operationsAutonomyRuns")
    .withIndex("by_event_policy_lifecycle", (index) =>
      index
        .eq("eventId", args.eventId)
        .eq("policyVersionId", args.policyVersionId)
        .eq("lifecycle.kind", "active"),
    )
    .take(2);
  if (active.length > 1) throw new Error("An event policy has multiple active autonomy runs.");
  if (active[0]) {
    await cancelAutonomyRun(ctx, { runId: active[0]._id, reason: args.reason, now: args.now });
  }
  const state = await ctx.db
    .query("operationsAutonomyStates")
    .withIndex("by_policy", (index) => index.eq("policyVersionId", args.policyVersionId))
    .unique();
  if (!state || state.eventId !== args.eventId) {
    throw new Error("The revoked autonomy policy scheduler is missing.");
  }
  await ctx.db.patch(state._id, {
    pendingCancellationAt: args.now,
    updatedAt: args.now,
    version: state.version + 1,
  });
  const pending = await ctx.db
    .query("operationsAutonomyInbox")
    .withIndex("by_policy_lifecycle", (index) =>
      index.eq("policyVersionId", args.policyVersionId).eq("lifecycle.kind", "pending"),
    )
    .take(inboxCancellationPageSize);
  for (const item of pending) {
    await ctx.db.patch(item._id, {
      lifecycle: { kind: "canceled", canceledAt: args.now },
      updatedAt: args.now,
    });
  }
  await ctx.db.patch(state._id, {
    pendingWorkCount: Math.max(0, state.pendingWorkCount - pending.length),
  });
  return active[0]?._id ?? null;
}

export async function cancelPendingAutonomyInboxPage(
  ctx: MutationCtx,
  args: {
    policyVersionId: Id<"operationsAutonomyPolicyVersions">;
    now: number;
  },
) {
  const state = await ctx.db
    .query("operationsAutonomyStates")
    .withIndex("by_policy", (index) => index.eq("policyVersionId", args.policyVersionId))
    .unique();
  if (!state || state.pendingCancellationAt === undefined) return false;
  const pending = await ctx.db
    .query("operationsAutonomyInbox")
    .withIndex("by_policy_lifecycle", (index) =>
      index.eq("policyVersionId", args.policyVersionId).eq("lifecycle.kind", "pending"),
    )
    .take(inboxCancellationPageSize);
  for (const item of pending) {
    await ctx.db.patch(item._id, {
      lifecycle: { kind: "canceled", canceledAt: state.pendingCancellationAt },
      updatedAt: args.now,
    });
  }
  const hasMore = await ctx.db
    .query("operationsAutonomyInbox")
    .withIndex("by_policy_lifecycle", (index) =>
      index.eq("policyVersionId", args.policyVersionId).eq("lifecycle.kind", "pending"),
    )
    .first();
  await ctx.db.patch(state._id, {
    pendingWorkCount: Math.max(0, state.pendingWorkCount - pending.length),
    ...(hasMore ? {} : { pendingCancellationAt: undefined, pendingWorkCount: 0 }),
    updatedAt: args.now,
    version: state.version + 1,
  });
  return hasMore !== null;
}

/**
 * Revokes autonomy in the same transaction that makes an event non-live.
 * The event transition is an authority boundary, so the scheduler must stop
 * and the Worker abort intent must exist before that transition is visible.
 */
export async function revokeOperationsAutonomyForEventClosure(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    actorPersonId: Id<"people">;
    reason: string;
    now: number;
  },
) {
  const policy = await ctx.db
    .query("operationsAutonomyPolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.eventId).eq("status", "published"),
    )
    .unique();
  if (!policy) {
    throw new Error("The event must have a published autonomy policy before it can close.");
  }
  const state = await ctx.db
    .query("operationsAutonomyStates")
    .withIndex("by_policy", (index) => index.eq("policyVersionId", policy._id))
    .unique();
  if (!state || state.eventId !== args.eventId || state.lifecycle.kind === "superseded") {
    throw new Error("The event's autonomy scheduler state is invalid.");
  }
  await revokeOperationsAutonomyPolicy(ctx, {
    eventId: args.eventId,
    policyVersionId: policy._id,
    reason: "event_not_live",
    now: args.now,
  });
  const revoked = await ctx.db.get(state._id);
  if (!revoked || revoked.lifecycle.kind === "superseded") {
    throw new Error("The event's revoked autonomy scheduler state is invalid.");
  }
  if (revoked.lifecycle.kind === "active") {
    await ctx.db.patch(revoked._id, {
      lifecycle: {
        kind: "disabled",
        disabledAt: args.now,
        disabledByPersonId: args.actorPersonId,
        reason: args.reason,
      },
      updatedAt: args.now,
    });
  }
}
