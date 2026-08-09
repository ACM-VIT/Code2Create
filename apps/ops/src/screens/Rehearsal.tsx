import { api } from '@code2create/backend/api'
import {
  rehearsalRunStateLabels,
  rehearsalScenarioStateLabels,
  rehearsalWorkstreamLabels,
  type RehearsalRunState,
  type RehearsalScenarioState,
  type RehearsalWorkstream,
} from '@code2create/domain'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { LoadingLabel, SkeletonCard, SkeletonList } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type RehearsalList = FunctionReturnType<typeof api.rehearsals.list>
type RehearsalRun = RehearsalList['runs'][number]
type RehearsalRunId = RehearsalRun['id']
type RehearsalDetail = FunctionReturnType<typeof api.rehearsals.detail>
type RehearsalScenario = RehearsalDetail['scenarios'][number]
type RehearsalScenarioId = RehearsalScenario['id']
type CreateArgs = FunctionArgs<typeof api.rehearsals.create>
type AssignArgs = FunctionArgs<typeof api.rehearsals.assignWorkstreamOwner>
type StartArgs = FunctionArgs<typeof api.rehearsals.start>
type CompleteArgs = FunctionArgs<typeof api.rehearsals.complete>
type CancelArgs = FunctionArgs<typeof api.rehearsals.cancel>
type UpdateScenarioArgs = FunctionArgs<typeof api.rehearsals.updateScenario>

/**
 * Checks are listed and filtered worst-first: the ones that went wrong are the
 * reason to hold a test run at all, and the ones that worked are a record.
 */
const scenarioStateOrder: RehearsalScenarioState[] = [
  'failed',
  'blocked',
  'running',
  'pending',
  'passed',
]

/** A run still being set up or worked comes before one already put to bed. */
const runOrder: Record<RehearsalRunState, number> = {
  active: 0,
  draft: 1,
  completed: 2,
  cancelled: 3,
}

type StateFilter = RehearsalScenarioState | 'all'
type WorkstreamFilter = RehearsalWorkstream | 'all'

export function Rehearsal() {
  const list = useQuery(api.rehearsals.list, { eventSlug })
  const [selectedId, setSelectedId] = useState<RehearsalRunId | null>(null)
  const runs = [...(list?.runs ?? [])].sort(
    (left, right) => runOrder[left.state] - runOrder[right.state] || right.createdAt - left.createdAt,
  )
  const visibleSelectedId = selectedId ?? runs.at(0)?.id ?? null

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

      {list === undefined ? (
        <>
          <LoadingLabel>Loading test runs</LoadingLabel>
          <SkeletonCard lines={3} />
          <SkeletonList rows={4} />
        </>
      ) : (
        <section className="stage-block">
          {runs.length === 0 ? (
            <>
              <p>No test run has been held.</p>
              <p className="muted">
                A test run works through every way this event can break, one check at a time,
                with a named owner for each area.
              </p>
            </>
          ) : (
            <RunLead run={runs[0]} />
          )}
        </section>
      )}

      {list?.canCreate ? <CreateRun defaultOpen={runs.length === 0} onCreated={() => setSelectedId(null)} /> : null}

      {runs.length > 0 ? (
        <div className="rehearsal-run-list" aria-label="Test runs">
          {runs.map((run) => (
            <button
              aria-pressed={visibleSelectedId === run.id}
              className={visibleSelectedId === run.id ? 'rehearsal-run selected' : 'rehearsal-run'}
              key={run.id}
              type="button"
              onClick={() => setSelectedId(run.id)}
            >
              <span>
                <strong>{run.name}</strong>
                <small>{run.counts.total - run.counts.passed} of {run.counts.total} checks still to pass</small>
              </span>
              <span className={`rehearsal-state ${run.state}`}>{rehearsalRunStateLabels[run.state]}</span>
            </button>
          ))}
        </div>
      ) : list !== undefined && !list.canRead ? (
        <div className="health-empty">
          <strong>No test run is visible to you.</strong>
          <span>Reading a run needs the rehearsal permission for that run.</span>
        </div>
      ) : null}

      {visibleSelectedId ? <RunDetail rehearsalRunId={visibleSelectedId} /> : null}
    </section>
  )
}

/** The most recent unfinished run, stated as work outstanding rather than a score. */
function RunLead({ run }: { run: RehearsalRun | undefined }) {
  if (!run) return null
  const wrong = run.counts.failed + run.counts.blocked
  const untried = run.counts.pending + run.counts.running
  if (run.state === 'completed') {
    return (
      <>
        <p>{run.name} has been signed off. All {run.counts.total} checks passed.</p>
      </>
    )
  }
  if (run.state === 'cancelled') {
    return (
      <>
        <p>{run.name} was cancelled, so nothing about this event has been rehearsed.</p>
      </>
    )
  }
  if (run.state === 'draft') {
    return (
      <>
        <p>
          {run.name} is set up with {run.counts.total} checks but has not started.
        </p>
        <p className="muted">
          {run.assignedWorkstreamCount === run.requiredWorkstreamCount
            ? 'Every area has an owner.'
            : `${run.requiredWorkstreamCount - run.assignedWorkstreamCount} of ${run.requiredWorkstreamCount} areas have no owner, so the run cannot start.`}
        </p>
      </>
    )
  }
  return (
    <>
      <p>
        {run.name}: {wrong > 0 ? `${wrong} ${wrong === 1 ? 'check' : 'checks'} went wrong and ` : ''}
        {untried} of {run.counts.total} have not been tried yet.
      </p>
      <p className="muted">
        {wrong > 0
          ? 'Fix each failure, then run the check again.'
          : 'The event should not open until every check has a passing result.'}
      </p>
    </>
  )
}

function CreateRun({ defaultOpen, onCreated }: { defaultOpen: boolean; onCreated: () => void }) {
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
    <details className="rehearsal-create" open={defaultOpen}>
      <summary>Create a test run</summary>
      <form onSubmit={(event) => void submit(event)}>
        <p className="section-note rehearsal-wide-field">
          Creating a run copies in a fixed list of checks, grouped into areas such as sign-in,
          attendance and reviewing. Each area needs an owner before the run can start.
        </p>
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

  if (detail === undefined) {
    return (
      <div className="rehearsal-detail">
        <LoadingLabel>Loading this test run</LoadingLabel>
        <SkeletonList rows={6} />
      </div>
    )
  }

  const runWorkstreams = runAreas(detail)
  const scenarios = detail.scenarios
    .filter(
      (scenario) =>
        (stateFilter === 'all' || scenario.state === stateFilter) &&
        (workstreamFilter === 'all' || scenario.workstream === workstreamFilter),
    )
    .sort(
      (left, right) =>
        scenarioStateOrder.indexOf(left.state) - scenarioStateOrder.indexOf(right.state)
        || left.sequence - right.sequence,
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
        <span className={`rehearsal-state ${detail.run.state}`}>{rehearsalRunStateLabels[detail.run.state]}</span>
      </header>

      <RunCounts run={detail.run} />
      <WorkstreamOwners areas={runWorkstreams} detail={detail} />
      <RunControls detail={detail} />

      <section className="rehearsal-scenarios">
        <div className="section-heading">
          <div>
            <h2>Checks</h2>
            <p className="muted">
              {detail.run.counts.failed + detail.run.counts.blocked > 0
                ? 'Fix what went wrong, then run the check again.'
                : 'Work through each check and record what happened.'}
            </p>
          </div>
          <div className="rehearsal-filters">
            <label className="filter">
              Result
              <select
                value={stateFilter}
                onChange={(event) => setStateFilter(parseStateFilter(event.target.value))}
              >
                <option value="all">Every check</option>
                {scenarioStateOrder.map((value) => (
                  <option key={value} value={value}>{rehearsalScenarioStateLabels[value]}</option>
                ))}
              </select>
            </label>
            <label className="filter">
              Area
              <select
                value={workstreamFilter}
                onChange={(event) => setWorkstreamFilter(parseWorkstreamFilter(event.target.value, runWorkstreams))}
              >
                <option value="all">Every area</option>
                {runWorkstreams.map((value) => (
                  <option key={value} value={value}>{rehearsalWorkstreamLabels[value]}</option>
                ))}
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
                  <small>
                    {rehearsalWorkstreamLabels[scenario.workstream]} · {rehearsalScenarioStateLabels[scenario.state]}
                  </small>
                </span>
                <span
                  className={`rehearsal-dot ${scenario.state}`}
                  title={rehearsalScenarioStateLabels[scenario.state]}
                />
              </button>
            ))}
            {scenarios.length === 0 ? (
              <p className="empty">No check matches both filters.</p>
            ) : null}
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

/** Worst first, so the strip reads in the order the work should be picked up. */
function RunCounts({ run }: { run: RehearsalRun }) {
  return (
    <dl className="rehearsal-counts">
      <div><dt>Did not work</dt><dd>{run.counts.failed}</dd></div>
      <div><dt>Could not be tried</dt><dd>{run.counts.blocked}</dd></div>
      <div><dt>Being tried now</dt><dd>{run.counts.running}</dd></div>
      <div><dt>Not tried yet</dt><dd>{run.counts.pending}</dd></div>
      <div><dt>Worked</dt><dd>{run.counts.passed}</dd></div>
    </dl>
  )
}

function WorkstreamOwners({
  areas,
  detail,
}: {
  areas: RehearsalWorkstream[]
  detail: RehearsalDetail
}) {
  const missing = detail.run.requiredWorkstreamCount - detail.run.assignedWorkstreamCount
  const inactive = detail.workstreamOwners.filter((owner) => !owner.accessActive)
  const rows = areas
    .map((workstream) => ({
      workstream,
      owner: detail.workstreamOwners.find((candidate) => candidate.workstream === workstream),
    }))
    .sort((left, right) => ownerRank(left.owner) - ownerRank(right.owner))

  return (
    <section className="rehearsal-section">
      <div className="section-heading">
        <div>
          <h2>Owners</h2>
          <p className="muted">
            {missing > 0
              ? `${missing} of ${detail.run.requiredWorkstreamCount} areas have no owner, so the run cannot start.`
              : inactive.length > 0
                ? `Every area has an owner, but ${inactive.length === 1 ? 'one has' : `${inactive.length} have`} inactive access and cannot record a result.`
                : `All ${detail.run.requiredWorkstreamCount} areas have an owner who can record results.`}
          </p>
        </div>
      </div>
      <div className="rehearsal-owner-list">
        {rows.map(({ owner, workstream }) => (
          <div className="rehearsal-owner-row" key={workstream}>
            <strong>{rehearsalWorkstreamLabels[workstream]}</strong>
            <span>{owner?.displayName ?? 'Nobody yet'}</span>
            <small>
              {!owner
                ? 'The run cannot start without an owner.'
                : owner.accessActive
                  ? owner.email
                  : 'Their event access is inactive, so they cannot record results.'}
            </small>
          </div>
        ))}
      </div>
      {detail.run.canManage && (detail.run.state === 'draft' || detail.run.state === 'active') ? (
        <OwnerAssignment areas={areas} detail={detail} />
      ) : null}
    </section>
  )
}

/** An area with nobody on it is the work; an area already covered is not. */
function ownerRank(owner: RehearsalDetail['workstreamOwners'][number] | undefined) {
  if (!owner) return 0
  return owner.accessActive ? 2 : 1
}

function OwnerAssignment({
  areas,
  detail,
}: {
  areas: RehearsalWorkstream[]
  detail: RehearsalDetail
}) {
  const assign = useMutation(api.rehearsals.assignWorkstreamOwner)
  const options = usePaginatedQuery(
    api.rehearsals.ownerOptions,
    { eventSlug, rehearsalRunId: detail.run.id },
    { initialNumItems: 100 },
  )
  const firstMissing = areas.find(
    (candidate) => !detail.workstreamOwners.some((owner) => owner.workstream === candidate),
  ) ?? areas[0]
  const [workstream, setWorkstream] = useState<RehearsalWorkstream>(firstMissing ?? 'auth_access')
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
      <p className="section-note rehearsal-owner-reason">
        One person per area, with active event access. Assigning again replaces the current owner.
      </p>
      <label className="field">
        Area
        <select
          value={workstream}
          onChange={(event) => {
            resetOperation()
            setWorkstream(parseWorkstream(event.target.value, workstream, areas))
          }}
        >
          {areas.map((value) => (
            <option key={value} value={value}>{rehearsalWorkstreamLabels[value]}</option>
          ))}
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
    return (
      <p className="notice rehearsal-final-note">
        Signed off, so nothing more can be recorded: {detail.run.completionSummary}
      </p>
    )
  }
  if (detail.run.state === 'cancelled') {
    return (
      <p className="notice rehearsal-final-note">
        Cancelled before it finished: {detail.run.cancellationReason}
      </p>
    )
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

  const missingOwners = detail.run.requiredWorkstreamCount - detail.run.assignedWorkstreamCount
  const outstanding = detail.run.counts.total - detail.run.counts.passed

  return (
    <section className="rehearsal-section rehearsal-run-controls">
      <div>
        <h2>{detail.run.state === 'draft' ? 'Starting this run' : 'Signing this run off'}</h2>
        <p className="muted">
          {detail.run.state === 'draft'
            ? 'Results can only be recorded while a run is under way.'
            : 'A run is signed off only when every check has passed.'}
        </p>
      </div>
      {detail.run.state === 'draft' && !startReady && detail.run.canManage ? (
        <p className="notice">
          {missingOwners > 0
            ? `This run cannot start: ${missingOwners} of its ${detail.run.requiredWorkstreamCount} areas have no owner.`
            : 'Starting this run needs the rehearsal manage permission, which you do not have.'}
        </p>
      ) : null}
      {detail.run.state === 'active' && !completionReady && detail.run.canComplete ? (
        <p className="notice">
          {detail.run.counts.total === 0
            ? 'This run has no checks, so there is nothing to sign off.'
            : `This run cannot be signed off yet: ${outstanding} of its ${detail.run.counts.total} checks have no passing result.`}
        </p>
      ) : null}
      <label className="field">
        {detail.run.state === 'active' ? 'What this run showed' : 'Why this run is starting or ending'}
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
        {startReady ? (
          <button className="primary" disabled={busy || note.trim().length < 5} type="button" onClick={() => void run('start')}>
            {busy ? 'Working…' : 'Start test run'}
          </button>
        ) : null}
        {completionReady ? (
          <button className="primary" disabled={busy || note.trim().length < 10} type="button" onClick={() => void run('complete')}>
            {busy ? 'Working…' : 'Sign off test run'}
          </button>
        ) : null}
        {detail.run.canManage ? (
          <button className="secondary" disabled={busy || note.trim().length < 5} type="button" onClick={() => void run('cancel')}>
            Cancel run
          </button>
        ) : null}
      </div>
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
          <p className="eyebrow">Check {scenario.sequence} · {rehearsalWorkstreamLabels[scenario.workstream]}</p>
          <h2>{scenario.title}</h2>
        </div>
        <span className={`rehearsal-state ${scenario.state}`}>
          {rehearsalScenarioStateLabels[scenario.state]}
        </span>
      </header>
      <dl className="rehearsal-expectation">
        <div><dt>What should happen</dt><dd>{scenario.expectedState}</dd></div>
        <div><dt>What to do if it does not</dt><dd>{scenario.recoveryAction}</dd></div>
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
          {runState === 'active'
            ? 'You can read this check but not record a result. The area owner does that.'
            : `Results can only be recorded while a run is under way, and this one is ${rehearsalRunStateLabels[runState].toLowerCase()}.`}
        </p>
      )}

      <div className="rehearsal-history">
        <h2>History</h2>
        {history === undefined ? (
          <>
            <LoadingLabel>Loading what has been recorded for this check</LoadingLabel>
            <SkeletonList rows={2} />
          </>
        ) : null}
        {history?.length === 0 ? (
          <p className="muted">Nothing has been recorded for this check yet.</p>
        ) : null}
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

/**
 * The areas this run actually covers, in check order. The run's own required
 * count is derived from its checks, so listing a fixed eleven would show areas
 * that need no owner and make "3 of 11 assigned" disagree with the server.
 */
function runAreas(detail: RehearsalDetail): RehearsalWorkstream[] {
  const seen: RehearsalWorkstream[] = []
  for (const scenario of [...detail.scenarios].sort((left, right) => left.sequence - right.sequence)) {
    if (!seen.includes(scenario.workstream)) seen.push(scenario.workstream)
  }
  return seen
}

function parseStateFilter(value: string): StateFilter {
  return scenarioStateOrder.find((state) => state === value) ?? 'all'
}

function parseWorkstreamFilter(value: string, areas: RehearsalWorkstream[]): WorkstreamFilter {
  return areas.find((workstream) => workstream === value) ?? 'all'
}

function parseWorkstream(value: string, fallback: RehearsalWorkstream, areas: RehearsalWorkstream[]) {
  return areas.find((workstream) => workstream === value) ?? fallback
}

function historyLabel(kind: FunctionReturnType<typeof api.rehearsals.scenarioHistory>[number]['kind']) {
  if (kind === 'started') return 'Started'
  if (kind === 'passed') return 'Worked'
  if (kind === 'failed') return 'Did not work'
  if (kind === 'blocked') return 'Could not be tried'
  return 'Tried again'
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}
