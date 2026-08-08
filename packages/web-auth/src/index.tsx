import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { ConvexProviderWithAuth, type ConvexReactClient } from 'convex/react'
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'

export function createCode2CreateAuthClient(baseURL: string) {
  return createAuthClient({ baseURL, plugins: [convexClient(), crossDomainClient()] })
}

export type Code2CreateAuthClient = ReturnType<typeof createCode2CreateAuthClient>

const oneTimeTokenVerifications = new Map<string, Promise<void>>()

export function Code2CreateAuthProvider({
  authClient,
  children,
  client,
}: {
  authClient: Code2CreateAuthClient
  children: ReactNode
  client: ConvexReactClient
}) {
  useOneTimeToken(authClient)
  const pendingToken = useRef<Promise<string | null> | null>(null)
  const useAuth = useMemo(
    () =>
      function useCode2CreateAuth() {
        const { data: session, isPending } = authClient.useSession()
        const sessionId = session?.session.id

        useEffect(() => {
          pendingToken.current = null
        }, [sessionId])

        const fetchAccessToken = useCallback(
          ({ forceRefreshToken = false }: { forceRefreshToken?: boolean } = {}) => {
            if (!forceRefreshToken && pendingToken.current) return pendingToken.current
            const request = authClient.convex
              .token({ fetchOptions: { throw: false } })
              .then(({ data }) => data?.token ?? null)
              .catch(() => null)
            pendingToken.current = request
            void request.finally(() => {
              if (pendingToken.current === request) pendingToken.current = null
            })
            return request
          },
          [authClient],
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
    [authClient],
  )

  return (
    <ConvexProviderWithAuth client={client} useAuth={useAuth}>
      {children}
    </ConvexProviderWithAuth>
  )
}

function useOneTimeToken(authClient: Code2CreateAuthClient) {
  useEffect(() => {
    const url = new URL(window.location.href)
    const token = url.searchParams.get('ott')
    if (!token) return
    url.searchParams.delete('ott')
    window.history.replaceState({}, '', url)
    void verifyOneTimeTokenOnce(authClient, token)
  }, [authClient])
}

function verifyOneTimeTokenOnce(authClient: Code2CreateAuthClient, token: string) {
  const existing = oneTimeTokenVerifications.get(token)
  if (existing) return existing

  const request = authClient.crossDomain.oneTimeToken
    .verify({ token })
    .then(async ({ data }) => {
      const sessionToken = data?.session?.token
      if (!sessionToken) return
      await authClient.getSession({
        fetchOptions: { headers: { Authorization: `Bearer ${sessionToken}` } },
      })
      authClient.updateSession()
    })
    .catch(() => undefined)
  oneTimeTokenVerifications.set(token, request)
  return request
}
