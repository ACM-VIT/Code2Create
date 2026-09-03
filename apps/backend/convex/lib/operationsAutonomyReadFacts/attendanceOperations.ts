import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  closeOperationsAutonomyFactVersion,
  nextOperationsAutonomyFactSequence,
} from "../operationsAutonomyReadFactLedger";

async function head(ctx: MutationCtx, eventId: Id<"events">, entityKey: string, now: number) {
  const source = "attendance_operations" as const;
  const sequence = await nextOperationsAutonomyFactSequence(ctx, eventId, source, now);
  await closeOperationsAutonomyFactVersion(ctx, { eventId, source, entityKey, sequence });
  return { source, sequence };
}

export async function appendAttendanceSessionJobReadFact(
  ctx: MutationCtx,
  row: Doc<"attendanceSessionJobs">,
  now: number,
) {
  const entityKey = `job:${row._id}`;
  const { source, sequence } = await head(ctx, row.eventId, entityKey, now);
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
    value: {
      kind: "session_job",
      jobId: row._id,
      sessionId: row.sessionId,
      jobKind: row.kind,
      status: row.status,
      scannedCount: row.scannedCount,
      affectedCount: row.affectedCount,
      revision: sequence,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }),
      ...(row.status === "failed" ? { failureClass: "failed" as const } : {}),
    },
    createdAt: now,
  });
}

export async function appendAttendanceDeviceReadFact(
  ctx: MutationCtx,
  row: Doc<"attendanceDeviceInstallations">,
  now: number,
) {
  const entityKey = `device:${row._id}`;
  const { source, sequence } = await head(ctx, row.eventId, entityKey, now);
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
    value: {
      kind: "device",
      deviceId: row._id,
      status: row.status,
      pendingReplayCount: row.pendingReplayCount,
      revision: sequence,
      registeredAt: row.registeredAt,
      ...(row.lastSeenAt === undefined ? {} : { lastSeenAt: row.lastSeenAt }),
      ...(row.oldestPendingCapturedAt === undefined
        ? {}
        : { oldestPendingCapturedAt: row.oldestPendingCapturedAt }),
    },
    createdAt: now,
  });
}

export async function appendAttendanceStationReadFact(
  ctx: MutationCtx,
  row: Doc<"attendanceStations">,
  now: number,
) {
  const entityKey = `station:${row._id}`;
  const { source, sequence } = await head(ctx, row.eventId, entityKey, now);
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
    value: {
      kind: "station",
      stationId: row._id,
      status: row.status,
      configurationVersion: row.configurationVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.validFrom === undefined ? {} : { validFrom: row.validFrom }),
      ...(row.validUntil === undefined ? {} : { validUntil: row.validUntil }),
    },
    createdAt: now,
  });
}

export async function appendAttendanceSessionJobReadFactById(
  ctx: MutationCtx,
  id: Id<"attendanceSessionJobs">,
  now: number,
) {
  const row = await ctx.db.get(id);
  if (!row) throw new Error("The attendance session job is missing after its write.");
  await appendAttendanceSessionJobReadFact(ctx, row, now);
}
export async function appendAttendanceDeviceReadFactById(
  ctx: MutationCtx,
  id: Id<"attendanceDeviceInstallations">,
  now: number,
) {
  const row = await ctx.db.get(id);
  if (!row) throw new Error("The attendance device is missing after its write.");
  await appendAttendanceDeviceReadFact(ctx, row, now);
}
export async function appendAttendanceStationReadFactById(
  ctx: MutationCtx,
  id: Id<"attendanceStations">,
  now: number,
) {
  const row = await ctx.db.get(id);
  if (!row) throw new Error("The attendance station is missing after its write.");
  await appendAttendanceStationReadFact(ctx, row, now);
}
