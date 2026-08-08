import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery } from 'convex/react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type InvitationPage = FunctionReturnType<typeof api.accessInvitations.open>
type Invitation = InvitationPage['page'][number]

const fiveMinutesMs = 5 * 60 * 1_000
const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000

export function AccessInvitations({ canReadPeople }: { canReadPeople: boolean }) {
  const invitations = usePaginatedQuery(
    api.accessInvitations.open,
    { eventSlug },
    { initialNumItems: 20 },
  )
  const create = useMutation(api.accessInvitations.create)
  const [email, setEmail] = useState('')
  const [validUntil, setValidUntil] = useState(() => localDateTime(Date.now() + sevenDaysMs))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{
    text: string
    personId?: string
    error: boolean
  } | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const expiry = new Date(validUntil).getTime()
    if (!Number.isFinite(expiry)) {
      setMessage({ text: 'Choose a valid invitation expiry.', error: true })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const result = await create({
        eventSlug,
        email,
        validUntil: expiry,
        reason,
        clientOperationId: crypto.randomUUID(),
      })
      if (result.outcome === 'already_linked') {
        setMessage({
          text: 'That Google account is already linked to this event.',
          personId: result.personId,
          error: false,
        })
      } else if (result.outcome === 'already_pending') {
        setMessage({ text: 'That Google account already has a current invitation.', error: false })
      } else {
        setMessage({
          text: 'Invitation created. This Google account can now sign in to the operations dashboard.',
          error: false,
        })
        setEmail('')
        setReason('')
        setValidUntil(localDateTime(Date.now() + sevenDaysMs))
      }
    } catch (caught) {
      setMessage({ text: readableError(caught), error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="permission-command invitation-command">
      <div>
        <h2>Invite one person</h2>
        <p className="muted">
          This lets one Google account enter the dashboard. It starts with no role or permissions.
        </p>
      </div>
      <form className="grant-form" onSubmit={submit}>
        <label className="field">
          <span>Google email</span>
          <input
            required
            autoComplete="off"
            inputMode="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Invitation expires <small>5 minutes to 30 days</small></span>
          <input
            required
            type="datetime-local"
            min={localDateTime(Date.now() + fiveMinutesMs)}
            max={localDateTime(Date.now() + thirtyDaysMs)}
            value={validUntil}
            onChange={(event) => setValidUntil(event.target.value)}
          />
        </label>
        <label className="field full-field">
          <span>Why they are being invited</span>
          <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="full-field invitation-submit">
          <button
            className="primary"
            type="submit"
            disabled={busy || !email.trim() || reason.trim().length < 5 || !validUntil}
          >
            {busy ? 'Creating…' : 'Allow this account to sign in'}
          </button>
          <small>You may be asked to sign in again before this access change.</small>
        </div>
      </form>
      {message ? (
        <p className={`notice${message.error ? ' error' : ''}`} role={message.error ? 'alert' : 'status'}>
          {message.text}{' '}
          {message.personId && canReadPeople ? <Link to={`/access/${message.personId}`}>Open account</Link> : null}
        </p>
      ) : null}

      <div className="invitation-list">
        {invitations.results.map((invitation) => (
          <InvitationRow key={invitation.id} invitation={invitation} />
        ))}
        {invitations.status === 'LoadingFirstPage' ? <p className="muted">Loading invitations…</p> : null}
        {invitations.status === 'Exhausted' && invitations.results.length === 0 ? (
          <p className="muted">No open invitations.</p>
        ) : null}
      </div>
      {invitations.status === 'CanLoadMore' ? (
        <button className="secondary" type="button" onClick={() => invitations.loadMore(20)}>
          Load more invitations
        </button>
      ) : null}
    </section>
  )
}

function InvitationRow({ invitation }: { invitation: Invitation }) {
  const revoke = useMutation(api.accessInvitations.revoke)
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirmRevoke = async () => {
    setBusy(true)
    setError(null)
    try {
      await revoke({
        eventSlug,
        invitationId: invitation.id,
        expectedVersion: invitation.version,
        reason,
        clientOperationId: crypto.randomUUID(),
      })
      setConfirming(false)
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="invitation-row">
      <div>
        <strong>{invitation.email}</strong>
        <span>
          {invitation.status === 'pending' ? `Sign in by ${dateTime(invitation.validUntil)}` : 'Expired'}
        </span>
        <small>{invitation.createdBy} · {invitation.reason}</small>
      </div>
      {invitation.status === 'pending' ? (
        <button className="text-button" type="button" onClick={() => setConfirming((value) => !value)}>
          {confirming ? 'Keep' : 'Revoke'}
        </button>
      ) : null}
      {confirming ? (
        <div className="revoke-confirmation invitation-revoke">
          <label className="field">
            <span>Why revoke this invitation?</span>
            <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="button-row">
            <button
              className="secondary"
              type="button"
              disabled={busy || reason.trim().length < 5}
              onClick={() => void confirmRevoke()}
            >
              {busy ? 'Revoking…' : 'Revoke invitation'}
            </button>
            <button className="text-button" type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </article>
  )
}

function localDateTime(timestamp: number) {
  const date = new Date(timestamp)
  const localTimestamp = timestamp - date.getTimezoneOffset() * 60_000
  return new Date(localTimestamp).toISOString().slice(0, 16)
}

function dateTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}
