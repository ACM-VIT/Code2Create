import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { revokeSourceGrantGroups } from "./permissions";

export function stationAssignmentSourceId(args: {
  stationId: Id<"attendanceStations">;
  deviceInstallationId: Id<"attendanceDeviceInstallations">;
  operatorPersonId: Id<"people">;
}) {
  return `station:${args.stationId}:device:${args.deviceInstallationId}:operator:${args.operatorPersonId}`;
}

async function disableAssignedAttendanceStationRows(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    station: Doc<"attendanceStations">;
    now: number;
  },
) {
  if (args.station.status !== "active" || args.station.deviceInstallationId === undefined) {
    throw new ConvexError({
      code: "STATION_NOT_ACTIVE",
      message: "Only an active scanner station can be disabled.",
    });
  }
  const device = await ctx.db.get(args.station.deviceInstallationId);
  if (
    !device ||
    device.eventId !== args.eventId ||
    device.status !== "active"
  ) {
    throw new Error("An active scanner station must own one active registered device.");
  }
  const configurationVersion = args.station.configurationVersion + 1;
  await ctx.db.patch(device._id, {
    status: "revoked",
    revokedAt: args.now,
  });
  await ctx.db.patch(args.station._id, {
    deviceInstallationId: undefined,
    status: "disabled",
    configurationVersion,
    updatedAt: args.now,
  });
  return {
    configurationVersion,
    deviceInstallationId: device._id,
    sourceId: stationAssignmentSourceId({
      stationId: args.station._id,
      deviceInstallationId: device._id,
      operatorPersonId: device.registeredByPersonId,
    }),
  };
}

export async function disableAssignedAttendanceStation(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    station: Doc<"attendanceStations">;
    disabledByPersonId: Id<"people">;
    reason: string;
    now: number;
  },
) {
  const result = await disableAssignedAttendanceStationRows(ctx, args);
  await revokeSourceGrantGroups(ctx, {
    eventId: args.eventId,
    sources: [{ sourceType: "station_assignment", sourceId: result.sourceId }],
    revokedByPersonId: args.disabledByPersonId,
    reason: args.reason,
  });
  return {
    configurationVersion: result.configurationVersion,
    deviceInstallationId: result.deviceInstallationId,
  };
}

export async function enableDisabledAttendanceStation(
  ctx: MutationCtx,
  args: {
    station: Doc<"attendanceStations">;
    now: number;
  },
) {
  if (args.station.status !== "disabled") {
    throw new ConvexError({
      code: "STATION_NOT_DISABLED",
      message: "Only a disabled scanner station can be made available.",
    });
  }
  if (args.station.deviceInstallationId !== undefined) {
    throw new Error("A disabled scanner station cannot retain a device assignment.");
  }
  const configurationVersion = args.station.configurationVersion + 1;
  await ctx.db.patch(args.station._id, {
    status: "inactive",
    configurationVersion,
    updatedAt: args.now,
  });
  return { configurationVersion };
}

export function requireReplaceableAttendancePlan(
  sessions: ReadonlyArray<Pick<Doc<"attendanceSessions">, "status">>,
) {
  if (
    sessions.some(
      (session) =>
        session.status === "preparing" ||
        session.status === "open" ||
        session.status === "closing",
    )
  ) {
    throw new ConvexError({
      code: "PLAN_REPLACEMENT_BLOCKED",
      message: "Finish the current attendance preparation or live session before replacing its plan.",
    });
  }
}

export async function retireAttendancePlanStations(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    stations: Doc<"attendanceStations">[];
    retiredByPersonId: Id<"people">;
    reason: string;
    now: number;
  },
) {
  const sources = [];
  for (const station of args.stations) {
    if (station.status === "active") {
      const disabled = await disableAssignedAttendanceStationRows(ctx, {
        eventId: args.eventId,
        station,
        now: args.now,
      });
      sources.push({ sourceType: "station_assignment" as const, sourceId: disabled.sourceId });
      continue;
    }
    if (station.deviceInstallationId !== undefined) {
      throw new Error("A station without active status cannot retain a device assignment.");
    }
    if (station.status === "inactive") {
      await ctx.db.patch(station._id, {
        status: "disabled",
        configurationVersion: station.configurationVersion + 1,
        updatedAt: args.now,
      });
    }
  }
  await revokeSourceGrantGroups(ctx, {
    eventId: args.eventId,
    sources,
    revokedByPersonId: args.retiredByPersonId,
    reason: args.reason,
  });
  return {
    retiredStationCount: args.stations.length,
    revokedDeviceCount: sources.length,
  };
}
