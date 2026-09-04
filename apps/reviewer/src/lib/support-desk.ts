import type { api } from "@code2create/backend/api";
import type { SupportCaseState } from "@code2create/domain";
import type { FunctionReturnType } from "convex/server";

export type StaffCase = FunctionReturnType<typeof api.support.staffList>["cases"][number];

export const supportFilters = [
  ["active", "Still open"],
  ["resolved", "Resolved"],
  ["closed", "Closed"],
  ["all", "Everything"],
] as const;

const transitions: Record<SupportCaseState, readonly SupportCaseState[]> = {
  open: ["investigating", "waiting", "resolved", "closed"],
  investigating: ["open", "waiting", "resolved", "closed"],
  waiting: ["open", "investigating", "resolved", "closed"],
  resolved: ["open", "investigating", "closed"],
  closed: ["open"],
};

export function supportStatusChoices(state: SupportCaseState) {
  return [state, ...transitions[state]];
}

function priority(row: StaffCase) {
  if (row.state === "closed") return 5;
  if (row.state === "resolved") return 4;
  if (row.category === "safety") return 0;
  if (row.awaitingStaffReply) return 1;
  if (row.state === "waiting") return 3;
  return 2;
}

export function orderStaffCases(cases: readonly StaffCase[]) {
  return [...cases].sort((left, right) => {
    const rank = priority(left) - priority(right);
    if (rank !== 0) return rank;
    return priority(left) >= 4
      ? right.lastActionAt - left.lastActionAt
      : left.lastActionAt - right.lastActionAt;
  });
}
