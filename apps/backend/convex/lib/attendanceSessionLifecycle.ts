import { ConvexError } from "convex/values";

import type { Doc } from "../_generated/dataModel";
import type { SessionTransition } from "./attendanceSessionTransition";

const minuteMs = 60_000;
const maximumExtensionMinutes = 24 * 60;

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
      message: "This session has already reached its accepted end time and cannot be extended retroactively.",
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

export function attendanceSessionJobIsTerminal(
  status: Doc<"attendanceSessionJobs">["status"],
) {
  return status === "complete" || status === "failed" || status === "cancelled";
}
