export type FigmaEventStatus =
  | "draft"
  | "registration_open"
  | "registration_closed"
  | "live"
  | "complete";

export type FigmaWebhookState = "pending" | "active" | "unavailable" | "error";

export const figmaMetadataDispatchBatchSize = 64;
export const figmaMetadataLeaseDurationMs = 90 * 1_000;
export const figmaMetadataDispatchRecoveryMs = 5 * 60 * 1_000;

function stableJitter(resourceKey: string, maximumMs: number) {
  let hash = 2_166_136_261;
  for (const character of resourceKey) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % (maximumMs + 1);
}

export function figmaMetadataIntervalMs(
  eventStatus: FigmaEventStatus,
  webhookState: FigmaWebhookState,
  resourceKey: string,
) {
  if (eventStatus === "live") {
    const baseMs = webhookState === "active" ? 90 * 1_000 : 60 * 1_000;
    return baseMs + stableJitter(resourceKey, 30 * 1_000);
  }
  if (eventStatus === "registration_open" || eventStatus === "registration_closed") {
    return 15 * 60 * 1_000 + stableJitter(resourceKey, 2 * 60 * 1_000);
  }
  return 6 * 60 * 60 * 1_000 + stableJitter(resourceKey, 30 * 60 * 1_000);
}

export function nextFigmaMetadataCheckAt(args: {
  from: number;
  eventStatus: FigmaEventStatus;
  webhookState: FigmaWebhookState;
  resourceKey: string;
}) {
  return (
    args.from +
    figmaMetadataIntervalMs(args.eventStatus, args.webhookState, args.resourceKey)
  );
}

export function nextFigmaMetadataFailureCheckAt(args: {
  now: number;
  eventStatus: FigmaEventStatus;
  resourceKey: string;
}) {
  const baseMs = args.eventStatus === "live" ? 2 * 60 * 1_000 : 30 * 60 * 1_000;
  return args.now + baseMs + stableJitter(args.resourceKey, 30 * 1_000);
}

export function shouldAcceptFigmaObservation(args: {
  currentLastTouchedAt: number;
  currentObservedAt: number;
  incomingLastTouchedAt: number;
  incomingObservedAt: number;
}) {
  if (args.incomingLastTouchedAt !== args.currentLastTouchedAt) {
    return args.incomingLastTouchedAt > args.currentLastTouchedAt;
  }
  return args.incomingObservedAt >= args.currentObservedAt;
}
