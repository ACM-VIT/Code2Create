import { api } from '@code2create/backend/api'
import { usePaginatedQuery, useQuery } from 'convex/react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { AccessInvitations } from '../components/AccessInvitations'
import { eventSlug } from '../lib/config'

export function AccessDirectory({
  canBrowsePeople,
  canReadPeople,
  canInvite,
  canReadBundles,
  canReadRoster,
}: {
  canBrowsePeople: boolean
  canReadPeople: boolean
  canInvite: boolean
  canReadBundles: boolean
  canReadRoster: boolean
}) {
  const directory = usePaginatedQuery(
    api.access.directory,
    canBrowsePeople ? { eventSlug } : 'skip',
    { initialNumItems: 40 },
  )
  const [email, setEmail] = useState('')
  const [searchedEmail, setSearchedEmail] = useState<string | null>(null)
  const match = useQuery(
    api.access.findByEmail,
    canReadPeople && searchedEmail ? { eventSlug, email: searchedEmail } : 'skip',
  )

  const search = (event: FormEvent) => {
    event.preventDefault()
    const normalized = email.trim().toLowerCase()
    setSearchedEmail(normalized || null)
  }

  return (
    <section className="access-shell">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Access</p>
          <h1>People and permissions</h1>
          <p className="muted">Invite staff, find participants, and control exactly what each person can do.</p>
        </div>
        <div className="button-row">
          {canReadRoster ? (
            <Link className="secondary compact-link" to="/access/roster">Event team</Link>
          ) : null}
          {canReadBundles ? (
            <Link className="secondary compact-link" to="/access/bundles">Reusable access</Link>
          ) : null}
        </div>
      </header>

      {canInvite ? <AccessInvitations canReadPeople={canReadPeople} /> : null}

      {canReadPeople ? (
        <>
          <form className="email-search" onSubmit={search}>
            <label className="field">
              <span>{canBrowsePeople ? 'Find any event account' : 'Find an account you can inspect'}</span>
              <input
                autoComplete="off"
                inputMode="email"
                placeholder="person@example.com"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <button className="secondary" type="submit" disabled={!email.trim()}>Find</button>
          </form>

          {searchedEmail ? (
            <div className="search-result">
              {match === undefined ? (
                <p className="muted">Looking up {searchedEmail}…</p>
              ) : match ? (
                <PersonRow person={match} />
              ) : (
                <p className="notice">No one in this event uses {searchedEmail}.</p>
              )}
            </div>
          ) : null}

          {canBrowsePeople ? (
            <>
              <div className="access-list">
                {directory.results.map((person) => <PersonRow key={person.personId} person={person} />)}
                {directory.status === 'LoadingFirstPage' ? <p className="muted">Loading people…</p> : null}
              </div>
              {directory.status === 'CanLoadMore' ? (
                <button className="secondary" type="button" onClick={() => directory.loadMore(40)}>Load more</button>
              ) : null}
            </>
          ) : (
            <p className="notice">Search by the email attached to your exact-person access.</p>
          )}
        </>
      ) : canInvite ? (
        <p className="notice">You can invite someone but not view the event team.</p>
      ) : null}
    </section>
  )
}

function PersonRow({
  person,
}: {
  person: {
    personId: string
    displayName: string
    email: string
    status: 'active' | 'suspended' | 'closed'
    isParticipant: boolean
    role?: string
  }
}) {
  return (
    <Link className="access-row" to={`/access/${person.personId}`}>
      <div>
        <strong>{person.displayName}</strong>
        <span>{person.email}</span>
      </div>
      <div className="access-row-meta">
        <span>{statusName(person.status)}</span>
        {person.role ? <span>{roleName(person.role)}</span> : null}
        {person.isParticipant ? <span>Participant</span> : null}
        {!person.role && !person.isParticipant ? <span>No role assigned</span> : null}
      </div>
    </Link>
  )
}

function roleName(value: string) {
  if (value === 'external_judge') return 'External judge'
  if (value === 'sc') return 'SC'
  if (value === 'jc') return 'JC'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function statusName(value: 'active' | 'suspended' | 'closed') {
  if (value === 'active') return 'Active'
  if (value === 'suspended') return 'Suspended'
  return 'Closed'
}
