import type { FunctionReturnType } from "convex/server";

import { api } from "@code2create/backend/api";

export type DutyStatus = {
  status: string;
  active: boolean;
  headline?: { value: string; unit?: string };
};

export function reviewerPanelMode({
  deviceIsCurrent,
  hasAssignment,
  hasReview,
}: {
  deviceIsCurrent: boolean;
  hasAssignment: boolean;
  hasReview: boolean;
}): "setup" | "empty" | "duty" {
  if (!deviceIsCurrent) return "setup";
  if (!hasAssignment && !hasReview) return "empty";
  return "duty";
}

export function incidentStatus(
  summary: { liveCount: number; pendingManualModeCount: number } | undefined,
  enabled: boolean,
): DutyStatus {
  if (!enabled) return { status: "", active: false };
  if (summary === undefined) return { status: "—", active: false };
  if (summary.liveCount === 0) return { status: "None live", active: false };
  const count = String(summary.liveCount);
  if (summary.pendingManualModeCount > 0) {
    return {
      status: "Awaiting approval",
      active: true,
      headline: { value: count, unit: "live" },
    };
  }
  return {
    status: `${count} live`,
    active: true,
    headline: { value: count, unit: "live" },
  };
}

export function helpStatus(
  summary: { openCount: number; countIsLowerBound: boolean } | undefined,
  enabled: boolean,
): DutyStatus {
  if (!enabled) return { status: "", active: false };
  if (summary === undefined) return { status: "—", active: false };
  if (summary.openCount === 0) return { status: "Nothing open", active: false };
  const count = `${summary.openCount}${summary.countIsLowerBound ? "+" : ""}`;
  return {
    status: `${count} open`,
    active: true,
    headline: {
      value: count,
      unit: summary.openCount === 1 && !summary.countIsLowerBound ? "case open" : "cases open",
    },
  };
}

type ReviewerDutySnapshot = FunctionReturnType<typeof api.reviewer.dutyStatus>;

export function judgingStatus(
  duty: ReviewerDutySnapshot | undefined,
  pageActive: boolean,
  enabled: boolean,
): DutyStatus {
  if (!enabled) return { status: "", active: false };
  if (pageActive) return { status: "Needed at a table", active: true };
  if (duty === undefined) return { status: "—", active: false };
  if (!duty.deviceRegistered) return { status: "Set up phone", active: false };
  if (!duty.panelAssigned) return { status: "No panel yet", active: false };
  if (duty.clockInStatus !== "present") return { status: "Not clocked in", active: false };
  if (!duty.review) return { status: "Waiting", active: false };
  if (!duty.review.reviewerPresenceConfirmed) {
    return { status: "Scan to start", active: true };
  }
  const scored = duty.review.scoredCount;
  const total = duty.review.criterionCount;
  if (total === 0) return { status: "Review under way", active: true };
  return {
    status: `${scored} of ${total} scored`,
    active: true,
    headline: { value: `${scored}/${total}`, unit: "scored" },
  };
}
