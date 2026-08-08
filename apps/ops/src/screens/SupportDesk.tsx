import { api } from '@code2create/backend/api'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type StaffList = FunctionReturnType<typeof api.support.staffList>
type SupportCase = StaffList['cases'][number]
type SupportCaseId = SupportCase['id']
type SupportCategory = SupportCase['category']
type SupportState = SupportCase['state']
type StaffFilter = FunctionArgs<typeof api.support.staffList>['state']
type CreateStaffArgs = FunctionArgs<typeof api.support.createStaff>
type UpdateStaffArgs = FunctionArgs<typeof api.support.updateStaff>
type StateDraft = { caseVersion: number; state: SupportState }

const categories = [
  ['identity', 'Identity or sign-in'],
  ['team', 'Team'],
  ['project_intake', 'Idea submission'],
  ['track_configuration', 'Track'],
  ['attendance_credential', 'Check-in or ID'],
  ['missing_scan', 'Check-in scan'],
  ['scanner_device', 'Scanner device'],
  ['table_location', 'Hall location'],
  ['integration', 'GitHub or Figma'],
  ['queue', 'Judging queue'],
  ['reviewer_device', 'Reviewer device'],
  ['scorecard', 'Judge scores'],
  ['accessibility', 'Accessibility'],
  ['safety', 'Safety'],
] as const satisfies readonly (readonly [SupportCategory, string])[]

const filters = [
  ['active', 'Active'],
  ['resolved', 'Resolved'],
  ['closed', 'Closed'],
  ['all', 'All'],
] as const satisfies readonly (readonly [StaffFilter, string])[]

const stateTransitions = {
  open: ['investigating', 'waiting', 'resolved', 'closed'],
  investigating: ['open', 'waiting', 'resolved', 'closed'],
  waiting: ['open', 'investigating', 'resolved', 'closed'],
  resolved: ['open', 'investigating', 'closed'],
  closed: ['open'],
} as const satisfies Record<SupportState, readonly SupportState[]>

export function SupportDesk() {
  const [filter, setFilter] = useState<StaffFilter>('active')
  const list = useQuery(api.support.staffList, { eventSlug, state: filter })
  const [selectedId, setSelectedId] = useState<SupportCaseId | null>(null)

  const visibleSelectedId = selectedId ?? list?.cases.at(0)?.id ?? null

  return (
    <section className="support-desk-shell">
      <header className="page-heading support-desk-heading">
        <div>
          <p className="eyebrow">Participant support</p>
          <h1>Help desk</h1>
          <p className="muted">Track participant and staff issues from first report to resolution.</p>
        </div>
        <label className="filter">
          Requests
          <select
            value={filter}
            onChange={(event) => {
              setSelectedId(null)
              setFilter(parseFilter(event.target.value))
            }}
          >
            {filters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </header>

      {list?.canCreate ? <CreateCase onCreated={setSelectedId} /> : null}

      <div className="support-desk-workspace">
        <div className="support-desk-list" aria-label="Help requests">
          {list === undefined ? <p className="muted">Loading requests…</p> : null}
          {list?.cases.map((supportCase) => (
            <button
              className={visibleSelectedId === supportCase.id ? 'support-desk-row selected' : 'support-desk-row'}
              key={supportCase.id}
              type="button"
              onClick={() => setSelectedId(supportCase.id)}
            >
              <span>
                <strong>{supportCase.publicCode}</strong>
                <small>{categoryLabel(supportCase.category)} · {supportCase.reporterName}</small>
              </span>
              <span className="support-desk-row-meta">
                <small>{stateLabel(supportCase.state)}</small>
                <time>{formatCompactTime(supportCase.updatedAt)}</time>
              </span>
            </button>
          ))}
          {list?.cases.length === 0 ? <p className="empty">No requests in this view.</p> : null}
        </div>
        {visibleSelectedId && list ? (
          <CaseDetail currentPersonId={list.currentPersonId} supportCaseId={visibleSelectedId} />
        ) : null}
      </div>
    </section>
  )
}

function CreateCase({ onCreated }: { onCreated: (supportCaseId: SupportCaseId) => void }) {
  const createCase = useMutation(api.support.createStaff)
  const [category, setCategory] = useState<SupportCategory>('queue')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const operationRef = useRef<CreateStaffArgs | null>(null)

  const resetOperation = () => {
    operationRef.current = null
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const normalizedDescription = description.trim()
    if (busyRef.current || normalizedDescription.length < 10) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const args = operationRef.current ?? {
      eventSlug,
      category,
      description: normalizedDescription,
      clientOperationId: crypto.randomUUID(),
    }
    operationRef.current = args
    try {
      const result = await createCase(args)
      operationRef.current = null
      setDescription('')
      onCreated(result.id)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <details className="support-create">
      <summary>Log a walk-up issue</summary>
      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          Category
          <select
            value={category}
            onChange={(event) => {
              resetOperation()
              setCategory(parseCategory(event.target.value))
            }}
          >
            {categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="field">
          What happened?
          <textarea
            required
            minLength={10}
            maxLength={2000}
            value={description}
            onChange={(event) => {
              resetOperation()
              setDescription(event.target.value)
            }}
          />
        </label>
        <button className="secondary" type="submit" disabled={busy || description.trim().length < 10}>
          {busy ? 'Saving…' : 'Log issue'}
        </button>
        {error ? <p className="notice error">{error}</p> : null}
      </form>
    </details>
  )
}

function CaseDetail({ currentPersonId, supportCaseId }: {
  currentPersonId: StaffList['currentPersonId']
  supportCaseId: SupportCaseId
}) {
  const detail = useQuery(api.support.detail, { eventSlug, supportCaseId })
  const updateCase = useMutation(api.support.updateStaff)
  const [stateDraft, setStateDraft] = useState<StateDraft | null>(null)
  const [publicNote, setPublicNote] = useState('')
  const [internalNote, setInternalNote] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const formOperationRef = useRef<UpdateStaffArgs | null>(null)
  const ownerOperationRef = useRef<{ kind: 'assign' | 'clear'; args: UpdateStaffArgs } | null>(null)

  useEffect(() => {
    if (!detail) return
    if (formOperationRef.current?.expectedVersion !== detail.supportCase.version) {
      formOperationRef.current = null
    }
    if (ownerOperationRef.current?.args.expectedVersion !== detail.supportCase.version) {
      ownerOperationRef.current = null
    }
  }, [detail])

  if (detail === undefined) return <article className="support-desk-detail"><p className="muted">Loading request…</p></article>

  const nextState = stateDraft?.caseVersion === detail.supportCase.version
    ? stateDraft.state
    : detail.supportCase.state

  const resetFormOperation = () => {
    formOperationRef.current = null
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busyRef.current || reason.trim().length < 5) return
    const stateChanged = nextState !== detail.supportCase.state
    const normalizedPublicNote = publicNote.trim()
    const normalizedInternalNote = internalNote.trim()
    if (!stateChanged && normalizedPublicNote.length < 2 && normalizedInternalNote.length < 2) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const args = formOperationRef.current ?? {
      eventSlug,
      supportCaseId,
      expectedVersion: detail.supportCase.version,
      ...(stateChanged ? { nextState } : {}),
      clearOwner: false,
      ...(normalizedPublicNote.length >= 2 ? { publicNote: normalizedPublicNote } : {}),
      ...(normalizedInternalNote.length >= 2 ? { internalNote: normalizedInternalNote } : {}),
      reason: reason.trim(),
      clientOperationId: crypto.randomUUID(),
    }
    formOperationRef.current = args
    try {
      await updateCase(args)
      formOperationRef.current = null
      setPublicNote('')
      setInternalNote('')
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const changeOwner = async (kind: 'assign' | 'clear') => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const prior = ownerOperationRef.current
    const args = prior?.kind === kind ? prior.args : {
      eventSlug,
      supportCaseId,
      expectedVersion: detail.supportCase.version,
      ...(kind === 'assign' ? { nextOwnerPersonId: currentPersonId } : {}),
      clearOwner: kind === 'clear',
      reason: kind === 'assign' ? 'Claimed by support operator' : 'Returned to the unassigned support queue',
      clientOperationId: crypto.randomUUID(),
    }
    ownerOperationRef.current = { kind, args }
    try {
      await updateCase(args)
      ownerOperationRef.current = null
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const hasFormChange =
    nextState !== detail.supportCase.state || publicNote.trim().length >= 2 || internalNote.trim().length >= 2

  return (
    <article className="support-desk-detail">
      <header className="support-case-heading">
        <div>
          <p className="eyebrow">{categoryLabel(detail.supportCase.category)}</p>
          <h2>{detail.supportCase.publicCode}</h2>
        </div>
        <span className="state-label">{stateLabel(detail.supportCase.state)}</span>
      </header>
      <dl className="support-case-context">
        <div><dt>Reporter</dt><dd>{detail.supportCase.reporterName}</dd></div>
        <div><dt>Contact</dt><dd>{detail.supportCase.contactEmail}</dd></div>
        {detail.supportCase.subjectName ? <div><dt>Subject</dt><dd>{detail.supportCase.subjectName}</dd></div> : null}
        {detail.supportCase.teamName ? <div><dt>Team</dt><dd>{detail.supportCase.teamName}</dd></div> : null}
        {detail.supportCase.roundName ? <div><dt>Round</dt><dd>{detail.supportCase.roundName}</dd></div> : null}
        <div><dt>Owner</dt><dd>{detail.supportCase.ownerName ?? 'Unassigned'}</dd></div>
      </dl>
      <p className="support-case-description">{detail.supportCase.description}</p>

      <ol className="support-case-timeline">
        {detail.actions.map((action) => (
          <li className={action.visibility === 'internal' ? 'internal' : undefined} key={action.id}>
            <div><strong>{action.actorName}</strong><time>{formatTime(action.createdAt)}</time></div>
            <small>{actionLabel(action)}</small>
            {action.body && action.kind !== 'opened' ? <p>{action.body}</p> : null}
          </li>
        ))}
      </ol>

      {detail.supportCase.canManage ? (
        <div className="support-case-controls">
          <div className="support-owner-actions">
            <span>{detail.supportCase.ownerName ? `Owned by ${detail.supportCase.ownerName}` : 'No owner'}</span>
            {!detail.supportCase.ownedByViewer ? (
              <button className="text-button" disabled={busy} type="button" onClick={() => void changeOwner('assign')}>Assign to me</button>
            ) : null}
            {detail.supportCase.ownerName ? (
              <button className="text-button" disabled={busy} type="button" onClick={() => void changeOwner('clear')}>Unassign</button>
            ) : null}
          </div>
          <form className="support-case-form" onSubmit={(event) => void save(event)}>
            <label className="field">
              Status
              <select
                value={nextState}
                onChange={(event) => {
                  resetFormOperation()
                  setStateDraft({
                    caseVersion: detail.supportCase.version,
                    state: parseState(event.target.value, detail.supportCase.state),
                  })
                }}
              >
                {availableStates(detail.supportCase.state).map((state) => <option key={state} value={state}>{stateLabel(state)}</option>)}
              </select>
            </label>
            <label className="field">
              Reply visible to reporter
              <textarea
                maxLength={2000}
                value={publicNote}
                onChange={(event) => {
                  resetFormOperation()
                  setPublicNote(event.target.value)
                }}
              />
            </label>
            <label className="field">
              Internal note
              <textarea
                maxLength={2000}
                value={internalNote}
                onChange={(event) => {
                  resetFormOperation()
                  setInternalNote(event.target.value)
                }}
              />
            </label>
            <label className="field">
              Why this update
              <input
                required
                minLength={5}
                maxLength={300}
                value={reason}
                onChange={(event) => {
                  resetFormOperation()
                  setReason(event.target.value)
                }}
              />
            </label>
            <button className="primary" type="submit" disabled={busy || !hasFormChange || reason.trim().length < 5}>
              {busy ? 'Saving…' : 'Save update'}
            </button>
          </form>
        </div>
      ) : <p className="notice">You can view this request but cannot update it.</p>}
      {error ? <p className="notice error">{error}</p> : null}
    </article>
  )
}

function parseCategory(value: string): SupportCategory {
  return categories.find(([category]) => category === value)?.[0] ?? 'queue'
}

function parseFilter(value: string): StaffFilter {
  return filters.find(([filter]) => filter === value)?.[0] ?? 'active'
}

function parseState(value: string, fallback: SupportState): SupportState {
  return availableStates(fallback).find((state) => state === value) ?? fallback
}

function availableStates(current: SupportState): SupportState[] {
  return [current, ...stateTransitions[current]]
}

function categoryLabel(value: SupportCategory) {
  return categories.find(([category]) => category === value)?.[1] ?? value.replaceAll('_', ' ')
}

function stateLabel(value: SupportState) {
  if (value === 'investigating') return 'Investigating'
  if (value === 'waiting') return 'Waiting for reporter'
  if (value === 'resolved') return 'Resolved'
  if (value === 'closed') return 'Closed'
  return 'Open'
}

function actionLabel(action: FunctionReturnType<typeof api.support.detail>['actions'][number]) {
  if (action.kind === 'opened') return 'Request opened'
  if (action.kind === 'reporter_reply') return 'Reporter replied'
  if (action.kind === 'public_note') return 'Public reply'
  if (action.kind === 'internal_note') return 'Internal note'
  if (action.kind === 'state_changed') return `Status: ${stateLabel(action.previousState ?? 'open')} → ${stateLabel(action.nextState ?? 'open')}`
  if (action.kind === 'owner_changed') return `Owner: ${action.previousOwnerName ?? 'unassigned'} → ${action.nextOwnerName ?? 'unassigned'}`
  return 'Request updated'
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

function formatCompactTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(value)
}
