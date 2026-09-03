const maximumTypingDebounceMs = 400;
const maximumRetryDelayMs = 5_000;

export type NoveltyBand = "familiar" | "developing" | "distinct";

export type NoveltySignal = {
  score: number;
  band: NoveltyBand | null;
};

export type NoveltyState =
  | { status: "idle" }
  | { status: "checking"; previous: NoveltySignal | null }
  | { status: "ready"; signal: NoveltySignal };

export function visibleNoveltySignal(state: NoveltyState) {
  if (state.status === "ready") return state.signal;
  if (state.status === "checking") return state.previous;
  return null;
}

export function noveltyRetryDelayMs(attempt: number) {
  return Math.min(maximumRetryDelayMs, 400 * 2 ** Math.max(0, attempt - 1));
}

export function noveltyRequestDelayMs({
  configuredDebounceMs,
  retryAt,
  now = Date.now(),
}: {
  configuredDebounceMs: number;
  retryAt: number | null;
  now?: number;
}) {
  return retryAt === null
    ? Math.min(configuredDebounceMs, maximumTypingDebounceMs)
    : Math.max(0, retryAt - now);
}
