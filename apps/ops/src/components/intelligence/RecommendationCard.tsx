import { api } from '@code2create/backend/api'
import type {
  IntelligenceRecommendationCitation,
  OperationsAutonomyRecommendationCitation,
} from '@code2create/domain'
import { useMutation, usePaginatedQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useState } from 'react'

import { eventSlug } from '../../lib/config'
import { formatCompactDateTime } from '../../lib/dateTime'
import { readableError } from '../../lib/errors'
import type { OperationRunner } from '../../lib/operations'
import {
  type Recommendation,
  recommendationCommandRows,
  recommendationKindLabel,
  recommendationSourceLabel,
  recommendationStatusLabel,
  recommendationStatusTone,
} from '../../lib/recommendationPresentation'

type Decision = 'reject' | 'suggest'

export function RecommendationCard({
  collapsed = false,
  operations,
  recommendation,
}: {
  collapsed?: boolean
  operations: OperationRunner<{ version: number }>
  recommendation: Recommendation
}) {
  const approve = useMutation(api.intelligenceRecommendations.approve)
  const reject = useMutation(api.intelligenceRecommendations.reject)
  const suggest = useMutation(api.intelligenceRecommendations.suggest)
  const [decision, setDecision] = useState<Decision>()
  const [note, setNote] = useState('')
  const [error, setError] = useState<string>()
  const [confirming, setConfirming] = useState(false)

  const approveSlot = `${recommendation.id}:approve`
  const rejectSlot = `${recommendation.id}:reject`
  const suggestSlot = `${recommendation.id}:suggest`
  const pendingSlot = operations.hasPending(approveSlot)
    ? approveSlot
    : operations.hasPending(rejectSlot)
      ? rejectSlot
      : operations.hasPending(suggestSlot)
        ? suggestSlot
        : undefined
  const hasPending = pendingSlot !== undefined
  const proposed = recommendation.status === 'proposed'

  const approveRecommendation = async () => {
    setConfirming(true)
    setError(undefined)
    try {
      await operations.run(approveSlot, (clientOperationId) => () => approve({
        eventSlug,
        recommendationId: recommendation.id,
        expectedVersion: recommendation.version,
        clientOperationId,
      }))
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setConfirming(false)
    }
  }

  const submitDecision = async () => {
    if (decision === undefined) return
    const normalizedNote = note.trim()
    if (normalizedNote.length < 5) {
      setError('Add at least five characters so the agent has actionable feedback.')
      return
    }
    const slot = decision === 'reject' ? rejectSlot : suggestSlot
    setConfirming(true)
    setError(undefined)
    try {
      await operations.run(slot, (clientOperationId) => decision === 'reject'
        ? () => reject({
            eventSlug,
            recommendationId: recommendation.id,
            expectedVersion: recommendation.version,
            clientOperationId,
            reason: normalizedNote,
          })
        : () => suggest({
            eventSlug,
            recommendationId: recommendation.id,
            expectedVersion: recommendation.version,
            clientOperationId,
            suggestion: normalizedNote,
          }))
      setDecision(undefined)
      setNote('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setConfirming(false)
    }
  }

  const confirmPendingDecision = async () => {
    if (pendingSlot === undefined) return
    setConfirming(true)
    setError(undefined)
    try {
      await operations.retryPending(pendingSlot)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setConfirming(false)
    }
  }

  const meta = [
    recommendationKindLabel(recommendation.arguments.kind),
    recommendationSourceLabel(recommendation.provenance),
    `Proposed ${formatCompactDateTime(recommendation.proposedAt)}`,
    ...(recommendation.decidedAt === undefined
      ? []
      : [`Decided ${formatCompactDateTime(recommendation.decidedAt)}`]),
  ]

  const header = (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="m-0 text-[11.5px] leading-5 text-ink-3">{meta.join(' · ')}</p>
        <h3 className="m-0 mt-1 text-[14px] leading-snug font-medium text-ink">
          {recommendation.statement}
        </h3>
      </div>
      <span className={`inline-flex h-5.5 shrink-0 items-center rounded-full px-2 text-[11px] ${recommendationStatusTone(recommendation.status)}`}>
        {recommendationStatusLabel(recommendation.status)}
      </span>
    </div>
  )

  const body = (
    <>
      <p className="m-0 text-[13px] leading-6 text-ink-2">{recommendation.reasoning}</p>

      <dl className="m-0 grid rounded-lg bg-canvas/60 px-3.5 py-1">
        {recommendationCommandRows(recommendation.arguments).map((row) => (
          <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-3 border-t border-line py-2 first:border-t-0" key={row.label}>
            <dt className="text-[12px] leading-5 text-ink-3">{row.label}</dt>
            <dd className={`m-0 [overflow-wrap:anywhere] text-[12.5px] leading-5 text-ink-2 ${row.code ? 'font-mono text-[11.5px]' : ''}`}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {recommendation.executedTargetType === undefined ? null : (
        <p className="m-0 rounded-lg bg-green/10 px-3 py-2 text-[12px] leading-5 text-green">
          Executed {recommendation.executedTargetType.replaceAll('_', ' ')}{' '}
          <code className="font-mono text-[11px]">{recommendation.executedTargetId}</code>
        </p>
      )}
      {recommendation.operatorNote === undefined ? null : (
        <p className="m-0 rounded-lg bg-field px-3 py-2 text-[12.5px] leading-5 text-ink-2">
          <span className="text-ink-3">Operator note · </span>
          {recommendation.operatorNote}
        </p>
      )}

      <details className="group rounded-lg border border-line">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2.5 text-[12px] text-ink-2 hover:bg-hover [&::-webkit-details-marker]:hidden">
          <span>Evidence and provenance</span>
          <span aria-hidden className="font-mono text-[14px] text-ink-3 transition-transform group-open:rotate-45">+</span>
        </summary>
        <div className="grid gap-4 border-t border-line px-3.5 py-3.5">
          <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <ProvenanceDatum label="Agent release" value={recommendation.agentVersion} />
            <ProvenanceDatum label="Model" value={recommendation.model} />
            <ProvenanceDatum label="Command version" value={String(recommendation.version)} />
            <ProvenanceDatum
              label={recommendation.provenance.kind === 'autonomy' ? 'Autonomous run' : 'Conversation'}
              value={recommendation.provenance.kind === 'autonomy'
                ? recommendation.provenance.runId
                : recommendation.provenance.conversationId}
            />
          </dl>
          {recommendation.provenance.kind === 'autonomy' ? (
            <AutonomyEvidence recommendationId={recommendation.id} />
          ) : (
            <CitationList citations={recommendation.provenance.citations} />
          )}
        </div>
      </details>

      {pendingSlot !== undefined ? (
        <div className="grid gap-2 border-t border-line pt-4">
          <p className="m-0 text-[12.5px] text-ink-2">
            Delivery of your earlier decision was interrupted. Confirm it once; it cannot apply twice.
          </p>
          <button
            className="w-fit cursor-pointer rounded-lg border border-amber/30 bg-amber/10 px-3 py-1.5 text-[12px] font-semibold text-amber disabled:cursor-not-allowed disabled:opacity-50"
            disabled={confirming}
            onClick={() => void confirmPendingDecision()}
            type="button"
          >
            {pendingSlot === approveSlot
              ? 'Confirm the earlier approval'
              : pendingSlot === rejectSlot
                ? 'Confirm the earlier rejection'
                : 'Confirm the earlier guidance'}
          </button>
        </div>
      ) : proposed ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <button
            className="primary"
            disabled={confirming}
            onClick={() => void approveRecommendation()}
            type="button"
          >
            Approve and execute
          </button>
          <button
            className="secondary"
            disabled={confirming}
            onClick={() => {
              setDecision('reject')
              setError(undefined)
            }}
            type="button"
          >
            Reject
          </button>
          <button
            className="secondary"
            disabled={confirming}
            onClick={() => {
              setDecision('suggest')
              setError(undefined)
            }}
            type="button"
          >
            Suggest a change
          </button>
          <span className="text-[11px] text-ink-3">
            Runs with your permissions after fresh checks.
          </span>
        </div>
      ) : null}

      {proposed && decision !== undefined && !hasPending ? (
        <div className="grid gap-2">
          <label className="text-[12px] font-medium text-ink" htmlFor={`recommendation-note-${recommendation.id}`}>
            {decision === 'reject' ? 'Why should this not run?' : 'What should the agent change?'}
          </label>
          <textarea
            className="min-h-20 w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] leading-normal text-ink outline-none transition-colors focus:border-line-strong"
            id={`recommendation-note-${recommendation.id}`}
            maxLength={decision === 'reject' ? 500 : 1_000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Tell the agent what to do differently…"
            rows={3}
            value={note}
          />
          <div className="flex flex-wrap gap-2">
            <button
              className="primary"
              disabled={confirming}
              onClick={() => void submitDecision()}
              type="button"
            >
              {decision === 'reject' ? 'Reject proposal' : 'Send guidance'}
            </button>
            <button
              className="secondary"
              disabled={confirming}
              onClick={() => {
                setDecision(undefined)
                setNote('')
                setError(undefined)
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error === undefined ? null : <p className="notice error" role="alert">{error}</p>}
    </>
  )

  if (collapsed) {
    return (
      <details className="group overflow-hidden rounded-xl bg-surface">
        <summary className="cursor-pointer list-none p-4 hover:bg-hover sm:px-5 [&::-webkit-details-marker]:hidden">
          {header}
        </summary>
        <div className="grid gap-4 border-t border-line p-4 sm:p-5">{body}</div>
      </details>
    )
  }

  return (
    <article className="grid gap-4 rounded-xl bg-surface p-4 sm:p-5">
      {header}
      {body}
    </article>
  )
}

function ProvenanceDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] leading-5 text-ink-3">{label}</dt>
      <dd className="m-0 [overflow-wrap:anywhere] font-mono text-[11.5px] leading-5 text-ink-2">{value}</dd>
    </div>
  )
}

function AutonomyEvidence({ recommendationId }: { recommendationId: Recommendation['id'] }) {
  const observationPageSize = 4
  const observations = usePaginatedQuery(
    api.operationsAutonomyRecommendationEvidence.observations,
    { eventSlug, recommendationId },
    { initialNumItems: observationPageSize },
  )
  return (
    <div className="grid gap-3">
      <p className="m-0 text-[12px] font-medium text-ink-2">Evidence used</p>
      {observations.status === 'LoadingFirstPage' ? (
        <p className="m-0 text-[12px] text-ink-3" role="status">Loading supporting observations</p>
      ) : observations.results.length === 0 ? (
        <p className="m-0 text-[12px] text-ink-3">No sealed observation is attached to this proposal.</p>
      ) : null}
      {observations.results.map((observation) => (
        <AutonomyEvidenceObservation
          key={observation.id}
          observation={observation}
          recommendationId={recommendationId}
        />
      ))}
      {observations.status === 'CanLoadMore' ? (
        <button
          className="secondary"
          onClick={() => observations.loadMore(observationPageSize)}
          type="button"
        >
          Load more supporting observations
        </button>
      ) : null}
    </div>
  )
}

type ObservationPage = FunctionReturnType<
  typeof api.operationsAutonomyRecommendationEvidence.observations
>
type Observation = ObservationPage['page'][number]

function AutonomyEvidenceObservation({
  observation,
  recommendationId,
}: {
  observation: Observation
  recommendationId: Recommendation['id']
}) {
  const evidencePageSize = 8
  const evidence = usePaginatedQuery(
    api.operationsAutonomyRecommendationEvidence.page,
    { eventSlug, recommendationId, observationId: observation.id },
    { initialNumItems: evidencePageSize },
  )
  return (
    <section className="grid gap-3 rounded-lg bg-canvas/60 p-3.5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="m-0 text-[13px] leading-snug font-medium text-ink">{observation.statement}</h4>
        </div>
        <time className="shrink-0 text-[11px] text-ink-3" dateTime={new Date(observation.observedAt).toISOString()}>
          {formatCompactDateTime(observation.observedAt)}
        </time>
      </header>
      <p className="m-0 text-[12.5px] leading-5 text-ink-2">{observation.reasoning}</p>
      <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <ProvenanceDatum label="Agent" value={`${observation.agentVersion} · ${observation.model}`} />
        <ProvenanceDatum label="Run" value={observation.runId} />
        <ProvenanceDatum label="Exact citations" value={String(observation.evidenceSet.leafCount)} />
        <ProvenanceDatum label="Evidence root" value={observation.evidenceSet.rootHash} />
      </dl>
      <CitationList citations={evidence.results.map((leaf) => leaf.citation)} />
      {evidence.status === 'CanLoadMore' ? (
        <button
          className="secondary"
          onClick={() => evidence.loadMore(evidencePageSize)}
          type="button"
        >
          Load more exact evidence
        </button>
      ) : null}
    </section>
  )
}

function CitationList({
  citations,
}: {
  citations: Array<IntelligenceRecommendationCitation | OperationsAutonomyRecommendationCitation>
}) {
  if (citations.length === 0) {
    return <p className="m-0 text-[12px] text-ink-3">No citation was recorded.</p>
  }
  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {citations.map((citation) => (
        <li
          className="grid gap-1 rounded-lg border border-line px-3 py-2"
          key={`${citation.read}:${citation.generatedAt}:${citation.keys.join(':')}:${
            'operationId' in citation ? citation.operationId : ''
          }`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <strong className="text-[12px] font-medium text-ink">{citation.read.replaceAll('_', ' ')}</strong>
            <time className="text-[11px] text-ink-3" dateTime={new Date(citation.generatedAt).toISOString()}>
              {formatCompactDateTime(citation.generatedAt)}
            </time>
          </div>
          <code className="[overflow-wrap:anywhere] font-mono text-[11px] leading-4 text-ink-2">
            {citation.keys.join(' · ')}
          </code>
          {'operationId' in citation ? (
            <span className="[overflow-wrap:anywhere] font-mono text-[10.5px] text-ink-3">
              Receipt {citation.operationId} · snapshot {citation.snapshot}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
