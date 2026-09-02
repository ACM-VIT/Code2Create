import { api } from '@code2create/backend/api'
import {
  admissionRecommendationStateLabels,
  applicationStateLabels,
  type ApplicationState,
} from '@code2create/domain'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { Link } from 'react-router-dom'
import { useState } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import { LoadingLabel, SkeletonList } from '../components/Skeleton'

type AssignmentState = 'active' | 'completed'
type QueueView = 'all' | 'mine'

export function AdmissionsQueue({
  canReadApplications,
  canReadAssignments,
  isSupreme,
}: {
  canReadApplications: boolean
  canReadAssignments: boolean
  isSupreme: boolean
}) {
  const [selectedView, setSelectedView] = useState<QueueView>(canReadApplications ? 'all' : 'mine')
  const view = selectedView === 'all'
    ? (canReadApplications ? 'all' : 'mine')
    : (canReadAssignments ? 'mine' : 'all')

  return (
    <section className="queue-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Before the event</p>
          <h1>Applications</h1>
        </div>
      </div>
      {isSupreme ? <AdmissionResultsRelease /> : null}
      {canReadApplications && canReadAssignments ? (
        <div className="configuration-tabs" role="tablist" aria-label="Admission queue view">
          <button
            aria-selected={view === 'all'}
            className={view === 'all' ? 'active' : ''}
            role="tab"
            type="button"
            onClick={() => setSelectedView('all')}
          >
            All applications
          </button>
          <button
            aria-selected={view === 'mine'}
            className={view === 'mine' ? 'active' : ''}
            role="tab"
            type="button"
            onClick={() => setSelectedView('mine')}
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

function AdmissionResultsRelease() {
  const status = useQuery(api.admissions.admissionResultsReleaseStatus, { eventSlug })
  const release = useMutation(api.admissions.releaseAdmissionResults)
  const operations = useOperationRunner()
  const [armed, setArmed] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = operations.hasPending('admission-results-release')
  if (status === undefined) {
    return <section className="catalog-review"><LoadingLabel>Checking recorded decisions</LoadingLabel></section>
  }
  if (!status.isSupreme) return null
  const ready = status.serverNow >= status.applicationsCloseAt &&
    status.releasedAt === undefined &&
    status.total > 0 &&
    status.unrecorded === 0

  const releaseResults = async () => {
    setError(null)
    setBusy(true)
    try {
      if (pending) {
        await operations.retryPending('admission-results-release')
      } else {
        await operations.run('admission-results-release', (clientOperationId) => () => release({
          eventSlug,
          expectedEventVersion: status.eventVersion,
          reason,
          clientOperationId,
        }))
      }
      setArmed(false)
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="catalog-review admissions-release-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Supreme review</p>
          <h2>{status.releasedAt ? 'Admission results released' : 'Release admission results'}</h2>
          <p className="muted">
            {status.releasedAt
              ? `${status.releasedByName ?? 'Supreme'} released the results. Participant portals and emails use the same decision set.`
              : 'Review every recorded decision here. Releasing makes all final results visible together and queues the configured emails.'}
          </p>
        </div>
        {!status.releasedAt && !armed ? (
          <button className="primary" type="button" disabled={!ready} onClick={() => setArmed(true)}>
            Review release
          </button>
        ) : null}
      </div>
      <dl className="catalog-summary">
        <div><dt>Applications</dt><dd>{status.total}</dd></div>
        <div><dt>Decisions ready</dt><dd>{status.recorded + status.released}</dd></div>
        <div><dt>Still needed</dt><dd>{status.unrecorded}</dd></div>
        <div><dt>Selected</dt><dd>{status.accepted}</dd></div>
        <div><dt>Waitlisted</dt><dd>{status.waitlisted}</dd></div>
        <div><dt>Not selected</dt><dd>{status.declined}</dd></div>
      </dl>
      {status.decisions.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Team</th><th>Decision</th><th>Reason</th><th>Recorded by</th></tr></thead>
            <tbody>
              {status.decisions.map((row) => (
                <tr key={row.applicationId}>
                  <td><Link to={`/admissions/${row.applicationId}`}>{row.teamName}</Link></td>
                  <td>{decisionName(row.decision)}</td>
                  <td>{row.reasonLabel}</td>
                  <td>{row.decidedByName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!status.releasedAt && status.unrecorded > 0 ? (
        <p className="notice">Record a final decision for all {status.unrecorded} remaining applications before release.</p>
      ) : null}
      {!status.releasedAt && armed ? (
        <div className="publish-confirmation">
          <h3>Release all {status.total} results?</h3>
          <p className="muted">This is the participant-visible boundary. It cannot be rolled back.</p>
          <label className="field">
            <span>Release note</span>
            <textarea required minLength={5} maxLength={500} value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
          </label>
          <div className="button-row">
            <button className="primary" type="button" disabled={busy || reason.trim().length < 5} onClick={() => void releaseResults()}>
              {busy ? 'Releasing…' : pending ? 'Confirm earlier release' : 'Release all results'}
            </button>
            <button className="secondary" type="button" disabled={busy || pending} onClick={() => setArmed(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

const stageOrder: ApplicationState[] = [
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
  const busiest = stageOrder.find((candidate) => (countByState.get(candidate) ?? 0) > 0)
  const [chosen, setState] = useState<ApplicationState | null>(null)
  const state = chosen ?? busiest ?? 'submitted'
  const { results, status, loadMore } = usePaginatedQuery(
    api.admissions.list,
    { eventSlug, state },
    { initialNumItems: 30 },
  )

  return (
    <>
      <label className="filter queue-stage-filter">
        <span>Status</span>
        <select value={state} onChange={(event) => setState(parseQueueState(event.target.value))}>
          {stageOrder.map((candidate) => (
            <option key={candidate} value={candidate}>
              {applicationStateLabels[candidate]} · {countByState.get(candidate) ?? 0}
            </option>
          ))}
        </select>
      </label>
      <div className="queue-list">
        {results.map((application) => (
          <Link className="queue-row" key={application.id} to={`/admissions/${application.id}`}>
            <div>
              <strong>{application.teamName}</strong>
              <span>
                {application.experienceBand ? experienceName(application.experienceBand) : 'Application'}
              </span>
            </div>
            <div className="queue-meta">
              <span>{countLabel(application.completedReviewCount, 'review')} · {application.assignedReviewCount} assigned</span>
              {application.decisionStage === 'recorded' && application.humanDecision ? (
                <span>Recorded · {decisionName(application.humanDecision)}</span>
              ) : null}
              {application.aiState ? (
                <span>Idea agent · {admissionRecommendationStateLabels[application.aiState]}</span>
              ) : null}
            </div>
          </Link>
        ))}
        {status === 'LoadingFirstPage' ? (
          <>
            <LoadingLabel>Loading applications</LoadingLabel>
            <SkeletonList rows={5} />
          </>
        ) : null}
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

function parseQueueState(value: string): ApplicationState {
  return stageOrder.find((candidate) => candidate === value) ?? 'submitted'
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
                {assignment.experienceBand ? experienceName(assignment.experienceBand) : 'Application'}
              </span>
            </div>
            <div className="queue-meta">
              <span>{assignment.ownRecommendation ? `Your review: ${decisionName(assignment.ownRecommendation)}` : 'Review not submitted'}</span>
              <span>{applicationStateLabels[assignment.applicationState]}</span>
            </div>
          </Link>
        ))}
        {status === 'LoadingFirstPage' ? (
          <>
            <LoadingLabel>Loading your review work</LoadingLabel>
            <SkeletonList rows={5} />
          </>
        ) : null}
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
