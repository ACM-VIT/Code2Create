import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { ConvexProviderWithAuth, type ConvexReactClient } from 'convex/react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { fetchAccessTokenUntilSettled } from './access-token'
import { authProviderState, type SettledAuthentication } from './auth-state'
import {
  abandonAuthTransfer,
  completeAuthTransfer,
  selectTransferCredential,
  type TransferCredential,
} from './one-time-token'
import { readAuthPopupNonce, signalAuthPopupCompletion } from './popup'

export { signInWithGooglePopup, type AuthPopupErrorCode } from './popup'
export { GoogleFedCmButton, preloadGoogleIdentityServices } from './GoogleFedCmButton'

export function createCode2CreateAuthClient(baseURL: string) {
  return createAuthClient({
    baseURL,
    plugins: [convexClient(), crossDomainClient()],
  })
}

export type Code2CreateAuthClient = ReturnType<typeof createCode2CreateAuthClient>

const oneTimeTokenVerifications = new Map<string, Promise<string>>()

type TransferState = 'idle' | 'working' | 'failed'

export function Code2CreateAuthProvider({
  authClient,
  children,
  client,
}: {
  authClient: Code2CreateAuthClient
  children: ReactNode
  client: ConvexReactClient
}) {
  const transfer = useOneTimeToken(authClient)
  const pendingToken = useRef<Promise<string | null> | null>(null)
  const useAuth = useMemo(
    () =>
      function useCode2CreateAuth() {
        const { data: session, isPending } = authClient.useSession()
        const sessionId = session?.session.id
        const sessionAuthenticated = Boolean(session?.session)
        const tokenRequestControllers = useRef(new Set<AbortController>())
        const [settledAuthentication, setSettledAuthentication] =
          useState<SettledAuthentication>(() => isPending ? null : sessionAuthenticated)

        useEffect(() => {
          if (!isPending) setSettledAuthentication(sessionAuthenticated)
        }, [isPending, sessionAuthenticated])

        useEffect(() => {
          pendingToken.current = null
          return () => {
            for (const controller of tokenRequestControllers.current) controller.abort()
            tokenRequestControllers.current.clear()
            pendingToken.current = null
          }
        }, [sessionId])

        const fetchAccessToken = useCallback(
          ({ forceRefreshToken = false }: { forceRefreshToken?: boolean } = {}) => {
            if (!forceRefreshToken && pendingToken.current) return pendingToken.current
            const controller = new AbortController()
            tokenRequestControllers.current.add(controller)
            const request = fetchAccessTokenUntilSettled({
              request: async () => {
                const { data, error } = await authClient.convex.token({
                  fetchOptions: { signal: controller.signal, throw: false },
                })
                return {
                  token: data?.token ?? null,
                  status: error?.status ?? (data ? 200 : null),
                }
              },
              isActive: () => !controller.signal.aborted,
            })
            pendingToken.current = request
            void request.finally(() => {
              tokenRequestControllers.current.delete(controller)
              if (pendingToken.current === request) pendingToken.current = null
            })
            return request
          },
          [authClient, sessionId],
        )

        const providerState = authProviderState(
          isPending,
          sessionAuthenticated,
          settledAuthentication,
        )

        return { ...providerState, fetchAccessToken }
      },
    [authClient],
  )

  if (transfer.state === 'working') {
    return <AuthTransferStatus>Completing sign-in…</AuthTransferStatus>
  }
  if (transfer.state === 'failed') {
    return (
      <AuthTransferStatus>
        Sign-in could not be completed.
        <button type="button" onClick={transfer.retry}>Try again</button>
        <button type="button" onClick={transfer.startAgain}>Start sign-in again</button>
      </AuthTransferStatus>
    )
  }

  return (
    <ConvexProviderWithAuth client={client} useAuth={useAuth}>
      {children}
    </ConvexProviderWithAuth>
  )
}

function useOneTimeToken(authClient: Code2CreateAuthClient) {
  const credential = useRef<TransferCredential | null>(readTransferCredential())
  const popupNonce = useRef(readAuthPopupNonce())
  const inFlight = useRef(false)
  const [state, setState] = useState<TransferState>(credential.current ? 'working' : 'idle')

  const complete = useCallback(async () => {
    if (!credential.current || inFlight.current) return
    inFlight.current = true
    setState('working')
    try {
      await completeAuthTransfer(credential.current, {
        verifyOneTimeToken: (token) => verifyOneTimeTokenOnce(authClient, token),
        storeSessionToken: (token) => {
          credential.current = { kind: 'session-token', value: token }
          writeSessionTransferToken(token)
        },
        establishSession: async (token) => {
          const result = await authClient.getSession({
            fetchOptions: { headers: { Authorization: `Bearer ${token}` } },
          })
          if (result.error || !result.data?.session) {
            throw new Error('The browser session was not established.')
          }
          authClient.updateSession()
        },
        clearSessionToken: clearSessionTransferToken,
        removeOneTimeToken: removeOneTimeTokenFromUrl,
      })
      credential.current = null
      if (popupNonce.current) signalAuthPopupCompletion(popupNonce.current)
      setState('idle')
    } catch {
      setState('failed')
    } finally {
      inFlight.current = false
    }
  }, [authClient])

  useEffect(() => {
    if (!credential.current) return
    void complete()
  }, [complete])

  const startAgain = () => {
    credential.current = null
    setState(abandonAuthTransfer({
      clearSessionToken: clearSessionTransferToken,
      removeOneTimeToken: removeOneTimeTokenFromUrl,
    }))
  }

  return { state, retry: () => void complete(), startAgain }
}

function verifyOneTimeTokenOnce(authClient: Code2CreateAuthClient, token: string) {
  const existing = oneTimeTokenVerifications.get(token)
  if (existing) return existing

  const request = authClient.crossDomain.oneTimeToken.verify({ token }).then((result) => {
    const sessionToken = result.data?.session?.token
    if (result.error || !sessionToken) throw new Error('The one-time sign-in token was rejected.')
    return sessionToken
  })
  oneTimeTokenVerifications.set(token, request)
  void request.then(
    () => oneTimeTokenVerifications.delete(token),
    () => oneTimeTokenVerifications.delete(token),
  )
  return request
}

function readTransferCredential(): TransferCredential | null {
  const sessionToken = window.sessionStorage.getItem(sessionTransferStorageKey)
  const token = new URL(window.location.href).searchParams.get('ott')
  if (token) clearSessionTransferToken()
  return selectTransferCredential(sessionToken, token)
}

function removeOneTimeTokenFromUrl() {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('ott') && !url.searchParams.has('authPopup')) return
  url.searchParams.delete('ott')
  url.searchParams.delete('authPopup')
  window.history.replaceState({}, '', url)
}

const sessionTransferStorageKey = 'code2create.auth.session-transfer-token'

function writeSessionTransferToken(token: string) {
  window.sessionStorage.setItem(sessionTransferStorageKey, token)
}

function clearSessionTransferToken() {
  window.sessionStorage.removeItem(sessionTransferStorageKey)
}

function AuthTransferStatus({ children }: { children: ReactNode }) {
  return (
    <main aria-live="polite" style={{ display: 'grid', minHeight: '100vh', placeItems: 'center' }}>
      <p style={{ display: 'grid', gap: 16, justifyItems: 'center' }}>{children}</p>
    </main>
  )
}
