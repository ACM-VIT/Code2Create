export const scannerCaptureFutureToleranceMs = 30_000;

export function offlineReplayTimeRejection(args: {
  capturedAt: number;
  receivedAt: number;
  maxAgeMs: number;
}) {
  if (!Number.isSafeInteger(args.capturedAt)) return "scan_capture_time_invalid" as const;
  if (args.capturedAt > args.receivedAt + scannerCaptureFutureToleranceMs) {
    return "scan_capture_time_invalid" as const;
  }
  if (args.receivedAt - args.capturedAt > args.maxAgeMs) {
    return "offline_replay_expired" as const;
  }
  return null;
}

export function offlineReplayConflictsWithNewerEvidence(args: {
  capturedAt: number;
  proposedOutcome: "accepted" | "duplicate" | "rejected" | "needs_review";
  priorEvent: null | {
    capturedAt: number;
    receivedAt: number;
    isOfflineReplay: boolean;
  };
}) {
  if (args.proposedOutcome !== "accepted" || !args.priorEvent) return false;
  const priorEffectiveAt = args.priorEvent.isOfflineReplay
    ? args.priorEvent.capturedAt
    : args.priorEvent.receivedAt;
  return args.capturedAt <= priorEffectiveAt;
}
