import { ConvexError, type Infer, v } from "convex/values";

import type { Doc } from "../_generated/dataModel";

export const attendanceCompletionPolicy = v.union(
  v.object({ kind: v.literal("confirmation") }),
  v.object({
    kind: v.literal("minimum_present_minutes"),
    minimumPresentMinutes: v.number(),
  }),
);

export type AttendanceCompletionPolicy = Infer<typeof attendanceCompletionPolicy>;

type FinalResult = NonNullable<Doc<"attendanceSessionParticipants">["result"]>;

export function requireAttendanceCompletionPolicy(
  policy: AttendanceCompletionPolicy,
  session: { startsAt: number; endsAt: number },
) {
  if (policy.kind === "confirmation") return;
  if (
    !Number.isSafeInteger(policy.minimumPresentMinutes) ||
    policy.minimumPresentMinutes < 1
  ) {
    throw new ConvexError({
      code: "INVALID_ATTENDANCE_COMPLETION_POLICY",
      message: "Minimum presence must be a positive whole number of minutes.",
    });
  }
  const requiredDurationMs = policy.minimumPresentMinutes * 60_000;
  if (requiredDurationMs > session.endsAt - session.startsAt) {
    throw new ConvexError({
      code: "INVALID_ATTENDANCE_COMPLETION_POLICY",
      message: "Minimum presence cannot exceed the configured session duration.",
    });
  }
}

export function attendanceCompletionResult(args: {
  participant: Pick<
    Doc<"attendanceSessionParticipants">,
    "state" | "confirmedAt" | "result"
  >;
  intervalsValid: boolean;
  presentDurationMs: number;
  policy: AttendanceCompletionPolicy;
}): {
  state: Doc<"attendanceSessionParticipants">["state"];
  result: FinalResult;
} {
  const { participant } = args;
  if (!args.intervalsValid || participant.state === "needs_review") {
    return { state: "needs_review", result: "needs_review" };
  }
  if (participant.state === "excused") {
    return { state: "excused", result: "excused" };
  }
  if (participant.state === "not_expected") {
    return { state: "complete", result: "not_expected" };
  }
  if (participant.state === "complete") {
    if (!participant.result) {
      return { state: "needs_review", result: "needs_review" };
    }
    return { state: "complete", result: participant.result };
  }
  if (participant.confirmedAt === undefined) {
    return { state: "complete", result: "absent" };
  }
  if (args.policy.kind === "confirmation") {
    return { state: "complete", result: "attended" };
  }
  const requiredDurationMs = args.policy.minimumPresentMinutes * 60_000;
  return {
    state: "complete",
    result: args.presentDurationMs >= requiredDurationMs ? "attended" : "partial",
  };
}
