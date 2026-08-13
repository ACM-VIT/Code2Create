import type { SongRequestState } from "./labels.ts";

export type SynesthesiaQueueItem = {
  state: SongRequestState;
  queueMode: "normal" | "pinned" | "deferred";
  scheduledFor?: number;
  voteCount: number;
  createdAt: number;
};

export function mergeSynesthesiaVoteCounts<
  Request extends Omit<SynesthesiaQueueItem, "voteCount"> & { id: string },
>(
  requests: readonly Request[],
  counts: readonly { requestId: string; voteCount: number }[],
) {
  const countByRequest = new Map(
    counts.map((entry) => [entry.requestId, entry.voteCount]),
  );
  return requests
    .map((request) => ({
      ...request,
      voteCount: countByRequest.get(request.id) ?? 0,
    }))
    .sort(compareSynesthesiaQueueItems);
}

function queueStateRank(state: SongRequestState) {
  if (state === "playing") return 0;
  if (state === "queued") return 1;
  if (state === "approved") return 2;
  if (state === "pending") return 3;
  if (state === "played") return 4;
  if (state === "skipped") return 5;
  if (state === "rejected") return 6;
  return 7;
}

export function compareSynesthesiaQueueItems(
  left: SynesthesiaQueueItem,
  right: SynesthesiaQueueItem,
) {
  const stateDifference = queueStateRank(left.state) - queueStateRank(right.state);
  if (stateDifference !== 0) return stateDifference;
  if (left.state === "queued" && right.state === "queued") {
    const leftPinned = left.queueMode === "pinned" ? 1 : 0;
    const rightPinned = right.queueMode === "pinned" ? 1 : 0;
    if (leftPinned !== rightPinned) return rightPinned - leftPinned;
    const leftScheduled = left.queueMode === "deferred"
      ? left.scheduledFor ?? Number.POSITIVE_INFINITY
      : Number.NEGATIVE_INFINITY;
    const rightScheduled = right.queueMode === "deferred"
      ? right.scheduledFor ?? Number.POSITIVE_INFINITY
      : Number.NEGATIVE_INFINITY;
    if (leftScheduled !== rightScheduled) return leftScheduled - rightScheduled;
  }
  if (left.voteCount !== right.voteCount) return right.voteCount - left.voteCount;
  return left.createdAt - right.createdAt;
}
