import { api } from '@code2create/backend/api'
import {
  activeWorkBlockerKeys,
  eventBlockerPaths,
  eventStageGuidance,
} from '@code2create/domain'
import { useMutation, useQuery } from 'convex/react'

import { Icon, type IconName } from '../components/Icon'
import { LoadingLabel, SkeletonCard, SkeletonList } from '../components/Skeleton'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../lib/config'

const refreshIntervalMs = 30_000

/**
 * Health signals whose subjects the named rows above now report concretely.
 * Showing the aggregate count as well would state one problem twice.
 */
const attentionCoveredSignalKeys = ['panels_needing_reviewer', 'overdue_reviews']

function currentRefreshBucket() {
  return Math.floor(Date.now() / refreshIntervalMs)
}

type HealthOverviewProps = {
  canGenerateIntelligence: boolean
  canReadIntelligence: boolean
}

export function HealthOverview({
  canGenerateIntelligence,
  canReadIntelligence,
}: HealthOverviewProps) {
  const [refreshBucket, setRefreshBucket] = useState(currentRefreshBucket)

  useEffect(() => {
    const interval = setInterval(() => setRefreshBucket(currentRefreshBucket()), refreshIntervalMs)
    return () => clearInterval(interval)
  }, [])

  const overview = useQuery(api.operationsHealth.overview, { eventSlug, refreshBucket })
  const attention = useQuery(api.operationsAttention.overview, { eventSlug, refreshBucket })
  const brief = useQuery(
    api.operationsIntelligence.latest,
    canReadIntelligence ? { eventSlug } : 'skip',
  )
  const requestBrief = useMutation(api.operationsIntelligence.request)
  const operationRef = useRef<string | null>(null)
  const [requestingBrief, setRequestingBrief] = useState(false)
  const [briefError, setBriefError] = useState<string | null>(null)

  async function generateBrief() {
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setRequestingBrief(true)
    setBriefError(null)
    try {
      await requestBrief({ eventSlug, clientOperationId })
      operationRef.current = null
    } catch (error) {
      setBriefError(error instanceof Error ? error.message : 'Could not request the brief.')
    } finally {
      setRequestingBrief(false)
    }
  }

  if (overview === undefined) {
    return (
      <section className="health-shell">
        <LoadingLabel>Loading the event overview</LoadingLabel>
        <SkeletonCard lines={3} />
        <SkeletonList rows={5} />
      </section>
    )
  }
  const systemSignals = overview.signals.filter(
    (signal) => !attentionCoveredSignalKeys.some((covered) => covered === signal.key),
  )
  const briefInProgress = brief?.state === 'pending' || brief?.state === 'dispatching' || brief?.state === 'accepted'
  const briefExpired = brief?.relevanceExpiresAt !== undefined && Date.now() >= brief.relevanceExpiresAt

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

      <section className="attention-section">
        <div className="section-heading">
          <h2>Needs attention now</h2>
          {attention && attention.rows.length > 0 ? <span>{attention.rows.length}</span> : null}
        </div>
        {attention === undefined ? (
          <SkeletonList rows={4} />
        ) : attention.rows.length === 0 ? (
          <div className="health-empty">
            <strong>Nothing needs action.</strong>
            <span>No panel is short, no review is overdue, and no team is stuck.</span>
          </div>
        ) : (
          <div className="health-list">
            {attention.rows.map((row) => (
              <article className={`list-row ${row.severity}`} key={row.key}>
                <span className={`row-glyph ${row.severity}`}>
                  <Icon name={severityIcon(row.severity)} />
                </span>
                <div className="row-text">
                  <strong>
                    {row.subject}
                    {row.context ? <span className="row-context"> · {row.context}</span> : null}
                  </strong>
                  <small>
                    {row.statement}
                    {row.since !== undefined ? ` · since ${formatDateTime(row.since)}` : ''}
                  </small>
                </div>
                <Link className="row-action" to={row.route}>
                  {row.canAct ? row.actionLabel : 'Open'}
                  <Icon name="arrow" size={13} />
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>

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

      {canReadIntelligence || canGenerateIntelligence ? (
        <section className="intelligence-brief" aria-labelledby="intelligence-brief-heading">
          <div className="intelligence-brief-heading">
            <div>
              <h2 id="intelligence-brief-heading">Operations brief</h2>
              <p className="muted">Current issues, owners, and next actions.</p>
            </div>
            {canGenerateIntelligence ? (
              <button
                type="button"
                className="secondary"
                disabled={requestingBrief || briefInProgress}
                onClick={() => void generateBrief()}
              >
                {requestingBrief || briefInProgress ? 'Preparing…' : brief ? 'Refresh' : 'Prepare brief'}
              </button>
            ) : null}
          </div>
          {briefError ? <p className="notice error">{briefError}</p> : null}
          {canReadIntelligence ? (
            brief === undefined ? (
              <p className="muted">Loading the latest brief…</p>
            ) : brief === null ? (
              <p className="muted">No brief has been prepared yet.</p>
            ) : brief.state === 'succeeded' ? (
              <div className="intelligence-brief-result">
                <p className="eyebrow">
                  {brief.origin === 'automation' ? 'Prepared automatically' : 'Requested by an operator'} · Source checked {brief.sourceGeneratedAt ? formatDateTime(brief.sourceGeneratedAt) : 'recently'}
                </p>
                {briefExpired ? <p className="notice">This brief is outside its configured relevance window. Use the current signals below.</p> : null}
                <h3>{brief.headline}</h3>
                <p>{brief.summary}</p>
                {brief.accountableOwner ? <p className="intelligence-owner">Accountable owner: {brief.accountableOwner}</p> : null}
                {brief.priorities.length > 0 ? (
                  <ol className="intelligence-priorities">
                    {brief.priorities.map((priority) => (
                      <li key={priority.signalKeys.join(':')}>
                        <span className="health-severity">{severityLabel(priority.severity)}</span>
                        <h4>{priority.title}</h4>
                        <p>{priority.why}</p>
                        <dl className="health-action">
                          <div><dt>Owner</dt><dd>{priority.owner}</dd></div>
                          <div><dt>Next</dt><dd>{priority.nextAction}</dd></div>
                        </dl>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>
            ) : brief.state === 'failed' ? (
              <p className="muted">The brief could not be prepared. The health signals below remain authoritative.</p>
            ) : (
              <p className="muted">Preparing from a frozen copy of the current health signals…</p>
            )
          ) : (
            <p className="muted">This account may request a brief but cannot read its result.</p>
          )}
        </section>
      ) : null}

    </section>
  )
}

/**
 * Where the event is, and what stands between it and the next step.
 *
 * The backend already computes exactly what is missing before each transition;
 * until now nothing showed it, so an operator faced twelve settings with no way
 * to tell which were required, which were optional, and whether they were done.
 */
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
          Nothing is blocking you. When you are ready, the next step is <strong>{stage.nextStep.toLowerCase()}</strong>.
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

function severityLabel(value: 'watch' | 'attention' | 'critical') {
  if (value === 'attention') return 'Needs attention'
  if (value === 'critical') return 'Critical'
  return 'Watch'
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
