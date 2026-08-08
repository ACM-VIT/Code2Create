import { api } from '@code2create/backend/api'
import { useMutation } from 'convex/react'
import { useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ErrorNotice, Field, TextInput } from '../components/Form'
import { eventSlug } from '../lib/config'
import { operationId, readableError } from '../lib/errors'

export function TeamScreen({ embedded = false }: { embedded?: boolean }) {
  const params = useParams<{ code?: string }>()
  const navigate = useNavigate()
  const createTeam = useMutation(api.teams.create)
  const joinTeam = useMutation(api.teams.join)
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>(params.code ? 'join' : 'choose')
  const [name, setName] = useState('')
  const [code, setCode] = useState(params.code ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createTeam({ eventSlug, name, clientOperationId: operationId('team-create') })
      navigate('/', { replace: true })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const join = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await joinTeam({ eventSlug, code, clientOperationId: operationId('team-join') })
      navigate('/', { replace: true })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const content = (
    <section className={embedded ? 'team-setup-content' : 'narrow-panel'} aria-label="Team setup">
        <p className="muted">Team setup</p>
        <h1>
          {mode === 'choose'
            ? 'Are you creating a team or joining one?'
            : mode === 'create'
              ? 'What should we call your team?'
              : 'What is your team code?'}
        </h1>
        <p className="muted">
          {mode === 'choose'
            ? 'You can change members until the final application is submitted.'
            : mode === 'create'
              ? 'You will become the lead and can invite everyone else next.'
              : 'Enter the seven-character code shared by your team lead.'}
        </p>

        {mode === 'choose' ? (
          <div className="choice-stack" aria-label="Choose a team action">
            <button type="button" className="choice" onClick={() => setMode('create')}>
              <span><strong>Create a team</strong><small>Start a new team as its lead</small></span>
            </button>
            <button type="button" className="choice" onClick={() => setMode('join')}>
              <span><strong>Join a team</strong><small>Use a code from your lead</small></span>
            </button>
          </div>
        ) : null}

        {mode === 'create' ? (
          <form onSubmit={create} className="team-setup-form">
            <Field label="Team name">
              <TextInput autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Parallel Labs" />
            </Field>
            <ErrorNotice message={error} />
            <div className="form-actions">
              <button type="button" className="text-button" onClick={() => setMode('choose')}>Back</button>
              <button type="submit" className="primary" disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Continue'}
              </button>
            </div>
          </form>
        ) : null}
        {mode === 'join' ? (
          <form onSubmit={join} className="team-setup-form">
            <Field label="Team code">
              <TextInput autoFocus required maxLength={7} value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="C2C7ABC" />
            </Field>
            <ErrorNotice message={error} />
            <div className="form-actions">
              <button type="button" className="text-button" onClick={() => setMode('choose')}>Back</button>
              <button type="submit" className="primary" disabled={busy || code.trim().length < 7}>
                {busy ? 'Joining…' : 'Continue'}
              </button>
            </div>
          </form>
        ) : null}
    </section>
  )

  if (embedded) return <aside className="team-panel team-setup-panel">{content}</aside>
  return <main className="centered-shell">{content}</main>
}
