import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { openAttendanceSessionInZone } from "./lib/attendanceSessionLifecycle";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import { attendanceScanTransition, barcodeSymbology } from "./values";

const stationSummary = v.object({
  id: v.id("attendanceStations"),
  stableKey: v.string(),
  name: v.string(),
  configurationVersion: v.number(),
  barcodeSymbologies: v.array(barcodeSymbology),
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

/**
 * The one gate for every device-scoped scanner read: the signed-in caller must
 * hold station read on the station this exact installation is actively
 * assigned to. A missing or inactive device or station returns null rather
 * than throwing, because a device mid-provisioning or retired by operations is
 * a state the client renders, not an error.
 */
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
  const station = await ctx.db
    .query("attendanceStations")
    .withIndex("by_device_status", (index) =>
      index.eq("deviceInstallationId", device._id).eq("status", "active"),
    )
    .unique();
  if (!station || station.eventId !== event._id) return null;
  await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "attendance.station.read",
    scopeType: "station",
    scopeId: station._id,
  });
  return { event, device, station };
}

/**
 * A presence event becomes a receipt only when a scanner produced it.
 * Reconciliation rows share the table and the device index, but they belong to
 * operations, so a device reading its own trail never sees them.
 */
async function scannerReceipt(
  ctx: QueryCtx,
  presenceEvent: Doc<"attendancePresenceEvents">,
) {
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
        .withIndex("by_membership", (index) =>
          index.eq("membershipId", membership._id),
        )
        .unique()
    : null;
  const participantPerson = membership ? await ctx.db.get(membership.personId) : null;
  return {
    id: presenceEvent._id,
    outcome: presenceEvent.outcome,
    reasonCode: presenceEvent.reasonCode,
    transition: presenceEvent.transition,
    receivedAt: presenceEvent.receivedAt,
    capturedAt: presenceEvent.capturedAt,
    isOfflineReplay: presenceEvent.isOfflineReplay,
    deviceSequence: presenceEvent.deviceSequence,
    ...(participantPerson
      ? {
          participantName:
            profile?.preferredName ?? profile?.fullName ?? participantPerson.displayName,
        }
      : {}),
  };
}

export const availableStations = query({
  args: { eventSlug: v.string() },
  returns: v.array(stationSummary),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const planId = event.publishedAttendancePlanVersionId;
    if (!planId) return [];
    const plan = await ctx.db.get(planId);
    if (!plan || plan.eventId !== event._id || plan.status !== "published") return [];
    const stations = await ctx.db
      .query("attendanceStations")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "inactive"),
      )
      .collect();
    const visible = [];
    for (const station of stations) {
      if (station.planVersionId !== plan._id || station.deviceInstallationId !== undefined) continue;
      const grantIds = await matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "attendance.station.manage",
        scopeType: "station",
        scopeId: station._id,
      });
      if (grantIds.length === 0) continue;
      const zone = await ctx.db.get(station.zoneId);
      if (!zone || zone.eventId !== event._id) continue;
      visible.push({
        id: station._id,
        stableKey: station.stableKey,
        name: station.name,
        configurationVersion: station.configurationVersion,
        barcodeSymbologies: plan.vitBarcodeSymbologies,
        zoneName: zone.name,
      });
    }
    return visible;
  },
});

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
      openAttendanceSessionInZone(ctx, { eventId: event._id, zoneId: station.zoneId }),
      ctx.db
        .query("attendancePresenceEvents")
        .withIndex("by_device_sequence", (index) =>
          index.eq("deviceInstallationId", device._id),
        )
        .order("desc")
        .take(8),
    ]);
    if (
      !plan ||
      plan.eventId !== event._id ||
      plan.status !== "published" ||
      !zone ||
      zone.eventId !== event._id
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
        zoneName: zone.name,
      },
      openSession: session
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

/**
 * Everything this device has ever produced, newest first, for auditing a whole
 * shift. `current` keeps only the last handful for the live surface; this pages
 * the rest behind exactly the same station gate, so a device can never read
 * another door's trail. Pages can come back short because reconciliation rows
 * interleaved in the device index are dropped, but the cursor still advances
 * through them.
 */
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
    // The states `current` answers with null — a device mid-provisioning or
    // retired — have no trail to page, so history is simply finished.
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
