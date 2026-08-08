import { api } from '@code2create/backend/api'
import { applicationStateLabels } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { usePaginatedQuery, useQuery } from 'convex/react'
import { Link } from 'react-router-dom'
import { useState } from 'react'

import { eventSlug } from '../lib/config'

type Access = NonNullable<FunctionReturnType<typeof api.access.mine>>
type QueueState =
  | 'submitted'
  | 'under_review'
  | 'needs_information'
  | 'accepted'
  | 'waitlisted'
  | 'declined'
  | 'offer_sent'
  | 'confirmed'
  | 'offer_expired'
  | 'withdrawn'
type AssignmentState = 'active' | 'completed'
type QueueView = 'all' | 'mine'

export function AdmissionsQueue({ access }: { access: Access }) {
  const canReadApplications = access.grants.some(
    (grant) => grant.permissionKey === 'application.read',
  )
  const canReadAssignments = access.grants.some(
    (grant) => grant.permissionKey === 'application.review.read',
  )
  const [view, setView] = useState<QueueView>(canReadApplications ? 'all' : 'mine')

  return (
    <section className="queue-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Before the event</p>
          <h1>Applications</h1>
        </div>
      </div>
      {canReadApplications && canReadAssignments ? (
        <div className="configuration-tabs" role="tablist" aria-label="Admission queue view">
          <button
            aria-selected={view === 'all'}
            className={view === 'all' ? 'active' : ''}
            role="tab"
            type="button"
            onClick={() => setView('all')}
          >
            All applications
          </button>
          <button
            aria-selected={view === 'mine'}
            className={view === 'mine' ? 'active' : ''}
            role="tab"
            type="button"
            onClick={() => setView('mine')}
          >
            Assigned to me
          </button>
        </div>
      ) : null}
      {view === 'all' && canReadApplications ? <ApplicationList /> : null}
      {view === 'mine' && canReadAssignments ? <AssignmentList /> : null}
    </section>
  )
}

/** Stages in the order an application moves through them. */
const stageOrder: QueueState[] = [
  'submitted',
  'under_review',
  'needs_information',
  'accepted',
  'offer_sent',
  'confirmed',
  'waitlisted',
  'declined',
  'offer_expired',
  'withdrawn',
]

function ApplicationList() {
  const counts = useQuery(api.admissions.stageCounts, { eventSlug })
  const countByState = new Map((counts ?? []).map((row) => [row.state, row.count]))
  // Open on the first stage that has anything in it, so the queue never lands
  // on an empty screen while applications are waiting somewhere else.
  const busiest = stageOrder.find((candidate) => (countByState.get(candidate) ?? 0) > 0)
  const [chosen, setState] = useState<QueueState | null>(null)
  const state = chosen ?? busiest ?? 'submitted'
  const { results, status, loadMore } = usePaginatedQuery(
    api.admissions.list,
    { eventSlug, state },
    { initialNumItems: 30 },
  )

  return (
    <>
      <nav className="stage-filter" aria-label="Application stage">
        {stageOrder.map((candidate) => {
          const count = countByState.get(candidate) ?? 0
          return (
            <button
              aria-current={candidate === state}
              className={candidate === state ? 'stage-chip active' : 'stage-chip'}
              disabled={count === 0 && candidate !== state}
              key={candidate}
              type="button"
              onClick={() => setState(candidate)}
            >
              {applicationStateLabels[candidate]}
              <span>{count}</span>
            </button>
          )
        })}
      </nav>
      <div className="queue-list">
        {results.map((application) => (
          <Link className="queue-row" key={application.id} to={`/admissions/${application.id}`}>
            <div>
              <strong>{application.teamName}</strong>
              <span>
                {application.trackName}
                {application.experienceBand ? ` · ${experienceName(application.experienceBand)}` : ''}
              </span>
            </div>
            <div className="queue-meta">
              <span>{countLabel(application.completedReviewCount, 'review')} · {application.assignedReviewCount} assigned</span>
            </div>
          </Link>
        ))}
        {status === 'LoadingFirstPage' ? <p className="muted">Loading applications…</p> : null}
        {status !== 'LoadingFirstPage' && results.length === 0 ? (
          <p className="empty">
            {countByState.size === 0
              ? 'No team has applied yet.'
              : `Nothing at this stage. ${[...countByState.entries()]
                  .map(([key, value]) => `${value} ${applicationStateLabels[key].toLowerCase()}`)
                  .join(', ')}.`}
          </p>
        ) : null}
      </div>
      {status === 'CanLoadMore' ? (
        <button className="secondary" type="button" onClick={() => loadMore(30)}>Load more</button>
      ) : null}
    </>
  )
}

function AssignmentList() {
  const [state, setState] = useState<AssignmentState>('active')
  const { results, status, loadMore } = usePaginatedQuery(
    api.admissions.myReviewAssignments,
    { eventSlug, state },
    { initialNumItems: 30 },
  )

  return (
    <>
      <div className="queue-toolbar">
        <label className="filter">
          <span>Show</span>
          <select value={state} onChange={(event) => setState(parseAssignmentState(event.target.value))}>
            <option value="active">To review</option>
            <option value="completed">Completed</option>
          </select>
        </label>
      </div>
      <div className="queue-list">
        {results.map((assignment) => (
          <Link className="queue-row" key={assignment.assignmentId} to={`/admissions/${assignment.applicationId}`}>
            <div>
              <strong>{assignment.teamName}</strong>
              <span>
                {assignment.trackName}
                {assignment.experienceBand ? ` · ${experienceName(assignment.experienceBand)}` : ''}
              </span>
            </div>
            <div className="queue-meta">
              <span>{assignment.ownRecommendation ? `Your review: ${decisionName(assignment.ownRecommendation)}` : 'Review not submitted'}</span>
              <span>{assignment.applicationState.replaceAll('_', ' ')}</span>
            </div>
          </Link>
        ))}
        {status === 'LoadingFirstPage' ? <p className="muted">Loading review work…</p> : null}
        {status !== 'LoadingFirstPage' && results.length === 0 ? (
          <p className="empty">No {assignmentStateName(state).toLowerCase()} review assignments.</p>
        ) : null}
      </div>
      {status === 'CanLoadMore' ? (
        <button className="secondary" type="button" onClick={() => loadMore(30)}>Load more</button>
      ) : null}
    </>
  )
}

function parseAssignmentState(value: string): AssignmentState {
  if (value === 'active' || value === 'completed') return value
  return 'active'
}

function assignmentStateName(value: AssignmentState) {
  if (value === 'active') return 'Active'
  return 'Completed'
}

function decisionName(value: string) {
  if (value === 'accept') return 'Accept'
  if (value === 'waitlist') return 'Waitlist'
  if (value === 'decline') return 'Decline'
  return 'Needs information'
}

function experienceName(value: string) {
  if (value === 'first_year') return 'First-year expectations'
  if (value === 'early_year') return 'Early-year expectations'
  if (value === 'later_year') return 'Later-year expectations'
  if (value === 'postgraduate_or_professional') return 'Postgraduate or professional expectations'
  return 'Mixed or external context'
}

function countLabel(value: number, label: string) {
  return `${value} ${label}${value === 1 ? '' : 's'}`
}
