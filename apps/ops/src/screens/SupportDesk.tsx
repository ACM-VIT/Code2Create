import { api } from '@code2create/backend/api'
import {
  supportCaseCategoryLabels,
  supportCaseCategoryOrder,
  supportCaseStateLabels,
} from '@code2create/domain'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState } from 'react'

import { Icon, type IconName } from '../components/Icon'
import { LoadingLabel, SkeletonCard, SkeletonList, SkeletonStats } from '../components/Skeleton'
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

/** A request nobody has moved in this long is the one that gets forgotten. */
const staleAfterMs = 60 * 60 * 1000
const ageTickMs = 60 * 1000


const filters = [
  ['active', 'Still open'],
  ['resolved', 'Resolved'],
  ['closed', 'Closed'],
  ['all', 'Everything'],
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
  const now = useCurrentMinute()

  const ordered = list === undefined
    ? []
    : [...list.cases].sort((left, right) => urgency(left) - urgency(right) || sortWithinRank(left, right))
  const mostUrgentId = ordered.at(0)?.id ?? null

  /**
   * Open on the most urgent request, then stay there. Reading the order live
   * would move the open case out from under whoever is working it the moment
   * they save.
   */
  useEffect(() => {
    setSelectedId((current) => current ?? mostUrgentId)
  }, [mostUrgentId])

  const heading = (
    <header className="page-heading support-desk-heading">
      <div>
        <p className="eyebrow">Participant support</p>
        <h1>Help desk</h1>
      </div>
      <label className="filter">
        Showing
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
  )

  if (list === undefined) {
    return (
      <section className="support-desk-shell health-shell">
        {heading}
        <LoadingLabel>Loading the help desk</LoadingLabel>
        <SkeletonStats columns={4} />
        <SkeletonList rows={5} />
      </section>
    )
  }

  const counts = countCases(list.cases, now)
  const visibleSelectedId = selectedId ?? mostUrgentId
  const showCounts = filter === 'active' || filter === 'all'

  return (
    <section className="support-desk-shell health-shell">
      {heading}
      <p className="muted">{leadSentence(filter, counts)}</p>

      {showCounts && counts.total > 0 ? (
        <dl className="catalog-summary">
          <div><dt>{supportCaseStateLabels.open}</dt><dd>{counts.open}</dd></div>
          <div><dt>{supportCaseStateLabels.investigating}</dt><dd>{counts.investigating}</dd></div>
          <div><dt>{supportCaseStateLabels.waiting}</dt><dd>{counts.waiting}</dd></div>
          <div><dt>Nobody assigned</dt><dd>{counts.unassigned}</dd></div>
        </dl>
      ) : null}

      {list.canCreate ? <CreateCase onCreated={setSelectedId} /> : null}

      {ordered.length === 0 ? null : (
        <div className="support-desk-list" aria-label="Help requests">
          {ordered.map((supportCase) => {
            const glyph = rowGlyph(supportCase, now)
            return (
              <button
                className={visibleSelectedId === supportCase.id ? 'list-row support-desk-row selected' : 'list-row support-desk-row'}
                key={supportCase.id}
                type="button"
                onClick={() => setSelectedId(supportCase.id)}
              >
                <span className={glyph.className}><Icon name={glyph.icon} /></span>
                <span className="row-text">
                  <strong>
                    {supportCase.reporterName}
                    <span className="row-context"> · {supportCaseCategoryLabels[supportCase.category]}</span>
                  </strong>
                  <small>{rowStatement(supportCase, now)}</small>
                </span>
                <span className="state-label">{supportCaseStateLabels[supportCase.state]}</span>
              </button>
            )
          })}
        </div>
      )}

      {visibleSelectedId ? (
        <CaseDetail currentPersonId={list.currentPersonId} supportCaseId={visibleSelectedId} />
      ) : null}
    </section>
  )
}

/**
 * Row text is written in elapsed time, so it has to move on its own rather than
 * wait for the next write to the case.
 */
function useCurrentMinute() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ageTickMs)
    return () => clearInterval(timer)
  }, [])
  return now
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

  const ready = description.trim().length >= 10

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
            {supportCaseCategoryOrder.map((value) => (
              <option key={value} value={value}>{supportCaseCategoryLabels[value]}</option>
            ))}
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
        {ready || busy ? (
          <button className="secondary" type="submit">{busy ? 'Saving…' : 'Log issue'}</button>
        ) : (
          <p className="review-blocked">Write at least ten characters about what happened.</p>
        )}
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

  if (detail === undefined) {
    return (
      <>
        <LoadingLabel>Loading this request</LoadingLabel>
        <SkeletonCard lines={5} />
      </>
    )
  }

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

  const stateChanged = nextState !== detail.supportCase.state
  const wroteSomething = publicNote.trim().length >= 2 || internalNote.trim().length >= 2
  const blocker = !stateChanged && !wroteSomething
    ? 'Pick a different status, or write a reply or a note.'
    : reason.trim().length < 5
      ? 'Say why in a few words so the change stays traceable.'
      : null

  return (
    <article className="support-desk-detail">
      <header className="support-case-heading">
        <div>
          <p className="eyebrow">{supportCaseCategoryLabels[detail.supportCase.category]}</p>
          <h2>{detail.supportCase.publicCode}</h2>
        </div>
        <span className="state-label">{supportCaseStateLabels[detail.supportCase.state]}</span>
      </header>
      <dl className="support-case-context">
        <div><dt>Reporter</dt><dd>{detail.supportCase.reporterName}</dd></div>
        <div><dt>Contact</dt><dd>{detail.supportCase.contactEmail}</dd></div>
        {detail.supportCase.subjectName ? <div><dt>Subject</dt><dd>{detail.supportCase.subjectName}</dd></div> : null}
        {detail.supportCase.teamName ? <div><dt>Team</dt><dd>{detail.supportCase.teamName}</dd></div> : null}
        {detail.supportCase.roundName ? <div><dt>Round</dt><dd>{detail.supportCase.roundName}</dd></div> : null}
        <div><dt>Owner</dt><dd>{detail.supportCase.ownerName ?? 'Nobody'}</dd></div>
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
            <span>
              {detail.supportCase.ownerName
                ? `${detail.supportCase.ownerName} is handling this.`
                : 'Nobody is handling this yet.'}
            </span>
            {!detail.supportCase.ownedByViewer ? (
              <button className="text-button" type="button" onClick={() => void changeOwner('assign')}>Take it</button>
            ) : null}
            {detail.supportCase.ownerName ? (
              <button className="text-button" type="button" onClick={() => void changeOwner('clear')}>Hand it back</button>
            ) : null}
          </div>
          <form className="support-case-form" onSubmit={(event) => void save(event)}>
            <p className="section-note">
              Waiting on a reply parks the case with the reporter, and resolved keeps it visible until you close it.
            </p>
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
                {availableStates(detail.supportCase.state).map((state) => (
                  <option key={state} value={state}>{supportCaseStateLabels[state]}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Reply the reporter will see
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
              Note only the desk will see
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
            {blocker === null || busy ? (
              <button className="primary" type="submit">{busy ? 'Saving…' : 'Save update'}</button>
            ) : (
              <p className="review-blocked">{blocker}</p>
            )}
          </form>
        </div>
      ) : <p className="review-blocked">You can read this request but not update it.</p>}
      {error ? <p className="notice error">{error}</p> : null}
    </article>
  )
}

type CaseCounts = {
  open: number
  investigating: number
  waiting: number
  unassigned: number
  stale: number
  safety: number
  total: number
}

function isLive(state: SupportState) {
  return state === 'open' || state === 'investigating' || state === 'waiting'
}

function countCases(cases: readonly SupportCase[], now: number): CaseCounts {
  const counts: CaseCounts = {
    open: 0,
    investigating: 0,
    waiting: 0,
    unassigned: 0,
    stale: 0,
    safety: 0,
    total: cases.length,
  }
  for (const supportCase of cases) {
    if (supportCase.state === 'open') counts.open += 1
    if (supportCase.state === 'investigating') counts.investigating += 1
    if (supportCase.state === 'waiting') counts.waiting += 1
    if (!isLive(supportCase.state)) continue
    if (supportCase.ownerName === undefined) counts.unassigned += 1
    if (supportCase.category === 'safety') counts.safety += 1
    if (supportCase.state !== 'waiting' && now - supportCase.updatedAt > staleAfterMs) counts.stale += 1
  }
  return counts
}

/**
 * The screen opens on what is left to do, not on how many rows exist. Two short
 * sentences at most: what is waiting, and the one thing about it worth knowing.
 */
function leadSentence(filter: StaffFilter, counts: CaseCounts): string {
  if (filter === 'resolved') {
    if (counts.total === 0) return 'Nothing has been resolved yet.'
    return `${counts.total} ${counts.total === 1 ? 'request is' : 'requests are'} resolved and can be closed.`
  }
  if (filter === 'closed') {
    if (counts.total === 0) return 'Nothing has been closed yet.'
    return `${counts.total} ${counts.total === 1 ? 'request is' : 'requests are'} closed. Nothing here needs action.`
  }
  const live = counts.open + counts.investigating + counts.waiting
  if (live === 0) return 'Nothing is open. Nobody is waiting on the desk.'

  const sentences: string[] = []
  if (counts.safety > 0) {
    sentences.push(`${counts.safety} safety ${counts.safety === 1 ? 'report needs' : 'reports need'} someone first.`)
  }
  if (counts.open > 0) {
    sentences.push(`${counts.open} ${counts.open === 1 ? 'request is' : 'requests are'} waiting for a first reply.`)
  } else if (counts.investigating > 0) {
    sentences.push(`Nothing is waiting for a first reply. ${counts.investigating} ${counts.investigating === 1 ? 'request is' : 'requests are'} being looked at.`)
  } else {
    sentences.push(`Nothing is waiting for a first reply. ${counts.waiting} ${counts.waiting === 1 ? 'request is' : 'requests are'} back with the reporter.`)
  }
  if (counts.stale > 0) {
    sentences.push(`${counts.stale} ${counts.stale === 1 ? 'has' : 'have'} gone over an hour with no update.`)
  }
  return sentences.slice(0, 2).join(' ')
}

/** Work that can be picked up sorts first; finished work sinks to the bottom. */
function urgency(supportCase: SupportCase): number {
  if (supportCase.state === 'closed') return 6
  if (supportCase.state === 'resolved') return 5
  if (supportCase.category === 'safety') return 0
  if (supportCase.state === 'waiting') return 4
  if (supportCase.state === 'investigating') return 3
  return supportCase.ownerName === undefined ? 1 : 2
}

/** Within a rank, the one that has waited longest is the one to act on. */
function sortWithinRank(left: SupportCase, right: SupportCase): number {
  const finished = !isLive(left.state) && !isLive(right.state)
  return finished ? right.updatedAt - left.updatedAt : left.updatedAt - right.updatedAt
}

function rowGlyph(supportCase: SupportCase, now: number): { className: string; icon: IconName } {
  if (isLive(supportCase.state) && supportCase.category === 'safety') {
    return { className: 'row-glyph critical', icon: 'alert' }
  }
  if (supportCase.state === 'open') {
    return now - supportCase.updatedAt > staleAfterMs
      ? { className: 'row-glyph critical', icon: 'alert' }
      : { className: 'row-glyph attention', icon: 'clock' }
  }
  if (supportCase.state === 'investigating') return { className: 'row-glyph watch', icon: 'lifebuoy' }
  if (supportCase.state === 'waiting') return { className: 'row-glyph watch', icon: 'pause' }
  return { className: 'row-glyph', icon: 'lifebuoy' }
}

/** What this request is doing to the person who filed it, in one line. */
function rowStatement(supportCase: SupportCase, now: number): string {
  if (supportCase.state === 'open') {
    return supportCase.ownerName === undefined
      ? `Nobody has picked this up. Reported ${formatAge(supportCase.createdAt, now)}.`
      : `${supportCase.ownerName} has it but has not started. Reported ${formatAge(supportCase.createdAt, now)}.`
  }
  if (supportCase.state === 'investigating') {
    return supportCase.ownerName === undefined
      ? `Being looked at, but nobody owns it. Last moved ${formatAge(supportCase.updatedAt, now)}.`
      : `${supportCase.ownerName} is on it. Last moved ${formatAge(supportCase.updatedAt, now)}.`
  }
  if (supportCase.state === 'waiting') {
    return `Back with ${supportCase.reporterName}, replied to ${formatAge(supportCase.updatedAt, now)}.`
  }
  if (supportCase.state === 'resolved') {
    return `Resolved ${formatAge(supportCase.updatedAt, now)}. Close it when the reporter agrees.`
  }
  return `Closed ${formatAge(supportCase.updatedAt, now)}.`
}

function parseCategory(value: string): SupportCategory {
  return supportCaseCategoryOrder.find((category) => category === value) ?? 'queue'
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

function actionLabel(action: FunctionReturnType<typeof api.support.detail>['actions'][number]) {
  if (action.kind === 'opened') return 'Request opened'
  if (action.kind === 'reporter_reply') return 'Reporter replied'
  if (action.kind === 'public_note') return 'Reply to the reporter'
  if (action.kind === 'internal_note') return 'Internal note'
  if (action.kind === 'state_changed') {
    return `Moved from ${supportCaseStateLabels[action.previousState ?? 'open']} to ${supportCaseStateLabels[action.nextState ?? 'open']}`
  }
  if (action.kind === 'owner_changed') {
    return `Handed from ${action.previousOwnerName ?? 'nobody'} to ${action.nextOwnerName ?? 'nobody'}`
  }
  return 'Request updated'
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

function formatAge(value: number, now: number) {
  const minutes = Math.max(0, Math.round((now - value) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}
