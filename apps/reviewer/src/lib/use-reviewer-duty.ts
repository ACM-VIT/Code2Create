import { api } from "@code2create/backend/api";
import { useQuery } from "convex/react";

import { useReviewerInstallationId } from "@/lib/duty-status";
import { judgingStatus } from "@/lib/judging-status";

export function useReviewerDuty(eventSlug: string, reviewEnabled: boolean) {
  const page = useQuery(
    api.reviewSubstitutions.currentPage,
    reviewEnabled ? { eventSlug } : "skip",
  );
  const installationId = useReviewerInstallationId(eventSlug);
  const duty = useQuery(
    api.reviewer.dutyStatus,
    reviewEnabled && installationId ? { eventSlug, installationId } : "skip",
  );
  return {
    installationId,
    judgingStatus: judgingStatus(duty, page !== undefined && page !== null, reviewEnabled),
    page,
  };
}
