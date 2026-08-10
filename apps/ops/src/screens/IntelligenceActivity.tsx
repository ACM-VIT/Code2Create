import { api } from '@code2create/backend/api'
import { useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'

import { Icon, type IconName } from '../components/Icon'
import { LoadingLabel, SkeletonList } from '../components/Skeleton'
import { eventSlug } from '../lib/config'

type Overview = FunctionReturnType<typeof api.intelligenceObservability.overview>
type BriefRun = Overview['briefRuns'][number]
type CopilotInstance = Overview['copilotInstances'][number]
type Recommendation = CopilotInstance['recommendations'][number]

function isActiveRun(run: BriefRun) {
  return run.state === 'pending' || run.state === 'dispatching' || run.state === 'accepted'
}

export function IntelligenceActivity() {
  const overview = useQuery(api.intelligenceObservability.overview, { eventSlug })

  if (overview === undefined) {
    return (
      <section className="intelligence-activity-shell">
        <LoadingLabel>Loading agent activity</LoadingLabel>
        <SkeletonList rows={5} />
      </section>
    )
  }

  const activeRun = overview.briefRuns.find(isActiveRun)
  const lastSettledRun = overview.briefRuns.find((run) => !isActiveRun(run))

  return (
    <section className="intelligence-activity-shell">
      <header className="health-heading">
        <div>
          <p className="eyebrow">Intelligence</p>
          <h1>Agent activity</h1>
        </div>
        <div className={`health-current${activeRun ? '' : ' watch'}`}>
          <span>Brief agent</span>
          <strong>{activeRun ? 'Working' : 'Idle'}</strong>
          <small>
            {activeRun
              ? `Preparing a brief since ${formatTime(activeRun.requestedAt)}`
              : lastSettledRun?.completedAt !== undefined
                ? `Last finished ${formatDateTime(lastSettledRun.completedAt)}`
                : 'Has not run yet'}
          </small>
        </div>
      </header>

      <section className="attention-section">
        <div className="section-heading">
          <h2>Automation</h2>
        </div>
        {overview.automation === null ? (
          <div className="health-empty">
            <strong>Proactive briefs are off.</strong>
            <span>No automation policy is active, so runs start only when an operator asks.</span>
          </div>
        ) : (
          <dl className="health-summary">
            <div>
              <dt>State</dt>
              <dd>{automationStateLabel(overview.automation.state)}</dd>
            </div>
            <div>
              <dt>Last checked</dt>
              <dd>
                {overview.automation.lastEvaluatedAt !== undefined
                  ? formatTime(overview.automation.lastEvaluatedAt)
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Last trigger</dt>
              <dd>
                {overview.automation.lastTriggerAt !== undefined
                  ? formatTime(overview.automation.lastTriggerAt)
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Briefs today</dt>
              <dd>
                {overview.automation.briefsStartedToday} of{' '}
                {overview.automation.maximumBriefsPerLocalDay}
              </dd>
            </div>
          </dl>
        )}
        {overview.automation !== null ? (
          <p className="muted">
            Accountable owner: {overview.automation.accountableOwner} · Cooldown{' '}
            {overview.automation.cooldownMinutes} min
          </p>
        ) : null}
      </section>

      <section className="attention-section">
        <div className="section-heading">
          <h2>Brief runs</h2>
          {overview.briefRuns.length > 0 ? <span>{overview.briefRuns.length}</span> : null}
        </div>
        {overview.briefRuns.length === 0 ? (
          <div className="health-empty">
            <strong>No brief has run yet.</strong>
            <span>A run appears when an operator requests a brief or the automation triggers one.</span>
          </div>
        ) : (
          <div className="health-list">
            {overview.briefRuns.map((run) => (
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
      </section>

      <section className="attention-section">
        <div className="section-heading">
          <h2>Copilot conversations</h2>
          {overview.copilotInstances.length > 0 ? (
            <span>{overview.copilotInstances.length}</span>
          ) : null}
        </div>
        {overview.copilotInstances.length === 0 ? (
          <div className="health-empty">
            <strong>No copilot conversation has proposed anything yet.</strong>
            <span>
              A conversation runs its turns and reads inside the agent; it appears here once it
              delivers a recommendation.
            </span>
          </div>
        ) : (
          <div className="agent-instance-list">
            {overview.copilotInstances.map((instance) => (
              <article className="copilot-instance" key={instance.instanceId}>
                <div className="copilot-instance-heading">
                  <span className="instance-id">{instance.instanceId}</span>
                  <span>
                    {instance.openCount > 0 ? `${instance.openCount} awaiting triage · ` : ''}
                    Last active {formatDateTime(instance.lastActivityAt)}
                  </span>
                </div>
                <div className="health-list">
                  {instance.recommendations.map((recommendation) => (
                    <article className="list-row" key={recommendation.id}>
                      <span className={`row-glyph ${recommendationGlyphTone(recommendation.status)}`}>
                        <Icon name={recommendationIcon(recommendation.status)} />
                      </span>
                      <div className="row-text">
                        <strong>{recommendation.statement}</strong>
                        <small>{recommendationMeta(recommendation)}</small>
                      </div>
                      <span className="row-count">
                        {recommendationStatusLabel(recommendation.status)}
                      </span>
                    </article>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  )
}

function runMeta(run: BriefRun) {
  const parts = [
    run.origin === 'automation' ? 'Triggered by automation' : 'Requested by an operator',
    `Requested ${formatDateTime(run.requestedAt)}`,
  ]
  if (run.workerAcceptedAt !== undefined) parts.push(`Accepted ${formatTime(run.workerAcceptedAt)}`)
  if (run.completedAt !== undefined) parts.push(`Finished ${formatTime(run.completedAt)}`)
  if (run.failureCode !== undefined) parts.push(failureLabel(run.failureCode))
  if (run.model !== undefined) parts.push(run.model)
  return parts.join(' · ')
}

function recommendationMeta(recommendation: Recommendation) {
  const parts = [
    kindLabel(recommendation.kind),
    `Read ${recommendation.citedReads.map((read) => read.replace(/_/g, ' ')).join(', ')}`,
    `Proposed ${formatDateTime(recommendation.proposedAt)}`,
  ]
  if (recommendation.decidedAt !== undefined) {
    parts.push(`Decided ${formatTime(recommendation.decidedAt)}`)
  }
  if (recommendation.operatorNote !== undefined) {
    parts.push(`“${recommendation.operatorNote}”`)
  }
  parts.push(recommendation.model)
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

function kindLabel(kind: Recommendation['kind']) {
  if (kind === 'hold_review_team') return 'Hold a review team'
  if (kind === 'page_reserve_reviewer') return 'Page a reserve reviewer'
  if (kind === 'open_support_case') return 'Open a support case'
  return 'Dismiss an attention item'
}

function recommendationStatusLabel(status: Recommendation['status']) {
  if (status === 'proposed') return 'Awaiting triage'
  if (status === 'approved') return 'Approved'
  if (status === 'rejected') return 'Rejected'
  return 'Superseded'
}

function recommendationIcon(status: Recommendation['status']): IconName {
  if (status === 'proposed') return 'clock'
  if (status === 'approved') return 'check'
  if (status === 'rejected') return 'pause'
  return 'arrow'
}

function recommendationGlyphTone(status: Recommendation['status']) {
  return status === 'proposed' ? 'attention' : 'watch'
}

function automationStateLabel(state: NonNullable<Overview['automation']>['state']) {
  if (state === 'active') return 'Active'
  if (state === 'disabled') return 'Off'
  return 'Superseded'
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
