import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  closeOperationsAutonomyFactVersion,
  nextOperationsAutonomyFactSequence,
  sameOperationsAutonomyFactValue,
} from "../operationsAutonomyReadFactLedger";

async function head(ctx: MutationCtx, eventId: Id<"events">, entityKey: string, now: number) {
  const source = "incident_readiness" as const;
  const sequence = await nextOperationsAutonomyFactSequence(ctx, eventId, source, now);
  await closeOperationsAutonomyFactVersion(ctx, { eventId, source, entityKey, sequence });
  return { source, sequence };
}

export async function appendIncidentReadFact(ctx: MutationCtx, row: Doc<"incidents">, now: number) {
  const entityKey = `incident:${row._id}`;
  const { source, sequence } = await head(ctx, row.eventId, entityKey, now);
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
    value: {
      kind: "incident",
      incidentId: row._id,
      severity: row.severity,
      affectedService: row.affectedService,
      state: row.state,
      manualModeState: row.manualModeState,
      manualModeApprovalCount: row.manualModeApprovalCount,
      version: row.version,
      openedAt: row.openedAt,
      updatedAt: row.updatedAt,
      ...(row.resolvedAt === undefined ? {} : { resolvedAt: row.resolvedAt }),
    },
    createdAt: now,
  });
}

export async function appendEmergencyPackReadFact(
  ctx: MutationCtx,
  row: Doc<"emergencyPacks">,
  now: number,
) {
  const entityKey = `pack:${row._id}`;
  const value = {
    kind: "emergency_pack" as const,
    packId: row._id,
    status: row.status,
    version: row.version,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }),
    ...(row.failedAt === undefined ? {} : { failedAt: row.failedAt }),
    ...(row.counts === undefined ? {} : { counts: row.counts }),
    ...(row.status === "failed" ? { failureClass: "generation_failed" as const } : {}),
  };
  const current = await ctx.db
    .query("operationsAutonomyReadFacts")
    .withIndex("by_event_source_entity_sequence", (index) =>
      index
        .eq("eventId", row.eventId)
        .eq("source", "incident_readiness")
        .eq("entityKey", entityKey),
    )
    .order("desc")
    .first();
  if (
    current?.source === "incident_readiness" &&
    sameOperationsAutonomyFactValue(current.value, value)
  )
    return;
  const { source, sequence } = await head(ctx, row.eventId, entityKey, now);
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
    value,
    createdAt: now,
  });
}

export async function appendIncidentReadFactById(
  ctx: MutationCtx,
  id: Id<"incidents">,
  now: number,
) {
  const row = await ctx.db.get(id);
  if (!row) throw new Error("The incident is missing after its write.");
  await appendIncidentReadFact(ctx, row, now);
}

export async function appendEmergencyPackReadFactById(
  ctx: MutationCtx,
  id: Id<"emergencyPacks">,
  now: number,
) {
  const row = await ctx.db.get(id);
  if (!row) throw new Error("The emergency pack is missing after its write.");
  await appendEmergencyPackReadFact(ctx, row, now);
}
