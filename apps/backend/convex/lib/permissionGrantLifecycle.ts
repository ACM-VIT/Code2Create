import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { advanceAccessVersion } from "./accessVersion";

export const permissionGrantLifecycleBatchSize = 128;

type LifecycleResult = "activated" | "expired" | "unchanged";

function nextLifecycleState(grant: Doc<"permissionGrants">, now: number): LifecycleResult {
  if (grant.status === "scheduled" && grant.validFrom <= now) {
    return grant.validUntil !== undefined && grant.validUntil <= now ? "expired" : "activated";
  }
  if (grant.status === "active" && grant.validUntil !== undefined && grant.validUntil <= now) {
    return "expired";
  }
  return "unchanged";
}

async function applyLifecycleState(
  ctx: MutationCtx,
  grant: Doc<"permissionGrants">,
  result: Exclude<LifecycleResult, "unchanged">,
  now: number,
) {
  if (result === "activated") {
    await ctx.db.patch("permissionGrants", grant._id, {
      status: "active",
      activatedAt: now,
    });
    return;
  }
  await ctx.db.patch("permissionGrants", grant._id, {
    status: "expired",
    expiredAt: now,
  });
}

export async function transitionPermissionGrant(
  ctx: MutationCtx,
  args: { grantId: Id<"permissionGrants">; now: number },
): Promise<LifecycleResult> {
  const grant = await ctx.db.get(args.grantId);
  if (!grant) return "unchanged";
  const result = nextLifecycleState(grant, args.now);
  if (result === "unchanged") return result;
  await applyLifecycleState(ctx, grant, result, args.now);
  await advanceAccessVersion(ctx, grant.eventAccessSubjectId, args.now);
  return result;
}

export async function sweepPermissionGrantLifecycle(
  ctx: MutationCtx,
  args: { now: number; limit: number },
) {
  if (
    !Number.isSafeInteger(args.limit) ||
    args.limit < 1 ||
    args.limit > permissionGrantLifecycleBatchSize
  ) {
    throw new Error("Permission lifecycle sweep limit is outside its supported bound.");
  }
  const [scheduledRows, activeRows] = await Promise.all([
    ctx.db
      .query("permissionGrants")
      .withIndex("by_status_valid_from", (query) =>
        query.eq("status", "scheduled").lte("validFrom", args.now),
      )
      .take(args.limit + 1),
    ctx.db
      .query("permissionGrants")
      .withIndex("by_status_valid_until", (query) =>
        query.eq("status", "active").gt("validUntil", 0).lte("validUntil", args.now),
      )
      .take(args.limit + 1),
  ]);
  const grants = [...scheduledRows.slice(0, args.limit), ...activeRows.slice(0, args.limit)];
  const subjectIds = new Set<Id<"eventAccessSubjects">>();
  let activated = 0;
  let expired = 0;

  for (const grant of grants) {
    const result = nextLifecycleState(grant, args.now);
    if (result === "unchanged") continue;
    await applyLifecycleState(ctx, grant, result, args.now);
    subjectIds.add(grant.eventAccessSubjectId);
    if (result === "activated") activated += 1;
    else expired += 1;
  }
  for (const subjectId of subjectIds) {
    await advanceAccessVersion(ctx, subjectId, args.now);
  }

  return {
    activated,
    expired,
    affectedSubjects: subjectIds.size,
    hasMore: scheduledRows.length > args.limit || activeRows.length > args.limit,
  };
}
