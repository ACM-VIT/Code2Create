import { TableAggregate } from "@convex-dev/aggregate";

import { components } from "../_generated/api";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

const voteCounts = new TableAggregate<{
  Namespace: Id<"songRequests">;
  Key: Id<"eventMemberships">;
  DataModel: DataModel;
  TableName: "songVotes";
}>(components.synesthesiaVotes, {
  namespace: (vote) => vote.requestId,
  sortKey: (vote) => vote.membershipId,
  sumValue: (vote) => (vote.state === "active" ? 1 : 0),
});

type NewSongVote = Omit<Doc<"songVotes">, "_id" | "_creationTime">;

export async function insertSongVote(ctx: MutationCtx, value: NewSongVote) {
  const voteId = await ctx.db.insert("songVotes", value);
  const vote = await ctx.db.get("songVotes", voteId);
  if (!vote) throw new Error("The song vote did not persist.");
  await voteCounts.insert(ctx, vote);
  return vote;
}

export async function setSongVoteState(
  ctx: MutationCtx,
  current: Doc<"songVotes">,
  state: Doc<"songVotes">["state"],
  updatedAt: number,
) {
  await ctx.db.patch("songVotes", current._id, {
    state,
    version: current.version + 1,
    updatedAt,
  });
  const updated = await ctx.db.get("songVotes", current._id);
  if (!updated) throw new Error("The song vote disappeared while it was changing.");
  await voteCounts.replace(ctx, current, updated);
  return updated;
}

export async function songRequestVoteCounts(
  ctx: QueryCtx,
  requests: readonly Doc<"songRequests">[],
) {
  if (requests.length === 0) return [];
  const counts = await voteCounts.sumBatch(
    ctx,
    requests.map((request) => ({ namespace: request._id })),
  );
  return requests.map((request, index) => ({
    requestId: request._id,
    voteCount: counts[index] ?? 0,
  }));
}
