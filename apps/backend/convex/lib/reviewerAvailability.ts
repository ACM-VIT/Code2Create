import { ConvexError } from "convex/values";

export const maximumReviewerAvailabilityWindows = 32;
export const minimumReviewerNoShowGraceSeconds = 30;
export const maximumReviewerNoShowGraceSeconds = 1_800;

export type ReviewerAvailabilityWindow = {
  startsAt: number;
  endsAt: number;
};

export type ReviewerRoundStaffingPolicy = {
  clockInOpensAt: number;
  reviewerReportAt: number;
  startsAt: number;
  endsAt: number;
  noShowGraceSeconds: number;
};

type ReviewerClockInState = {
  status: "present" | "temporarily_unavailable" | "clocked_out" | "no_show";
  expectedReturnAt?: number;
};

export function normalizedReviewerAvailabilityWindows(
  windows: readonly ReviewerAvailabilityWindow[],
) {
  if (windows.length > maximumReviewerAvailabilityWindows) {
    throw new ConvexError({
      code: "REVIEWER_AVAILABILITY_TOO_LARGE",
      message: `A reviewer can declare at most ${maximumReviewerAvailabilityWindows} availability windows.`,
    });
  }
  const ordered = windows
    .map((window) => {
      if (
        !Number.isSafeInteger(window.startsAt) ||
        !Number.isSafeInteger(window.endsAt) ||
        window.startsAt >= window.endsAt
      ) {
        throw new ConvexError({
          code: "INVALID_REVIEWER_AVAILABILITY",
          message: "Every reviewer availability window needs a valid start before its end.",
        });
      }
      return { startsAt: window.startsAt, endsAt: window.endsAt };
    })
    .sort((left, right) => left.startsAt - right.startsAt || left.endsAt - right.endsAt);

  const normalized: ReviewerAvailabilityWindow[] = [];
  for (const window of ordered) {
    const previous = normalized.at(-1);
    if (!previous || window.startsAt > previous.endsAt) {
      normalized.push(window);
      continue;
    }
    previous.endsAt = Math.max(previous.endsAt, window.endsAt);
  }
  return normalized;
}

export function reviewerCoversStaffingWindow(
  windows: readonly ReviewerAvailabilityWindow[],
  staffing: Pick<ReviewerRoundStaffingPolicy, "clockInOpensAt" | "endsAt">,
) {
  return windows.some(
    (window) => window.startsAt <= staffing.clockInOpensAt && window.endsAt >= staffing.endsAt,
  );
}

export function reviewerClockInIsOpenAt(
  round: Pick<ReviewerRoundStaffingPolicy, "clockInOpensAt" | "endsAt">,
  now: number,
) {
  return now >= round.clockInOpensAt && now < round.endsAt;
}

export function validateReviewerRoundStaffingPolicy(round: ReviewerRoundStaffingPolicy) {
  const noShowBoundary = round.reviewerReportAt + round.noShowGraceSeconds * 1_000;
  if (
    !Number.isSafeInteger(round.clockInOpensAt) ||
    !Number.isSafeInteger(round.reviewerReportAt) ||
    !Number.isSafeInteger(round.startsAt) ||
    !Number.isSafeInteger(round.endsAt) ||
    !Number.isSafeInteger(round.noShowGraceSeconds) ||
    round.noShowGraceSeconds < minimumReviewerNoShowGraceSeconds ||
    round.noShowGraceSeconds > maximumReviewerNoShowGraceSeconds ||
    round.clockInOpensAt > round.reviewerReportAt ||
    round.reviewerReportAt > round.startsAt ||
    round.startsAt >= round.endsAt ||
    !Number.isSafeInteger(noShowBoundary) ||
    noShowBoundary > round.startsAt
  ) {
    throw new ConvexError({
      code: "INVALID_REVIEWER_STAFFING_POLICY",
      message:
        "Clock-in must open before the reviewer report time, and the no-show grace must end by the round start.",
    });
  }
  return round;
}

export function reviewerNoShowBoundary(
  round: Pick<ReviewerRoundStaffingPolicy, "reviewerReportAt" | "noShowGraceSeconds">,
  clockIn: ReviewerClockInState | null,
) {
  const startsAt =
    clockIn?.status === "temporarily_unavailable"
      ? clockIn.expectedReturnAt
      : round.reviewerReportAt;
  if (startsAt === undefined) {
    throw new Error("A temporarily unavailable reviewer has no expected return time.");
  }
  const boundary = startsAt + round.noShowGraceSeconds * 1_000;
  if (!Number.isSafeInteger(boundary)) {
    throw new Error("The reviewer no-show boundary is invalid.");
  }
  return boundary;
}
