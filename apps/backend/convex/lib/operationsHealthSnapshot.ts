import type { OperationsHealthSnapshot } from "@code2create/domain";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type ReadCtx = QueryCtx | MutationCtx;

export const operationsHealthRefreshIntervalMs = 30_000;
export const operationsHealthMaximumAgeMs = 3 * operationsHealthRefreshIntervalMs;

export type OperationsHealthSnapshotState =
  | { state: "missing" }
  | { state: "stale"; lastGeneratedAt: number }
  | { state: "ready"; snapshot: OperationsHealthSnapshot };

export async function findOperationsHealthSnapshot(
  ctx: ReadCtx,
  eventId: Id<"events">,
): Promise<Doc<"operationsHealthSnapshots"> | null> {
  return ctx.db
    .query("operationsHealthSnapshots")
    .withIndex("by_event", (index) => index.eq("eventId", eventId))
    .unique();
}

export async function operationsHealthSnapshotState(
  ctx: ReadCtx,
  eventId: Id<"events">,
  now: number,
): Promise<OperationsHealthSnapshotState> {
  const materialized = await findOperationsHealthSnapshot(ctx, eventId);
  if (!materialized) return { state: "missing" };
  if (materialized.state === "stale" || materialized.staleAt <= now) {
    return {
      state: "stale",
      lastGeneratedAt: materialized.snapshot.generatedAt,
    };
  }
  return { state: "ready", snapshot: materialized.snapshot };
}
