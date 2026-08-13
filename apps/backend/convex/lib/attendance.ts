import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type {
  AttendanceScannerCredentialKind,
  AttendanceStationMode,
} from "../values";
import { requireEventBySlug } from "./events";
import { requireCurrentPerson, requireEventSubject } from "./identity";
import { requirePermission } from "./permissions";

type StationMutationPermission =
  | "attendance.station.manage"
  | "attendance.station.read"
  | "attendance.credential.enrol"
  | "attendance.scan.execute";

export type ConfiguredAttendanceStation = Doc<"attendanceStations"> & {
  mode: AttendanceStationMode;
  allowedCredentialKinds: AttendanceScannerCredentialKind[];
};

export function hasConfiguredAttendanceStationPolicy(station: {
  mode?: AttendanceStationMode;
  allowedCredentialKinds?: readonly AttendanceScannerCredentialKind[];
}) {
  return (
    station.mode !== undefined &&
    station.allowedCredentialKinds !== undefined &&
    station.allowedCredentialKinds.length > 0
  );
}

export function isConfiguredAttendanceStation(
  station: Doc<"attendanceStations">,
): station is ConfiguredAttendanceStation {
  return hasConfiguredAttendanceStationPolicy(station);
}

export function requireConfiguredAttendanceStation(
  station: Doc<"attendanceStations">,
): asserts station is ConfiguredAttendanceStation {
  if (!isConfiguredAttendanceStation(station)) {
    throw new ConvexError({
      code: "STATION_CONFIGURATION_REQUIRED",
      message: "Replace this attendance plan and explicitly configure each scanner action and credential method.",
    });
  }
}

export async function requireStationPermission(
  ctx: MutationCtx,
  args: {
    eventSlug: string;
    stationId: Id<"attendanceStations">;
    expectedConfigurationVersion: number;
    permissionKey: StationMutationPermission;
  },
) {
  const event = await requireEventBySlug(ctx, args.eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const station = await ctx.db.get(args.stationId);
  if (!station || station.eventId !== event._id) {
    throw new ConvexError({ code: "STATION_NOT_FOUND", message: "Attendance station not found." });
  }
  if (
    args.permissionKey !== "attendance.station.manage" &&
    station.planVersionId !== event.publishedAttendancePlanVersionId
  ) {
    throw new ConvexError({
      code: "STATION_PLAN_REPLACED",
      message: "This scanner belongs to an attendance plan that is no longer current.",
    });
  }
  if (station.configurationVersion !== args.expectedConfigurationVersion) {
    throw new ConvexError({
      code: "STATION_CHANGED",
      message: "The station configuration changed. Refresh before scanning.",
    });
  }
  requireConfiguredAttendanceStation(station);
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: args.permissionKey,
    scopeType: "station",
    scopeId: station._id,
  });
  return { event, person, subject, station, grantIds };
}

export async function requireAssignedDevice(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    stationId: Id<"attendanceStations">;
    deviceInstallationId: Id<"attendanceDeviceInstallations">;
    deviceSecretHash: string;
  },
) {
  const device = await ctx.db.get(args.deviceInstallationId);
  if (
    !device ||
    device.eventId !== args.eventId ||
    device.status !== "active" ||
    device.secretHash !== args.deviceSecretHash
  ) {
    throw new ConvexError({ code: "DEVICE_NOT_ACTIVE", message: "This scanner device is not active." });
  }
  const station = await ctx.db.get(args.stationId);
  if (!station || station.deviceInstallationId !== device._id || station.status !== "active") {
    throw new ConvexError({ code: "DEVICE_NOT_ASSIGNED", message: "This device is not assigned to the active station." });
  }
  return device;
}
