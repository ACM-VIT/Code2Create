import { api } from '@code2create/backend/api'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type RehearsalList = FunctionReturnType<typeof api.rehearsals.list>
type RehearsalRun = RehearsalList['runs'][number]
type RehearsalRunId = RehearsalRun['id']
type RehearsalDetail = FunctionReturnType<typeof api.rehearsals.detail>
type RehearsalScenario = RehearsalDetail['scenarios'][number]
type RehearsalScenarioId = RehearsalScenario['id']
type RehearsalScenarioState = RehearsalScenario['state']
type RehearsalWorkstream = RehearsalScenario['workstream']
type CreateArgs = FunctionArgs<typeof api.rehearsals.create>
type AssignArgs = FunctionArgs<typeof api.rehearsals.assignWorkstreamOwner>
type StartArgs = FunctionArgs<typeof api.rehearsals.start>
type CompleteArgs = FunctionArgs<typeof api.rehearsals.complete>
type CancelArgs = FunctionArgs<typeof api.rehearsals.cancel>
type UpdateScenarioArgs = FunctionArgs<typeof api.rehearsals.updateScenario>

const workstreams = [
  ['auth_access', 'Sign-in and access'],
  ['intake_admissions', 'Intake and admissions'],
  ['communications', 'Communications'],
  ['attendance', 'Attendance'],
  ['floor', 'Hall operations'],
  ['reviewer_app', 'Reviewer app'],
  ['review_operations', 'Review operations'],
  ['integrations', 'GitHub and Figma'],
  ['reliability', 'Reliability'],
  ['synesthesia', 'Synesthesia'],
  ['support', 'Support'],
] as const satisfies readonly (readonly [RehearsalWorkstream, string])[]

const scenarioStates = [
  ['pending', 'Pending'],
  ['running', 'Running'],
  ['passed', 'Passed'],
  ['failed', 'Failed'],
  ['blocked', 'Blocked'],
] as const satisfies readonly (readonly [RehearsalScenarioState, string])[]

type StateFilter = RehearsalScenarioState | 'all'
type WorkstreamFilter = RehearsalWorkstream | 'all'

export function Rehearsal() {
  const list = useQuery(api.rehearsals.list, { eventSlug })
  const [selectedId, setSelectedId] = useState<RehearsalRunId | null>(null)
  const visibleSelectedId = selectedId ?? list?.runs.at(0)?.id ?? null

  return (
    <section className="rehearsal-shell">
      <header className="page-heading rehearsal-heading">
        <div>
          <p className="eyebrow">Before launch</p>
          <h1>Test run</h1>
          <p className="muted">
            Practice every critical event flow and fix failures before launch.
          </p>
        </div>
      </header>

      {list?.canCreate ? <CreateRun onCreated={() => setSelectedId(null)} /> : null}

      <div className="rehearsal-run-list" aria-label="Test runs">
        {list === undefined ? <p className="muted">Loading test runs…</p> : null}
        {list?.runs.map((run) => (
          <button
            aria-pressed={visibleSelectedId === run.id}
            className={visibleSelectedId === run.id ? 'rehearsal-run selected' : 'rehearsal-run'}
            key={run.id}
            type="button"
            onClick={() => setSelectedId(run.id)}
          >
            <span>
              <strong>{run.name}</strong>
              <small>{run.counts.passed} of {run.counts.total} passed</small>
            </span>
            <span className={`rehearsal-state ${run.state}`}>{runStateLabel(run.state)}</span>
          </button>
        ))}
        {list?.runs.length === 0 ? (
          <p className="empty">
            {list.canRead ? 'No test run yet.' : 'No test run is visible to this account.'}
          </p>
        ) : null}
      </div>

      {visibleSelectedId ? <RunDetail rehearsalRunId={visibleSelectedId} /> : null}
    </section>
  )
}

function CreateRun({ onCreated }: { onCreated: () => void }) {
  const create = useMutation(api.rehearsals.create)
  const [name, setName] = useState('Full event test')
  const [scheduledFor, setScheduledFor] = useState('')
  const [reason, setReason] = useState('Preparing the event team for launch')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const operationRef = useRef<CreateArgs | null>(null)

  const resetOperation = () => {
    operationRef.current = null
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busyRef.current || name.trim().length < 3 || reason.trim().length < 5) return
    const schedule = scheduledFor ? new Date(scheduledFor).getTime() : undefined
    if (schedule !== undefined && (!Number.isFinite(schedule) || schedule <= Date.now())) {
      setError('Choose a future rehearsal time or leave it blank.')
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    const args = operationRef.current ?? {
      eventSlug,
      name: name.trim(),
      ...(schedule !== undefined ? { scheduledFor: schedule } : {}),
      reason: reason.trim(),
      clientOperationId: crypto.randomUUID(),
    }
    operationRef.current = args
    try {
      await create(args)
      operationRef.current = null
      onCreated()
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <details className="rehearsal-create">
      <summary>Create a test run</summary>
      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          Name
          <input
            required
            minLength={3}
            maxLength={100}
            value={name}
            onChange={(event) => {
              resetOperation()
              setName(event.target.value)
            }}
          />
        </label>
        <label className="field">
          Scheduled time <small>optional</small>
          <input
            type="datetime-local"
            value={scheduledFor}
            onChange={(event) => {
              resetOperation()
              setScheduledFor(event.target.value)
            }}
          />
        </label>
        <label className="field rehearsal-wide-field">
          Why this run is needed
          <input
            required
            minLength={5}
            maxLength={300}
            value={reason}
            onChange={(event) => {
              resetOperation()
              setReason(event.target.value)
            }}
          />
        </label>
        <button className="secondary" disabled={busy} type="submit">
          {busy ? 'Creating…' : 'Create test run'}
        </button>
        {error ? <p className="notice error">{error}</p> : null}
      </form>
    </details>
  )
}

function RunDetail({ rehearsalRunId }: { rehearsalRunId: RehearsalRunId }) {
  const detail = useQuery(api.rehearsals.detail, { eventSlug, rehearsalRunId })
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [workstreamFilter, setWorkstreamFilter] = useState<WorkstreamFilter>('all')
  const [selectedScenarioId, setSelectedScenarioId] = useState<RehearsalScenarioId | null>(null)

  if (detail === undefined) return <div className="rehearsal-detail"><p className="muted">Loading run…</p></div>

  const scenarios = detail.scenarios.filter(
    (scenario) =>
      (stateFilter === 'all' || scenario.state === stateFilter) &&
      (workstreamFilter === 'all' || scenario.workstream === workstreamFilter),
  )
  const visibleScenarioId = scenarios.some((scenario) => scenario.id === selectedScenarioId)
    ? selectedScenarioId
    : scenarios.at(0)?.id ?? null
  const selectedScenario = detail.scenarios.find((scenario) => scenario.id === visibleScenarioId) ?? null

  return (
    <div className="rehearsal-detail">
      <header className="rehearsal-run-heading">
        <div>
          <h2>{detail.run.name}</h2>
          <p className="muted">
            Created {formatTime(detail.run.createdAt)}
            {detail.run.scheduledFor ? ` · scheduled ${formatTime(detail.run.scheduledFor)}` : ''}
          </p>
        </div>
        <span className={`rehearsal-state ${detail.run.state}`}>{runStateLabel(detail.run.state)}</span>
      </header>

      <RunCounts run={detail.run} />
      <WorkstreamOwners detail={detail} />
      <RunControls detail={detail} />

      <section className="rehearsal-scenarios">
        <div className="section-heading">
          <div>
            <h2>Checks</h2>
            <p className="muted">Work through each check and record what happened.</p>
          </div>
          <div className="rehearsal-filters">
            <label className="filter">
              State
              <select
                value={stateFilter}
                onChange={(event) => setStateFilter(parseStateFilter(event.target.value))}
              >
                <option value="all">All states</option>
                {scenarioStates.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="filter">
              Area
              <select
                value={workstreamFilter}
                onChange={(event) => setWorkstreamFilter(parseWorkstreamFilter(event.target.value))}
              >
                <option value="all">All areas</option>
                {workstreams.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="rehearsal-scenario-workspace">
          <div className="rehearsal-scenario-list" aria-label="Test checks">
            {scenarios.map((scenario) => (
              <button
                aria-pressed={visibleScenarioId === scenario.id}
                className={visibleScenarioId === scenario.id ? 'rehearsal-scenario-row selected' : 'rehearsal-scenario-row'}
                key={scenario.id}
                type="button"
                onClick={() => setSelectedScenarioId(scenario.id)}
              >
                <span className="rehearsal-sequence">{scenario.sequence}</span>
                <span>
                  <strong>{scenario.title}</strong>
                  <small>{workstreamLabel(scenario.workstream)}</small>
                </span>
                <span className={`rehearsal-dot ${scenario.state}`} title={stateLabel(scenario.state)} />
              </button>
            ))}
            {scenarios.length === 0 ? <p className="empty">No checks match these filters.</p> : null}
          </div>
          {selectedScenario ? (
            <ScenarioDetail
              canExecute={detail.run.canExecute}
              rehearsalRunId={detail.run.id}
              runState={detail.run.state}
              scenario={selectedScenario}
            />
          ) : null}
        </div>
      </section>
    </div>
  )
}

function RunCounts({ run }: { run: RehearsalRun }) {
  return (
    <dl className="rehearsal-counts">
      <div><dt>Passed</dt><dd>{run.counts.passed}</dd></div>
      <div><dt>Running</dt><dd>{run.counts.running}</dd></div>
      <div><dt>Failed</dt><dd>{run.counts.failed}</dd></div>
      <div><dt>Blocked</dt><dd>{run.counts.blocked}</dd></div>
      <div><dt>Pending</dt><dd>{run.counts.pending}</dd></div>
    </dl>
  )
}

function WorkstreamOwners({ detail }: { detail: RehearsalDetail }) {
  return (
    <section className="rehearsal-section">
      <div className="section-heading">
        <div>
          <h2>Owners</h2>
          <p className="muted">Give each event area one person responsible for completing its checks.</p>
        </div>
        <span className="rehearsal-assignment-count">
          {detail.run.assignedWorkstreamCount} of {detail.run.requiredWorkstreamCount} assigned
        </span>
      </div>
      <div className="rehearsal-owner-list">
        {workstreams.map(([workstream, label]) => {
          const owner = detail.workstreamOwners.find((candidate) => candidate.workstream === workstream)
          return (
            <div className="rehearsal-owner-row" key={workstream}>
              <strong>{label}</strong>
              <span>{owner?.displayName ?? 'Unassigned'}</span>
              <small>{owner ? (owner.accessActive ? owner.email : 'Access inactive') : 'Needs an accountable owner'}</small>
            </div>
          )
        })}
      </div>
      {detail.run.canManage && (detail.run.state === 'draft' || detail.run.state === 'active') ? (
        <OwnerAssignment detail={detail} />
      ) : null}
    </section>
  )
}

function OwnerAssignment({ detail }: { detail: RehearsalDetail }) {
  const assign = useMutation(api.rehearsals.assignWorkstreamOwner)
  const options = usePaginatedQuery(
    api.rehearsals.ownerOptions,
    { eventSlug, rehearsalRunId: detail.run.id },
    { initialNumItems: 100 },
  )
  const firstMissing = workstreams.find(
    ([workstream]) => !detail.workstreamOwners.some((owner) => owner.workstream === workstream),
  )?.[0] ?? workstreams[0][0]
  const [workstream, setWorkstream] = useState<RehearsalWorkstream>(firstMissing)
  const [ownerPersonId, setOwnerPersonId] = useState('')
  const [reason, setReason] = useState('Assigning rehearsal accountability')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const operationRef = useRef<AssignArgs | null>(null)

  useEffect(() => {
    if (operationRef.current?.expectedRunVersion !== detail.run.version) operationRef.current = null
  }, [detail.run.version])

  const resetOperation = () => {
    operationRef.current = null
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const owner = options.results.find((candidate) => candidate.id === ownerPersonId)
    if (busyRef.current || !owner || reason.trim().length < 5) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const args = operationRef.current ?? {
      eventSlug,
      rehearsalRunId: detail.run.id,
      workstream,
      ownerPersonId: owner.id,
      expectedRunVersion: detail.run.version,
      reason: reason.trim(),
      clientOperationId: crypto.randomUUID(),
    }
    operationRef.current = args
    try {
      await assign(args)
      operationRef.current = null
      setOwnerPersonId('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <form className="rehearsal-owner-form" onSubmit={(event) => void submit(event)}>
      <label className="field">
        Area
        <select
          value={workstream}
          onChange={(event) => {
            resetOperation()
            setWorkstream(parseWorkstream(event.target.value, workstream))
          }}
        >
          {workstreams.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="field">
        Owner
        <select
          required
          value={ownerPersonId}
          onChange={(event) => {
            resetOperation()
            setOwnerPersonId(event.target.value)
          }}
        >
          <option value="">Choose an active event account</option>
          {options.results.map((person) => (
            <option key={person.id} value={person.id}>{person.displayName} · {person.email}</option>
          ))}
        </select>
      </label>
      <label className="field rehearsal-owner-reason">
        Why this owner is changing
        <input
          required
          minLength={5}
          maxLength={300}
          value={reason}
          onChange={(event) => {
            resetOperation()
            setReason(event.target.value)
          }}
        />
      </label>
      <button className="secondary" disabled={busy || !ownerPersonId || reason.trim().length < 5} type="submit">
        {busy ? 'Assigning…' : 'Assign owner'}
      </button>
      {options.status === 'CanLoadMore' ? (
        <button className="text-button" type="button" onClick={() => options.loadMore(100)}>Load more accounts</button>
      ) : null}
      {error ? <p className="notice error">{error}</p> : null}
    </form>
  )
}

type RunOperation =
  | { kind: 'start'; args: StartArgs }
  | { kind: 'complete'; args: CompleteArgs }
  | { kind: 'cancel'; args: CancelArgs }

function RunControls({ detail }: { detail: RehearsalDetail }) {
  const start = useMutation(api.rehearsals.start)
  const complete = useMutation(api.rehearsals.complete)
  const cancel = useMutation(api.rehearsals.cancel)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const operationRef = useRef<RunOperation | null>(null)

  useEffect(() => {
    const operation = operationRef.current
    if (!operation) return
    const expectedVersion = operation.args.expectedVersion
    if (expectedVersion !== detail.run.version) operationRef.current = null
  }, [detail.run.version])

  if (detail.run.state === 'completed') {
    return <p className="notice rehearsal-final-note">Signed off: {detail.run.completionSummary}</p>
  }
  if (detail.run.state === 'cancelled') {
    return <p className="notice rehearsal-final-note">Cancelled: {detail.run.cancellationReason}</p>
  }
  if (!detail.run.canManage && !detail.run.canComplete) return null

  const startReady =
    detail.run.state === 'draft' &&
    detail.run.canManage &&
    detail.run.assignedWorkstreamCount === detail.run.requiredWorkstreamCount
  const completionReady =
    detail.run.state === 'active' &&
    detail.run.canComplete &&
    detail.run.counts.total > 0 &&
    detail.run.counts.passed === detail.run.counts.total

  const run = async (kind: RunOperation['kind']) => {
    const normalizedNote = note.trim()
    const minimum = kind === 'complete' ? 10 : 5
    if (busyRef.current || normalizedNote.length < minimum) return
    if (kind === 'start' && !startReady) return
    if (kind === 'complete' && !completionReady) return
    if (kind === 'cancel' && !detail.run.canManage) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const prior = operationRef.current
    try {
      if (kind === 'start') {
        const args: StartArgs = prior?.kind === kind ? prior.args : {
          eventSlug,
          rehearsalRunId: detail.run.id,
          expectedVersion: detail.run.version,
          reason: normalizedNote,
          clientOperationId: crypto.randomUUID(),
        }
        operationRef.current = { kind, args }
        await start(args)
      } else if (kind === 'complete') {
        const args: CompleteArgs = prior?.kind === kind ? prior.args : {
          eventSlug,
          rehearsalRunId: detail.run.id,
          expectedVersion: detail.run.version,
          summary: normalizedNote,
          clientOperationId: crypto.randomUUID(),
        }
        operationRef.current = { kind, args }
        await complete(args)
      } else {
        const args: CancelArgs = prior?.kind === kind ? prior.args : {
          eventSlug,
          rehearsalRunId: detail.run.id,
          expectedVersion: detail.run.version,
          reason: normalizedNote,
          clientOperationId: crypto.randomUUID(),
        }
        operationRef.current = { kind, args }
        await cancel(args)
      }
      operationRef.current = null
      setNote('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <section className="rehearsal-section rehearsal-run-controls">
      <div>
        <h2>Start or finish</h2>
        <p className="muted">
          Start after every area has an owner. Finish only after every check passes.
        </p>
      </div>
      <label className="field">
        {detail.run.state === 'active' ? 'Result or completion note' : 'Why this run is starting or ending'}
        <textarea
          maxLength={1000}
          value={note}
          onChange={(event) => {
            operationRef.current = null
            setNote(event.target.value)
          }}
        />
      </label>
      <div className="rehearsal-control-actions">
        {detail.run.state === 'draft' && detail.run.canManage ? (
          <button className="primary" disabled={busy || !startReady || note.trim().length < 5} type="button" onClick={() => void run('start')}>
            {busy ? 'Working…' : 'Start test run'}
          </button>
        ) : null}
        {detail.run.state === 'active' && detail.run.canComplete ? (
          <button className="primary" disabled={busy || !completionReady || note.trim().length < 10} type="button" onClick={() => void run('complete')}>
            {busy ? 'Working…' : 'Finish test run'}
          </button>
        ) : null}
        {detail.run.canManage ? (
          <button className="secondary" disabled={busy || note.trim().length < 5} type="button" onClick={() => void run('cancel')}>
            Cancel run
          </button>
        ) : null}
      </div>
      {!startReady && detail.run.state === 'draft' ? <small>Assign every workstream before starting.</small> : null}
      {!completionReady && detail.run.state === 'active' ? <small>{detail.run.counts.total - detail.run.counts.passed} checks still need a passing result.</small> : null}
      {error ? <p className="notice error">{error}</p> : null}
    </section>
  )
}

function ScenarioDetail({
  canExecute,
  rehearsalRunId,
  runState,
  scenario,
}: {
  canExecute: boolean
  rehearsalRunId: RehearsalRunId
  runState: RehearsalRun['state']
  scenario: RehearsalScenario
}) {
  const history = useQuery(api.rehearsals.scenarioHistory, {
    eventSlug,
    rehearsalRunId,
    rehearsalScenarioId: scenario.id,
  })
  const update = useMutation(api.rehearsals.updateScenario)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const operationRef = useRef<{ nextState: RehearsalScenarioState; args: UpdateScenarioArgs } | null>(null)

  useEffect(() => {
    if (operationRef.current?.args.expectedVersion !== scenario.version) operationRef.current = null
  }, [scenario.version])

  const record = async (nextState: RehearsalScenarioState) => {
    const normalizedNote = note.trim()
    const noteRequired = nextState !== 'running' || scenario.state !== 'pending'
    if (busyRef.current || (noteRequired && normalizedNote.length < 5)) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const prior = operationRef.current
    const args = prior?.nextState === nextState ? prior.args : {
      eventSlug,
      rehearsalRunId,
      rehearsalScenarioId: scenario.id,
      nextState,
      ...(normalizedNote ? { note: normalizedNote } : {}),
      expectedVersion: scenario.version,
      clientOperationId: crypto.randomUUID(),
    }
    operationRef.current = { nextState, args }
    try {
      await update(args)
      operationRef.current = null
      setNote('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const terminal = scenario.state === 'passed' || scenario.state === 'failed' || scenario.state === 'blocked'

  return (
    <article className="rehearsal-scenario-detail">
      <header>
        <div>
          <p className="eyebrow">Check {scenario.sequence} · {workstreamLabel(scenario.workstream)}</p>
          <h2>{scenario.title}</h2>
        </div>
        <span className={`rehearsal-state ${scenario.state}`}>{stateLabel(scenario.state)}</span>
      </header>
      <dl className="rehearsal-expectation">
        <div><dt>Expected</dt><dd>{scenario.expectedState}</dd></div>
        <div><dt>If it fails</dt><dd>{scenario.recoveryAction}</dd></div>
      </dl>
      {scenario.resultSummary ? <p className="rehearsal-result">{scenario.resultSummary}</p> : null}

      {canExecute && runState === 'active' ? (
        <div className="rehearsal-scenario-command">
          <label className="field">
            Result note {scenario.state === 'pending' ? <small>optional only when starting</small> : null}
            <textarea
              maxLength={1000}
              value={note}
              onChange={(event) => {
                operationRef.current = null
                setNote(event.target.value)
              }}
            />
          </label>
          <div className="rehearsal-result-actions">
            {scenario.state === 'pending' ? (
              <button className="secondary" disabled={busy} type="button" onClick={() => void record('running')}>Start</button>
            ) : null}
            {!terminal ? (
              <>
                <button className="primary" disabled={busy || note.trim().length < 5} type="button" onClick={() => void record('passed')}>Pass</button>
                <button className="secondary" disabled={busy || note.trim().length < 5} type="button" onClick={() => void record('failed')}>Fail</button>
                <button className="secondary" disabled={busy || note.trim().length < 5} type="button" onClick={() => void record('blocked')}>Block</button>
              </>
            ) : (
              <button className="secondary" disabled={busy || note.trim().length < 5} type="button" onClick={() => void record('running')}>Run again</button>
            )}
          </div>
          {error ? <p className="notice error">{error}</p> : null}
        </div>
      ) : (
        <p className="notice">
          {runState === 'active' ? 'This account can read the check but cannot record outcomes.' : 'Results can be recorded only while the test run is active.'}
        </p>
      )}

      <div className="rehearsal-history">
        <h2>History</h2>
        {history === undefined ? <p className="muted">Loading history…</p> : null}
        {history?.length === 0 ? <p className="muted">No result recorded yet.</p> : null}
        <ol>
          {history?.map((action) => (
            <li key={action.id}>
              <div>
                <strong>{historyLabel(action.kind)}</strong>
                <time>{formatTime(action.createdAt)}</time>
              </div>
              <small>{action.actorName}</small>
              {action.note ? <p>{action.note}</p> : null}
            </li>
          ))}
        </ol>
      </div>
    </article>
  )
}

function parseStateFilter(value: string): StateFilter {
  if (value === 'all') return value
  return scenarioStates.find(([state]) => state === value)?.[0] ?? 'all'
}

function parseWorkstreamFilter(value: string): WorkstreamFilter {
  if (value === 'all') return value
  return workstreams.find(([workstream]) => workstream === value)?.[0] ?? 'all'
}

function parseWorkstream(value: string, fallback: RehearsalWorkstream) {
  return workstreams.find(([workstream]) => workstream === value)?.[0] ?? fallback
}

function workstreamLabel(value: RehearsalWorkstream) {
  return workstreams.find(([workstream]) => workstream === value)?.[1] ?? value.replaceAll('_', ' ')
}

function stateLabel(value: RehearsalScenarioState) {
  return scenarioStates.find(([state]) => state === value)?.[1] ?? value
}

function runStateLabel(value: RehearsalRun['state']) {
  if (value === 'active') return 'Active'
  if (value === 'completed') return 'Signed off'
  if (value === 'cancelled') return 'Cancelled'
  return 'Draft'
}

function historyLabel(kind: FunctionReturnType<typeof api.rehearsals.scenarioHistory>[number]['kind']) {
  if (kind === 'started') return 'Started'
  if (kind === 'passed') return 'Passed'
  if (kind === 'failed') return 'Failed'
  if (kind === 'blocked') return 'Blocked'
  return 'Run again'
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}
