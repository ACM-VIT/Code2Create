import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export async function revokeActivePortalQrTokens(
  ctx: MutationCtx,
  membershipId: Id<"eventMemberships">,
) {
  const activeTokens = await ctx.db
    .query("attendancePortalQrTokens")
    .withIndex("by_membership_state", (index) =>
      index.eq("membershipId", membershipId).eq("state", "active"),
    )
    .collect();
  for (const token of activeTokens) {
    await ctx.db.patch(token._id, { state: "revoked" });
  }
  return activeTokens.map((token) => token._id);
}

export async function consumePortalQrToken(
  ctx: MutationCtx,
  args:
    | {
        tokenId: Id<"attendancePortalQrTokens">;
        membershipId: Id<"eventMemberships">;
        usedAt: number;
        purpose: "staffed_participant_resolution";
      }
    | {
        tokenId: Id<"attendancePortalQrTokens">;
        membershipId: Id<"eventMemberships">;
        usedAt: number;
        purpose: "attendance_scan";
        presenceEventId: Id<"attendancePresenceEvents">;
      },
) {
  await ctx.db.patch(args.tokenId, {
    state: "used",
    usedAt: args.usedAt,
    ...(args.purpose === "attendance_scan" ? { usedByEventId: args.presenceEventId } : {}),
  });
  const revokedSiblingTokenIds = await revokeActivePortalQrTokens(ctx, args.membershipId);
  return { revokedSiblingTokenIds };
}
