import { api } from '@code2create/backend/api'
import { supportCaseCategoryLabels } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useRef, useState } from 'react'

import { ErrorNotice } from '../components/Form'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useMutationAttempt } from '../lib/operations'

type SupportCase = FunctionReturnType<typeof api.support.mine>[number]
type SupportCaseId = SupportCase['id']
type SupportCategory = SupportCase['category']
type CreateSelfResult = FunctionReturnType<typeof api.support.createSelf>
type ReplySelfResult = FunctionReturnType<typeof api.support.replySelf>

const categories = [
  'identity',
  'team',
  'project_intake',
  'attendance_credential',
  'missing_scan',
  'table_location',
  'integration',
  'queue',
  'accessibility',
  'safety',
] as const satisfies readonly SupportCategory[]

export function SupportScreen({ canCreate }: { canCreate: boolean }) {
  const cases = useQuery(api.support.mine, { eventSlug })
  const createCase = useMutation(api.support.createSelf)
  const [selectedId, setSelectedId] = useState<SupportCaseId | null>(null)
  const [category, setCategory] = useState<SupportCategory>('team')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const createAttempt = useMutationAttempt<CreateSelfResult>()
  const createPending = createAttempt.hasPending('create-support-case')

  const visibleSelectedId = selectedId ?? cases?.at(0)?.id ?? null

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await createAttempt.run('create-support-case', () => {
        const args = {
          eventSlug,
          category,
          description,
          clientOperationId: crypto.randomUUID(),
        }
        return () => createCase(args)
      })
      setDescription('')
      setSelectedId(result.id)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <section className="support-shell">
      <header className="support-heading">
        <div>
          <p className="eyebrow">Help desk</p>
          <h1>Help</h1>
          <p className="muted">Tell the event team what is blocking you. Follow replies here.</p>
        </div>
      </header>

      {canCreate ? (
        <form className="support-form" onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span className="field-label">What is this about?</span>
            <select
              disabled={busy || createPending}
              value={category}
              onChange={(event) => {
                setCategory(parseCategory(event.target.value))
              }}
            >
              {categories.map((value) => (
                <option key={value} value={value}>{supportCaseCategoryLabels[value]}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">What happened?</span>
            <textarea
              required
              minLength={10}
              maxLength={2000}
              disabled={busy || createPending}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value)
              }}
              placeholder="A short, factual description is enough."
            />
          </label>
          <button className="primary" type="submit" disabled={busy || description.trim().length < 10}>
            {busy ? 'Sending…' : createPending ? 'Confirm request' : 'Ask for help'}
          </button>
          {createPending ? <p className="fine-print">Confirm the earlier request before writing another.</p> : null}
          <ErrorNotice message={error} />
        </form>
      ) : null}

      <div className="support-workspace">
        <div className="support-case-list" role="region" aria-label="Your help requests">
          {cases === undefined ? <p className="muted">Loading requests…</p> : null}
          {cases?.map((supportCase) => (
            <button
              className={visibleSelectedId === supportCase.id ? 'support-case-row selected' : 'support-case-row'}
              key={supportCase.id}
              type="button"
              onClick={() => setSelectedId(supportCase.id)}
            >
              <span><strong>{supportCase.publicCode}</strong>{categoryLabel(supportCase.category)}</span>
              <small>{stateLabel(supportCase.state)}</small>
            </button>
          ))}
          {cases?.length === 0 ? <p className="empty">No help requests yet.</p> : null}
        </div>
        {visibleSelectedId ? <SupportCaseDetail supportCaseId={visibleSelectedId} /> : null}
      </div>
    </section>
  )
}

function SupportCaseDetail({ supportCaseId }: { supportCaseId: SupportCaseId }) {
  const detail = useQuery(api.support.detail, { eventSlug, supportCaseId })
  const reply = useMutation(api.support.replySelf)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const replyAttempt = useMutationAttempt<ReplySelfResult>()
  const replyPending = replyAttempt.hasPending('reply-to-support-case')

  if (detail === undefined) return <article className="support-case-detail"><p className="muted">Loading request…</p></article>
  if (detail === null) return <article className="support-case-detail"><p className="muted">This request is no longer available.</p></article>

  const sendReply = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await replyAttempt.run('reply-to-support-case', () => {
        const args = {
          eventSlug,
          supportCaseId,
          expectedVersion: detail.supportCase.version,
          message,
          clientOperationId: crypto.randomUUID(),
        }
        return () => reply(args)
      })
      setMessage('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <article className="support-case-detail">
      <div className="support-case-title">
        <div>
          <span>{categoryLabel(detail.supportCase.category)}</span>
          <h2>{detail.supportCase.publicCode}</h2>
        </div>
        <small>{stateLabel(detail.supportCase.state)}</small>
      </div>
      <p className="support-description">{detail.supportCase.description}</p>
      <ol className="support-timeline">
        {detail.actions.map((action) => (
          <li key={action.id}>
            <div><strong>{action.actorName}</strong><time>{formatTime(action.createdAt)}</time></div>
            <span>{actionText(action)}</span>
            {action.body && action.kind !== 'opened' ? <p>{action.body}</p> : null}
          </li>
        ))}
      </ol>
      {detail.supportCase.canReply ? (
        <form className="support-reply" onSubmit={(event) => void sendReply(event)}>
          <label className="field">
            <span className="field-label">Reply</span>
            <textarea
              required
              minLength={2}
              maxLength={2000}
              disabled={busy || replyPending}
              value={message}
              onChange={(event) => {
                setMessage(event.target.value)
              }}
            />
          </label>
          <button className="secondary" type="submit" disabled={busy || message.trim().length < 2}>
            {busy ? 'Sending…' : replyPending ? 'Confirm reply' : 'Send reply'}
          </button>
          <ErrorNotice message={error} />
        </form>
      ) : <p className="fine-print">This request is closed. Ask for help again if the issue returns.</p>}
    </article>
  )
}

function parseCategory(value: string): SupportCategory {
  return categories.find((category) => category === value) ?? 'team'
}

function categoryLabel(value: SupportCategory) {
  return supportCaseCategoryLabels[value]
}

function stateLabel(value: string) {
  if (value === 'investigating') return 'Investigating'
  if (value === 'waiting') return 'Waiting for you'
  if (value === 'resolved') return 'Resolved'
  if (value === 'closed') return 'Closed'
  return 'Open'
}

function actionText(action: NonNullable<FunctionReturnType<typeof api.support.detail>>['actions'][number]) {
  if (action.kind === 'opened') return 'Request sent'
  if (action.kind === 'reporter_reply') return 'You replied'
  if (action.kind === 'public_note') return 'Support replied'
  if (action.kind === 'state_changed') return `Status changed to ${stateLabel(action.nextState ?? 'open').toLowerCase()}`
  return 'Request updated'
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}
