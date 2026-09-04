import { ConvexError, type Infer, v } from "convex/values";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { requireAssignedDevice, requireStationPermission } from "./lib/attendance";
import { appendAttendanceDeviceReadFactById } from "./lib/operationsAutonomyReadFacts/attendanceOperations";
import { moveZoneCounter } from "./lib/attendanceCounters";
import { moveAttendanceTeamAvailability } from "./lib/attendanceTeamAvailability";
import {
  offlineReplayConflictsWithNewerEvidence,
  offlineReplayTimeRejection,
  scannerCaptureFutureToleranceMs,
} from "./lib/attendanceOfflineReplay";
import { updateActiveRollCallsForVenueChange } from "./lib/attendanceRollCalls";
import {
  applySessionTransitionProjection,
  prepareSessionTransition,
} from "./lib/attendanceSessionTransition";
import { attendanceSessionWindowRejection } from "./lib/attendanceSessionLifecycle";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
} from "./lib/operations";
import { attendanceScanTransition, attendanceStationMode } from "./values";

type Transition = Infer<typeof attendanceScanTransition>;
type StationMode = Infer<typeof attendanceStationMode>;
type VenueTransition = Extract<Transition, "venue_entry" | "venue_exit">;
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
  transition: attendanceScanTransition,
  previousState: v.optional(v.string()),
  nextState: v.optional(v.string()),
  participant: v.union(
    v.null(),
    v.object({
      membershipId: v.id("eventMemberships"),
      displayName: v.string(),
      teamName: v.optional(v.string()),
      /* Printed profile fields distinguish people who share a name. */
      vitRegistrationNumber: v.optional(v.string()),
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
    vitRegistrationNumber?: string;
  };
};

const scanReceiptOperationResult = z
  .object({
    outcome: z.enum(["accepted", "duplicate", "rejected", "needs_review"]),
    reasonCode: z.string(),
    serverTime: z.number().int().nonnegative(),
    transition: z.enum(["venue_entry", "venue_exit", "session_confirm", "zone_entry", "zone_exit"]),
    previousState: z.string().optional(),
    nextState: z.string().optional(),
    participantMembershipId: z.string().min(1).nullable(),
  })
  .strict();

function scanReceiptResultJson(result: Receipt) {
  return JSON.stringify({
    outcome: result.outcome,
    reasonCode: result.reasonCode,
    serverTime: result.serverTime,
    transition: result.transition,
    ...(result.previousState !== undefined ? { previousState: result.previousState } : {}),
    ...(result.nextState !== undefined ? { nextState: result.nextState } : {}),
    participantMembershipId: result.participant?.membershipId ?? null,
  });
}

async function storedScanReceipt(
  ctx: MutationCtx,
  targetId: string,
  resultJson: string | undefined,
): Promise<Receipt> {
  const presenceEventId = ctx.db.normalizeId("attendancePresenceEvents", targetId);
  if (!presenceEventId) throw new Error("The stored attendance scan result is invalid.");
  const stored = storedOperationResult(resultJson, "attendance scan", scanReceiptOperationResult);
  const membershipId = stored.participantMembershipId
    ? ctx.db.normalizeId("eventMemberships", stored.participantMembershipId)
    : null;
  if (stored.participantMembershipId && !membershipId) {
    throw new Error("The stored attendance scan result is invalid.");
  }
  const participant = membershipId ? await participantForReceipt(ctx, membershipId) : null;
  return {
    presenceEventId,
    outcome: stored.outcome,
    reasonCode: stored.reasonCode,
    serverTime: stored.serverTime,
    transition: stored.transition,
    ...(stored.previousState !== undefined ? { previousState: stored.previousState } : {}),
    ...(stored.nextState !== undefined ? { nextState: stored.nextState } : {}),
    participant,
  };
}

function venueDecision(state: VenueState, transition: VenueTransition): Decision {
  if (transition === "venue_entry") {
    if (state === "inside") {
      return {
        outcome: "duplicate",
        reasonCode: "already_inside",
        previousState: state,
        nextState: state,
      };
    }
    if (state === "unknown") {
      return {
        outcome: "needs_review",
        reasonCode: "venue_state_unknown",
        previousState: state,
        nextState: state,
      };
    }
    return {
      outcome: "accepted",
      reasonCode: "venue_entry_recorded",
      previousState: state,
      nextState: "inside",
    };
  }
  if (state === "inside") {
    return {
      outcome: "accepted",
      reasonCode: "venue_exit_recorded",
      previousState: state,
      nextState: "temporarily_out",
    };
  }
  if (state === "temporarily_out" || state === "departed") {
    return {
      outcome: "duplicate",
      reasonCode: "already_outside",
      previousState: state,
      nextState: state,
    };
  }
  return {
    outcome: "needs_review",
    reasonCode: "exit_without_entry",
    previousState: state,
    nextState: "unknown",
  };
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

function stationTransition(
  mode: StationMode,
  rovingTransition: Transition | undefined,
): Transition {
  if (mode === "roving") {
    if (rovingTransition === undefined) {
      throw new ConvexError({
        code: "ROVING_TRANSITION_REQUIRED",
        message: "Choose the roving station's transition before scanning.",
      });
    }
    return rovingTransition;
  }
  if (rovingTransition !== undefined) {
    throw new ConvexError({
      code: "STATION_TRANSITION_FIXED",
      message: "This station's transition is fixed by its configuration.",
    });
  }
  return mode;
}

async function resolveCredential(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    credentialKind: "vit_id_barcode" | "badge_qr" | "external_pass";
    lookupHash: string;
  },
): Promise<CredentialResolution> {
  if (args.credentialKind === "external_pass") {
    const pass = await ctx.db
      .query("attendanceExternalPasses")
      .withIndex("by_event_lookup", (index) =>
        index.eq("eventId", args.eventId).eq("lookupHash", args.lookupHash),
      )
      .unique();
    if (!pass || pass.state !== "active") {
      return { resolved: false, reasonCode: "external_pass_invalid" };
    }
    const identityBinding = await ctx.db
      .query("attendanceExternalIdentityBindings")
      .withIndex("by_membership", (index) => index.eq("membershipId", pass.membershipId))
      .unique();
    if (
      !identityBinding ||
      identityBinding.eventId !== args.eventId ||
      identityBinding.state !== "active"
    ) {
      return { resolved: false, reasonCode: "external_identity_not_verified" };
    }
    return {
      resolved: true,
      membershipId: pass.membershipId,
    };
  }
  const matches = await ctx.db
    .query("attendanceCredentials")
    .withIndex("by_event_lookup", (index) =>
      index.eq("eventId", args.eventId).eq("lookupHash", args.lookupHash),
    )
    .collect();
  const expectedKind = args.credentialKind === "vit_id_barcode" ? "vit_id_barcode" : "badge_qr";
  const active = matches.filter(
    (credential) => credential.kind === expectedKind && credential.state === "active",
  );
  if (active.length > 1) {
    throw new ConvexError({
      code: "CREDENTIAL_CONFLICT",
      message: "Two credentials answer to this card. Send the participant to the help desk.",
    });
  }
  const credential = active[0];
  if (!credential) return { resolved: false, reasonCode: "credential_not_found" };
  return {
    resolved: true,
    membershipId: credential.membershipId,
    credentialId: credential._id,
  };
}

async function participantForReceipt(ctx: MutationCtx, membershipId: Id<"eventMemberships">) {
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
    displayName: profile?.fullName ?? person.displayName,
    ...(team ? { teamName: team.name } : {}),
    ...(profile?.vitRegistrationNumber
      ? { vitRegistrationNumber: profile.vitRegistrationNumber }
      : {}),
  };
}

async function receiptForEvent(
  ctx: MutationCtx,
  event: Doc<"attendancePresenceEvents">,
): Promise<Receipt> {
  if (event.transition === "manual_reconcile" || event.outcome === "reconciled") {
    throw new ConvexError({
      code: "RECEIPT_KIND_MISMATCH",
      message:
        "This scan was resolved by operations, not a door. Check the operations dashboard for the outcome.",
    });
  }
  return {
    presenceEventId: event._id,
    outcome: event.outcome,
    reasonCode: event.reasonCode,
    serverTime: event.receivedAt,
    transition: event.transition,
    ...(event.previousState !== undefined ? { previousState: event.previousState } : {}),
    ...(event.nextState !== undefined ? { nextState: event.nextState } : {}),
    participant: event.membershipId ? await participantForReceipt(ctx, event.membershipId) : null,
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
      v.literal("external_pass"),
    ),
    lookupHash: v.string(),
    rovingTransition: v.optional(attendanceScanTransition),
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
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.scan.record",
      requestFingerprint,
    });
    if (prior) {
      return storedScanReceipt(ctx, prior.targetId, prior.resultJson);
    }
    if (!Number.isSafeInteger(args.deviceSequence) || args.deviceSequence < 1) {
      throw new ConvexError({
        code: "INVALID_DEVICE_SEQUENCE",
        message: "Scanner sequence is invalid.",
      });
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
        index.eq("deviceInstallationId", device._id).eq("deviceSequence", args.deviceSequence),
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
      throw new ConvexError({
        code: "STATION_NOT_ACTIVE",
        message: "This station assignment is not active.",
      });
    }
    if (!station.allowedCredentialKinds.includes(args.credentialKind)) {
      throw new ConvexError({
        code: "CREDENTIAL_NOT_ALLOWED_AT_STATION",
        message: "This credential method is not enabled at this station.",
      });
    }
    const transition = stationTransition(station.mode, args.rovingTransition);
    const usesSession =
      transition === "session_confirm" || transition === "zone_entry" || transition === "zone_exit";
    if (usesSession && station.sessionId === undefined) {
      throw new ConvexError({
        code: "STATION_SESSION_REQUIRED",
        message: "This transition requires a session-bound station.",
      });
    }
    const resolved = await resolveCredential(ctx, {
      eventId: event._id,
      credentialKind: args.credentialKind,
      lookupHash: args.lookupHash,
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
        const session =
          station.sessionId === undefined ? null : await ctx.db.get(station.sessionId);
        attendanceSession = session;
        if (
          !session ||
          session.eventId !== event._id ||
          session.planVersionId !== station.planVersionId ||
          session.zoneId !== station.zoneId ||
          session.status !== "open"
        ) {
          rejectionReason = args.isOfflineReplay
            ? "offline_scan_needs_reconciliation"
            : "session_not_open";
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
      const priorEventId = usesSession ? sessionParticipant?.lastEventId : venueState?.lastEventId;
      const priorEvent = priorEventId ? await ctx.db.get(priorEventId) : null;
      if (priorEventId && (!priorEvent || priorEvent.eventId !== event._id)) {
        throw new ConvexError({
          code: "ATTENDANCE_STATE_CORRUPT",
          message:
            "This participant's attendance history is inconsistent. Operations needs to reconcile it before more scans.",
        });
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
      ...(attendanceSession ? { sessionId: attendanceSession._id } : {}),
      deviceInstallationId: device._id,
      operatorPersonId: person._id,
      ...(membership ? { membershipId: membership._id } : {}),
      ...(resolved.resolved && resolved.credentialId !== undefined
        ? { credentialId: resolved.credentialId }
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
      if (usesSession && sessionParticipant && attendanceSession) {
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
        const previousZoneId = venueState?.zoneId;
        const nextZoneId =
          nextVenueState === "inside"
            ? station.zoneId
            : nextVenueState === "unknown"
              ? (previousZoneId ?? station.zoneId)
              : undefined;
        if (venueState) {
          await ctx.db.patch(venueState._id, {
            state: nextVenueState,
            ...(nextZoneId !== undefined ? { zoneId: nextZoneId } : {}),
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
            ...(nextZoneId !== undefined ? { zoneId: nextZoneId } : {}),
            ...(currentIntervalId !== undefined ? { currentIntervalId } : {}),
            lastEventId: presenceEventId,
            version: 1,
            updatedAt: now,
          });
        }
        await moveZoneCounter(ctx, {
          eventId: event._id,
          membershipId: membership._id,
          previousState: venueState?.state ?? "not_arrived",
          ...(previousZoneId !== undefined ? { previousZoneId } : {}),
          nextState: nextVenueState,
          ...(nextZoneId !== undefined ? { nextZoneId } : {}),
          now,
        });
        await moveAttendanceTeamAvailability(ctx, {
          eventId: event._id,
          membershipId: membership._id,
          previousState: venueState?.state ?? "not_arrived",
          nextState: nextVenueState,
          now,
        });
        const rollCallZoneId = nextZoneId ?? venueState?.zoneId;
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
            ...(rollCallZoneId !== undefined ? { zoneId: rollCallZoneId } : {}),
          },
          now,
        });
      }
    }
    await ctx.db.patch(device._id, {
      lastSeenAt: now,
      lastSequence: Math.max(device.lastSequence ?? 0, args.deviceSequence),
    });
    await appendAttendanceDeviceReadFactById(ctx, device._id, now);
    const presenceEvent = await ctx.db.get(presenceEventId);
    if (!presenceEvent) {
      throw new ConvexError({
        code: "SCAN_NOT_SAVED",
        message: "The scan did not save. Scan the same card again.",
      });
    }
    const result = await receiptForEvent(ctx, presenceEvent);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.scan.record",
      requestFingerprint,
      targetType: "attendance_presence_event",
      targetId: presenceEventId,
      resultJson: scanReceiptResultJson(result),
      createdAt: now,
    });
    return result;
  },
});
