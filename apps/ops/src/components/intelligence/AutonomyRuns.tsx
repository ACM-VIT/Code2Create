import { Icon, type IconName } from '../Icon'
import { OperationsAutonomyRunStream } from '../OperationsAutonomyRunStream'
import {
  autonomyCancellationLabel,
  autonomyFailureLabel,
  autonomyRunCanStream,
  autonomyRunIsActive,
  autonomyRunPhaseLabel,
  autonomyRunStateLabel,
  autonomyTriggerLabel,
  type AutonomyQueuedWork,
  type AutonomyRun,
} from '../../lib/operationsAutonomyPresentation'
import { formatCompactDateTime } from '../../lib/dateTime'

export function AutonomyQueuedWorkList({ items }: { items: AutonomyQueuedWork[] }) {
  if (items.length === 0) return null
  return (
    <div className="health-list">
      {items.map((item) => (
        <article className="list-row" key={item.id}>
          <span className="row-glyph attention"><Icon name="clock" /></span>
          <div className="row-text">
            <strong>{autonomyTriggerLabel(item.trigger)} queued</strong>
            <small>
              Requested {formatCompactDateTime(item.createdAt)} · event state from{' '}
              {formatCompactDateTime(item.sourceGeneratedAt)}
            </small>
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
        <strong>No check has run yet.</strong>
        <span>A run starts from the published schedule, a qualifying health signal, or a manual request.</span>
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
            <strong>{runTitle(run)}</strong>
            <small>{runMeta(run)}</small>
          </div>
          <div className="row-controls">
            <span className="state-label">{autonomyRunStateLabel(run.state)}</span>
            <button
              aria-pressed={selectedRunId === run.runId}
              className="row-action"
              onClick={() => onSelect(run.runId)}
              type="button"
            >
              {selectedRunId === run.runId ? 'Viewing' : 'View'}
            </button>
          </div>
        </article>
      ))}
    </div>
  )
}

/** The selected run: what it did, in numbers, then its live trace. */
export function AutonomyRunInspection({ run }: { run: AutonomyRun }) {
  return (
    <div className="grid gap-3">
      <article className="grid gap-4 rounded-xl bg-surface p-4 sm:p-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 text-[12px] leading-5 text-ink-3">
              {autonomyTriggerLabel(run.trigger)} · {formatCompactDateTime(run.createdAt)}
            </p>
            <h3 className="m-0 mt-1 text-[14px] font-medium text-ink">
              {autonomyRunIsActive(run.state) ? autonomyRunPhaseLabel(run.phase) : autonomyRunStateLabel(run.state)}
            </h3>
          </div>
          <span className="state-label">{autonomyRunStateLabel(run.state)}</span>
        </header>
        <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <RunMetric label="Checks and proposals" value={run.telemetry.toolCalls} />
          <RunMetric label="Focused investigations" value={run.telemetry.delegations} />
          <RunMetric label="Evidence read" value={formatBytes(run.telemetry.readBytes)} />
          <RunMetric label="Actions proposed" value={run.telemetry.recommendations} />
        </dl>
        {run.failureCode === undefined ? null : (
          <p className="notice error">{autonomyFailureLabel(run.failureCode)}</p>
        )}
        {run.cancellationReason === undefined ? null : (
          <p className="notice">{autonomyCancellationLabel(run.cancellationReason)}</p>
        )}
        {run.shutdownState === 'pending' ? (
          <p className="notice">
            This run can no longer affect operations. Its stop confirmation is still pending.
          </p>
        ) : null}
        <details className="group rounded-lg border border-line">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2.5 text-[12px] text-ink-2 hover:bg-hover [&::-webkit-details-marker]:hidden">
            <span>Run details</span>
            <span aria-hidden className="font-mono text-[14px] text-ink-3 transition-transform group-open:rotate-45">+</span>
          </summary>
          <dl className="m-0 grid gap-x-6 gap-y-2 border-t border-line px-3.5 py-3.5 sm:grid-cols-2">
            <RunDatum label="Mode" value={run.mode === 'recommend' ? 'Observe and propose' : 'Observe only'} />
            <RunDatum label="Event state from" value={formatCompactDateTime(run.sourceGeneratedAt)} />
            <RunDatum label="Accepted" value={run.acceptedAt === undefined ? 'Not accepted' : formatCompactDateTime(run.acceptedAt)} />
            <RunDatum label="Executor" value={run.agentVersion === undefined ? 'Not reported' : `${run.agentVersion} · ${run.model ?? 'model pending'}`} />
            <RunDatum label="Policy" value={`Version ${run.policyVersion} · ${run.policyChecksum}`} mono />
            <RunDatum label="Run" value={run.runId} mono />
          </dl>
        </details>
      </article>
      {autonomyRunCanStream(run) ? (
        <OperationsAutonomyRunStream key={run.runId} run={run} />
      ) : (
        <div className="health-empty">
          <strong>No live trace for this run.</strong>
          <span>
            {autonomyRunIsActive(run.state)
              ? 'Activity appears here once the agent starts this review.'
              : 'This run ended before the agent recorded any activity.'}
          </span>
        </div>
      )}
    </div>
  )
}

function RunMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="grid gap-1 rounded-lg bg-canvas/60 px-3 py-2.5">
      <dt className="text-[12px] leading-5 text-ink-3">{label}</dt>
      <dd className="m-0 text-[15px] font-medium tabular-nums text-ink">{value}</dd>
    </div>
  )
}

function RunDatum({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] leading-5 text-ink-3">{label}</dt>
      <dd className={`m-0 [overflow-wrap:anywhere] text-[12.5px] leading-5 text-ink-2 ${mono ? 'font-mono text-[11.5px]' : ''}`}>
        {value}
      </dd>
    </div>
  )
}

function runTitle(run: AutonomyRun) {
  if (autonomyRunIsActive(run.state)) return autonomyRunPhaseLabel(run.phase)
  if (run.state === 'no_op') return 'Reviewed, nothing to propose'
  if (run.state === 'succeeded') {
    return run.telemetry.recommendations === 0
      ? 'Review complete'
      : `Proposed ${run.telemetry.recommendations} ${run.telemetry.recommendations === 1 ? 'action' : 'actions'}`
  }
  if (run.state === 'escalated') return 'Escalated to an organizer'
  if (run.state === 'canceled') return 'Review stopped'
  return 'Review failed'
}

function runMeta(run: AutonomyRun) {
  const parts = [
    `${autonomyTriggerLabel(run.trigger)} · ${formatCompactDateTime(run.createdAt)}`,
    `${run.telemetry.toolCalls} ${run.telemetry.toolCalls === 1 ? 'check' : 'checks'}`,
    `${run.telemetry.delegations} ${run.telemetry.delegations === 1 ? 'investigation' : 'investigations'}`,
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

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`
  return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`
}
