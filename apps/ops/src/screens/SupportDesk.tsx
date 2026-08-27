import { api } from '@code2create/backend/api'
import {
  supportCaseCategoryLabels,
  supportCaseCategoryOrder,
  supportCaseStateLabels,
} from '@code2create/domain'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useRef, useState } from 'react'

import { Icon, type IconName } from '../components/Icon'
import { LoadingLabel, SkeletonCard, SkeletonLine, SkeletonList, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { formatMediumDateTime as formatTime } from '../lib/dateTime'
import { readableError } from '../lib/errors'
import { useMutationAttempt } from '../lib/operations'
import { useEstimatedServerNow } from '../lib/useEstimatedServerNow'

type StaffList = FunctionReturnType<typeof api.support.staffList>
type SupportCase = StaffList['cases'][number]
type SupportCaseId = SupportCase['id']
type SupportCategory = SupportCase['category']
type SupportState = SupportCase['state']
type StaffTotals = StaffList['totals']
type PersonId = StaffList['currentPersonId']
type OwnerCandidate = FunctionReturnType<typeof api.support.owners>[number]
type StaffFilter = FunctionArgs<typeof api.support.staffList>['state']
type CreateStaffResult = FunctionReturnType<typeof api.support.createStaff>
type UpdateStaffResult = FunctionReturnType<typeof api.support.updateStaff>
type StateDraft = { caseVersion: number; state: SupportState }

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
  const now = useEstimatedServerNow(list?.serverNow, ageTickMs)

  const ordered = list === undefined
    ? []
    : [...list.cases].sort((left, right) => urgency(left) - urgency(right) || sortWithinRank(left, right))
  const mostUrgentId = ordered.at(0)?.id ?? null
  const visibleSelectedId = selectedId !== null && ordered.some((supportCase) => supportCase.id === selectedId)
    ? selectedId
    : mostUrgentId

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
        <SkeletonStats columns={5} />
        <SkeletonList rows={5} />
      </section>
    )
  }

  const totals = list.totals
  return (
    <section className="support-desk-shell health-shell">
      {heading}
      <p className="muted">{leadSentence(filter, totals)}</p>

      {everyCase(totals) > 0 ? (
        <dl className="catalog-summary">
          <div><dt>{supportCaseStateLabels.open}</dt><dd>{totals.open}</dd></div>
          <div><dt>{supportCaseStateLabels.investigating}</dt><dd>{totals.investigating}</dd></div>
          <div><dt>{supportCaseStateLabels.waiting}</dt><dd>{totals.waiting}</dd></div>
          <div><dt>Owed a reply</dt><dd>{totals.awaitingStaffReply}</dd></div>
          <div><dt>Nobody assigned</dt><dd>{totals.unowned}</dd></div>
        </dl>
      ) : null}

      {list.caseLimitReached ? (
        <p className="notice">
          Showing the 80 most recently changed requests in this view. Narrow the status filter to reach older work.
        </p>
      ) : null}

      {list.canCreate ? (
        <CreateCase defaultOpen={everyCase(totals) === 0} onCreated={setSelectedId} />
      ) : null}

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

function CreateCase({
  defaultOpen,
  onCreated,
}: {
  defaultOpen: boolean
  onCreated: (supportCaseId: SupportCaseId) => void
}) {
  const createCase = useMutation(api.support.createStaff)
  const [category, setCategory] = useState<SupportCategory>('queue')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(defaultOpen)
  const busyRef = useRef(false)
  const createAttempt = useMutationAttempt<CreateStaffResult>()
  const createPending = createAttempt.hasPending('create-support-case')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const normalizedDescription = description.trim()
    if (busyRef.current || normalizedDescription.length < 10) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await createAttempt.run('create-support-case', () => {
        const args = {
          eventSlug,
          category,
          description: normalizedDescription,
          clientOperationId: crypto.randomUUID(),
        }
        return () => createCase(args)
      })
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
    <details
      className="support-create"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Log a walk-up issue</summary>
      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          Category
          <select
            disabled={busy || createPending}
            value={category}
            onChange={(event) => {
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
            disabled={busy || createPending}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value)
            }}
          />
        </label>
        {ready || busy ? (
          <button className="secondary" type="submit">{busy ? 'Saving…' : createPending ? 'Confirm issue' : 'Log issue'}</button>
        ) : (
          <p className="review-blocked">Write at least ten characters about what happened.</p>
        )}
        {error ? <p className="notice error">{error}</p> : null}
        {createPending ? <p className="muted">Confirm the earlier issue before writing another.</p> : null}
      </form>
    </details>
  )
}

function CaseDetail({ currentPersonId, supportCaseId }: {
  currentPersonId: StaffList['currentPersonId']
  supportCaseId: SupportCaseId
}) {
  const detail = useQuery(api.support.detail, { eventSlug, supportCaseId })
  const canManage = detail?.supportCase.canManage === true
  const owners = useQuery(api.support.owners, canManage ? { eventSlug } : 'skip')
  const updateCase = useMutation(api.support.updateStaff)
  const [stateDraft, setStateDraft] = useState<StateDraft | null>(null)
  const [handoffPersonId, setHandoffPersonId] = useState('')
  const [publicNote, setPublicNote] = useState('')
  const [internalNote, setInternalNote] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const formAttempt = useMutationAttempt<UpdateStaffResult>()
  const ownerAttempt = useMutationAttempt<UpdateStaffResult>()

  if (detail === undefined) {
    return (
      <>
        <LoadingLabel>Loading this request</LoadingLabel>
        <SkeletonCard lines={5} />
      </>
    )
  }
  if (detail === null) {
    return <p className="review-blocked">This request is no longer available.</p>
  }

  const nextState = stateDraft?.caseVersion === detail.supportCase.version
    ? stateDraft.state
    : detail.supportCase.state

  const formPending = formAttempt.hasPending('update-support-case')
  const ownerPending = ownerAttempt.hasPending('change-support-owner')

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    const operationKey = 'update-support-case'
    const retrying = formAttempt.hasPending(operationKey)
    if (busyRef.current || (!retrying && reason.trim().length < 5)) return
    const stateChanged = nextState !== detail.supportCase.state
    const normalizedPublicNote = publicNote.trim()
    const normalizedInternalNote = internalNote.trim()
    if (!retrying && !stateChanged && normalizedPublicNote.length < 2 && normalizedInternalNote.length < 2) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await formAttempt.run(operationKey, () => {
        const args = {
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
        return () => updateCase(args)
      })
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

  const changeOwner = async (nextOwnerPersonId: PersonId | null, ownerReason: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const key = 'change-support-owner'
    try {
      await ownerAttempt.run(key, () => {
        const args = {
          eventSlug,
          supportCaseId,
          expectedVersion: detail.supportCase.version,
          ...(nextOwnerPersonId === null ? {} : { nextOwnerPersonId }),
          clearOwner: nextOwnerPersonId === null,
          reason: ownerReason,
          clientOperationId: crypto.randomUUID(),
        }
        return () => updateCase(args)
      })
      setHandoffPersonId('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handoffChoices = (owners ?? []).filter(
    (candidate) => candidate.personId !== detail.supportCase.ownerPersonId,
  )
  const handoffTarget = handoffChoices.find((candidate) => candidate.personId === handoffPersonId) ?? null

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
        <div>
          <dt>First reply</dt>
          <dd>{firstReplyStatement(detail.supportCase.createdAt, detail.supportCase.firstResponseAt)}</dd>
        </div>
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
              <button
                className="text-button"
                type="button"
                onClick={() => void changeOwner(currentPersonId, 'Claimed at the help desk')}
              >
                Take it
              </button>
            ) : null}
            {detail.supportCase.ownerName ? (
              <button
                className="text-button"
                type="button"
                onClick={() => void changeOwner(null, 'Returned to the unassigned support queue')}
              >
                Hand it back
              </button>
            ) : null}
          </div>
          {owners === undefined ? <SkeletonLine width="46%" /> : handoffChoices.length === 0 ? (
            <p className="review-blocked">Nobody else on the desk can take a request yet.</p>
          ) : (
            <div className="support-owner-actions">
              <label className="field">
                Hand it to
                <select
                  disabled={busy || ownerPending}
                  value={handoffPersonId}
                  onChange={(event) => setHandoffPersonId(event.target.value)}
                >
                  <option value="">Choose someone</option>
                  {handoffChoices.map((candidate) => (
                    <option key={candidate.personId} value={candidate.personId}>{candidate.displayName}</option>
                  ))}
                </select>
              </label>
              {handoffTarget === null ? (
                <p className="review-blocked">Choose who should take this over.</p>
              ) : (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => void changeOwner(handoffTarget.personId, handoffReason(handoffTarget))}
                >
                  Hand it to {handoffTarget.displayName}
                </button>
              )}
            </div>
          )}
          <form className="support-case-form" onSubmit={(event) => void save(event)}>
            <p className="section-note">
              Waiting on a reply parks the case with the reporter, and resolved keeps it visible until you close it.
            </p>
            <label className="field">
              Status
              <select
                disabled={busy || formPending}
                value={nextState}
                onChange={(event) => {
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
                disabled={busy || formPending}
                maxLength={2000}
                value={publicNote}
                onChange={(event) => setPublicNote(event.target.value)}
              />
            </label>
            <label className="field">
              Note only the desk will see
              <textarea
                disabled={busy || formPending}
                maxLength={2000}
                value={internalNote}
                onChange={(event) => setInternalNote(event.target.value)}
              />
            </label>
            <label className="field">
              Why this update
              <input
                disabled={busy || formPending}
                required
                minLength={5}
                maxLength={300}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            {blocker === null || busy ? (
              <button className="primary" type="submit">{busy ? 'Saving…' : formPending ? 'Confirm update' : 'Save update'}</button>
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

function isLive(state: SupportState) {
  return state === 'open' || state === 'investigating' || state === 'waiting'
}

function everyCase(totals: StaffTotals): number {
  return totals.open + totals.investigating + totals.waiting + totals.resolved + totals.closed
}

function leadSentence(filter: StaffFilter, totals: StaffTotals): string {
  if (filter === 'resolved') {
    if (totals.resolved === 0) return 'Nothing has been resolved yet.'
    return `${totals.resolved} ${totals.resolved === 1 ? 'request is' : 'requests are'} resolved and can be closed.`
  }
  if (filter === 'closed') {
    if (totals.closed === 0) return 'Nothing has been closed yet.'
    return `${totals.closed} ${totals.closed === 1 ? 'request is' : 'requests are'} closed. Nothing here needs action.`
  }
  const live = totals.open + totals.investigating + totals.waiting
  if (live === 0) return 'Nothing is open. Nobody is waiting on the desk.'

  const sentences: string[] = []
  if (totals.safety > 0) {
    sentences.push(`${totals.safety} safety ${totals.safety === 1 ? 'report needs' : 'reports need'} someone first.`)
  }
  if (totals.awaitingStaffReply > 0) {
    sentences.push(`${totals.awaitingStaffReply} ${totals.awaitingStaffReply === 1 ? 'request is' : 'requests are'} waiting on a reply from the desk.`)
  } else {
    sentences.push('Every open request has had a reply.')
  }
  if (totals.unowned > 0) {
    sentences.push(`${totals.unowned} ${totals.unowned === 1 ? 'has' : 'have'} nobody assigned.`)
  } else if (totals.waiting > 0) {
    sentences.push(`${totals.waiting} ${totals.waiting === 1 ? 'is' : 'are'} back with the reporter.`)
  }
  return sentences.slice(0, 2).join(' ')
}

function urgency(supportCase: SupportCase): number {
  if (supportCase.state === 'closed') return 6
  if (supportCase.state === 'resolved') return 5
  if (supportCase.category === 'safety') return 0
  if (!supportCase.awaitingStaffReply) return supportCase.state === 'waiting' ? 4 : 3
  return supportCase.ownerName === undefined ? 1 : 2
}

function sortWithinRank(left: SupportCase, right: SupportCase): number {
  const finished = !isLive(left.state) && !isLive(right.state)
  return finished ? right.lastActionAt - left.lastActionAt : left.lastActionAt - right.lastActionAt
}

function rowGlyph(supportCase: SupportCase, now: number): { className: string; icon: IconName } {
  if (!isLive(supportCase.state)) return { className: 'row-glyph', icon: 'lifebuoy' }
  if (supportCase.category === 'safety') return { className: 'row-glyph critical', icon: 'alert' }
  if (supportCase.awaitingStaffReply) {
    return now - supportCase.lastActionAt > staleAfterMs
      ? { className: 'row-glyph critical', icon: 'alert' }
      : { className: 'row-glyph attention', icon: 'clock' }
  }
  if (supportCase.state === 'waiting') return { className: 'row-glyph watch', icon: 'pause' }
  return { className: 'row-glyph watch', icon: 'lifebuoy' }
}

function rowStatement(supportCase: SupportCase, now: number): string {
  if (supportCase.state === 'resolved') {
    return `Resolved ${formatAge(supportCase.lastActionAt, now)}. Close it when the reporter agrees.`
  }
  if (supportCase.state === 'closed') return `Closed ${formatAge(supportCase.lastActionAt, now)}.`
  if (supportCase.awaitingStaffReply) {
    if (supportCase.firstResponseAt === undefined) {
      return supportCase.ownerName === undefined
        ? `Nobody has picked this up, and ${supportCase.reporterName} has had no reply. Reported ${formatAge(supportCase.createdAt, now)}.`
        : `${supportCase.ownerName} has it, and ${supportCase.reporterName} has had no reply. Reported ${formatAge(supportCase.createdAt, now)}.`
    }
    return supportCase.ownerName === undefined
      ? `${supportCase.reporterName} wrote back and nobody has picked it up. Last moved ${formatAge(supportCase.lastActionAt, now)}.`
      : `${supportCase.reporterName} wrote back and is waiting on ${supportCase.ownerName}. Last moved ${formatAge(supportCase.lastActionAt, now)}.`
  }
  if (supportCase.state === 'waiting') {
    return `Back with ${supportCase.reporterName}. Last moved ${formatAge(supportCase.lastActionAt, now)}.`
  }
  return supportCase.ownerName === undefined
    ? `Replied to ${supportCase.reporterName}, but nobody owns it. Last moved ${formatAge(supportCase.lastActionAt, now)}.`
    : `${supportCase.ownerName} replied and still has it. Last moved ${formatAge(supportCase.lastActionAt, now)}.`
}

function firstReplyStatement(createdAt: number, firstResponseAt: number | undefined): string {
  if (firstResponseAt === undefined) return 'Nobody has replied yet.'
  return `${formatDuration(firstResponseAt - createdAt)} after it was reported.`
}

function handoffReason(target: OwnerCandidate): string {
  return `Handed to ${target.displayName} at the help desk`
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

function actionLabel(action: NonNullable<FunctionReturnType<typeof api.support.detail>>['actions'][number]) {
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

function formatDuration(milliseconds: number) {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000))
  if (minutes < 1) return 'Under a minute'
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'}`
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
