import { api } from '@code2create/backend/api'
import { eventRoleLabels } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { usePaginatedQuery, useQuery } from 'convex/react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { AccessInvitations } from '../components/AccessInvitations'
import { eventSlug } from '../lib/config'

type DirectoryPerson = FunctionReturnType<typeof api.access.directory>['page'][number]

const accessSubjectStatusLabels: Record<DirectoryPerson['status'], string> = {
  active: 'Active',
  suspended: 'Suspended',
  closed: 'Closed',
}

export function AccessDirectory({
  canBrowsePeople,
  canReadPeople,
  canInvite,
  canReadBundles,
  canReadRoster,
  canReadTeamRoster,
  serverNow,
}: {
  canBrowsePeople: boolean
  canReadPeople: boolean
  canInvite: boolean
  canReadBundles: boolean
  canReadRoster: boolean
  canReadTeamRoster: boolean
  serverNow: number
}) {
  const directory = usePaginatedQuery(
    api.access.directory,
    canBrowsePeople ? { eventSlug } : 'skip',
    { initialNumItems: 40 },
  )
  const [email, setEmail] = useState('')
  const [searchedEmail, setSearchedEmail] = useState<string | null>(null)
  const [showInvitations, setShowInvitations] = useState(false)
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
          {canInvite ? (
            <button
              aria-expanded={showInvitations}
              className={showInvitations ? 'secondary active' : 'secondary'}
              type="button"
              onClick={() => setShowInvitations((current) => !current)}
            >
              {showInvitations ? 'Close invitations' : 'Invite someone'}
            </button>
          ) : null}
          {canReadRoster ? (
            <Link className="secondary compact-link" to="/access/roster">Event team</Link>
          ) : null}
          {canReadTeamRoster ? (
            <Link className="secondary compact-link" to="/access/team-roster">Participant teams</Link>
          ) : null}
          {canReadBundles ? (
            <Link className="secondary compact-link" to="/access/bundles">Reusable access</Link>
          ) : null}
        </div>
      </header>

      {canInvite && showInvitations ? <AccessInvitations serverNow={serverNow} /> : null}

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
            <p className="notice">Search by the person’s email address.</p>
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
  person: DirectoryPerson
}) {
  return (
    <Link className="access-row" to={`/access/${person.personId}`}>
      <div>
        <strong>{person.displayName}</strong>
        <span>{person.email}</span>
      </div>
      <div className="access-row-meta">
        <span>{accessSubjectStatusLabels[person.status]}</span>
        {person.role ? <span>{eventRoleLabels[person.role]}</span> : null}
        {person.isParticipant ? <span>Participant</span> : null}
        {!person.role && !person.isParticipant ? <span>No role assigned</span> : null}
      </div>
    </Link>
  )
}
