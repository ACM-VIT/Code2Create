import { Icon, type IconName } from '../Icon'
import { OperationsAutonomyRunStream } from '../OperationsAutonomyRunStream'
import {
  autonomyCancellationLabel,
  autonomyFailureLabel,
  autonomyRunCanStream,
  autonomyRunIsActive,
  autonomyRunPhaseLabel,
  autonomyRunStateLabel,
  type AutonomyQueuedWork,
  type AutonomyRun,
} from '../../lib/operationsAutonomyPresentation'

export function AutonomyQueuedWorkList({ items }: { items: AutonomyQueuedWork[] }) {
  if (items.length === 0) return null
  return (
    <div className="health-list">
      {items.map((item) => (
        <article className="list-row" key={item.id}>
          <span className="row-glyph attention"><Icon name="clock" /></span>
          <div className="row-text">
            <strong>{triggerLabel(item.trigger)} queued</strong>
            <small>
              Requested {formatDateTime(item.createdAt)} · event state{' '}
              {formatDateTime(item.sourceGeneratedAt)}
            </small>
            <small className="instance-id">{item.id}</small>
          </div>
          <span className="state-label">Waiting</span>
        </article>
      ))}
    </div>
  )
}

export function AutonomyRunList({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: AutonomyRun[]
  selectedRunId: string | undefined
  onSelect: (runId: string) => void
}) {
  if (runs.length === 0) {
    return (
      <div className="health-empty">
        <strong>No autonomous review has run yet.</strong>
        <span>A run can start from a schedule, a qualifying signal, or an authorized manual request.</span>
      </div>
    )
  }

  return (
    <div className="health-list">
      {runs.map((run) => (
        <article className={`list-row${runTone(run) === 'critical' ? ' critical' : ''}`} key={run.runId}>
          <span className={`row-glyph ${runTone(run)}`}>
            <Icon name={runIcon(run)} />
          </span>
          <div className="row-text">
            <strong>{autonomyRunPhaseLabel(run.phase)}</strong>
            <small>{runMeta(run)}</small>
            <small className="instance-id">{run.runId}</small>
          </div>
          <div className="row-controls">
            <span className="state-label">{autonomyRunStateLabel(run.state)}</span>
            <button className="row-action" onClick={() => onSelect(run.runId)} type="button">
              {selectedRunId === run.runId ? 'Viewing' : 'View'}
            </button>
          </div>
        </article>
      ))}
    </div>
  )
}

export function AutonomyRunInspection({ run }: { run: AutonomyRun }) {
  return (
    <>
      <article className="card-surface intelligence-recommendation">
        <header className="section-heading">
          <div>
            <p className="eyebrow">Selected autonomous run</p>
            <h4>{triggerLabel(run.trigger)} · policy {run.policyVersion}</h4>
          </div>
          <span className="state-label">{autonomyRunStateLabel(run.state)}</span>
        </header>
        <dl className="review-progress">
          <div>
            <dt>Mode</dt>
            <dd>{run.mode === 'recommend' ? 'Observe and propose' : 'Observe only'}</dd>
          </div>
          <div>
            <dt>Source generated</dt>
            <dd>{formatDateTime(run.sourceGeneratedAt)}</dd>
          </div>
          <div>
            <dt>Accepted</dt>
            <dd>{run.acceptedAt === undefined ? 'Not accepted' : formatDateTime(run.acceptedAt)}</dd>
          </div>
          <div>
            <dt>Executor</dt>
            <dd>{run.agentVersion === undefined ? 'Not reported' : `${run.agentVersion} · ${run.model ?? 'model pending'}`}</dd>
          </div>
        </dl>
        <dl className="criteria-list">
          <RunMetric label="Checks and proposals" value={run.telemetry.toolCalls} />
          <RunMetric label="Focused investigations" value={run.telemetry.delegations} />
          <RunMetric label="Evidence read" value={formatBytes(run.telemetry.readBytes)} />
          <RunMetric label="Actions proposed" value={run.telemetry.recommendations} />
        </dl>
        <p className="notice">
          These numbers show what happened; they do not limit a run. The agent continues until it
          finishes, an organizer stops it, its access is removed, or the event ends.
        </p>
        {run.shutdownState === 'pending' ? (
          <p className="notice">
            This run can no longer affect operations. Its stop confirmation is still pending.
          </p>
        ) : null}
        <p className="muted">
          Policy checksum <code>{run.policyChecksum}</code>
        </p>
      </article>
      {autonomyRunCanStream(run) ? (
        <OperationsAutonomyRunStream key={run.runId} run={run} />
      ) : (
        <div className="card-surface">
          <div className="health-empty">
            <strong>Live trace is not available for this run.</strong>
            <span>
              {autonomyRunIsActive(run.state)
                ? 'Activity appears after the agent starts this review.'
                : 'This run ended before the agent recorded any activity.'}
            </span>
          </div>
        </div>
      )}
    </>
  )
}

function RunMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function runMeta(run: AutonomyRun) {
  const parts = [
    `${triggerLabel(run.trigger)} · ${formatDateTime(run.createdAt)}`,
    `${run.telemetry.toolCalls} ${run.telemetry.toolCalls === 1 ? 'tool call' : 'tool calls'}`,
    `${run.telemetry.delegations} ${run.telemetry.delegations === 1 ? 'investigation' : 'investigations'}`,
    `${formatBytes(run.telemetry.readBytes)} read`,
  ]
  if (run.failureCode !== undefined) parts.push(autonomyFailureLabel(run.failureCode))
  if (run.cancellationReason !== undefined) parts.push(autonomyCancellationLabel(run.cancellationReason))
  return parts.join(' · ')
}

function runIcon(run: AutonomyRun): IconName {
  if (run.state === 'succeeded' || run.state === 'no_op') return 'check'
  if (run.state === 'failed' || run.state === 'canceled') return 'alert'
  return 'pulse'
}

function runTone(run: AutonomyRun) {
  if (run.state === 'failed') return 'critical'
  if (run.state === 'succeeded' || run.state === 'no_op') return 'watch'
  return 'attention'
}

function triggerLabel(trigger: AutonomyRun['trigger']) {
  if (trigger.kind === 'manual') return 'Manual review'
  if (trigger.kind === 'schedule') return 'Scheduled review'
  return 'Signal review'
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`
  return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`
}

function formatDateTime(value: number) {
  return new Date(value).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
