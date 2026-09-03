import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { SessionTransition } from "./attendanceSessionTransition";

const minuteMs = 60_000;
const maximumExtensionMinutes = 24 * 60;

/**
 * A zone holds at most one open attendance session at a time, so a scan taken
 * anywhere in that zone resolves to exactly one session. `attendanceSessions.open`
 * owns that invariant.
 */
export async function openAttendanceSessionInZone(
  ctx: QueryCtx | MutationCtx,
  args: { eventId: Id<"events">; zoneId: Id<"attendanceZones"> },
) {
  const open = await openAttendanceSessionsInZone(ctx, args);
  if (open.length > 1) {
    throw new Error("More than one attendance session is open in one zone.");
  }
  return open[0] ?? null;
}

export async function openAttendanceSessionsInZone(
  ctx: QueryCtx | MutationCtx,
  args: { eventId: Id<"events">; zoneId: Id<"attendanceZones"> },
) {
  const open = await ctx.db
    .query("attendanceSessions")
    .withIndex("by_event_status_start", (index) =>
      index.eq("eventId", args.eventId).eq("status", "open"),
    )
    .collect();
  return open.filter((session) => session.zoneId === args.zoneId);
}

type SessionTiming = Pick<
  Doc<"attendanceSessions">,
  "checkInOpensAt" | "checkInClosesAt" | "endsAt"
>;

export function extendedAttendanceSessionTiming(args: {
  session: SessionTiming;
  extensionMinutes: number;
  now: number;
  eventEndsAt?: number;
}) {
  if (
    !Number.isSafeInteger(args.extensionMinutes) ||
    args.extensionMinutes < 1 ||
    args.extensionMinutes > maximumExtensionMinutes
  ) {
    throw new ConvexError({
      code: "INVALID_SESSION_EXTENSION",
      message: "Extend the session by a whole number of minutes between 1 and 1,440.",
    });
  }
  if (args.now > args.session.endsAt) {
    throw new ConvexError({
      code: "SESSION_EXTENSION_TOO_LATE",
      message:
        "This session has already reached its accepted end time and cannot be extended retroactively.",
    });
  }
  const durationMs = args.extensionMinutes * minuteMs;
  const endsAt = args.session.endsAt + durationMs;
  const checkInClosesAt = args.session.checkInClosesAt + durationMs;
  if (args.eventEndsAt !== undefined && endsAt > args.eventEndsAt) {
    throw new ConvexError({
      code: "SESSION_EXTENSION_OUTSIDE_EVENT",
      message: "The extended session must still end within the event window.",
    });
  }
  return { endsAt, checkInClosesAt };
}

export function attendanceSessionCutoffAt(
  session: Pick<Doc<"attendanceSessions">, "endsAt">,
  now: number,
) {
  return Math.min(session.endsAt, now);
}

export function attendanceSessionWindowRejection(args: {
  session: SessionTiming;
  transition: SessionTransition;
  now: number;
}): "outside_check_in_window" | "outside_session_window" | null {
  if (args.transition === "session_confirm") {
    return args.now < args.session.checkInOpensAt || args.now > args.session.checkInClosesAt
      ? "outside_check_in_window"
      : null;
  }
  return args.now > args.session.endsAt ? "outside_session_window" : null;
}

export function attendanceSessionJobIsTerminal(status: Doc<"attendanceSessionJobs">["status"]) {
  return status === "complete" || status === "failed" || status === "cancelled";
}
