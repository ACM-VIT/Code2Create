import { api } from '@code2create/backend/api'
import {
  activeWorkBlockerKeys,
  eventBlockerPaths,
  eventStageGuidance,
} from '@code2create/domain'
import { useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'

import { Icon, type IconName } from '../components/Icon'
import { LoadingLabel, SkeletonCard, SkeletonList } from '../components/Skeleton'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../lib/config'

const attentionCoveredSignalKeys = ['panels_needing_reviewer', 'overdue_reviews']

type AttentionRow = FunctionReturnType<typeof api.operationsAttention.overview>['rows'][number]

export function HealthOverview({ canManageAttention }: { canManageAttention: boolean }) {
  const health = useQuery(api.operationsHealth.overview, { eventSlug })
  if (health === undefined) {
    return (
      <section className="health-shell">
        <LoadingLabel>Loading the event overview</LoadingLabel>
        <SkeletonCard lines={3} />
        <SkeletonList rows={5} />
      </section>
    )
  }
  if (health.state !== 'ready') {
    return (
      <section className="health-shell">
        <header className="health-heading">
          <div>
            <p className="eyebrow">Event operations</p>
            <h1>Overview</h1>
          </div>
        </header>
        <StageBlock />
        <AttentionSection canManageAttention={canManageAttention} />
        <section className="attention-section">
          <div className="section-heading"><h2>System checks</h2></div>
          <div className="health-empty">
            <strong>
              {health.state === 'missing' ? 'System checks are starting.' : 'System checks are delayed.'}
            </strong>
            <span>
              {health.state === 'missing'
                ? 'The first event-wide check has not completed yet.'
                : `The last complete check was ${formatDateTime(health.lastGeneratedAt)}.`}
            </span>
          </div>
        </section>
      </section>
    )
  }
  const overview = health.snapshot
  const systemSignals = overview.signals.filter(
    (signal) => !attentionCoveredSignalKeys.some((covered) => covered === signal.key),
  )
  return (
    <section className="health-shell">
      <header className="health-heading">
        <div>
          <p className="eyebrow">{overview.event.name}</p>
          <h1>Overview</h1>
        </div>
        <div className={`health-current ${overview.summary.status}`}>
          <span>System health</span>
          <strong>{statusLabel(overview.summary.status)}</strong>
          <small>Updated {formatTime(overview.generatedAt)}</small>
        </div>
      </header>

      <StageBlock />

      <AttentionSection canManageAttention={canManageAttention} />

      <section className="attention-section">
        <div className="section-heading">
          <h2>System checks</h2>
          {systemSignals.length > 0 ? <span>{systemSignals.length}</span> : null}
        </div>
        {systemSignals.length === 0 ? (
          <div className="health-empty">
            <strong>No live issues.</strong>
            <span>Automated checks are clear.</span>
          </div>
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
                    {signal.oldestAt !== undefined ? `, oldest ${formatDateTime(signal.oldestAt)}` : ''}.
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

function AttentionSection({ canManageAttention }: { canManageAttention: boolean }) {
  const attention = useQuery(api.operationsAttention.overview, { eventSlug })
  const acknowledge = useMutation(api.operationsAttention.acknowledge)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function claim(row: AttentionRow) {
    setPending(row.id)
    setError(null)
    try {
      await acknowledge({ eventSlug, itemId: row.id, expectedVersion: row.version })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not pick that up.')
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="attention-section">
      <div className="section-heading">
        <h2>Needs attention now</h2>
        {attention && attention.rows.length > 0 ? (
          <span>
            {attention.summary.acknowledgedCount > 0
              ? `${attention.rows.length}${attention.summary.hasMore ? '+' : ''}, ${attention.summary.acknowledgedCount} picked up`
              : `${attention.rows.length}${attention.summary.hasMore ? '+' : ''}`}
          </span>
        ) : null}
      </div>
      {error ? <p className="notice error">{error}</p> : null}
      {attention === undefined ? (
        <>
          <LoadingLabel>Reading the attention ledger</LoadingLabel>
          <SkeletonList rows={4} />
        </>
      ) : attention.rows.length === 0 ? (
        <div className="health-empty">
          <strong>Nothing needs action.</strong>
          <span>No panel is short, no review is overdue, and no team is stuck.</span>
        </div>
      ) : (
        <div className="health-list">
          {attention.rows.map((row) => (
            <article
              className={`list-row ${row.severity}${row.acknowledged ? ' acknowledged' : ''}`}
              key={row.id}
            >
              <span className={`row-glyph ${row.severity}`}>
                <Icon name={severityIcon(row.severity)} />
              </span>
              <div className="row-text">
                <strong>{row.statement}</strong>
                <small>{rowMeta(row)}</small>
              </div>
              <span className="row-controls">
                {canManageAttention && !row.acknowledged ? (
                  <button
                    type="button"
                    className="row-action"
                    disabled={pending === row.id}
                    onClick={() => void claim(row)}
                  >
                    {pending === row.id ? 'Picking up' : 'Pick up'}
                  </button>
                ) : null}
                <Link className="row-action" to={row.route}>
                  {row.canAct ? row.actionLabel : 'Open'}
                  <Icon name="arrow" size={13} />
                </Link>
              </span>
            </article>
          ))}
          {attention.summary.hasMore ? (
            <p className="notice">
              Showing the {attention.summary.limit} highest-priority items. More remain in the ledger.
            </p>
          ) : null}
        </div>
      )}
    </section>
  )
}

function rowMeta(row: {
  firstObservedAt: number
  recurrenceCount: number
  acknowledged: boolean
}) {
  const parts = [`Open since ${formatTime(row.firstObservedAt)}`]
  if (row.recurrenceCount > 1) parts.push(`${ordinal(row.recurrenceCount)} time today`)
  if (row.acknowledged) parts.push('Someone has picked this up')
  return parts.join(' · ')
}

function ordinal(value: number) {
  const remainderOfTen = value % 10
  const remainderOfHundred = value % 100
  if (remainderOfTen === 1 && remainderOfHundred !== 11) return `${value}st`
  if (remainderOfTen === 2 && remainderOfHundred !== 12) return `${value}nd`
  if (remainderOfTen === 3 && remainderOfHundred !== 13) return `${value}rd`
  return `${value}th`
}

function StageBlock() {
  const lifecycle = useQuery(api.eventLifecycle.current, { eventSlug })
  if (lifecycle === undefined) return null

  const stage = eventStageGuidance[lifecycle.status]
  const nextTransition = stage.nextStatus
    ? lifecycle.transitions.find((transition) => transition.targetStatus === stage.nextStatus)
    : undefined
  const blockers = nextTransition?.blockers ?? []
  const isActiveWork = blockers.some((blocker) => activeWorkBlockerKeys.includes(blocker.key))

  return (
    <section className="stage-block">
      <p className="eyebrow">{stage.label}</p>
      <p>{stage.goal}</p>
      {stage.nextStep === null ? null : blockers.length === 0 ? (
        <p className="muted">
          Nothing is blocking you. The next step is <strong>{stage.nextStep.toLowerCase()}</strong>.
        </p>
      ) : (
        <>
          <p className="muted">
            {isActiveWork
              ? `You cannot ${stage.nextStep.toLowerCase()} while this is still running:`
              : `Before you can ${stage.nextStep.toLowerCase()}, ${blockers.length === 1 ? 'one thing is' : `${blockers.length} things are`} missing:`}
          </p>
          <ul className="stage-blockers">
            {blockers.map((blocker) => {
              const to = eventBlockerPaths[blocker.key]
              return (
                <li key={blocker.key}>
                  {to ? <Link to={to}>{blocker.label} →</Link> : <span>{blocker.label}</span>}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
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
