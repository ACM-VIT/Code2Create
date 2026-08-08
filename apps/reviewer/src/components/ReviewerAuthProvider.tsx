import { ConvexProviderWithAuth } from 'convex/react'
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'

import type { ReviewerRuntime } from '@/lib/runtime'

export function ReviewerAuthProvider({
  children,
  runtime,
}: {
  children: ReactNode
  runtime: ReviewerRuntime
}) {
  const pendingToken = useRef<Promise<string | null> | null>(null)
  const useAuth = useMemo(
    () =>
      function useReviewerAuth() {
        const { data: session, isPending } = runtime.authClient.useSession()
        const sessionId = session?.session.id

        useEffect(() => {
          pendingToken.current = null
        }, [sessionId])

        const fetchAccessToken = useCallback(
          ({ forceRefreshToken = false }: { forceRefreshToken?: boolean } = {}) => {
            if (!forceRefreshToken && pendingToken.current) return pendingToken.current

            const request = runtime.authClient.convex
              .token({ fetchOptions: { throw: false } })
              .then(({ data }) => data?.token ?? null)
              .catch(() => null)

            pendingToken.current = request
            void request.finally(() => {
              if (pendingToken.current === request) pendingToken.current = null
            })
            return request
          },
          [],
        )

        return useMemo(
          () => ({
            isLoading: isPending,
            isAuthenticated: Boolean(session?.session),
            fetchAccessToken,
          }),
          [fetchAccessToken, isPending, session],
        )
      },
    [runtime],
  )

  return (
    <ConvexProviderWithAuth client={runtime.convex} useAuth={useAuth}>
      {children}
    </ConvexProviderWithAuth>
  )
}
