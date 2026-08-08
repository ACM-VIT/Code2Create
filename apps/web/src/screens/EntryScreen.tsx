import { api } from '@code2create/backend/api'
import { useState } from 'react'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import { useAction } from 'convex/react'
import { ErrorNotice } from '../components/Form'
import { readableError } from '../lib/errors'
import type { ParticipantClass, PublicState } from '../types'

export const participantClassStorageKey = 'code2create.participant-class'

export function EntryScreen({
  publicState,
  authClient,
}: {
  publicState: PublicState
  authClient: Code2CreateAuthClient
}) {
  const [participantClass, setParticipantClass] = useState<ParticipantClass | null>(() => {
    const stored = sessionStorage.getItem(participantClassStorageKey)
    return stored === 'vit_student' || stored === 'external_participant' ? stored : null
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const createBrowserSession = useAction(api.localDevelopment.createBrowserSession)

  if (!publicState.event) {
    return (
      <main className="centered-shell">
        <section className="narrow-panel">
          <p className="eyebrow">Code2Create</p>
          <h1>Event setup is not complete</h1>
          <p className="muted">An authorised Supreme account needs to publish the event and track catalog.</p>
        </section>
      </main>
    )
  }

  const choose = (value: ParticipantClass) => {
    sessionStorage.setItem(participantClassStorageKey, value)
    setParticipantClass(value)
    setError(null)
  }

  const signIn = async () => {
    if (!participantClass || !publicState.auth.googleConfigured) return
    setBusy(true)
    setError(null)
    try {
      const result = await authClient.signIn.social({
        provider: 'google',
        callbackURL: window.location.href,
      })
      if (result.error) setError(result.error.message ?? 'Google sign-in could not start.')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const signInLocally = async () => {
    if (!participantClass || !publicState.auth.localDevelopmentFixturesEnabled) return
    setBusy(true)
    setError(null)
    try {
      const session = await createBrowserSession({
        confirmation: 'create-code2create-local-browser-session',
        actor: participantClass === 'vit_student' ? 'vitParticipant' : 'externalParticipant',
        surface: 'participant',
      })
      window.location.assign(session.url)
    } catch (caught) {
      setError(readableError(caught))
      setBusy(false)
    }
  }

  return (
    <main className="centered-shell">
      <section className="narrow-panel entry-panel">
        <p className="eyebrow">{publicState.event.name}</p>
        <h1>Hello.</h1>
        <p className="lead">Which describes you?</p>

        <div className="choice-stack" aria-label="Participant type">
          <button
            type="button"
            className={participantClass === 'vit_student' ? 'choice selected' : 'choice'}
            onClick={() => choose('vit_student')}
          >
            <span>VIT Student</span>
            <small>Use your VIT Google account.</small>
          </button>
          <button
            type="button"
            className={participantClass === 'external_participant' ? 'choice selected' : 'choice'}
            onClick={() => choose('external_participant')}
          >
            <span>External participant</span>
            <small>Use your regular Google account.</small>
          </button>
        </div>

        <button
          type="button"
          className="primary full-width"
          disabled={!participantClass || busy || !publicState.auth.googleConfigured}
          onClick={signIn}
        >
          {busy ? 'Opening Google…' : 'Continue with Google'}
        </button>
        {publicState.auth.localDevelopmentFixturesEnabled ? (
          <button
            type="button"
            className="secondary full-width"
            disabled={!participantClass || busy}
            onClick={() => void signInLocally()}
          >
            {busy ? 'Opening…' : 'Use local test account'}
          </button>
        ) : null}
        {!publicState.auth.googleConfigured && !publicState.auth.localDevelopmentFixturesEnabled ? (
          <p className="configuration-note">Google sign-in has not been configured for this environment.</p>
        ) : null}
        <ErrorNotice message={error} />
        <p className="fine-print">Sign-in confirms who you are. Event eligibility is checked next.</p>
      </section>
    </main>
  )
}
