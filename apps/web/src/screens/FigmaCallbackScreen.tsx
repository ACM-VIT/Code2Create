import { api } from '@code2create/backend/api'
import { useAction } from 'convex/react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import type { FigmaConnectionResult } from '../types'

const pendingCompletions = new Map<string, Promise<FigmaConnectionResult>>()

export function FigmaCallbackScreen() {
  const completeConnection = useAction(api.figmaActions.completeConnection)
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const state = searchParams.get('state')
  const code = searchParams.get('code')

  useEffect(() => {
    if (!state || !code) {
      setError('Figma returned an incomplete connection. Start again from integrations.')
      return
    }
    let completion = pendingCompletions.get(state)
    if (!completion) {
      completion = completeConnection({ eventSlug, state, code })
      pendingCompletions.set(state, completion)
      void completion.then(
        () => pendingCompletions.delete(state),
        () => pendingCompletions.delete(state),
      )
    }
    let active = true
    void completion
      .then(() => {
        if (active) navigate('/integrations', { replace: true })
      })
      .catch((caught) => {
        if (active) setError(readableError(caught))
      })
    return () => {
      active = false
    }
  }, [code, completeConnection, navigate, state])

  return (
    <section className="integration-shell narrow-panel">
      <p className="eyebrow">Figma</p>
      <h1>{error ? 'Connection failed.' : 'Connecting…'}</h1>
      {error ? (
        <>
          <p className="lead">{error}</p>
          <Link className="secondary link-button" to="/integrations">Back to integrations</Link>
        </>
      ) : (
        <p className="muted" role="status">Exchanging the short-lived Figma authorization.</p>
      )}
    </section>
  )
}
