import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  closeOperationsAutonomyFactVersion,
  nextOperationsAutonomyFactSequence,
} from "../operationsAutonomyReadFactLedger";

async function head(
  ctx: MutationCtx,
  args: { eventId: Id<"events">; entityKey: string; now: number },
) {
  const source = "synesthesia_operations" as const;
  const sequence = await nextOperationsAutonomyFactSequence(ctx, args.eventId, source, args.now);
  await closeOperationsAutonomyFactVersion(ctx, { ...args, source, sequence });
  return { source, sequence };
}

export async function appendSynesthesiaWindowReadFact(
  ctx: MutationCtx,
  row: Doc<"synesthesiaWindows">,
  now: number,
) {
  const entityKey = `window:${row._id}`;
  const { source, sequence } = await head(ctx, { eventId: row.eventId, entityKey, now });
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId, source, entityKey, sequence,
    value: {
      kind: "window", windowId: row._id, status: row.status,
      requestsOpen: row.requestsOpen, votingOpen: row.votingOpen,
      playbackPaused: row.playbackPaused, version: row.version,
      startsAt: row.startsAt, endsAt: row.endsAt, updatedAt: row.updatedAt,
    },
    createdAt: now,
  });
}

export async function appendSongRequestReadFact(
  ctx: MutationCtx,
  row: Doc<"songRequests">,
  now: number,
) {
  const entityKey = `request:${row._id}`;
  const { source, sequence } = await head(ctx, { eventId: row.eventId, entityKey, now });
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId, source, entityKey, sequence,
    value: {
      kind: "request", requestId: row._id, windowId: row.windowId,
      state: row.state, queueMode: row.queueMode, openReportCount: row.openReportCount,
      version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
      ...(row.scheduledFor === undefined ? {} : { scheduledFor: row.scheduledFor }),
      ...(row.playbackStartedAt === undefined ? {} : { playbackStartedAt: row.playbackStartedAt }),
      ...(row.playbackFinishedAt === undefined ? {} : { playbackFinishedAt: row.playbackFinishedAt }),
    },
    createdAt: now,
  });
}

export async function appendSynesthesiaReportReadFact(
  ctx: MutationCtx,
  row: Doc<"synesthesiaReports">,
  now: number,
) {
  const entityKey = `report:${row._id}`;
  const { source, sequence } = await head(ctx, { eventId: row.eventId, entityKey, now });
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId, source, entityKey, sequence,
    value: {
      kind: "report", reportId: row._id, windowId: row.windowId,
      requestId: row.requestId, state: row.state, version: row.version,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
      ...(row.resolvedAt === undefined ? {} : { resolvedAt: row.resolvedAt }),
    },
    createdAt: now,
  });
}

export async function appendSynesthesiaWindowReadFactById(ctx: MutationCtx, id: Id<"synesthesiaWindows">, now: number) {
  const row = await ctx.db.get(id);
  if (!row) throw new Error("The synesthesia window is missing after its write.");
  await appendSynesthesiaWindowReadFact(ctx, row, now);
}

export async function appendSongRequestReadFactById(ctx: MutationCtx, id: Id<"songRequests">, now: number) {
  const row = await ctx.db.get(id);
  if (!row) throw new Error("The song request is missing after its write.");
  await appendSongRequestReadFact(ctx, row, now);
}

export async function appendSynesthesiaReportReadFactById(ctx: MutationCtx, id: Id<"synesthesiaReports">, now: number) {
  const row = await ctx.db.get(id);
  if (!row) throw new Error("The synesthesia report is missing after its write.");
  await appendSynesthesiaReportReadFact(ctx, row, now);
}
