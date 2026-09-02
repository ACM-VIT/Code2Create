const maximumTypingDebounceMs = 400
const maximumRetryDelayMs = 5_000

export function noveltyRetryDelayMs(attempt: number) {
  return Math.min(maximumRetryDelayMs, 400 * (2 ** Math.max(0, attempt - 1)))
}

export function noveltyRequestDelayMs({
  configuredDebounceMs,
  retryAt,
  now = Date.now(),
}: {
  configuredDebounceMs: number
  retryAt: number | null
  now?: number
}) {
  return retryAt === null
    ? Math.min(configuredDebounceMs, maximumTypingDebounceMs)
    : Math.max(0, retryAt - now)
}
