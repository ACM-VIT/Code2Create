export type AccessTokenAttempt = {
  token: string | null
  status: number | null
}

type AccessTokenRetryOptions = {
  request: () => Promise<AccessTokenAttempt>
  isActive: () => boolean
  wait?: (delayMs: number) => Promise<void>
}

const retryDelaysMs = [250, 500, 1_000, 2_000, 5_000] as const

function wait(delayMs: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
}

export function isRetryableAccessTokenStatus(status: number | null) {
  return status === null || status === 0 || status === 408 || status === 425 ||
    status === 429 || status >= 500
}

/**
 * Convex treats a null token as a definitive sign-out. A suspended mobile
 * browser can interrupt the token request even though its session is still
 * valid, so transient transport and server failures must settle in place
 * instead of clearing every authenticated query.
 */
export async function fetchAccessTokenUntilSettled({
  request,
  isActive,
  wait: waitForRetry = wait,
}: AccessTokenRetryOptions): Promise<string | null> {
  let retryIndex = 0
  while (isActive()) {
    let attempt: AccessTokenAttempt
    try {
      attempt = await request()
    } catch {
      attempt = { token: null, status: null }
    }
    if (!isActive()) return null
    if (attempt.token) return attempt.token
    if (!isRetryableAccessTokenStatus(attempt.status)) return null

    const delayMs = retryDelaysMs[retryIndex] ?? 5_000
    await waitForRetry(delayMs)
    retryIndex += 1
  }
  return null
}
