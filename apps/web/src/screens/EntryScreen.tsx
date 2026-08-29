import { useState } from 'react'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import { ErrorNotice } from '../components/Form'
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
  if (!publicState.event) {
    return (
      <main className="centered-shell">
        <section className="narrow-panel">
          <p className="eyebrow">Code2Create</p>
          <h1>Event setup is not complete</h1>
          <p className="muted">An organizer with event setup access needs to finish setup.</p>
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
      if (result.error) setError('Google sign-in could not start. Try again.')
    } catch {
      setError('Google sign-in could not start. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="centered-shell">
      <section className="narrow-panel entry-panel">
        <p className="eyebrow">{publicState.event.name}</p>
        <h1>Hello.</h1>
        <p className="lead">Which describes you?</p>

        <div className="choice-stack" role="group" aria-label="Participant type">
          <button
            type="button"
            className={participantClass === 'vit_student' ? 'choice selected' : 'choice'}
            onClick={() => choose('vit_student')}
          >
            <span>VIT student</span>
            <small>Only @vitstudent.ac.in Google accounts are accepted.</small>
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
        {!publicState.auth.googleConfigured ? (
          <p className="configuration-note">Google sign-in is unavailable right now. Ask an organizer for help.</p>
        ) : null}
        <ErrorNotice message={error} />
        <p className="fine-print">Sign-in confirms who you are. Event eligibility is checked next.</p>
      </section>
    </main>
  )
}
