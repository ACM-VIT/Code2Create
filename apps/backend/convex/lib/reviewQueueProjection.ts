import { DirectAggregate } from "@convex-dev/aggregate";
import type { WithoutSystemFields } from "convex/server";
import { ConvexError } from "convex/values";

import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appendTeamRoundStateReadFact } from "./operationsAutonomyReadFacts";
import { maximumReviewTeamsPerEvent } from "./reviewLimits";

type ReadCtx = QueryCtx | MutationCtx;
type TeamRoundStateFields = WithoutSystemFields<Doc<"teamRoundStates">>;
type TeamRoundStatePatch = {
  [Key in keyof TeamRoundStateFields]?: undefined extends TeamRoundStateFields[Key]
    ? TeamRoundStateFields[Key] | undefined
    : TeamRoundStateFields[Key];
};
type QueueState = Pick<Doc<"teamRoundStates">, "_id" | "state" | "priority"> & {
  panelId?: Id<"reviewPanels"> | undefined;
  queuedAt?: number | undefined;
};
type QueueKey = [number, number];
type QueueItem = {
  namespace: Id<"reviewPanels">;
  key: QueueKey;
  id: Id<"teamRoundStates">;
};

const reviewQueue = new DirectAggregate<{
  Namespace: Id<"reviewPanels">;
  Key: QueueKey;
  Id: Id<"teamRoundStates">;
}>(components.reviewQueue);

function queueItem(state: QueueState): QueueItem | null {
  if (state.state !== "queued") return null;
  const panelId = state.panelId;
  const queuedAt = state.queuedAt;
  if (panelId === undefined || queuedAt === undefined) {
    throw new Error("A queued team must have a panel and queue time.");
  }
  return {
    namespace: panelId,
    key: [-state.priority, queuedAt],
    id: state._id,
  };
}

function sameQueueItem(left: QueueItem | null, right: QueueItem | null) {
  return (
    left?.namespace === right?.namespace &&
    left?.key[0] === right?.key[0] &&
    left?.key[1] === right?.key[1] &&
    left?.id === right?.id
  );
}

async function requirePanelQueueCapacity(ctx: MutationCtx, panelId: Id<"reviewPanels">) {
  const count = await reviewQueue.count(ctx, { namespace: panelId });
  if (count >= maximumReviewTeamsPerEvent) {
    throw new ConvexError({
      code: "REVIEW_PANEL_QUEUE_LIMIT_REACHED",
      message: `A panel queue can hold at most ${maximumReviewTeamsPerEvent} teams.`,
    });
  }
}

async function syncQueueProjection(
  ctx: MutationCtx,
  previous: QueueState | null,
  next: QueueState,
) {
  const previousItem = previous ? queueItem(previous) : null;
  const nextItem = queueItem(next);
  if (sameQueueItem(previousItem, nextItem)) return;
  if (previousItem && nextItem) {
    if (previousItem.namespace !== nextItem.namespace) {
      await requirePanelQueueCapacity(ctx, nextItem.namespace);
    }
    await reviewQueue.replace(ctx, previousItem, nextItem);
    return;
  }
  if (previousItem) {
    await reviewQueue.delete(ctx, previousItem);
    return;
  }
  if (nextItem) {
    await requirePanelQueueCapacity(ctx, nextItem.namespace);
    await reviewQueue.insert(ctx, nextItem);
  }
}

export async function insertTeamRoundState(ctx: MutationCtx, value: TeamRoundStateFields) {
  const stateId = await ctx.db.insert("teamRoundStates", value);
  await syncQueueProjection(ctx, null, { _id: stateId, ...value });
  const inserted = await ctx.db.get(stateId);
  if (!inserted) throw new Error("The inserted team-round state is missing.");
  await appendTeamRoundStateReadFact(ctx, inserted, value.updatedAt);
  return stateId;
}

export async function patchTeamRoundState(
  ctx: MutationCtx,
  state: Doc<"teamRoundStates">,
  patch: TeamRoundStatePatch,
) {
  await ctx.db.patch(state._id, patch);
  await syncQueueProjection(ctx, state, { ...state, ...patch });
  const updated = await ctx.db.get(state._id);
  if (!updated) throw new Error("The updated team-round state is missing.");
  await appendTeamRoundStateReadFact(ctx, updated, updated.updatedAt);
}

export async function participantQueuePosition(ctx: ReadCtx, state: Doc<"teamRoundStates">) {
  const item = queueItem(state);
  if (!item) throw new Error("Queue position requires a queued team.");
  const position = await reviewQueue.indexOf(ctx, item.key, {
    namespace: item.namespace,
    id: item.id,
  });
  const projected = await reviewQueue.at(ctx, position, {
    namespace: item.namespace,
  });
  if (
    projected.id !== item.id ||
    projected.key[0] !== item.key[0] ||
    projected.key[1] !== item.key[1]
  ) {
    throw new Error("The queued team is missing from its panel queue projection.");
  }
  return position;
}
