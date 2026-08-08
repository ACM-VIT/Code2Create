"use node";

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, internalAction } from "./_generated/server";
import {
  signAttendanceExportDownload,
  storeAttendanceExport,
} from "./lib/artifactStorage";
import { csvDocument } from "./lib/csv";

type ExportField = Doc<"attendanceExports">["fields"][number];
type SnapshotRow = {
  participantReference: string;
  fullName: string;
  email: string;
  participantClass: string;
  institution: string;
  yearOfStudy: string;
  vitRegistrationNumber: string;
  expectation: string;
  state: string;
  result: string;
  confirmedAt?: number;
  presentDurationMs?: number;
  late: boolean;
  sessionName: string;
  sessionStartsAt: number;
  sessionEndsAt: number;
};

function columnName(field: ExportField) {
  switch (field) {
    case "participant_reference": return "Participant reference";
    case "full_name": return "Full name";
    case "email": return "Verified email";
    case "participant_class": return "Participant class";
    case "institution": return "Institution";
    case "year_of_study": return "Year of study";
    case "vit_registration_number": return "VIT registration number";
    case "expectation": return "Expectation";
    case "state": return "Attendance state";
    case "result": return "Attendance result";
    case "confirmed_at": return "Confirmed at";
    case "present_duration_minutes": return "Present duration minutes";
    case "late": return "Late";
    case "session_name": return "Session";
    case "session_starts_at": return "Session starts at";
    case "session_ends_at": return "Session ends at";
  }
}

function isoTime(value: number | undefined) {
  return value === undefined ? "" : new Date(value).toISOString();
}

function fieldValue(field: ExportField, row: SnapshotRow) {
  switch (field) {
    case "participant_reference": return row.participantReference;
    case "full_name": return row.fullName;
    case "email": return row.email;
    case "participant_class": return row.participantClass;
    case "institution": return row.institution;
    case "year_of_study": return row.yearOfStudy;
    case "vit_registration_number": return row.vitRegistrationNumber;
    case "expectation": return row.expectation;
    case "state": return row.state;
    case "result": return row.result;
    case "confirmed_at": return isoTime(row.confirmedAt);
    case "present_duration_minutes":
      return row.presentDurationMs === undefined
        ? ""
        : (row.presentDurationMs / 60_000).toFixed(2);
    case "late": return row.late ? "yes" : "no";
    case "session_name": return row.sessionName;
    case "session_starts_at": return isoTime(row.sessionStartsAt);
    case "session_ends_at": return isoTime(row.sessionEndsAt);
  }
}

function buildCsv(fields: ExportField[], rows: SnapshotRow[]) {
  return csvDocument([
    fields.map(columnName),
    ...rows.map((row) => fields.map((field) => fieldValue(field, row))),
  ]);
}

export const generate = internalAction({
  args: { exportId: v.id("attendanceExports") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(internal.attendanceExports.generationContext, args);
    if (context.kind === "skip") return null;
    const csv = buildCsv(context.fields, context.rows);
    const stored = await storeAttendanceExport({
      eventId: context.eventId,
      exportId: context.exportId,
      csv,
    });
    await ctx.runMutation(internal.attendanceExports.complete, {
      exportId: context.exportId,
      snapshotAt: context.snapshotAt,
      rowCount: context.rows.length,
      objectKey: stored.objectKey,
      storageRegion: stored.storageRegion,
      storageBucket: stored.storageBucket,
      byteCount: stored.storedBytes,
      sha256: stored.sha256,
    });
    return null;
  },
});

export const download = action({
  args: {
    eventSlug: v.string(),
    exportId: v.id("attendanceExports"),
  },
  returns: v.object({
    url: v.string(),
    expiresAt: v.number(),
    sha256: v.string(),
  }),
  handler: async (
    ctx: ActionCtx,
    args: { eventSlug: string; exportId: Id<"attendanceExports"> },
  ): Promise<{ url: string; expiresAt: number; sha256: string }> => {
    const context = await ctx.runQuery(internal.attendanceExports.downloadContext, args);
    const now = Date.now();
    const remainingWholeSeconds = Math.floor((context.exportExpiresAt - now) / 1_000) - 1;
    if (remainingWholeSeconds < 1) {
      throw new ConvexError({
        code: "EXPORT_NOT_AVAILABLE",
        message: "This attendance export is too close to expiry. Create a new export.",
      });
    }
    const expiresInSeconds = Math.min(60, remainingWholeSeconds);
    const expiresAt = now + expiresInSeconds * 1_000;
    const url = await signAttendanceExportDownload({ ...context, expiresInSeconds });
    await ctx.runMutation(internal.attendanceExports.recordDownload, {
      ...args,
      expectedVersion: context.version,
      expectedSha256: context.sha256,
      signedUrlExpiresAt: expiresAt,
    });
    return {
      url,
      expiresAt,
      sha256: context.sha256,
    };
  },
});
