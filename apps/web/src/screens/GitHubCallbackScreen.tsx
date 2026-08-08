import { api } from '@code2create/backend/api'
import { useAction } from 'convex/react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import type { GitHubConnectionResult } from '../types'

const pendingCompletions = new Map<string, Promise<GitHubConnectionResult>>()

export function GitHubCallbackScreen() {
  const completeConnection = useAction(api.githubActions.completeConnection)
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const state = searchParams.get('state')
  const code = searchParams.get('code')
  const installationId = searchParams.get('installation_id')

  useEffect(() => {
    if (!state || !code || !installationId) {
      setError('GitHub returned an incomplete connection. Start again from integrations.')
      return
    }
    const key = `${state}:${installationId}`
    let completion = pendingCompletions.get(key)
    if (!completion) {
      completion = completeConnection({ eventSlug, state, code, installationId })
      pendingCompletions.set(key, completion)
      void completion.finally(() => pendingCompletions.delete(key))
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
  }, [code, completeConnection, installationId, navigate, state])

  return (
    <section className="integration-shell narrow-panel">
      <p className="eyebrow">GitHub</p>
      <h1>{error ? 'Connection failed.' : 'Connecting…'}</h1>
      {error ? (
        <>
          <p className="lead">{error}</p>
          <Link className="secondary link-button" to="/integrations">Back to integrations</Link>
        </>
      ) : (
        <p className="muted" role="status">Verifying the installation with GitHub.</p>
      )}
    </section>
  )
}
