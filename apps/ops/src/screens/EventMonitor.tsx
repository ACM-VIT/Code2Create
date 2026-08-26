import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useQuery } from 'convex/react'

import { Icon, type IconName } from '../components/Icon'
import { OperationsAttention } from '../components/OperationsAttention'
import { LoadingLabel, SkeletonCard, SkeletonList } from '../components/Skeleton'
import { eventSlug } from '../lib/config'

const attentionCoveredSignalKeys = ['panels_needing_reviewer', 'overdue_reviews']
type HealthOverviewData = FunctionReturnType<typeof api.operationsHealth.overview>

export function EventMonitor({ canManageAttention }: { canManageAttention: boolean }) {
  const health = useQuery(api.operationsHealth.overview, { eventSlug })

  if (health === undefined) {
    return (
      <section className="health-shell">
        <LoadingLabel>Loading the event monitor</LoadingLabel>
        <SkeletonCard lines={3} />
        <SkeletonList rows={5} />
      </section>
    )
  }

  const snapshot = health.state === 'ready' ? health.snapshot : null
  const systemSignals = snapshot?.signals.filter(
    (signal) => !attentionCoveredSignalKeys.some((covered) => covered === signal.key),
  ) ?? []

  return (
    <section className="health-shell">
      <header className="health-heading">
        <div>
          <p className="eyebrow">{snapshot?.event.name ?? 'Live operations'}</p>
          <h1>Event monitor</h1>
        </div>
        <HealthState health={health} />
      </header>

      <OperationsAttention canManageAttention={canManageAttention} compact={false} />

      <section className="attention-section" aria-labelledby="system-checks-heading">
        <div className="section-heading">
          <h2 id="system-checks-heading">System checks</h2>
          {systemSignals.length > 0 ? <span>{systemSignals.length} open</span> : null}
        </div>
        {health.state !== 'ready' ? (
          <div className="health-empty">
            <strong>
              {health.state === 'missing' ? 'Checks are starting.' : 'Checks are delayed.'}
            </strong>
            <span>
              {health.state === 'missing'
                ? 'The first event-wide check has not completed.'
                : `Last complete check: ${formatDateTime(health.lastGeneratedAt)}.`}
            </span>
          </div>
        ) : systemSignals.length === 0 ? (
          <div className="health-empty"><strong>No system issue needs action.</strong></div>
        ) : (
          <div className="health-list">
            {systemSignals.map((signal) => (
              <article className={`list-row ${signal.severity}`} key={signal.key}>
                <span className={`row-glyph ${signal.severity}`}>
                  <Icon name={severityIcon(signal.severity)} />
                </span>
                <div className="row-text">
                  <strong>{signal.title}</strong>
                  <small>
                    {signal.detail} {signal.owner} handles this
                    {signal.oldestAt !== undefined ? ` · oldest ${formatDateTime(signal.oldestAt)}` : ''}.
                  </small>
                </div>
                <span className="row-count">{signal.count}{signal.atLeast ? '+' : ''}</span>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  )
}

function HealthState({
  health,
}: {
  health: HealthOverviewData
}) {
  if (health.state !== 'ready') {
    return (
      <div className="health-current watch">
        <span>System health</span>
        <strong>{health.state === 'missing' ? 'Starting' : 'Delayed'}</strong>
        <small>
          {health.state === 'missing' ? 'Waiting for the first check' : `Last complete ${formatTime(health.lastGeneratedAt)}`}
        </small>
      </div>
    )
  }
  return (
    <div className={`health-current ${health.snapshot.summary.status}`}>
      <span>System health</span>
      <strong>{statusLabel(health.snapshot.summary.status)}</strong>
      <small>Updated {formatTime(health.snapshot.generatedAt)}</small>
    </div>
  )
}

function statusLabel(value: 'healthy' | 'watch' | 'attention' | 'critical') {
  if (value === 'healthy') return 'Clear'
  if (value === 'watch') return 'Watch'
  if (value === 'attention') return 'Needs attention'
  return 'Critical'
}

function severityIcon(value: 'watch' | 'attention' | 'critical'): IconName {
  if (value === 'critical') return 'alert'
  if (value === 'attention') return 'clock'
  return 'pause'
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
