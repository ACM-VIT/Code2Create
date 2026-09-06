import { api } from "@code2create/backend/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useAction } from "convex/react";
import { useEffect, useState } from "react";

import { describeError } from "./errors";

type Workspace = FunctionReturnType<typeof api.reviewer.reviewWorkspace>;
type ReviewId = FunctionArgs<
  typeof api.reviewer.reviewWorkspace
>["reviewSessionId"];
type Load = { key: string; value: Workspace } | { key: string; error: string };

export function useReviewWorkspace(
  eventSlug: string,
  review: { id: ReviewId; startedAt?: number } | null | undefined,
) {
  const load = useAction(api.reviewer.reviewWorkspace);
  const [result, setResult] = useState<Load | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reviewSessionId = review?.id;
  const key = JSON.stringify([eventSlug, reviewSessionId, review?.startedAt]);

  useEffect(() => {
    if (!reviewSessionId) return;
    let active = true;
    void load({ eventSlug, reviewSessionId }).then(
      (value) => {
        if (active) setResult({ key, value });
      },
      (error: unknown) => {
        if (active)
          setResult({
            key,
            error: describeError(error, "Project details could not be loaded."),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [eventSlug, key, load, reviewSessionId, attempt]);

  return {
    workspace: result?.key === key && "value" in result ? result.value : null,
    error: result?.key === key && "error" in result ? result.error : null,
    retry: () => {
      setResult(null);
      setAttempt((current) => current + 1);
    },
  };
}
