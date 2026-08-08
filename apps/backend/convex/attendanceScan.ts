import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { requireAssignedDevice, requireStationPermission } from "./lib/attendance";
import { moveZoneCounter } from "./lib/attendanceCounters";
import { moveAttendanceTeamAvailability } from "./lib/attendanceTeamAvailability";
import {
  offlineReplayConflictsWithNewerEvidence,
  offlineReplayTimeRejection,
  scannerCaptureFutureToleranceMs,
} from "./lib/attendanceOfflineReplay";
import { consumePortalQrToken } from "./lib/attendancePortalQrLifecycle";
import { updateActiveRollCallsForVenueChange } from "./lib/attendanceRollCalls";
import {
  applySessionTransitionProjection,
  prepareSessionTransition,
} from "./lib/attendanceSessionTransition";
import { attendanceSessionWindowRejection } from "./lib/attendanceSessionLifecycle";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson } from "./lib/identity";
import { operationFingerprint } from "./lib/operations";

type Transition =
  | "venue_entry"
  | "venue_exit"
  | "session_confirm"
  | "zone_entry"
  | "zone_exit";
type Outcome = "accepted" | "duplicate" | "rejected" | "needs_review";
type VenueState = Doc<"attendanceVenueStates">["state"];
type SessionState = Doc<"attendanceSessionParticipants">["state"];
type ProjectionState = VenueState | SessionState;
type Decision = {
  outcome: Outcome;
  reasonCode: string;
  previousState: ProjectionState;
  nextState: ProjectionState;
};
type CredentialResolution =
  | {
      resolved: true;
      membershipId: Id<"eventMemberships">;
      credentialId?: Id<"attendanceCredentials">;
      portalQrTokenId?: Id<"attendancePortalQrTokens">;
    }
  | { resolved: false; reasonCode: string };

const receipt = v.object({
  presenceEventId: v.id("attendancePresenceEvents"),
  outcome: v.union(
    v.literal("accepted"),
    v.literal("duplicate"),
    v.literal("rejected"),
    v.literal("needs_review"),
  ),
  reasonCode: v.string(),
  serverTime: v.number(),
  transition: v.union(
    v.literal("venue_entry"),
    v.literal("venue_exit"),
    v.literal("session_confirm"),
    v.literal("zone_entry"),
    v.literal("zone_exit"),
  ),
  previousState: v.optional(v.string()),
  nextState: v.optional(v.string()),
  participant: v.union(
    v.null(),
    v.object({
      membershipId: v.id("eventMemberships"),
      displayName: v.string(),
      teamName: v.optional(v.string()),
    }),
  ),
});

type Receipt = {
  presenceEventId: Id<"attendancePresenceEvents">;
  outcome: Outcome;
  reasonCode: string;
  serverTime: number;
  transition: Transition;
  previousState?: string;
  nextState?: string;
  participant: null | {
    membershipId: Id<"eventMemberships">;
    displayName: string;
    teamName?: string;
  };
};

function transitionFor(
  station: Doc<"attendanceStations">,
  rovingTransition: Transition | undefined,
): Transition {
  if (station.mode === "roving") {
    if (rovingTransition === undefined) {
      throw new ConvexError({
        code: "TRANSITION_REQUIRED",
        message: "Choose entry, exit, or session confirmation on this roving station.",
      });
    }
    return rovingTransition;
  }
  if (rovingTransition !== undefined) {
    throw new ConvexError({
      code: "TRANSITION_FIXED",
      message: "This station's transition is fixed by its configuration.",
    });
  }
  return station.mode;
}

function venueDecision(state: VenueState, transition: Transition): Decision {
  if (transition === "venue_entry") {
    if (state === "inside") {
      return { outcome: "duplicate", reasonCode: "already_inside", previousState: state, nextState: state };
    }
    if (state === "unknown") {
      return { outcome: "needs_review", reasonCode: "venue_state_unknown", previousState: state, nextState: state };
    }
    return { outcome: "accepted", reasonCode: "venue_entry_recorded", previousState: state, nextState: "inside" };
  }
  if (transition === "venue_exit") {
    if (state === "inside") {
      return { outcome: "accepted", reasonCode: "venue_exit_recorded", previousState: state, nextState: "temporarily_out" };
    }
    if (state === "temporarily_out" || state === "departed") {
      return { outcome: "duplicate", reasonCode: "already_outside", previousState: state, nextState: state };
    }
    return { outcome: "needs_review", reasonCode: "exit_without_entry", previousState: state, nextState: "unknown" };
  }
  throw new ConvexError({ code: "STATION_SESSION_REQUIRED", message: "This transition needs a session station." });
}

function venueProjectionState(state: ProjectionState): VenueState {
  if (
    state === "not_arrived" ||
    state === "inside" ||
    state === "temporarily_out" ||
    state === "departed" ||
    state === "unknown"
  ) {
    return state;
  }
  return "unknown";
}

async function resolveCredential(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    station: Doc<"attendanceStations">;
    credentialKind: "vit_id_barcode" | "badge_qr" | "portal_qr";
    lookupHash: string;
    receivedAt: number;
  },
): Promise<CredentialResolution> {
  if (!args.station.allowedCredentialKinds.some((kind) => kind === args.credentialKind)) {
    return { resolved: false, reasonCode: "credential_method_not_allowed" };
  }
  if (args.credentialKind === "portal_qr") {
    const token = await ctx.db
      .query("attendancePortalQrTokens")
      .withIndex("by_event_token", (index) =>
        index.eq("eventId", args.eventId).eq("tokenHash", args.lookupHash),
      )
      .unique();
    if (!token || token.state === "revoked" || token.expiresAt <= args.receivedAt) {
      return { resolved: false, reasonCode: "portal_qr_invalid" };
    }
    if (token.state === "used") {
      return { resolved: false, reasonCode: "portal_qr_used" };
    }
    if (token.sessionId !== undefined && token.sessionId !== args.station.sessionId) {
      return { resolved: false, reasonCode: "portal_qr_wrong_session" };
    }
    const portalCredential = await ctx.db.get(token.portalCredentialId);
    if (
      !portalCredential ||
      portalCredential.eventId !== args.eventId ||
      portalCredential.state !== "active" ||
      portalCredential.version !== token.credentialVersion
    ) {
      return { resolved: false, reasonCode: "portal_qr_revoked" };
    }
    return {
      resolved: true,
      membershipId: token.membershipId,
      portalQrTokenId: token._id,
    };
  }
  const matches = await ctx.db
    .query("attendanceCredentials")
    .withIndex("by_event_lookup", (index) =>
      index.eq("eventId", args.eventId).eq("lookupHash", args.lookupHash),
    )
    .collect();
  const expectedKind =
    args.credentialKind === "vit_id_barcode" ? "vit_id_barcode" : "badge_qr";
  const active = matches.filter(
    (credential) => credential.kind === expectedKind && credential.state === "active",
  );
  if (active.length > 1) throw new Error("More than one active attendance credential has the same lookup hash.");
  const credential = active[0];
  if (!credential) return { resolved: false, reasonCode: "credential_not_found" };
  return {
    resolved: true,
    membershipId: credential.membershipId,
    credentialId: credential._id,
  };
}

async function participantForReceipt(
  ctx: MutationCtx,
  membershipId: Id<"eventMemberships">,
) {
  const membership = await ctx.db.get(membershipId);
  if (!membership) return null;
  const [person, profile, teamMember] = await Promise.all([
    ctx.db.get(membership.personId),
    ctx.db
      .query("participantProfiles")
      .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
      .unique(),
    ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", membership.eventId)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique(),
  ]);
  if (!person) return null;
  const team = teamMember ? await ctx.db.get(teamMember.teamId) : null;
  return {
    membershipId: membership._id,
    displayName: profile?.preferredName ?? profile?.fullName ?? person.displayName,
    ...(team ? { teamName: team.name } : {}),
  };
}

async function receiptForEvent(
  ctx: MutationCtx,
  event: Doc<"attendancePresenceEvents">,
): Promise<Receipt> {
  if (event.transition === "manual_reconcile" || event.outcome === "reconciled") {
    throw new Error("A staff reconciliation cannot be returned as a scanner receipt.");
  }
  return {
    presenceEventId: event._id,
    outcome: event.outcome,
    reasonCode: event.reasonCode,
    serverTime: event.receivedAt,
    transition: event.transition,
    ...(event.previousState !== undefined ? { previousState: event.previousState } : {}),
    ...(event.nextState !== undefined ? { nextState: event.nextState } : {}),
    participant: event.membershipId
      ? await participantForReceipt(ctx, event.membershipId)
      : null,
  };
}

export const recordScan = internalMutation({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecretHash: v.string(),
    credentialKind: v.union(
      v.literal("vit_id_barcode"),
      v.literal("badge_qr"),
      v.literal("portal_qr"),
    ),
    lookupHash: v.string(),
    rovingTransition: v.optional(
      v.union(
        v.literal("venue_entry"),
        v.literal("venue_exit"),
        v.literal("session_confirm"),
        v.literal("zone_entry"),
        v.literal("zone_exit"),
      ),
    ),
    clientOperationId: v.string(),
    deviceSequence: v.number(),
    capturedAt: v.number(),
    isOfflineReplay: v.boolean(),
  },
  returns: receipt,
  handler: async (ctx, args): Promise<Receipt> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.stationId,
      args.expectedConfigurationVersion,
      args.deviceInstallationId,
      args.deviceSecretHash,
      args.credentialKind,
      args.lookupHash,
      args.rovingTransition ?? null,
      args.deviceSequence,
      args.capturedAt,
    ]);
    const prior = await ctx.db
      .query("attendancePresenceEvents")
      .withIndex("by_operator_operation", (index) =>
        index
          .eq("operatorPersonId", person._id)
          .eq("clientOperationId", args.clientOperationId),
      )
      .unique();
    if (prior) {
      if (prior.eventId !== event._id || prior.requestFingerprint !== requestFingerprint) {
        throw new ConvexError({ code: "OPERATION_ID_REUSED", message: "Operation ID was reused." });
      }
      return receiptForEvent(ctx, prior);
    }
    if (!Number.isSafeInteger(args.deviceSequence) || args.deviceSequence < 1) {
      throw new ConvexError({ code: "INVALID_DEVICE_SEQUENCE", message: "Scanner sequence is invalid." });
    }
    const { station } = await requireStationPermission(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      permissionKey: "attendance.scan.execute",
    });
    const plan = await ctx.db.get(station.planVersionId);
    if (!plan || plan.eventId !== event._id || plan.status !== "published") {
      throw new ConvexError({
        code: "PLAN_NOT_ACTIVE",
        message: "The station's attendance plan is not published.",
      });
    }
    const device = await requireAssignedDevice(ctx, {
      eventId: event._id,
      stationId: station._id,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: args.deviceSecretHash,
    });
    if (!args.isOfflineReplay && args.deviceSequence <= (device.lastSequence ?? 0)) {
      throw new ConvexError({
        code: "DEVICE_SEQUENCE_STALE",
        message: "This scan is older than the scanner's latest accepted operation.",
      });
    }
    const sameSequence = await ctx.db
      .query("attendancePresenceEvents")
      .withIndex("by_device_sequence", (index) =>
        index
          .eq("deviceInstallationId", device._id)
          .eq("deviceSequence", args.deviceSequence),
      )
      .unique();
    if (sameSequence) {
      throw new ConvexError({
        code: "DEVICE_SEQUENCE_REUSED",
        message: "That scanner sequence was already used by another operation.",
      });
    }
    const now = Date.now();
    if (
      !Number.isSafeInteger(args.capturedAt) ||
      args.capturedAt > now + scannerCaptureFutureToleranceMs
    ) {
      throw new ConvexError({
        code: "SCAN_CAPTURE_TIME_INVALID",
        message: "The scanner capture time is invalid.",
      });
    }
    if (args.isOfflineReplay) {
      const timeRejection = offlineReplayTimeRejection({
        capturedAt: args.capturedAt,
        receivedAt: now,
        maxAgeMs: plan.offlineQueueMaxAgeSeconds * 1_000,
      });
      if (timeRejection) {
        throw new ConvexError({
          code:
            timeRejection === "offline_replay_expired"
              ? "OFFLINE_REPLAY_EXPIRED"
              : "SCAN_CAPTURE_TIME_INVALID",
          message:
            timeRejection === "offline_replay_expired"
              ? "This pending scan expired before it could replay."
              : "The scanner capture time is invalid.",
        });
      }
    }
    const effectiveAt = args.isOfflineReplay ? args.capturedAt : now;
    if (
      (station.validFrom !== undefined && station.validFrom > now) ||
      (station.validUntil !== undefined && station.validUntil <= now)
    ) {
      throw new ConvexError({ code: "STATION_NOT_ACTIVE", message: "This station assignment is not active." });
    }
    const transition = transitionFor(station, args.rovingTransition);
    const usesSession =
      transition === "session_confirm" ||
      transition === "zone_entry" ||
      transition === "zone_exit";
    if (usesSession !== (station.sessionId !== undefined)) {
      throw new ConvexError({
        code: "STATION_CONFIGURATION_INVALID",
        message: "The station's session assignment does not match its transition.",
      });
    }
    const resolved = await resolveCredential(ctx, {
      eventId: event._id,
      station,
      credentialKind: args.credentialKind,
      lookupHash: args.lookupHash,
      receivedAt: now,
    });
    let membership: Doc<"eventMemberships"> | null = null;
    let decision: Decision | null = null;
    let venueState: Doc<"attendanceVenueStates"> | null = null;
    let attendanceSession: Doc<"attendanceSessions"> | null = null;
    let sessionParticipant: Doc<"attendanceSessionParticipants"> | null = null;
    let openInterval: Doc<"attendancePresenceIntervals"> | null = null;
    let rejectionReason: string | null = resolved.resolved ? null : resolved.reasonCode;

    if (resolved.resolved) {
      membership = await ctx.db.get(resolved.membershipId);
      if (
        !membership ||
        membership.eventId !== event._id ||
        membership.eligibilityStatus === "suspended" ||
        membership.eligibilityStatus === "rejected" ||
        membership.onboardingStatus !== "accepted"
      ) {
        rejectionReason = "participant_not_active";
      } else if (usesSession) {
        const activeMembership = membership;
        const sessionId = station.sessionId;
        if (!sessionId) throw new Error("Validated session station has no session.");
        const session = await ctx.db.get(sessionId);
        attendanceSession = session;
        if (!session || session.eventId !== event._id || session.status !== "open") {
          rejectionReason = args.isOfflineReplay ? "offline_scan_needs_reconciliation" : "session_not_open";
        } else {
          const windowRejection = attendanceSessionWindowRejection({
            session,
            transition,
            now: effectiveAt,
          });
          if (windowRejection) {
            rejectionReason = windowRejection;
          } else {
            sessionParticipant = await ctx.db
              .query("attendanceSessionParticipants")
              .withIndex("by_session_membership", (index) =>
                index.eq("sessionId", session._id).eq("membershipId", activeMembership._id),
              )
              .unique();
            if (!sessionParticipant) {
              rejectionReason = "participant_not_expected";
            } else {
              const prepared = await prepareSessionTransition(ctx, {
                participant: sessionParticipant,
                transition,
              });
              decision = prepared.decision;
              openInterval = prepared.openInterval;
            }
          }
        }
      } else {
        const activeMembership = membership;
        venueState = await ctx.db
          .query("attendanceVenueStates")
          .withIndex("by_event_membership", (index) =>
            index.eq("eventId", event._id).eq("membershipId", activeMembership._id),
          )
          .unique();
        decision = venueDecision(venueState?.state ?? "not_arrived", transition);
        if (decision.outcome === "accepted") {
          if (transition === "venue_exit") {
            openInterval = venueState?.currentIntervalId
              ? await ctx.db.get(venueState.currentIntervalId)
              : null;
            if (!openInterval || openInterval.status !== "open" || openInterval.kind !== "venue") {
              decision = {
                outcome: "needs_review",
                reasonCode: "venue_interval_missing",
                previousState: venueState?.state ?? "not_arrived",
                nextState: "unknown",
              };
            }
          } else if (venueState?.currentIntervalId !== undefined) {
            decision = {
              outcome: "needs_review",
              reasonCode: "venue_interval_already_open",
              previousState: venueState.state,
              nextState: "unknown",
            };
          }
        }
      }
    }

    let offlineReplayConflict = false;
    if (args.isOfflineReplay && decision?.outcome === "accepted") {
      const priorEventId = usesSession
        ? sessionParticipant?.lastEventId
        : venueState?.lastEventId;
      const priorEvent = priorEventId ? await ctx.db.get(priorEventId) : null;
      if (priorEventId && (!priorEvent || priorEvent.eventId !== event._id)) {
        throw new Error("The latest attendance projection event is invalid.");
      }
      offlineReplayConflict = offlineReplayConflictsWithNewerEvidence({
        capturedAt: args.capturedAt,
        proposedOutcome: decision.outcome,
        priorEvent,
      });
      if (offlineReplayConflict) {
        decision = {
          outcome: "needs_review",
          reasonCode: "offline_replay_conflicts_with_newer_state",
          previousState: decision.previousState,
          nextState: decision.previousState,
        };
      }
    }

    const outcome: Outcome =
      decision?.outcome ??
      (rejectionReason === "offline_scan_needs_reconciliation" ? "needs_review" : "rejected");
    const reasonCode = decision?.reasonCode ?? rejectionReason ?? "scan_rejected";
    const linkedEventId =
      decision?.outcome === "duplicate"
        ? (sessionParticipant?.lastEventId ?? venueState?.lastEventId)
        : undefined;
    const presenceEventId = await ctx.db.insert("attendancePresenceEvents", {
      eventId: event._id,
      sourceKind: "scanner",
      stationId: station._id,
      stationConfigurationVersion: station.configurationVersion,
      zoneId: station.zoneId,
      ...(station.sessionId !== undefined ? { sessionId: station.sessionId } : {}),
      deviceInstallationId: device._id,
      operatorPersonId: person._id,
      ...(membership ? { membershipId: membership._id } : {}),
      ...(resolved.resolved && resolved.credentialId !== undefined
        ? { credentialId: resolved.credentialId }
        : {}),
      ...(resolved.resolved && resolved.portalQrTokenId !== undefined
        ? { portalQrTokenId: resolved.portalQrTokenId }
        : {}),
      credentialKind: args.credentialKind,
      clientOperationId: args.clientOperationId,
      requestFingerprint,
      deviceSequence: args.deviceSequence,
      capturedAt: args.capturedAt,
      receivedAt: now,
      isOfflineReplay: args.isOfflineReplay,
      transition,
      outcome,
      reasonCode,
      ...(decision ? { previousState: decision.previousState, nextState: decision.nextState } : {}),
      ...(linkedEventId !== undefined ? { linkedEventId } : {}),
    });

    if (
      !offlineReplayConflict &&
      membership &&
      decision &&
      (decision.outcome === "accepted" || decision.outcome === "needs_review")
    ) {
      if (usesSession && sessionParticipant && station.sessionId) {
        if (!attendanceSession || attendanceSession._id !== station.sessionId) {
          throw new Error("Attendance session disappeared during scan.");
        }
        await applySessionTransitionProjection(ctx, {
          eventId: event._id,
          session: attendanceSession,
          participant: sessionParticipant,
          membershipId: membership._id,
          zoneId: station.zoneId,
          transition,
          decision: {
            outcome: decision.outcome,
            reasonCode: decision.reasonCode,
            previousState: sessionParticipant.state,
            nextState:
              decision.nextState === "not_expected" ||
              decision.nextState === "confirmation_due" ||
              decision.nextState === "present" ||
              decision.nextState === "temporarily_out" ||
              decision.nextState === "complete" ||
              decision.nextState === "excused" ||
              decision.nextState === "needs_review"
                ? decision.nextState
                : "needs_review",
          },
          openInterval,
          presenceEventId,
          effectiveAt,
          updatedAt: now,
        });
      }
      if (!usesSession) {
        let currentIntervalId = venueState?.currentIntervalId;
        if (decision.outcome === "accepted" && transition === "venue_entry") {
          currentIntervalId = await ctx.db.insert("attendancePresenceIntervals", {
            eventId: event._id,
            membershipId: membership._id,
            zoneId: station.zoneId,
            kind: "venue",
            status: "open",
            openedByEventId: presenceEventId,
            openedAt: effectiveAt,
          });
        }
        if (decision.outcome === "accepted" && transition === "venue_exit" && openInterval) {
          await ctx.db.patch(openInterval._id, {
            status: "closed",
            closedByEventId: presenceEventId,
            closedAt: effectiveAt,
          });
          currentIntervalId = undefined;
        }
        const nextVenueState = venueProjectionState(decision.nextState);
        if (venueState) {
          await ctx.db.patch(venueState._id, {
            state: nextVenueState,
            ...(nextVenueState === "inside" ? { zoneId: station.zoneId } : {}),
            currentIntervalId,
            lastEventId: presenceEventId,
            version: venueState.version + 1,
            updatedAt: now,
          });
        } else {
          await ctx.db.insert("attendanceVenueStates", {
            eventId: event._id,
            membershipId: membership._id,
            state: nextVenueState,
            ...(nextVenueState === "inside" ? { zoneId: station.zoneId } : {}),
            ...(currentIntervalId !== undefined ? { currentIntervalId } : {}),
            lastEventId: presenceEventId,
            version: 1,
            updatedAt: now,
          });
        }
        await moveZoneCounter(ctx, {
          eventId: event._id,
          zoneId: station.zoneId,
          membershipId: membership._id,
          previousState: venueState?.state ?? "not_arrived",
          nextState: nextVenueState,
          now,
        });
        await moveAttendanceTeamAvailability(ctx, {
          eventId: event._id,
          membershipId: membership._id,
          previousState: venueState?.state ?? "not_arrived",
          nextState: nextVenueState,
          now,
        });
        const nextZoneId = nextVenueState === "inside" ? station.zoneId : venueState?.zoneId;
        await updateActiveRollCallsForVenueChange(ctx, {
          eventId: event._id,
          membershipId: membership._id,
          previousVenue: venueState
            ? {
                state: venueState.state,
                ...(venueState.zoneId !== undefined ? { zoneId: venueState.zoneId } : {}),
              }
            : null,
          nextVenue: {
            state: nextVenueState,
            ...(nextZoneId !== undefined ? { zoneId: nextZoneId } : {}),
          },
          now,
        });
      }
    }
    if (
      resolved.resolved &&
      resolved.portalQrTokenId !== undefined
    ) {
      await consumePortalQrToken(ctx, {
        tokenId: resolved.portalQrTokenId,
        membershipId: resolved.membershipId,
        usedAt: now,
        purpose: "attendance_scan",
        presenceEventId,
      });
    }
    await ctx.db.patch(device._id, {
      lastSeenAt: now,
      lastSequence: Math.max(device.lastSequence ?? 0, args.deviceSequence),
    });
    const presenceEvent = await ctx.db.get(presenceEventId);
    if (!presenceEvent) throw new Error("Presence event did not persist.");
    return receiptForEvent(ctx, presenceEvent);
  },
});
