import { api } from '@code2create/backend/api'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useState } from 'react'

import {
  AutonomyQueuedWorkList,
  AutonomyRunInspection,
  AutonomyRunList,
  ManualBriefHistory,
  RecommendationQueues,
} from '../components/intelligence'
import { LoadingLabel, SkeletonList } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { formatClockTime, formatCompactDateTime } from '../lib/dateTime'
import { readableError } from '../lib/errors'
import {
  autonomyRunPhaseLabel,
  autonomyRunStateLabel,
} from '../lib/operationsAutonomyPresentation'
import { useOperationRunner } from '../lib/operations'

type AutonomyStart = FunctionReturnType<typeof api.operationsAutonomy.startManual>
const autonomyPageSize = 12

export function IntelligenceActivity({ canGenerate }: { canGenerate: boolean }) {
  const autonomy = useQuery(api.operationsAutonomy.status, { eventSlug })
  const runHistory = usePaginatedQuery(
    api.operationsAutonomy.history,
    { eventSlug },
    { initialNumItems: autonomyPageSize },
  )
  const queuedWork = usePaginatedQuery(
    api.operationsAutonomy.queuedWork,
    { eventSlug },
    { initialNumItems: autonomyPageSize },
  )
  const startManual = useMutation(api.operationsAutonomy.startManual)
  const startOperation = useOperationRunner<AutonomyStart>()
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [startError, setStartError] = useState<string>()

  if (
    autonomy === undefined
    || runHistory.status === 'LoadingFirstPage'
    || queuedWork.status === 'LoadingFirstPage'
  ) {
    return (
      <section className="intelligence-activity-shell">
        <LoadingLabel>Loading agent activity</LoadingLabel>
        <SkeletonList rows={5} />
      </section>
    )
  }

  const activeRun = autonomy.activeRun
  const runs = activeRun === null || runHistory.results.some((run) => run.runId === activeRun.runId)
    ? runHistory.results
    : [activeRun, ...runHistory.results]
  const selectedRun = runs.find((run) => run.runId === selectedRunId)
    ?? activeRun
    ?? runs[0]
  const startPending = startOperation.hasPending('autonomy-start-manual')
  const canStart = canGenerate && autonomy.canStart

  const requestManualRun = async () => {
    setStartError(undefined)
    try {
      const result = await startOperation.run(
        'autonomy-start-manual',
        (clientOperationId) => () => startManual({ eventSlug, clientOperationId }),
      )
      if (result.state === 'started') setSelectedRunId(result.runId)
    } catch (caught) {
      setStartError(readableError(caught))
    }
  }

  return (
    <section className="intelligence-activity-shell">
      <header className="health-heading">
        <div>
          <h2>Agent activity</h2>
          <p className="muted">Autonomous reviews, manual briefs, and human-controlled recommendations.</p>
        </div>
        <div className={`health-current${activeRun ? ' attention' : ' watch'}`}>
          <span>Autonomous agent</span>
          <strong>{activeRun ? autonomyRunStateLabel(activeRun.state) : 'Idle'}</strong>
          <small>
            {activeRun
              ? `${autonomyRunPhaseLabel(activeRun.phase)} · since ${formatClockTime(activeRun.createdAt)}`
              : runs[0] !== undefined
                ? `Last updated ${formatCompactDateTime(runs[0].updatedAt)}`
                : 'Has not run yet'}
          </small>
        </div>
      </header>

      <section className="attention-section">
        <div className="section-heading">
          <div>
            <h2>Autonomous operations</h2>
            <p className="muted">
              {autonomy.policy.mode === 'recommend'
                ? 'Observes the event and proposes actions for an organizer to decide'
                : 'Observes the event without proposing actions'}
            </p>
          </div>
          <div className="row-controls">
            <span className={`state-label ${autonomy.scheduler.lifecycle === 'active' ? 'connected' : 'offline'}`}>
              {autonomy.scheduler.lifecycle === 'active' ? 'Enabled' : 'Stopped'}
            </span>
            {canGenerate ? (
              <button
                className="secondary"
                disabled={!canStart && !startPending}
                onClick={() => void requestManualRun()}
                type="button"
              >
                {startPending ? 'Confirm request' : activeRun ? 'Queue another review' : 'Run now'}
              </button>
            ) : null}
          </div>
        </div>
        {startError === undefined ? null : <p className="notice error" role="alert">{startError}</p>}
        {autonomy.eventStatus !== 'live' ? (
          <p className="notice">Autonomy is unavailable because this event is no longer live.</p>
        ) : !autonomy.policy.enabled || autonomy.scheduler.lifecycle === 'disabled' ? (
          <p className="notice">Autonomy is stopped. Publish an enabled policy before starting a run.</p>
        ) : null}
        <AutonomyRunList
          runs={runs}
          selectedRunId={selectedRun?.runId}
          onSelect={setSelectedRunId}
        />
        {runHistory.status === 'CanLoadMore' ? (
          <button
            className="secondary"
            onClick={() => runHistory.loadMore(autonomyPageSize)}
            type="button"
          >
            Load older autonomous runs
          </button>
        ) : null}
        {runHistory.status === 'LoadingMore' ? <LoadingLabel>Loading older runs</LoadingLabel> : null}
        {selectedRun === undefined ? null : <AutonomyRunInspection run={selectedRun} />}
        {queuedWork.results.length === 0 ? null : (
          <section>
            <div className="section-heading">
              <div>
                <h3>Queued autonomous work</h3>
                <p className="muted">New checks wait here and run in order.</p>
              </div>
              <span>{autonomy.scheduler.queuedWorkCount}</span>
            </div>
            <AutonomyQueuedWorkList items={queuedWork.results} />
            {queuedWork.status === 'CanLoadMore' ? (
              <button
                className="secondary"
                onClick={() => queuedWork.loadMore(autonomyPageSize)}
                type="button"
              >
                Load more queued work
              </button>
            ) : null}
          </section>
        )}
      </section>

      <RecommendationQueues />

      <ManualBriefHistory />

    </section>
  )
}
