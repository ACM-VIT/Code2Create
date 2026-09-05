import { api } from "@code2create/backend/api";
import { usePaginatedQuery } from "convex/react";
import { useEffect } from "react";

import {
  teamOriginQueryArgs,
  type ReviewAssignmentCounts,
  type TeamOriginFilter,
} from "./admissionsPresentation";
import { eventSlug } from "./config";

export function useReviewAssignmentCounts(
  origin: TeamOriginFilter = "all",
  enabled = true,
): ReviewAssignmentCounts | undefined {
  const {
    results,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.admissions.myReviewAssignmentCountRows,
    enabled ? { eventSlug, ...teamOriginQueryArgs(origin) } : "skip",
    { initialNumItems: 100 },
  );

  useEffect(() => {
    if (status === "CanLoadMore") loadMore(100);
  }, [status, loadMore]);

  if (!enabled || status !== "Exhausted") return undefined;
  return results.reduce(
    (totals, row) => ({
      active: totals.active + Number(row.state === "active"),
      completed: totals.completed + Number(row.state === "completed"),
    }),
    { active: 0, completed: 0 },
  );
}
