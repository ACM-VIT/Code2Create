import { api } from '@code2create/backend/api'
import { usePaginatedQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'

import { eventSlug } from '../../lib/config'
import { Icon, type IconName } from '../Icon'
import { LoadingLabel } from '../Skeleton'

type BriefRun = FunctionReturnType<typeof api.intelligenceObservability.briefHistory>['page'][number]
const briefPageSize = 12

export function ManualBriefHistory() {
  const history = usePaginatedQuery(
    api.intelligenceObservability.briefHistory,
    { eventSlug },
    { initialNumItems: briefPageSize },
  )

  if (history.status === 'LoadingFirstPage') {
    return (
      <section className="attention-section">
        <LoadingLabel>Loading manual brief history</LoadingLabel>
      </section>
    )
  }

  return (
    <section className="attention-section">
      <div className="section-heading">
        <h2>Manual brief runs</h2>
        {history.results.length > 0 ? <span>{history.results.length}</span> : null}
      </div>
      {history.results.length === 0 ? (
        <div className="health-empty">
          <strong>No brief has run yet.</strong>
          <span>A run appears when an operator requests a brief.</span>
        </div>
      ) : (
        <div className="health-list">
          {history.results.map((run) => (
            <article className={`list-row${run.state === 'failed' ? ' critical' : ''}`} key={run.id}>
              <span className={`row-glyph ${runGlyphTone(run)}`}>
                <Icon name={runIcon(run)} />
              </span>
              <div className="row-text">
                <strong>{run.headline ?? runStateLabel(run.state)}</strong>
                <small>{runMeta(run)}</small>
                <small className="instance-id">{run.id}</small>
              </div>
              <span className="row-count">{runStateLabel(run.state)}</span>
            </article>
          ))}
        </div>
      )}
      {history.status === 'CanLoadMore' ? (
        <button
          className="secondary"
          onClick={() => history.loadMore(briefPageSize)}
          type="button"
        >
          Load older manual briefs
        </button>
      ) : null}
      {history.status === 'LoadingMore' ? <LoadingLabel>Loading older briefs</LoadingLabel> : null}
    </section>
  )
}

function runMeta(run: BriefRun) {
  const parts = [
    'Requested by an operator',
    `Requested ${formatDateTime(run.requestedAt)}`,
  ]
  if (run.workerAcceptedAt !== undefined) parts.push(`Accepted ${formatTime(run.workerAcceptedAt)}`)
  if (run.completedAt !== undefined) parts.push(`Finished ${formatTime(run.completedAt)}`)
  if (run.failureCode !== undefined) parts.push(failureLabel(run.failureCode))
  if (run.model !== undefined) parts.push(run.model)
  return parts.join(' · ')
}

function runStateLabel(state: BriefRun['state']) {
  if (state === 'pending') return 'Queued'
  if (state === 'dispatching') return 'Dispatching'
  if (state === 'accepted') return 'Running'
  if (state === 'succeeded') return 'Done'
  return 'Failed'
}

function runIcon(run: BriefRun): IconName {
  if (run.state === 'succeeded') return 'check'
  if (run.state === 'failed') return 'alert'
  return 'clock'
}

function runGlyphTone(run: BriefRun) {
  if (run.state === 'failed') return 'critical'
  if (run.state === 'succeeded') return 'watch'
  return 'attention'
}

function failureLabel(code: NonNullable<BriefRun['failureCode']>) {
  if (code === 'dispatch_failed') return 'The dispatch failed'
  if (code === 'agent_timed_out') return 'The agent timed out'
  if (code === 'model_did_not_publish') return 'The model did not publish'
  return 'The callback was rejected'
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDateTime(value: number) {
  return new Date(value).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
