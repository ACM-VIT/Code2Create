import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type ReadCtx = QueryCtx | MutationCtx;

export function activeRoundPause(ctx: ReadCtx, roundId: Id<"reviewRounds">) {
  return ctx.db
    .query("reviewRoundPauses")
    .withIndex("by_round_state", (index) =>
      index.eq("roundId", roundId).eq("state", "active"),
    )
    .unique();
}
