import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { isConfiguredAttendanceStation } from "./lib/attendance";
import { requireEventBySlug } from "./lib/events";
import { outingScanDecision } from "./lib/outingValues";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds } from "./lib/permissions";
import {
  attendanceScannerCredentialKind,
  attendanceMovementReason,
  attendanceScanTransition,
  attendanceStationMode,
  barcodeSymbology,
} from "./values";

const stationSummary = v.object({
  id: v.id("attendanceStations"),
  stableKey: v.string(),
  name: v.string(),
  configurationVersion: v.number(),
  barcodeSymbologies: v.array(barcodeSymbology),
  mode: attendanceStationMode,
  allowedCredentialKinds: v.array(attendanceScannerCredentialKind),
  sessionId: v.optional(v.id("attendanceSessions")),
  zoneName: v.string(),
});

const openSession = v.union(
  v.null(),
  v.object({
    id: v.id("attendanceSessions"),
    name: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
  }),
);

const scanReceipt = v.object({
  movementReason: v.optional(attendanceMovementReason),
  outing: v.optional(outingScanDecision),
  id: v.id("attendancePresenceEvents"),
  outcome: v.union(
    v.literal("accepted"),
    v.literal("duplicate"),
    v.literal("rejected"),
    v.literal("needs_review"),
  ),
  reasonCode: v.string(),
  transition: attendanceScanTransition,
  receivedAt: v.number(),
  capturedAt: v.number(),
  isOfflineReplay: v.boolean(),
  deviceSequence: v.number(),
  participantName: v.optional(v.string()),
});

/** Requires this installation's active station assignment and station-read grant. */
async function authoriseScannerDevice(
  ctx: QueryCtx,
  args: { eventSlug: string; installationId: string },
) {
  const event = await requireEventBySlug(ctx, args.eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const device = await ctx.db
    .query("attendanceDeviceInstallations")
    .withIndex("by_event_installation", (index) =>
      index.eq("eventId", event._id).eq("installationId", args.installationId),
    )
    .unique();
  if (!device || device.eventId !== event._id || device.status !== "active") return null;
  const station = device.stationId
    ? await ctx.db.get(device.stationId)
    : await ctx.db
        .query("attendanceStations")
        .withIndex("by_device_status", (index) =>
          index.eq("deviceInstallationId", device._id).eq("status", "active"),
        )
        .unique();
  if (!station || station.eventId !== event._id || !isConfiguredAttendanceStation(station)) {
    return null;
  }
  const grantIds = await matchingPermissionGrantIds(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "attendance.scan.execute",
    scopeType: "event",
  });
  if (grantIds.length === 0) return null;
  return { event, device, station };
}

/** Device receipts exclude operations reconciliation events in the same table. */
async function scannerReceipt(ctx: QueryCtx, presenceEvent: Doc<"attendancePresenceEvents">) {
  if (
    presenceEvent.sourceKind !== "scanner" ||
    presenceEvent.deviceSequence === undefined ||
    presenceEvent.transition === "manual_reconcile" ||
    presenceEvent.outcome === "reconciled"
  ) {
    return null;
  }
  const membership = presenceEvent.membershipId
    ? await ctx.db.get(presenceEvent.membershipId)
    : null;
  const profile = membership
    ? await ctx.db
        .query("participantProfiles")
        .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
        .unique()
    : null;
  const participantPerson = membership ? await ctx.db.get(membership.personId) : null;
  return {
    id: presenceEvent._id,
    ...(presenceEvent.movementReason ? { movementReason: presenceEvent.movementReason } : {}),
    ...(presenceEvent.outing ? { outing: presenceEvent.outing } : {}),
    outcome: presenceEvent.outcome,
    reasonCode: presenceEvent.reasonCode,
    transition: presenceEvent.transition,
    receivedAt: presenceEvent.receivedAt,
    capturedAt: presenceEvent.capturedAt,
    isOfflineReplay: presenceEvent.isOfflineReplay,
    deviceSequence: presenceEvent.deviceSequence,
    ...(participantPerson
      ? {
          participantName: profile?.fullName ?? participantPerson.displayName,
        }
      : {}),
  };
}

export const current = query({
  args: {
    eventSlug: v.string(),
    installationId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      device: v.object({
        id: v.id("attendanceDeviceInstallations"),
        name: v.string(),
        installationId: v.string(),
        lastSequence: v.number(),
        pendingReplayCount: v.number(),
        oldestPendingCapturedAt: v.optional(v.number()),
      }),
      station: stationSummary,
      openSession,
      serverNow: v.number(),
      offlinePolicy: v.object({
        maxScans: v.number(),
        maxAgeSeconds: v.number(),
      }),
      recentReceipts: v.array(scanReceipt),
    }),
  ),
  handler: async (ctx, args) => {
    const authorised = await authoriseScannerDevice(ctx, args);
    if (!authorised) return null;
    const { event, device, station } = authorised;
    const [plan, zone, session, recentEvents] = await Promise.all([
      ctx.db.get(station.planVersionId),
      ctx.db.get(station.zoneId),
      station.sessionId === undefined ? null : ctx.db.get(station.sessionId),
      ctx.db
        .query("attendancePresenceEvents")
        .withIndex("by_device_sequence", (index) => index.eq("deviceInstallationId", device._id))
        .order("desc")
        .take(8),
    ]);
    if (
      !plan ||
      plan.eventId !== event._id ||
      plan.status !== "published" ||
      !zone ||
      zone.eventId !== event._id ||
      (session !== null &&
        (session.eventId !== event._id ||
          session.planVersionId !== station.planVersionId ||
          session.zoneId !== station.zoneId))
    ) {
      return null;
    }
    const recentReceipts = [];
    for (const presenceEvent of recentEvents) {
      const receipt = await scannerReceipt(ctx, presenceEvent);
      if (receipt) recentReceipts.push(receipt);
    }
    return {
      device: {
        id: device._id,
        name: device.name,
        installationId: device.installationId,
        lastSequence: device.lastSequence ?? 0,
        pendingReplayCount: device.pendingReplayCount,
        ...(device.oldestPendingCapturedAt !== undefined
          ? { oldestPendingCapturedAt: device.oldestPendingCapturedAt }
          : {}),
      },
      station: {
        id: station._id,
        stableKey: station.stableKey,
        name: station.name,
        configurationVersion: station.configurationVersion,
        barcodeSymbologies: plan.vitBarcodeSymbologies,
        mode: station.mode,
        allowedCredentialKinds: station.allowedCredentialKinds,
        ...(station.sessionId !== undefined ? { sessionId: station.sessionId } : {}),
        zoneName: zone.name,
      },
      openSession:
        session?.status === "open"
          ? {
              id: session._id,
              name: session.name,
              startsAt: session.startsAt,
              endsAt: session.endsAt,
            }
          : null,
      serverNow: Date.now(),
      offlinePolicy: {
        maxScans: plan.offlineQueueMaxScans,
        maxAgeSeconds: plan.offlineQueueMaxAgeSeconds,
      },
      recentReceipts,
    };
  },
});

/** Paginates device-only receipts; filtered reconciliation rows can make pages short. */
export const history = query({
  args: {
    eventSlug: v.string(),
    installationId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(scanReceipt),
  handler: async (ctx, args) => {
    const authorised = await authoriseScannerDevice(ctx, {
      eventSlug: args.eventSlug,
      installationId: args.installationId,
    });
    // Mid-provisioning and retired devices have no receipt history.
    if (!authorised) return { page: [], isDone: true, continueCursor: "" };
    const result = await ctx.db
      .query("attendancePresenceEvents")
      .withIndex("by_device_sequence", (index) =>
        index.eq("deviceInstallationId", authorised.device._id),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const receipts = [];
    for (const presenceEvent of result.page) {
      const receipt = await scannerReceipt(ctx, presenceEvent);
      if (receipt) receipts.push(receipt);
    }
    return { ...result, page: receipts };
  },
});
