import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { enqueueOperationsAutonomySignal } from "./operationsAutonomyInbox";

export type OperationsAutonomyFactSource = Doc<"operationsAutonomyReadFactStates">["source"];

function canonicalFactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFactValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalFactValue(nested)]),
  );
}

export function sameOperationsAutonomyFactValue(left: unknown, right: unknown) {
  return JSON.stringify(canonicalFactValue(left)) === JSON.stringify(canonicalFactValue(right));
}

async function enqueueCurrentSignalEpisode(ctx: MutationCtx, eventId: Id<"events">, now: number) {
  const materialized = await ctx.db
    .query("operationsHealthSnapshots")
    .withIndex("by_event", (index) => index.eq("eventId", eventId))
    .unique();
  if (!materialized) return;
  await enqueueOperationsAutonomySignal(ctx, {
    eventId,
    snapshot: materialized.snapshot,
    now,
  });
}

export async function nextOperationsAutonomyFactSequence(
  ctx: MutationCtx,
  eventId: Id<"events">,
  source: Exclude<OperationsAutonomyFactSource, "support_load">,
  now: number,
) {
  const current = await ctx.db
    .query("operationsAutonomyReadFactStates")
    .withIndex("by_event_source", (index) => index.eq("eventId", eventId).eq("source", source))
    .unique();
  if (current) {
    if (current.source === "support_load") {
      throw new Error("The autonomy read fact state has the wrong source shape.");
    }
    const sequence = current.sequence + 1;
    await ctx.db.patch(current._id, { sequence, updatedAt: now });
    await enqueueCurrentSignalEpisode(ctx, eventId, now);
    return sequence;
  }
  await ctx.db.insert("operationsAutonomyReadFactStates", {
    eventId,
    source,
    sequence: 1,
    updatedAt: now,
  });
  await enqueueCurrentSignalEpisode(ctx, eventId, now);
  return 1;
}

export async function closeOperationsAutonomyFactVersion(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    source: OperationsAutonomyFactSource;
    entityKey: string;
    sequence: number;
  },
) {
  const current = await ctx.db
    .query("operationsAutonomyReadFacts")
    .withIndex("by_event_source_entity_sequence", (index) =>
      index.eq("eventId", args.eventId).eq("source", args.source).eq("entityKey", args.entityKey),
    )
    .order("desc")
    .first();
  if (!current) return;
  if (current.effectiveThroughSequence !== undefined) {
    throw new Error("The autonomy read fact head is already closed.");
  }
  await ctx.db.patch(current._id, { effectiveThroughSequence: args.sequence - 1 });
}
