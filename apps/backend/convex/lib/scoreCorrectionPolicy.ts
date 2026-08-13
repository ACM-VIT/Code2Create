import { ConvexError } from "convex/values";

export type ScoreCorrectionRoundPolicy = {
  startsAt: number;
  endsAt: number;
  correctionRequestsCloseAt: number;
};

export function requireScoreCorrectionPolicy(policy: ScoreCorrectionRoundPolicy) {
  if (
    !Number.isSafeInteger(policy.correctionRequestsCloseAt) ||
    policy.correctionRequestsCloseAt < policy.startsAt ||
    policy.correctionRequestsCloseAt > policy.endsAt
  ) {
    throw new ConvexError({
      code: "INVALID_ROUND_CONFIGURATION",
      message: "The score-correction request deadline must fall within the review round.",
    });
  }
}

export function scoreCorrectionRequestIsOpen(
  round: ScoreCorrectionRoundPolicy & { status: string },
  now: number,
) {
  return round.status === "open" && now <= round.correctionRequestsCloseAt;
}
