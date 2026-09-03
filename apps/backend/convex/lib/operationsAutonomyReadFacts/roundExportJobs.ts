import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  closeOperationsAutonomyFactVersion,
  nextOperationsAutonomyFactSequence,
  sameOperationsAutonomyFactValue,
} from "../operationsAutonomyReadFactLedger";

export async function appendRoundExportJobReadFact(
  ctx: MutationCtx,
  row: Doc<"roundExports">,
  now: number,
) {
  const source = "round_export_jobs" as const;
  const entityKey = `export:${row._id}`;
  const value = {
    exportId: row._id,
    roundId: row.roundId,
    state: row.state,
    revision: row.revision,
    formatVersion: row.exportFormatVersion,
    closingRoundVersion: row.closingRoundVersion,
    counts: row.counts,
    version: row.version,
    requestedAt: row.requestedAt,
    updatedAt: row.updatedAt,
    ...(row.uploadedAt === undefined ? {} : { uploadedAt: row.uploadedAt }),
    ...(row.verifiedAt === undefined ? {} : { verifiedAt: row.verifiedAt }),
    ...(row.failedAt === undefined ? {} : { failedAt: row.failedAt }),
    ...(row.state === "failed" ? { failureClass: "generation_failed" as const } : {}),
  };
  const current = await ctx.db
    .query("operationsAutonomyReadFacts")
    .withIndex("by_event_source_entity_sequence", (index) =>
      index.eq("eventId", row.eventId).eq("source", source).eq("entityKey", entityKey),
    )
    .order("desc")
    .first();
  if (current?.source === source && sameOperationsAutonomyFactValue(current.value, value)) return;
  const sequence = await nextOperationsAutonomyFactSequence(ctx, row.eventId, source, now);
  await closeOperationsAutonomyFactVersion(ctx, {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
  });
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
    value,
    createdAt: now,
  });
}

export async function appendRoundExportJobReadFactById(
  ctx: MutationCtx,
  exportId: Id<"roundExports">,
  now: number,
) {
  const row = await ctx.db.get(exportId);
  if (!row) throw new Error("The round export is missing after its write.");
  await appendRoundExportJobReadFact(ctx, row, now);
}
