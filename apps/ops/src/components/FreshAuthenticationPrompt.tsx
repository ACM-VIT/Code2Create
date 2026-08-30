import { api } from '@code2create/backend/api'
import { signInWithGooglePopup, type Code2CreateAuthClient } from '@code2create/web-auth'
import { useQuery } from 'convex/react'
import { useEffect, useState } from 'react'

import {
  cancelFreshAuthentication,
  completeFreshAuthentication,
  type FreshAuthenticationRequest,
  useFreshAuthenticationRequest,
} from '../lib/freshAuthentication'

export function FreshAuthenticationPrompt({ authClient }: { authClient: Code2CreateAuthClient }) {
  const request = useFreshAuthenticationRequest()
  if (!request) return null
  return <FreshAuthenticationDialog authClient={authClient} key={request.id} request={request} />
}

function FreshAuthenticationDialog({
  authClient,
  request,
}: {
  authClient: Code2CreateAuthClient
  request: FreshAuthenticationRequest
}) {
  const status = useQuery(api.system.freshAuthenticationStatus, {})
  const [popupFinished, setPopupFinished] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (popupFinished && status?.fresh) completeFreshAuthentication(request.id)
  }, [popupFinished, request.id, status?.fresh])

  const verify = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await signInWithGooglePopup(authClient, window.location.href)
      if (result.error) {
        setError(popupErrorMessage(result.error.code))
        return
      }
      setPopupFinished(true)
    } catch {
      setError('Google verification could not be completed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fresh-auth-backdrop" role="presentation">
      <section
        aria-describedby="fresh-auth-description"
        aria-labelledby="fresh-auth-title"
        aria-modal="true"
        className="fresh-auth-dialog"
        role="dialog"
      >
        <h2 id="fresh-auth-title">Verify it is you</h2>
        <p id="fresh-auth-description">
          This change is sensitive. Confirm your Google account, then it will continue automatically.
        </p>
        {popupFinished && !status?.fresh ? (
          <p className="muted" role="status">Finishing verification…</p>
        ) : null}
        {error ? <p className="notice error" role="alert">{error}</p> : null}
        <div className="button-row">
          <button
            autoFocus
            className="primary"
            disabled={busy || popupFinished}
            type="button"
            onClick={() => void verify()}
          >
            {busy ? 'Opening Google…' : popupFinished ? 'Verified' : 'Verify with Google'}
          </button>
          <button
            className="secondary"
            disabled={busy}
            type="button"
            onClick={() => cancelFreshAuthentication(request.id)}
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
  )
}

function popupErrorMessage(code: string) {
  if (code === 'POPUP_BLOCKED') return 'Allow pop-ups for this site, then try again.'
  if (code === 'POPUP_CLOSED') return 'Google verification was closed before it finished.'
  if (code === 'POPUP_TIMEOUT') return 'Google verification took too long. Try again.'
  return 'Google verification could not be completed. Try again.'
}
