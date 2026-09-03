import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { attendanceExportExpiresAt } from "./lib/attendanceExportLifetime";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import {
  attendanceExportField,
  attendanceExportSnapshotRow,
  type AttendanceExportSnapshotRow,
} from "./values";
import { exportWorkpool } from "./workpools";

const maximumExportRows = 1_200;
const exportIdValidator = v.id("attendanceExports");
const skipGenerationKind = "skip" as const;
const generateGenerationKind = "generate" as const;
const expiredExportStatus = "expired" as const;

type ExportField = Doc<"attendanceExports">["fields"][number];

const exportView = v.object({
  id: v.id("attendanceExports"),
  sessionVersion: v.number(),
  purpose: v.string(),
  fields: v.array(attendanceExportField),
  status: v.union(
    v.literal("pending"),
    v.literal("ready"),
    v.literal("failed"),
    v.literal("expired"),
  ),
  requestedAt: v.number(),
  expiresAt: v.number(),
  snapshotAt: v.optional(v.number()),
  rowCount: v.optional(v.number()),
  byteCount: v.optional(v.number()),
  sha256: v.optional(v.string()),
  completedAt: v.optional(v.number()),
  failureCode: v.optional(v.string()),
  version: v.number(),
});

function includesAny(fields: ExportField[], choices: readonly ExportField[]) {
  return fields.some((field) => choices.some((choice) => choice === field));
}

function validateFields(fields: ExportField[]) {
  if (fields.length < 1 || fields.length > 16 || new Set(fields).size !== fields.length) {
    throw new ConvexError({
      code: "INVALID_EXPORT_FIELDS",
      message: "Choose at least one field and do not select a field twice.",
    });
  }
}

export const generationFinished = exportWorkpool.defineOnComplete<
  DataModel,
  typeof exportIdValidator
>({
  context: exportIdValidator,
  handler: async (ctx, { context: exportId, result }) => {
    if (result.kind === "success") return;
    const exportRecord = await ctx.db.get(exportId);
    if (!exportRecord || exportRecord.status !== "pending") return;
    const now = Date.now();
    await ctx.db.patch(exportRecord._id, {
      status: "failed",
      failedAt: now,
      failureCode: result.kind === "canceled" ? "generation_canceled" : "generation_failed",
      version: exportRecord.version + 1,
    });
  },
});

export const request = mutation({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
    expectedSessionVersion: v.number(),
    purpose: v.string(),
    fields: v.array(attendanceExportField),
    lifetime: v.union(
      v.literal("fifteen_minutes"),
      v.literal("one_hour"),
      v.literal("one_day"),
      v.literal("three_days"),
      v.literal("seven_days"),
    ),
    clientOperationId: v.string(),
  },
  returns: v.object({ exportId: v.id("attendanceExports"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const purpose = normalizedText(args.purpose, "Export purpose", 10, 240);
    validateFields(args.fields);
    const requestFingerprint = operationFingerprint([
      args.sessionId,
      args.expectedSessionVersion,
      purpose,
      ...args.fields,
      args.lifetime,
    ]);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({
        code: "SESSION_NOT_FOUND",
        message: "Attendance session not found.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.export.identifiable",
      scopeType: "attendance_session",
      scopeId: session._id,
    });
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.export.identifiable.request",
      requestFingerprint,
    });
    if (prior) {
      const exportId = ctx.db.normalizeId("attendanceExports", prior.targetId);
      if (!exportId) throw new Error("The stored attendance export is invalid.");
      return {
        exportId,
        version: storedOperationVersion(prior.resultJson, "attendance export"),
      };
    }
    const requestedAt = Date.now();
    const expiresAt = attendanceExportExpiresAt(args.lifetime, requestedAt);
    if (session.version !== args.expectedSessionVersion) {
      throw new ConvexError({
        code: "SESSION_CHANGED",
        message: "The session changed. Review it before exporting.",
      });
    }
    if (session.expectationBuildState !== "complete") {
      throw new ConvexError({
        code: "SESSION_COHORT_NOT_READY",
        message: "Prepare the session cohort before requesting an export.",
      });
    }
    if (session.expectationCount > maximumExportRows) {
      throw new ConvexError({
        code: "EXPORT_COHORT_TOO_LARGE",
        message: `This session exceeds the ${maximumExportRows}-participant protected export limit.`,
      });
    }
    const exportId = await ctx.db.insert("attendanceExports", {
      eventId: event._id,
      sessionId: session._id,
      sessionVersion: session.version,
      requestedByPersonId: person._id,
      purpose,
      fields: args.fields,
      status: "pending",
      expiresAt,
      requestedAt,
      version: 1,
    });
    const workId = await exportWorkpool.enqueueAction(
      ctx,
      internal.attendanceExportActions.generate,
      { exportId },
      {
        retry: true,
        onComplete: internal.attendanceExports.generationFinished,
        context: exportId,
      },
    );
    await ctx.db.patch(exportId, { workId });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "attendance.export.identifiable.request",
      requestFingerprint,
      targetType: "attendance_export",
      targetId: exportId,
      resultJson: "1",
      createdAt: requestedAt,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.export.identifiable",
      grantIds,
      scopeType: "attendance_session",
      scopeId: session._id,
      action: "attendance.identifiable_export_requested",
      targetType: "attendance_export",
      targetId: exportId,
      nextSummary: JSON.stringify({
        sessionVersion: session.version,
        fields: args.fields,
        expiresAt,
      }),
      reason: purpose,
    });
    return { exportId, version: 1 };
  },
});

export const list = query({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("attendanceSessions"),
  },
  returns: v.array(exportView),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({
        code: "SESSION_NOT_FOUND",
        message: "Attendance session not found.",
      });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.export.identifiable",
      scopeType: "attendance_session",
      scopeId: session._id,
    });
    const records = await ctx.db
      .query("attendanceExports")
      .withIndex("by_session_requester_created", (index) =>
        index.eq("sessionId", session._id).eq("requestedByPersonId", person._id),
      )
      .order("desc")
      .take(10);
    const now = Date.now();
    return records.map((record) => ({
      id: record._id,
      sessionVersion: record.sessionVersion,
      purpose: record.purpose,
      fields: record.fields,
      status: record.expiresAt <= now ? expiredExportStatus : record.status,
      requestedAt: record.requestedAt,
      expiresAt: record.expiresAt,
      ...(record.snapshotAt !== undefined ? { snapshotAt: record.snapshotAt } : {}),
      ...(record.rowCount !== undefined ? { rowCount: record.rowCount } : {}),
      ...(record.byteCount !== undefined ? { byteCount: record.byteCount } : {}),
      ...(record.sha256 !== undefined ? { sha256: record.sha256 } : {}),
      ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
      ...(record.failureCode !== undefined ? { failureCode: record.failureCode } : {}),
      version: record.version,
    }));
  },
});

export const generationContext = internalQuery({
  args: { exportId: v.id("attendanceExports") },
  returns: v.union(
    v.object({ kind: v.literal("skip") }),
    v.object({
      kind: v.literal("generate"),
      eventId: v.id("events"),
      exportId: v.id("attendanceExports"),
      fields: v.array(attendanceExportField),
      snapshotAt: v.number(),
      rows: v.array(attendanceExportSnapshotRow),
    }),
  ),
  handler: async (ctx, args) => {
    const exportRecord = await ctx.db.get(args.exportId);
    if (!exportRecord) {
      throw new ConvexError({ code: "EXPORT_NOT_FOUND", message: "Attendance export not found." });
    }
    if (exportRecord.status !== "pending") return { kind: skipGenerationKind };
    if (exportRecord.expiresAt <= Date.now()) {
      throw new ConvexError({
        code: "EXPORT_EXPIRED",
        message: "The attendance export expired before generation completed.",
      });
    }
    const session = await ctx.db.get(exportRecord.sessionId);
    if (!session || session.eventId !== exportRecord.eventId) {
      throw new Error("Attendance export session no longer resolves.");
    }
    if (session.version !== exportRecord.sessionVersion) {
      throw new ConvexError({
        code: "SESSION_CHANGED",
        message: "The attendance session changed before its export snapshot was created.",
      });
    }
    const participants = await ctx.db
      .query("attendanceSessionParticipants")
      .withIndex("by_session_membership", (index) => index.eq("sessionId", session._id))
      .take(maximumExportRows + 1);
    if (participants.length > maximumExportRows) {
      throw new ConvexError({
        code: "EXPORT_COHORT_TOO_LARGE",
        message: `This session exceeds the ${maximumExportRows}-participant protected export limit.`,
      });
    }

    const needsProfile = includesAny(exportRecord.fields, [
      "full_name",
      "institution",
      "year_of_study",
      "vit_registration_number",
    ]);
    const needsPerson = includesAny(exportRecord.fields, ["full_name", "email"]);
    const needsMembership =
      needsProfile || needsPerson || exportRecord.fields.includes("participant_class");
    const rows: AttendanceExportSnapshotRow[] = [];
    const batchSize = 100;
    for (let offset = 0; offset < participants.length; offset += batchSize) {
      const batch = participants.slice(offset, offset + batchSize);
      const batchRows = await Promise.all(
        batch.map(async (participant) => {
          const membership = needsMembership ? await ctx.db.get(participant.membershipId) : null;
          if (needsMembership && (!membership || membership.eventId !== exportRecord.eventId)) {
            throw new Error("Attendance export membership no longer resolves.");
          }
          const [profile, participantPerson] = membership
            ? await Promise.all([
                needsProfile
                  ? ctx.db
                      .query("participantProfiles")
                      .withIndex("by_membership", (index) =>
                        index.eq("membershipId", membership._id),
                      )
                      .unique()
                  : Promise.resolve(null),
                needsPerson ? ctx.db.get(membership.personId) : Promise.resolve(null),
              ])
            : [null, null];
          if (needsPerson && !participantPerson) {
            throw new Error("Attendance export identity no longer resolves.");
          }
          const fullName = profile?.fullName ?? participantPerson?.displayName;
          return {
            ...(exportRecord.fields.includes("participant_reference")
              ? { participantReference: participant.membershipId }
              : {}),
            ...(exportRecord.fields.includes("full_name") && fullName !== undefined
              ? { fullName }
              : {}),
            ...(exportRecord.fields.includes("email") && participantPerson
              ? { email: participantPerson.verifiedEmail }
              : {}),
            ...(exportRecord.fields.includes("participant_class") && membership
              ? { participantClass: membership.participantClass }
              : {}),
            ...(exportRecord.fields.includes("institution") && profile
              ? { institution: profile.institution }
              : {}),
            ...(exportRecord.fields.includes("year_of_study") && profile
              ? { yearOfStudy: profile.yearOfStudy }
              : {}),
            ...(exportRecord.fields.includes("vit_registration_number") &&
            profile?.vitRegistrationNumber !== undefined
              ? { vitRegistrationNumber: profile.vitRegistrationNumber }
              : {}),
            ...(exportRecord.fields.includes("expectation")
              ? { expectation: participant.expectation }
              : {}),
            ...(exportRecord.fields.includes("state") ? { state: participant.state } : {}),
            ...(exportRecord.fields.includes("result") && participant.result !== undefined
              ? { result: participant.result }
              : {}),
            ...(exportRecord.fields.includes("confirmed_at") &&
            participant.confirmedAt !== undefined
              ? { confirmedAt: participant.confirmedAt }
              : {}),
            ...(exportRecord.fields.includes("present_duration_minutes") &&
            participant.presentDurationMs !== undefined
              ? { presentDurationMs: participant.presentDurationMs }
              : {}),
            ...(exportRecord.fields.includes("late") ? { late: participant.late } : {}),
            ...(exportRecord.fields.includes("session_name") ? { sessionName: session.name } : {}),
            ...(exportRecord.fields.includes("session_starts_at")
              ? { sessionStartsAt: session.startsAt }
              : {}),
            ...(exportRecord.fields.includes("session_ends_at")
              ? { sessionEndsAt: session.endsAt }
              : {}),
          };
        }),
      );
      rows.push(...batchRows);
    }
    return {
      kind: generateGenerationKind,
      eventId: exportRecord.eventId,
      exportId: exportRecord._id,
      fields: exportRecord.fields,
      snapshotAt: Date.now(),
      rows,
    };
  },
});

export const complete = internalMutation({
  args: {
    exportId: v.id("attendanceExports"),
    snapshotAt: v.number(),
    rowCount: v.number(),
    objectKey: v.string(),
    storageRegion: v.string(),
    storageBucket: v.string(),
    byteCount: v.number(),
    sha256: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const exportRecord = await ctx.db.get(args.exportId);
    if (!exportRecord) throw new Error("Attendance export no longer resolves.");
    if (exportRecord.status === "ready") {
      if (exportRecord.sha256 !== args.sha256 || exportRecord.objectKey !== args.objectKey) {
        throw new Error("Attendance export completion does not match the stored file.");
      }
      return null;
    }
    if (exportRecord.status !== "pending") return null;
    const now = Date.now();
    if (exportRecord.expiresAt <= now) {
      await ctx.db.patch(exportRecord._id, {
        status: "failed",
        failedAt: now,
        failureCode: "expired_before_completion",
        version: exportRecord.version + 1,
      });
      return null;
    }
    await ctx.db.patch(exportRecord._id, {
      status: "ready",
      snapshotAt: args.snapshotAt,
      rowCount: args.rowCount,
      objectKey: args.objectKey,
      storageRegion: args.storageRegion,
      storageBucket: args.storageBucket,
      byteCount: args.byteCount,
      sha256: args.sha256,
      completedAt: now,
      version: exportRecord.version + 1,
    });
    return null;
  },
});

async function requireDownloadAccess(
  ctx: QueryCtx | MutationCtx,
  args: { eventSlug: string; exportId: Id<"attendanceExports"> },
) {
  const event = await requireEventBySlug(ctx, args.eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const exportRecord = await ctx.db.get(args.exportId);
  if (
    !exportRecord ||
    exportRecord.eventId !== event._id ||
    exportRecord.requestedByPersonId !== person._id
  ) {
    throw new ConvexError({
      code: "EXPORT_NOT_FOUND",
      message: "Attendance export not found.",
    });
  }
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "attendance.export.identifiable",
    scopeType: "attendance_session",
    scopeId: exportRecord.sessionId,
  });
  if (exportRecord.status !== "ready" || exportRecord.expiresAt <= Date.now()) {
    throw new ConvexError({
      code: "EXPORT_NOT_AVAILABLE",
      message: "This attendance export is not ready or has expired.",
    });
  }
  if (
    exportRecord.objectKey === undefined ||
    exportRecord.storageRegion === undefined ||
    exportRecord.storageBucket === undefined ||
    exportRecord.sha256 === undefined
  ) {
    throw new Error("Ready attendance export has no complete storage manifest.");
  }
  return {
    event,
    person,
    exportRecord,
    grantIds,
    manifest: {
      objectKey: exportRecord.objectKey,
      storageRegion: exportRecord.storageRegion,
      storageBucket: exportRecord.storageBucket,
      sha256: exportRecord.sha256,
    },
  };
}

export const downloadContext = internalQuery({
  args: {
    eventSlug: v.string(),
    exportId: v.id("attendanceExports"),
  },
  returns: v.object({
    objectKey: v.string(),
    storageRegion: v.string(),
    storageBucket: v.string(),
    sha256: v.string(),
    version: v.number(),
    exportExpiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const { exportRecord, manifest } = await requireDownloadAccess(ctx, args);
    return {
      ...manifest,
      version: exportRecord.version,
      exportExpiresAt: exportRecord.expiresAt,
    };
  },
});

export const recordDownload = internalMutation({
  args: {
    eventSlug: v.string(),
    exportId: v.id("attendanceExports"),
    expectedVersion: v.number(),
    expectedSha256: v.string(),
    signedUrlExpiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { event, person, exportRecord, grantIds, manifest } = await requireDownloadAccess(
      ctx,
      args,
    );
    if (exportRecord.version !== args.expectedVersion || manifest.sha256 !== args.expectedSha256) {
      throw new ConvexError({
        code: "EXPORT_CHANGED",
        message: "This attendance export changed. Prepare the download again.",
      });
    }
    if (
      !Number.isSafeInteger(args.signedUrlExpiresAt) ||
      args.signedUrlExpiresAt <= Date.now() ||
      args.signedUrlExpiresAt > exportRecord.expiresAt
    ) {
      throw new ConvexError({
        code: "EXPORT_DOWNLOAD_EXPIRY_INVALID",
        message: "This attendance download would outlive its export.",
      });
    }
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "attendance.export.identifiable",
      grantIds,
      scopeType: "attendance_session",
      scopeId: exportRecord.sessionId,
      action: "attendance.identifiable_export_download_opened",
      targetType: "attendance_export",
      targetId: exportRecord._id,
      nextSummary: JSON.stringify({
        rowCount: exportRecord.rowCount,
        sha256: manifest.sha256,
        expiresAt: exportRecord.expiresAt,
        signedUrlExpiresAt: args.signedUrlExpiresAt,
      }),
      reason: exportRecord.purpose,
    });
    return null;
  },
});
