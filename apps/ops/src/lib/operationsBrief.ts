/** Changes once Worker acceptance is durable, replacing an observer that may have seen a pre-creation 404. */
export function briefStreamObserverKey(briefId: string, workerAcceptedAt: number | undefined) {
  return workerAcceptedAt === undefined
    ? `${briefId}:awaiting-worker`
    : `${briefId}:accepted:${workerAcceptedAt}`;
}
