import type { PaginationStatus } from "convex/react";
import { useEffect, useState } from "react";

export const admissionPageSize = 30;

export function queuePageBounds(requestedPage: number, resultCount: number, exhausted: boolean) {
  const lastPage = Math.max(0, Math.ceil(resultCount / admissionPageSize) - 1);
  const page = exhausted ? Math.min(requestedPage, lastPage) : requestedPage;
  const start = page * admissionPageSize;
  return { page, start, end: Math.min(start + admissionPageSize, resultCount) };
}

/** Show fixed-size pages while Convex keeps the loaded cursor ranges live. */
export function useQueuePagination<Item>(
  results: readonly Item[],
  status: PaginationStatus,
  loadMore: (numItems: number) => void,
  queryKey: string,
) {
  const [position, setPosition] = useState({ queryKey, page: 0 });
  if (position.queryKey !== queryKey) {
    setPosition({ queryKey, page: 0 });
  }
  const requestedPage = position.queryKey === queryKey ? position.page : 0;
  const exhausted = status === "Exhausted";
  const { page, start, end } = queuePageBounds(requestedPage, results.length, exhausted);
  if (requestedPage !== page) {
    setPosition({ queryKey, page });
  }

  // Filtered server pages can be short. Fill the visible page before advancing again.
  const needsMore = results.length < start + admissionPageSize;
  useEffect(() => {
    if (status === "CanLoadMore" && needsMore) loadMore(admissionPageSize);
  }, [status, needsMore, loadMore]);

  const loading = status === "LoadingFirstPage" || (!exhausted && needsMore);
  return {
    items: results.slice(start, end),
    page: page + 1,
    first: end > start ? start + 1 : 0,
    last: end,
    total: exhausted ? results.length : undefined,
    loading,
    canPrevious: page > 0,
    canNext: !loading && (end < results.length || !exhausted),
    previous: () => setPosition({ queryKey, page: Math.max(0, page - 1) }),
    next: () => setPosition({ queryKey, page: page + 1 }),
  };
}
