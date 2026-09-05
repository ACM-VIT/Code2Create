import type { RefObject } from "react";
import { LiveNumber } from "./LiveNumber";

type QueuePaginationProps = {
  page: number;
  first: number;
  last: number;
  total: number | undefined;
  loading: boolean;
  canPrevious: boolean;
  canNext: boolean;
  previous: () => void;
  next: () => void;
  listRef: RefObject<HTMLDivElement | null>;
};

export function QueuePagination({
  page, first, last, total, loading, canPrevious, canNext, previous, next, listRef,
}: QueuePaginationProps) {
  const navigate = (changePage: () => void) => {
    changePage();
    listRef.current?.scrollIntoView({ block: "start" });
    listRef.current?.focus({ preventScroll: true });
  };
  return (
    <nav className="queue-pagination" aria-label="Application pages">
      <p className="muted" role="status" aria-live="polite">
        {loading ? "Loading page…" : first === 0 ? "No results" : (
          <>Showing <LiveNumber value={first} />–<LiveNumber value={last} />
            {total === undefined ? null : <> of <LiveNumber value={total} /></>}
          </>
        )}
      </p>
      <div className="button-row">
        <button className="secondary" type="button" disabled={!canPrevious} onClick={() => navigate(previous)}>
          Previous
        </button>
        <span className="queue-page-number" aria-current="page">Page <LiveNumber value={page} /></span>
        <button className="secondary" type="button" disabled={!canNext} onClick={() => navigate(next)}>
          Next
        </button>
      </div>
    </nav>
  );
}
