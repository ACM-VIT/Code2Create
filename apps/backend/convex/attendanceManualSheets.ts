import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import {
  applySessionTransitionProjection,
  prepareSessionTransition,
  type AttendanceTransitionOutcome,
  type SessionTransitionDecision,
} from "./lib/attendanceSessionTransition";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  type OperationFingerprintPart,
} from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedText, optionalNormalizedText } from "./lib/strings";
import { attendanceManualTransition } from "./values";

const maximumSheetEntries = 25;
const maximumSourceBytes = 900_000;
const allowedSourceContentType = "image/jpeg";
const readyUploadKind: "ready" = "ready";
const completeUploadKind: "complete" = "complete";
const rejectedSheetStatus: "rejected" = "rejected";

const draftEntry = v.object({
  lineNumber: v.number(),
  participantReference: v.string(),
  capturedAt: v.number(),
  operatorInitials: v.string(),
  correctionReason: v.optional(v.string()),
});

const sheetEntryView = v.object({
  lineNumber: v.number(),
  membershipId: v.id("eventMemberships"),
  participantReference: v.string(),
  referenceKind: v.union(
    v.literal("participant_reference"),
    v.literal("vit_registration_number"),
    v.literal("badge_reference"),
  ),
  participantName: v.string(),
  capturedAt: v.number(),
  operatorInitials: v.string(),
  correctionReason: v.optional(v.string()),
});

const importSummary = v.object({
  accepted: v.number(),
  duplicate: v.number(),
  rejected: v.number(),
  needsReview: v.number(),
});

const sheetView = v.object({
  id: v.id("attendanceManualSheets"),
  incidentId: v.id("incidents"),
  incidentTitle: v.string(),
  stationId: v.id("attendanceStations"),
  stationName: v.string(),
  serial: v.string(),
  revision: v.number(),
  transition: attendanceManualTransition,
  entries: v.array(sheetEntryView),
  status: v.union(
    v.literal("draft"),
    v.literal("submitted"),
    v.literal("imported"),
    v.literal("needs_review"),
    v.literal("rejected"),
    v.literal("cancelled"),
  ),
  enteredByPersonId: v.id("people"),
  enteredByName: v.string(),
  enteredAt: v.number(),
  submittedAt: v.optional(v.number()),
  hasSource: v.boolean(),
  sourceFileName: v.optional(v.string()),
  sourceByteCount: v.optional(v.number()),
  verifiedByName: v.optional(v.string()),
  verifiedAt: v.optional(v.number()),
  importSummary: v.optional(importSummary),
  rejectionReason: v.optional(v.string()),
  cancellationReason: v.optional(v.string()),
  version: v.number(),
  canUploadSource: v.boolean(),
  canVerify: v.boolean(),
  canReadSource: v.boolean(),
});

type ReferenceKind = Doc<"attendanceManualSheets">["entries"][number]["referenceKind"];
type ResolvedReference = {
  membership: Doc<"eventMemberships">;
  referenceKind: ReferenceKind;
  participantName: string;
};

function normalizedSerial(value: string) {
  const serial = normalizedText(value, "Sheet serial", 3, 32).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(serial)) {
    throw new ConvexError({
      code: "INVALID_SHEET_SERIAL",
      message: "Use the serial printed on the incident sheet.",
    });
  }
  return serial;
}

async function resolveReference(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    sessionId: Id<"attendanceSessions">;
    reference: string;
  },
): Promise<ResolvedReference> {
  const reference = normalizedText(args.reference, "Participant reference", 3, 100);
  const candidates: Array<{
    membershipId: Id<"eventMemberships">;
    referenceKind: ReferenceKind;
  }> = [];
  const membershipId = ctx.db.normalizeId("eventMemberships", reference);
  if (membershipId) {
    const membership = await ctx.db.get(membershipId);
    if (membership?.eventId === args.eventId) {
      candidates.push({ membershipId: membership._id, referenceKind: "participant_reference" });
    }
  }
  const profiles = await ctx.db
    .query("participantProfiles")
    .withIndex("by_event_vit_registration", (index) =>
      index.eq("eventId", args.eventId).eq("vitRegistrationNumber", reference),
    )
    .collect();
  for (const profile of profiles) {
    candidates.push({
      membershipId: profile.membershipId,
      referenceKind: "vit_registration_number",
    });
  }
  const credentials = await ctx.db
    .query("attendanceCredentials")
    .withIndex("by_event_badge_reference", (index) =>
      index.eq("eventId", args.eventId).eq("badgeReference", reference),
    )
    .collect();
  for (const credential of credentials) {
    if (credential.kind === "badge_qr" && credential.state === "active") {
      candidates.push({
        membershipId: credential.membershipId,
        referenceKind: "badge_reference",
      });
    }
  }
  const distinct = candidates.filter(
    (candidate, index) =>
      candidates.findIndex((value) => value.membershipId === candidate.membershipId) === index,
  );
  const candidate = distinct[0];
  if (distinct.length !== 1 || !candidate) {
    throw new ConvexError({
      code: distinct.length === 0 ? "PARTICIPANT_REFERENCE_NOT_FOUND" : "PARTICIPANT_REFERENCE_AMBIGUOUS",
      message:
        distinct.length === 0
          ? "No accepted participant matches that exact event, VIT registration, or badge reference."
          : "That reference matches more than one participant. Use the participant reference instead.",
    });
  }
  const [membership, sessionParticipant] = await Promise.all([
    ctx.db.get(candidate.membershipId),
    ctx.db
      .query("attendanceSessionParticipants")
      .withIndex("by_session_membership", (index) =>
        index.eq("sessionId", args.sessionId).eq("membershipId", candidate.membershipId),
      )
      .unique(),
  ]);
  if (
    !membership ||
    membership.eventId !== args.eventId ||
    membership.eligibilityStatus !== "eligible" ||
    membership.onboardingStatus !== "accepted" ||
    !sessionParticipant ||
    sessionParticipant.eventId !== args.eventId
  ) {
    throw new ConvexError({
      code: "PARTICIPANT_NOT_IN_SESSION",
      message: "That reference is not an active participant in the session's frozen cohort.",
    });
  }
  const [person, profile] = await Promise.all([
    ctx.db.get(membership.personId),
    ctx.db
      .query("participantProfiles")
      .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
      .unique(),
  ]);
  if (!person) throw new Error("Manual-sheet participant identity no longer resolves.");
  return {
    membership,
    referenceKind: candidate.referenceKind,
    participantName: profile?.preferredName ?? profile?.fullName ?? person.displayName,
  };
}

export const forSession = query({
  args: { eventSlug: v.string(), sessionId: v.id("attendanceSessions") },
  returns: v.object({
    currentPersonId: v.id("people"),
    canEnter: v.boolean(),
    canVerify: v.boolean(),
    canReadSource: v.boolean(),
    stations: v.array(
      v.object({
        id: v.id("attendanceStations"),
        name: v.string(),
        configurationVersion: v.number(),
      }),
    ),
    sheets: v.array(sheetView),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "SESSION_NOT_FOUND", message: "Attendance session not found." });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.manual_sheet.read",
      scopeType: "attendance_session",
      scopeId: session._id,
    });
    const [enterGrants, verifyGrants, sourceGrants, sheets, stations] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "attendance.manual_sheet.enter",
        scopeType: "attendance_session",
        scopeId: session._id,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "attendance.manual_sheet.verify",
        scopeType: "attendance_session",
        scopeId: session._id,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "attendance.manual_sheet.source.read",
        scopeType: "attendance_session",
        scopeId: session._id,
      }),
      ctx.db
        .query("attendanceManualSheets")
        .withIndex("by_session_created", (index) => index.eq("sessionId", session._id))
        .order("desc")
        .take(30),
      ctx.db
        .query("attendanceStations")
        .withIndex("by_plan_key", (index) => index.eq("planVersionId", session.planVersionId))
        .collect(),
    ]);
    const sheetViews = [];
    for (const sheet of sheets) {
      const [incident, station, enteredBy, verifiedBy] = await Promise.all([
        ctx.db.get(sheet.incidentId),
        ctx.db.get(sheet.stationId),
        ctx.db.get(sheet.enteredByPersonId),
        sheet.verifiedByPersonId
          ? ctx.db.get(sheet.verifiedByPersonId)
          : Promise.resolve(null),
      ]);
      if (!incident || !station || !enteredBy) continue;
      sheetViews.push({
        id: sheet._id,
        incidentId: incident._id,
        incidentTitle: incident.title,
        stationId: station._id,
        stationName: station.name,
        serial: sheet.serial,
        revision: sheet.revision,
        transition: sheet.transition,
        entries: sheet.entries,
        status: sheet.status,
        enteredByPersonId: sheet.enteredByPersonId,
        enteredByName: enteredBy.displayName,
        enteredAt: sheet.enteredAt,
        ...(sheet.submittedAt !== undefined ? { submittedAt: sheet.submittedAt } : {}),
        hasSource: sheet.sourceStorageId !== undefined,
        ...(sheet.sourceFileName !== undefined ? { sourceFileName: sheet.sourceFileName } : {}),
        ...(sheet.sourceByteCount !== undefined ? { sourceByteCount: sheet.sourceByteCount } : {}),
        ...(verifiedBy ? { verifiedByName: verifiedBy.displayName } : {}),
        ...(sheet.verifiedAt !== undefined ? { verifiedAt: sheet.verifiedAt } : {}),
        ...(sheet.importSummary !== undefined ? { importSummary: sheet.importSummary } : {}),
        ...(sheet.rejectionReason !== undefined ? { rejectionReason: sheet.rejectionReason } : {}),
        ...(sheet.cancellationReason !== undefined
          ? { cancellationReason: sheet.cancellationReason }
          : {}),
        version: sheet.version,
        canUploadSource:
          enterGrants.length > 0 &&
          sheet.enteredByPersonId === person._id &&
          sheet.status === "draft",
        canVerify:
          verifyGrants.length > 0 &&
          sourceGrants.length > 0 &&
          sheet.enteredByPersonId !== person._id &&
          sheet.status === "submitted",
        canReadSource: sourceGrants.length > 0 && sheet.sourceStorageId !== undefined,
      });
    }
    return {
      currentPersonId: person._id,
      canEnter: enterGrants.length > 0,
      canVerify: verifyGrants.length > 0 && sourceGrants.length > 0,
      canReadSource: sourceGrants.length > 0,
      stations: stations
        .filter((station) => station.zoneId === session.zoneId)
        .map((station) => ({
          id: station._id,
          name: station.name,
          configurationVersion: station.configurationVersion,
        })),
      sheets: sheetViews,
    };
  },
});

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    incidentId: v.id("incidents"),
    sessionId: v.id("attendanceSessions"),
    stationId: v.id("attendanceStations"),
    expectedIncidentVersion: v.number(),
    expectedSessionVersion: v.number(),
    serial: v.string(),
    transition: attendanceManualTransition,
    entries: v.array(draftEntry),
    clientOperationId: v.string(),
  },
  returns: v.object({ id: v.id("attendanceManualSheets"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const serial = normalizedSerial(args.serial);
    if (args.entries.length < 1 || args.entries.length > maximumSheetEntries) {
      throw new ConvexError({
        code: "SHEET_ENTRY_COUNT_INVALID",
        message: `A numbered paper sheet must contain between 1 and ${maximumSheetEntries} rows.`,
      });
    }
    const fingerprintParts: OperationFingerprintPart[] = [
      args.incidentId,
      args.sessionId,
      args.stationId,
      args.expectedIncidentVersion,
      args.expectedSessionVersion,
      serial,
      args.transition,
    ];
    for (const entry of args.entries) {
      fingerprintParts.push(
        entry.lineNumber,
        entry.participantReference,
        entry.capturedAt,
        entry.operatorInitials,
        entry.correctionReason ?? null,
      );
    }
    const requestFingerprint = operationFingerprint(fingerprintParts);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.manual_sheet.create",
      requestFingerprint,
    });
    if (prior) {
      const sheetId = ctx.db.normalizeId("attendanceManualSheets", prior.targetId);
      const sheet = sheetId ? await ctx.db.get(sheetId) : null;
      if (!sheet || sheet.eventId !== event._id) {
        throw new Error("Prior manual-sheet draft no longer resolves.");
      }
      return { id: sheet._id, version: sheet.version };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const [incident, session, station] = await Promise.all([
      ctx.db.get(args.incidentId),
      ctx.db.get(args.sessionId),
      ctx.db.get(args.stationId),
    ]);
    if (!incident || incident.eventId !== event._id) {
      throw new ConvexError({ code: "INCIDENT_NOT_FOUND", message: "Incident not found." });
    }
    if (
      incident.version !== args.expectedIncidentVersion ||
      incident.state === "resolved" ||
      incident.manualModeState !== "approved" ||
      incident.manualModeApprovalCount !== 2
    ) {
      throw new ConvexError({
        code: "MANUAL_MODE_NOT_APPROVED",
        message: "This incident needs two current manual-mode approvals before paper entry.",
      });
    }
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "SESSION_NOT_FOUND", message: "Attendance session not found." });
    }
    if (
      session.version !== args.expectedSessionVersion ||
      session.status !== "open" ||
      session.openedAt === undefined
    ) {
      throw new ConvexError({
        code: "SESSION_NOT_OPEN",
        message: "Paper attendance must be entered and verified before this open session begins closing.",
      });
    }
    if (
      !station ||
      station.eventId !== event._id ||
      station.zoneId !== session.zoneId
    ) {
      throw new ConvexError({
        code: "STATION_NOT_IN_SESSION",
        message: "Choose a station in the same area as this session.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.manual_sheet.enter",
      scopeType: "attendance_session",
      scopeId: session._id,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);

    const now = Date.now();
    const earliestCapturedAt = Math.max(session.openedAt, incident.openedAt - 15 * 60_000);
    const lineNumbers = new Set<number>();
    const membershipIds = new Set<string>();
    const resolvedEntries: Doc<"attendanceManualSheets">["entries"] = [];
    for (const entry of args.entries) {
      if (
        !Number.isSafeInteger(entry.lineNumber) ||
        entry.lineNumber < 1 ||
        entry.lineNumber > maximumSheetEntries ||
        lineNumbers.has(entry.lineNumber)
      ) {
        throw new ConvexError({
          code: "SHEET_LINE_INVALID",
          message: "Paper line numbers must be unique whole numbers from 1 through 25.",
        });
      }
      if (
        !Number.isSafeInteger(entry.capturedAt) ||
        entry.capturedAt < earliestCapturedAt ||
        entry.capturedAt > now + 5 * 60_000
      ) {
        throw new ConvexError({
          code: "SHEET_TIME_INVALID",
          message: "Each paper time must fall inside the open session and approved incident window.",
        });
      }
      lineNumbers.add(entry.lineNumber);
      const resolved = await resolveReference(ctx, {
        eventId: event._id,
        sessionId: session._id,
        reference: entry.participantReference,
      });
      if (membershipIds.has(resolved.membership._id)) {
        throw new ConvexError({
          code: "PARTICIPANT_REPEATED_ON_SHEET",
          message: "Use one line per participant on a single-direction paper sheet.",
        });
      }
      membershipIds.add(resolved.membership._id);
      const participantReference = normalizedText(
        entry.participantReference,
        "Participant reference",
        3,
        100,
      );
      const operatorInitials = normalizedText(entry.operatorInitials, "Operator initials", 1, 12);
      const correctionReason = optionalNormalizedText(
        entry.correctionReason,
        "Correction reason",
        200,
      );
      resolvedEntries.push({
        lineNumber: entry.lineNumber,
        membershipId: resolved.membership._id,
        participantReference,
        referenceKind: resolved.referenceKind,
        participantName: resolved.participantName,
        capturedAt: entry.capturedAt,
        operatorInitials,
        ...(correctionReason !== undefined ? { correctionReason } : {}),
      });
    }
    resolvedEntries.sort((left, right) => left.lineNumber - right.lineNumber);
    const revisions = await ctx.db
      .query("attendanceManualSheets")
      .withIndex("by_event_serial_revision", (index) =>
        index.eq("eventId", event._id).eq("serial", serial),
      )
      .collect();
    if (revisions.some((sheet) => sheet.status !== "rejected" && sheet.status !== "cancelled")) {
      throw new ConvexError({
        code: "SHEET_SERIAL_ALREADY_USED",
        message: "That paper serial already has an active or completed import record.",
      });
    }
    const revision = revisions.reduce((highest, sheet) => Math.max(highest, sheet.revision), 0) + 1;
    const sheetId = await ctx.db.insert("attendanceManualSheets", {
      eventId: event._id,
      incidentId: incident._id,
      sessionId: session._id,
      zoneId: session.zoneId,
      stationId: station._id,
      stationConfigurationVersion: station.configurationVersion,
      serial,
      revision,
      transition: args.transition,
      entries: resolvedEntries,
      status: "draft",
      enteredByPersonId: person._id,
      enteredAt: now,
      version: 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.manual_sheet.create",
      requestFingerprint,
      targetType: "attendance_manual_sheet",
      targetId: sheetId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.manual_sheet.enter",
      grantIds,
      scopeType: "attendance_session",
      scopeId: session._id,
      action: "attendance.manual_sheet_entered",
      targetType: "attendance_manual_sheet",
      targetId: sheetId,
      nextSummary: JSON.stringify({
        incidentId: incident._id,
        serial,
        revision,
        transition: args.transition,
        rowCount: resolvedEntries.length,
        stationConfigurationVersion: station.configurationVersion,
      }),
      reason: "Entered a numbered paper attendance sheet after approved manual mode",
    });
    return { id: sheetId, version: 1 };
  },
});

export const sourceUploadContext = query({
  args: {
    eventSlug: v.string(),
    sheetId: v.id("attendanceManualSheets"),
    expectedSheetVersion: v.number(),
  },
  returns: v.union(
    v.object({ kind: v.literal("ready") }),
    v.object({ kind: v.literal("complete"), version: v.number() }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const sheet = await ctx.db.get(args.sheetId);
    if (!sheet || sheet.eventId !== event._id) {
      throw new ConvexError({ code: "SHEET_NOT_FOUND", message: "Paper sheet not found." });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.manual_sheet.enter",
      scopeType: "attendance_session",
      scopeId: sheet.sessionId,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    if (sheet.enteredByPersonId !== person._id) {
      throw new ConvexError({
        code: "SHEET_OWNER_REQUIRED",
        message: "Only the person who entered this draft may attach its source image.",
      });
    }
    if (sheet.status === "submitted" && sheet.sourceStorageId !== undefined) {
      return { kind: completeUploadKind, version: sheet.version };
    }
    if (sheet.version !== args.expectedSheetVersion) {
      throw new ConvexError({ code: "SHEET_CHANGED", message: "The paper sheet changed. Refresh and try again." });
    }
    if (sheet.status !== "draft") {
      throw new ConvexError({ code: "SHEET_NOT_DRAFT", message: "This paper sheet no longer accepts a source image." });
    }
    const [incident, session] = await Promise.all([
      ctx.db.get(sheet.incidentId),
      ctx.db.get(sheet.sessionId),
    ]);
    if (
      !incident ||
      incident.eventId !== event._id ||
      incident.state === "resolved" ||
      incident.manualModeState !== "approved"
    ) {
      throw new ConvexError({ code: "MANUAL_MODE_CLOSED", message: "Manual mode is no longer open for this sheet." });
    }
    if (!session || session.eventId !== event._id || session.status !== "open") {
      throw new ConvexError({
        code: "SESSION_NOT_OPEN",
        message: "The paper source must be submitted before the session begins closing.",
      });
    }
    return { kind: readyUploadKind };
  },
});

export const attachSource = internalMutation({
  args: {
    eventSlug: v.string(),
    sheetId: v.id("attendanceManualSheets"),
    expectedSheetVersion: v.number(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    contentType: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    id: v.id("attendanceManualSheets"),
    version: v.number(),
    storageId: v.id("_storage"),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const fileName = normalizedText(args.fileName, "Source file name", 1, 120);
    if (args.contentType !== allowedSourceContentType) {
      throw new ConvexError({
        code: "SOURCE_TYPE_INVALID",
        message: "The paper source must be a compressed JPEG image.",
      });
    }
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (
      !metadata ||
      metadata.contentType !== allowedSourceContentType ||
      metadata.size < 1 ||
      metadata.size > maximumSourceBytes
    ) {
      throw new ConvexError({
        code: "SOURCE_FILE_INVALID",
        message: "The source image is missing, too large, or not a JPEG.",
      });
    }
    const requestFingerprint = operationFingerprint([
      args.sheetId,
      args.expectedSheetVersion,
      args.storageId,
      fileName,
      args.contentType,
      metadata.sha256,
      metadata.size,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.manual_sheet.submit",
      requestFingerprint,
    });
    if (prior) {
      const sheetId = ctx.db.normalizeId("attendanceManualSheets", prior.targetId);
      const sheet = sheetId ? await ctx.db.get(sheetId) : null;
      if (!sheet || !sheet.sourceStorageId || sheet.eventId !== event._id) {
        throw new Error("Prior paper-sheet submission no longer resolves.");
      }
      return { id: sheet._id, version: sheet.version, storageId: sheet.sourceStorageId };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const sheet = await ctx.db.get(args.sheetId);
    if (!sheet || sheet.eventId !== event._id) {
      throw new ConvexError({ code: "SHEET_NOT_FOUND", message: "Paper sheet not found." });
    }
    if (sheet.enteredByPersonId !== person._id) {
      throw new ConvexError({ code: "SHEET_OWNER_REQUIRED", message: "Only the draft owner may submit this sheet." });
    }
    if (sheet.version !== args.expectedSheetVersion || sheet.status !== "draft") {
      throw new ConvexError({ code: "SHEET_CHANGED", message: "The paper sheet changed. Refresh and try again." });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.manual_sheet.enter",
      scopeType: "attendance_session",
      scopeId: sheet.sessionId,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const [incident, session, reusedSource] = await Promise.all([
      ctx.db.get(sheet.incidentId),
      ctx.db.get(sheet.sessionId),
      ctx.db
        .query("attendanceManualSheets")
        .withIndex("by_source_storage", (index) => index.eq("sourceStorageId", args.storageId))
        .unique(),
    ]);
    if (reusedSource) {
      throw new ConvexError({ code: "SOURCE_ALREADY_USED", message: "That source image is already bound to a paper sheet." });
    }
    if (
      !incident ||
      incident.eventId !== event._id ||
      incident.state === "resolved" ||
      incident.manualModeState !== "approved"
    ) {
      throw new ConvexError({ code: "MANUAL_MODE_CLOSED", message: "Manual mode is no longer open for this sheet." });
    }
    if (!session || session.eventId !== event._id || session.status !== "open") {
      throw new ConvexError({
        code: "SESSION_NOT_OPEN",
        message: "The source must be submitted before the attendance session begins closing.",
      });
    }
    const now = Date.now();
    const version = sheet.version + 1;
    await ctx.db.patch(sheet._id, {
      status: "submitted",
      submittedAt: now,
      sourceStorageId: args.storageId,
      sourceFileName: fileName,
      sourceContentType: metadata.contentType,
      sourceByteCount: metadata.size,
      sourceSha256: metadata.sha256,
      version,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.manual_sheet.submit",
      requestFingerprint,
      targetType: "attendance_manual_sheet",
      targetId: sheet._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.manual_sheet.enter",
      grantIds,
      scopeType: "attendance_session",
      scopeId: sheet.sessionId,
      action: "attendance.manual_sheet_submitted",
      targetType: "attendance_manual_sheet",
      targetId: sheet._id,
      previousSummary: JSON.stringify({ status: sheet.status, version: sheet.version }),
      nextSummary: JSON.stringify({
        status: "submitted",
        version,
        sourceByteCount: metadata.size,
        sourceSha256: metadata.sha256,
      }),
      reason: "Attached the photographed paper source for independent verification",
    });
    return { id: sheet._id, version, storageId: args.storageId };
  },
});

export const cancelDraft = mutation({
  args: {
    eventSlug: v.string(),
    sheetId: v.id("attendanceManualSheets"),
    expectedSheetVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ id: v.id("attendanceManualSheets"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Cancellation reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.sheetId,
      args.expectedSheetVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.manual_sheet.cancel",
      requestFingerprint,
    });
    if (prior) {
      const sheetId = ctx.db.normalizeId("attendanceManualSheets", prior.targetId);
      const sheet = sheetId ? await ctx.db.get(sheetId) : null;
      if (!sheet || sheet.eventId !== event._id) {
        throw new Error("Prior manual-sheet cancellation no longer resolves.");
      }
      return { id: sheet._id, version: sheet.version };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const sheet = await ctx.db.get(args.sheetId);
    if (!sheet || sheet.eventId !== event._id) {
      throw new ConvexError({ code: "SHEET_NOT_FOUND", message: "Paper sheet not found." });
    }
    if (
      sheet.enteredByPersonId !== person._id ||
      sheet.version !== args.expectedSheetVersion ||
      sheet.status !== "draft"
    ) {
      throw new ConvexError({
        code: "SHEET_NOT_CANCELLABLE",
        message: "Only the current owner can cancel an unchanged draft before source submission.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.manual_sheet.enter",
      scopeType: "attendance_session",
      scopeId: sheet.sessionId,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const now = Date.now();
    const version = sheet.version + 1;
    await ctx.db.patch(sheet._id, {
      status: "cancelled",
      cancelledAt: now,
      cancellationReason: reason,
      version,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.manual_sheet.cancel",
      requestFingerprint,
      targetType: "attendance_manual_sheet",
      targetId: sheet._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.manual_sheet.enter",
      grantIds,
      scopeType: "attendance_session",
      scopeId: sheet.sessionId,
      action: "attendance.manual_sheet_cancelled",
      targetType: "attendance_manual_sheet",
      targetId: sheet._id,
      previousSummary: JSON.stringify({ status: sheet.status, version: sheet.version }),
      nextSummary: JSON.stringify({ status: "cancelled", version }),
      reason,
    });
    return { id: sheet._id, version };
  },
});

export const sourceContext = query({
  args: { eventSlug: v.string(), sheetId: v.id("attendanceManualSheets") },
  returns: v.object({
    storageId: v.id("_storage"),
    contentType: v.string(),
    byteCount: v.number(),
    sha256: v.string(),
    fileName: v.string(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const sheet = await ctx.db.get(args.sheetId);
    if (
      !sheet ||
      sheet.eventId !== event._id ||
      !sheet.sourceStorageId ||
      !sheet.sourceContentType ||
      sheet.sourceByteCount === undefined ||
      !sheet.sourceSha256 ||
      !sheet.sourceFileName
    ) {
      throw new ConvexError({ code: "SOURCE_NOT_FOUND", message: "Paper source image not found." });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.manual_sheet.source.read",
      scopeType: "attendance_session",
      scopeId: sheet.sessionId,
    });
    return {
      storageId: sheet.sourceStorageId,
      contentType: sheet.sourceContentType,
      byteCount: sheet.sourceByteCount,
      sha256: sheet.sourceSha256,
      fileName: sheet.sourceFileName,
    };
  },
});

type SheetImportSummary = NonNullable<Doc<"attendanceManualSheets">["importSummary"]>;

function addOutcome(summary: SheetImportSummary, outcome: AttendanceTransitionOutcome) {
  if (outcome === "accepted") summary.accepted += 1;
  if (outcome === "duplicate") summary.duplicate += 1;
  if (outcome === "rejected") summary.rejected += 1;
  if (outcome === "needs_review") summary.needsReview += 1;
}

async function insertManualPresenceEvent(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    sheet: Doc<"attendanceManualSheets">;
    entry: Doc<"attendanceManualSheets">["entries"][number];
    verifierPersonId: Id<"people">;
    receivedAt: number;
    outcome: AttendanceTransitionOutcome;
    reasonCode: string;
    verificationReason: string;
    participant?: Doc<"attendanceSessionParticipants">;
    decision?: SessionTransitionDecision;
    linkedEventId?: Id<"attendancePresenceEvents">;
  },
) {
  return ctx.db.insert("attendancePresenceEvents", {
    eventId: args.eventId,
    sourceKind: "manual_import",
    stationId: args.sheet.stationId,
    stationConfigurationVersion: args.sheet.stationConfigurationVersion,
    zoneId: args.sheet.zoneId,
    sessionId: args.sheet.sessionId,
    operatorPersonId: args.verifierPersonId,
    membershipId: args.entry.membershipId,
    credentialKind: "manual",
    clientOperationId: `manual:${args.sheet._id}:${args.entry.lineNumber}`,
    requestFingerprint: operationFingerprint([
      args.sheet._id,
      args.sheet.version,
      args.entry.lineNumber,
      args.entry.membershipId,
      args.entry.capturedAt,
      args.sheet.transition,
    ]),
    capturedAt: args.entry.capturedAt,
    receivedAt: args.receivedAt,
    isOfflineReplay: false,
    transition: args.sheet.transition,
    outcome: args.outcome,
    reasonCode: args.reasonCode,
    ...(args.decision
      ? {
          previousState: args.decision.previousState,
          nextState: args.decision.nextState,
        }
      : {}),
    operatorReason: args.entry.correctionReason ?? args.verificationReason,
    ...(args.participant
      ? { linkedParticipantVersion: args.participant.version }
      : {}),
    ...(args.linkedEventId !== undefined ? { linkedEventId: args.linkedEventId } : {}),
    manualSheetId: args.sheet._id,
    manualSheetLineNumber: args.entry.lineNumber,
  });
}

export const verify = mutation({
  args: {
    eventSlug: v.string(),
    sheetId: v.id("attendanceManualSheets"),
    expectedSheetVersion: v.number(),
    expectedSessionVersion: v.number(),
    decision: v.union(
      v.object({ kind: v.literal("import"), originalFiled: v.boolean() }),
      v.object({ kind: v.literal("reject") }),
    ),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    id: v.id("attendanceManualSheets"),
    version: v.number(),
    status: v.union(
      v.literal("imported"),
      v.literal("needs_review"),
      v.literal("rejected"),
    ),
    importSummary: v.optional(importSummary),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Verification reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.sheetId,
      args.expectedSheetVersion,
      args.expectedSessionVersion,
      args.decision.kind,
      args.decision.kind === "import" ? args.decision.originalFiled : null,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.manual_sheet.verify",
      requestFingerprint,
    });
    if (prior) {
      const sheetId = ctx.db.normalizeId("attendanceManualSheets", prior.targetId);
      const sheet = sheetId ? await ctx.db.get(sheetId) : null;
      if (
        !sheet ||
        sheet.eventId !== event._id ||
        (sheet.status !== "imported" &&
          sheet.status !== "needs_review" &&
          sheet.status !== "rejected")
      ) {
        throw new Error("Prior manual-sheet verification no longer resolves.");
      }
      return {
        id: sheet._id,
        version: sheet.version,
        status: sheet.status,
        ...(sheet.importSummary !== undefined ? { importSummary: sheet.importSummary } : {}),
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const sheet = await ctx.db.get(args.sheetId);
    if (!sheet || sheet.eventId !== event._id) {
      throw new ConvexError({ code: "SHEET_NOT_FOUND", message: "Paper sheet not found." });
    }
    if (sheet.enteredByPersonId === person._id) {
      throw new ConvexError({
        code: "SECOND_VERIFIER_REQUIRED",
        message: "A different authorized person must verify and import this paper sheet.",
      });
    }
    if (sheet.version !== args.expectedSheetVersion || sheet.status !== "submitted") {
      throw new ConvexError({ code: "SHEET_CHANGED", message: "The paper sheet changed. Refresh and try again." });
    }
    const [grantIds, sourceGrantIds] = await Promise.all([
      requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "attendance.manual_sheet.verify",
        scopeType: "attendance_session",
        scopeId: sheet.sessionId,
      }),
      requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "attendance.manual_sheet.source.read",
        scopeType: "attendance_session",
        scopeId: sheet.sessionId,
      }),
    ]);
    const authorizationGrantIds = [...grantIds, ...sourceGrantIds];
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const [incident, session, sourceMetadata] = await Promise.all([
      ctx.db.get(sheet.incidentId),
      ctx.db.get(sheet.sessionId),
      sheet.sourceStorageId
        ? ctx.db.system.get("_storage", sheet.sourceStorageId)
        : Promise.resolve(null),
    ]);
    if (
      !sheet.sourceStorageId ||
      !sheet.sourceSha256 ||
      sheet.sourceByteCount === undefined ||
      !sourceMetadata ||
      sourceMetadata.sha256 !== sheet.sourceSha256 ||
      sourceMetadata.size !== sheet.sourceByteCount ||
      sourceMetadata.contentType !== allowedSourceContentType
    ) {
      throw new ConvexError({
        code: "SOURCE_CHANGED",
        message: "The protected paper source no longer matches its submitted manifest.",
      });
    }
    if (!session || session.eventId !== event._id || session.version !== args.expectedSessionVersion) {
      throw new ConvexError({ code: "SESSION_CHANGED", message: "The attendance session changed. Refresh and try again." });
    }
    if (!incident || incident.eventId !== event._id) {
      throw new ConvexError({ code: "INCIDENT_NOT_FOUND", message: "The linked incident no longer exists." });
    }
    const now = Date.now();
    const version = sheet.version + 1;

    if (args.decision.kind === "reject") {
      await ctx.db.patch(sheet._id, {
        status: "rejected",
        rejectedByPersonId: person._id,
        rejectedAt: now,
        rejectionReason: reason,
        version,
        updatedAt: now,
      });
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "attendance.manual_sheet.verify",
        requestFingerprint,
        targetType: "attendance_manual_sheet",
        targetId: sheet._id,
        createdAt: now,
      });
      await writeAuditEvent(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        permissionKey: "attendance.manual_sheet.verify",
        grantIds: authorizationGrantIds,
        scopeType: "attendance_session",
        scopeId: sheet.sessionId,
        action: "attendance.manual_sheet_rejected",
        targetType: "attendance_manual_sheet",
        targetId: sheet._id,
        previousSummary: JSON.stringify({ status: sheet.status, version: sheet.version }),
        nextSummary: JSON.stringify({ status: "rejected", version }),
        reason,
      });
      return { id: sheet._id, version, status: rejectedSheetStatus };
    }

    if (!args.decision.originalFiled) {
      throw new ConvexError({
        code: "ORIGINAL_SHEET_NOT_FILED",
        message: "File the numbered original in the event audit packet before importing it.",
      });
    }
    if (
      incident.state === "resolved" ||
      incident.manualModeState !== "approved" ||
      incident.manualModeApprovalCount !== 2
    ) {
      throw new ConvexError({ code: "MANUAL_MODE_CLOSED", message: "Manual mode is no longer approved for this incident." });
    }
    if (session.status !== "open" || session.openedAt === undefined) {
      throw new ConvexError({
        code: "SESSION_NOT_OPEN",
        message: "Import every submitted paper sheet before the attendance session begins closing.",
      });
    }

    const summary: SheetImportSummary = {
      accepted: 0,
      duplicate: 0,
      rejected: 0,
      needsReview: 0,
    };
    const entries = [...sheet.entries].sort(
      (left, right) => left.capturedAt - right.capturedAt || left.lineNumber - right.lineNumber,
    );
    for (const entry of entries) {
      const existingEvent = await ctx.db
        .query("attendancePresenceEvents")
        .withIndex("by_manual_sheet_line", (index) =>
          index.eq("manualSheetId", sheet._id).eq("manualSheetLineNumber", entry.lineNumber),
        )
        .unique();
      if (existingEvent) {
        throw new Error("A submitted paper line was already imported outside its sheet transaction.");
      }
      const [membership, participant] = await Promise.all([
        ctx.db.get(entry.membershipId),
        ctx.db
          .query("attendanceSessionParticipants")
          .withIndex("by_session_membership", (index) =>
            index.eq("sessionId", session._id).eq("membershipId", entry.membershipId),
          )
          .unique(),
      ]);
      if (
        !membership ||
        membership.eventId !== event._id ||
        membership.eligibilityStatus !== "eligible" ||
        membership.onboardingStatus !== "accepted" ||
        !participant ||
        participant.eventId !== event._id
      ) {
        const presenceEventId = await insertManualPresenceEvent(ctx, {
          eventId: event._id,
          sheet,
          entry,
          verifierPersonId: person._id,
          receivedAt: now,
          outcome: "rejected",
          reasonCode: "manual_participant_not_active",
          verificationReason: reason,
        });
        if (!presenceEventId) throw new Error("Rejected manual presence event did not persist.");
        addOutcome(summary, "rejected");
        continue;
      }
      const lastEvent = participant.lastEventId
        ? await ctx.db.get(participant.lastEventId)
        : null;
      const precedesNewerEvidence =
        lastEvent !== null && lastEvent.capturedAt >= entry.capturedAt;
      if (precedesNewerEvidence) {
        const decision: SessionTransitionDecision = {
          outcome: "needs_review",
          reasonCode: "manual_import_precedes_newer_evidence",
          previousState: participant.state,
          nextState: participant.state,
        };
        await insertManualPresenceEvent(ctx, {
          eventId: event._id,
          sheet,
          entry,
          verifierPersonId: person._id,
          receivedAt: now,
          outcome: decision.outcome,
          reasonCode: decision.reasonCode,
          verificationReason: reason,
          participant,
          decision,
          ...(lastEvent ? { linkedEventId: lastEvent._id } : {}),
        });
        addOutcome(summary, decision.outcome);
        continue;
      }
      const prepared = await prepareSessionTransition(ctx, {
        participant,
        transition: sheet.transition,
      });
      const presenceEventId = await insertManualPresenceEvent(ctx, {
        eventId: event._id,
        sheet,
        entry,
        verifierPersonId: person._id,
        receivedAt: now,
        outcome: prepared.decision.outcome,
        reasonCode: prepared.decision.reasonCode,
        verificationReason: reason,
        participant,
        decision: prepared.decision,
        ...(lastEvent ? { linkedEventId: lastEvent._id } : {}),
      });
      if (
        prepared.decision.outcome === "accepted" ||
        prepared.decision.outcome === "needs_review"
      ) {
        await applySessionTransitionProjection(ctx, {
          eventId: event._id,
          session,
          participant,
          membershipId: membership._id,
          zoneId: sheet.zoneId,
          transition: sheet.transition,
          decision: prepared.decision,
          openInterval: prepared.openInterval,
          presenceEventId,
          effectiveAt: entry.capturedAt,
          updatedAt: now,
        });
      }
      addOutcome(summary, prepared.decision.outcome);
    }
    const status: "imported" | "needs_review" =
      summary.rejected > 0 || summary.needsReview > 0
        ? "needs_review"
        : "imported";
    await ctx.db.patch(sheet._id, {
      status,
      verifiedByPersonId: person._id,
      verifiedAt: now,
      verificationReason: reason,
      originalFiledByPersonId: person._id,
      originalFiledAt: now,
      importSummary: summary,
      version,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.manual_sheet.verify",
      requestFingerprint,
      targetType: "attendance_manual_sheet",
      targetId: sheet._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.manual_sheet.verify",
      grantIds: authorizationGrantIds,
      scopeType: "attendance_session",
      scopeId: sheet.sessionId,
      action: "attendance.manual_sheet_imported",
      targetType: "attendance_manual_sheet",
      targetId: sheet._id,
      previousSummary: JSON.stringify({ status: sheet.status, version: sheet.version }),
      nextSummary: JSON.stringify({
        status,
        version,
        rowCount: sheet.entries.length,
        importSummary: summary,
        sourceSha256: sheet.sourceSha256,
        originalFiled: true,
      }),
      reason,
    });
    return { id: sheet._id, version, status, importSummary: summary };
  },
});
