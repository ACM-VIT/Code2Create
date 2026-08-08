import { api } from '@code2create/backend/api'
import { usePaginatedQuery, useQuery } from 'convex/react'
import { lazy, Suspense, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { AttendanceRemedy } from '../components/AttendanceRemedy'
import { AttendanceReconciliation } from '../components/AttendanceReconciliation'
import { AttendanceRollCall } from '../components/AttendanceRollCall'
import { eventSlug } from '../lib/config'

const AttendanceExport = lazy(() => import('../components/AttendanceExport'))
const AttendanceManualRecovery = lazy(() => import('../components/AttendanceManualRecovery'))

type PresenceFilter =
  | 'all'
  | 'confirmation_due'
  | 'present'
  | 'temporarily_out'
  | 'complete'
  | 'excused'
  | 'needs_review'

export function AttendanceSession() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [filter, setFilter] = useState<PresenceFilter>('all')
  const overview = useQuery(api.attendanceOperations.overview, { eventSlug })
  const session = overview?.sessions.find((candidate) => candidate.id === sessionId)
  const roster = usePaginatedQuery(
    api.attendanceOperations.sessionRoster,
    sessionId && session?.canReadRoster
      ? {
          eventSlug,
          sessionId,
          ...(filter === 'all' ? {} : { state: filter }),
        }
      : 'skip',
    { initialNumItems: 50 },
  )

  if (!sessionId) return <p className="notice error">Session ID is missing.</p>
  if (overview === undefined || (session?.canReadRoster && roster.status === 'LoadingFirstPage')) {
    return <p className="muted">Loading session…</p>
  }
  if (!session) return <p className="notice error">This session is not visible to your permission scope.</p>

  return (
    <section className="attendance-shell">
      <Link className="back-link" to="/attendance">← Attendance</Link>
      <header className="page-heading">
        <div>
          <p className="eyebrow">{session.zoneName}</p>
          <h1>{session.name}</h1>
          <p className="muted">Accepted scanner and paper state, closed-session review, and emergency accounting from one backend.</p>
        </div>
        {session.canReadRoster ? (
          <label className="filter">
            <span>Show</span>
            <select value={filter} onChange={(event) => setFilter(parseFilter(event.target.value))}>
              <option value="all">Everyone</option>
              <option value="confirmation_due">Waiting</option>
              <option value="present">Present</option>
              <option value="temporarily_out">Temporarily out</option>
              <option value="complete">Complete</option>
              <option value="excused">Excused</option>
              <option value="needs_review">Needs review</option>
            </select>
          </label>
        ) : null}
      </header>

      {session.canReadRollCalls ? <AttendanceRollCall session={session} /> : null}

      {session.canExport ? (
        <Suspense fallback={<p className="muted">Loading protected export…</p>}>
          <AttendanceExport session={session} />
        </Suspense>
      ) : null}

      {session.canReadManualSheets ? (
        <Suspense fallback={<p className="muted">Loading paper recovery…</p>}>
          <AttendanceManualRecovery session={session} />
        </Suspense>
      ) : null}

      {session.canReadRoster ? (
        <>
          <div className="roster-list">
            {roster.results.map((participant) => (
              <article className="roster-entry" key={`${participant.membershipId}-${participant.version}`}>
                <div className="roster-row">
                  <div>
                    <strong>{participant.displayName}</strong>
                    <span>{participant.teamName ?? 'No active team'}</span>
                  </div>
                  <div className="roster-state">
                    <strong>{participant.result ? resultName(participant.result) : stateName(participant.state)}</strong>
                    <span>
                      {participant.presentDurationMs !== undefined
                        ? durationName(participant.presentDurationMs)
                        : participant.late
                          ? 'Late confirmation'
                          : participant.expectation.replaceAll('_', ' ')}
                    </span>
                    {session.canReconcile ? (
                      <AttendanceReconciliation session={session} participant={participant} />
                    ) : null}
                    {session.canReadRemedies ? (
                      <AttendanceRemedy session={session} participant={participant} />
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
            {roster.results.length === 0 ? <p className="empty">No participants match this view.</p> : null}
          </div>
          {roster.status === 'CanLoadMore' ? (
            <button className="secondary" type="button" onClick={() => roster.loadMore(50)}>Load more</button>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function parseFilter(value: string): PresenceFilter {
  if (
    value === 'confirmation_due' ||
    value === 'present' ||
    value === 'temporarily_out' ||
    value === 'complete' ||
    value === 'excused' ||
    value === 'needs_review'
  ) return value
  return 'all'
}

function stateName(value: string) {
  if (value === 'confirmation_due') return 'Waiting'
  if (value === 'temporarily_out') return 'Temporarily out'
  if (value === 'needs_review') return 'Needs review'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function resultName(value: string) {
  if (value === 'not_expected') return 'Not expected'
  if (value === 'needs_review') return 'Needs review'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function durationName(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60_000)
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return hours > 0 ? `${hours}h ${remainder}m present` : `${minutes}m present`
}
