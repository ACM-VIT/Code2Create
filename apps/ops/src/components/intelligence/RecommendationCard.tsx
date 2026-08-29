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
import { PendingOperationRecovery } from '../PendingOperationRecovery'

type RecommendationPage = FunctionReturnType<typeof api.intelligenceRecommendations.proposed>
type Recommendation = RecommendationPage['page'][number]
type Decision = 'reject' | 'suggest'

export function RecommendationCard({
  operations,
  recommendation,
  sourceLabel,
}: {
  operations: OperationRunner<{ version: number }>
  recommendation: Recommendation
  sourceLabel?: string
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
  const provenanceLabel = sourceLabel ?? (
    recommendation.provenance.kind === 'autonomy'
      ? 'Autonomous recommendation'
      : 'Copilot recommendation'
  )

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

  return (
    <article className={`card-surface intelligence-recommendation ${recommendation.status}`}>
      <header className="section-heading">
        <div>
          <p className="eyebrow">{provenanceLabel}</p>
          <h4>{recommendation.statement}</h4>
        </div>
        <span className="state-label">
          {recommendationStatusLabel(recommendation.status)}
        </span>
      </header>
      <p className="muted">{kindLabel(recommendation.arguments.kind)}</p>
      <RecommendationCommand arguments={recommendation.arguments} />
      <p>{recommendation.reasoning}</p>
      <dl className="review-progress intelligence-recommendation-evidence">
        <div>
          <dt>Proposed</dt>
          <dd>{formatCompactDateTime(recommendation.proposedAt)}</dd>
        </div>
        <div>
          <dt>Command version</dt>
          <dd>{recommendation.version}</dd>
        </div>
        {recommendation.decidedAt === undefined ? null : (
          <div>
            <dt>Decided</dt>
            <dd>{formatCompactDateTime(recommendation.decidedAt)}</dd>
          </div>
        )}
        <div>
          <dt>Agent</dt>
          <dd>{recommendation.agentVersion} · {recommendation.model}</dd>
        </div>
        <div>
          <dt>{recommendation.provenance.kind === 'autonomy' ? 'Autonomous run' : 'Conversation'}</dt>
          <dd>
            <code>
              {recommendation.provenance.kind === 'autonomy'
                ? recommendation.provenance.runId
                : recommendation.provenance.conversationId}
            </code>
          </dd>
        </div>
      </dl>
      {recommendation.executedTargetType === undefined ? null : (
        <p className="notice">
          Executed {recommendation.executedTargetType.replaceAll('_', ' ')}{' '}
          <code>{recommendation.executedTargetId}</code>
        </p>
      )}
      {recommendation.provenance.kind === 'autonomy' ? (
        <AutonomyEvidence recommendationId={recommendation.id} />
      ) : (
        <CitationList citations={recommendation.provenance.citations} />
      )}

      {recommendation.operatorNote === undefined ? null : (
        <p className="notice">{recommendation.operatorNote}</p>
      )}

      {pendingSlot !== undefined ? (
        <PendingOperationRecovery
          action={pendingSlot === approveSlot
            ? 'Confirm approval'
            : pendingSlot === rejectSlot
              ? 'Confirm rejection'
              : 'Confirm guidance'}
          busy={confirming}
          onConfirm={() => void confirmPendingDecision()}
          title="Confirm the earlier decision"
        />
      ) : recommendation.status === 'proposed' ? (
        <div className="button-row">
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
            Suggest change
          </button>
        </div>
      ) : null}

      {recommendation.status === 'proposed' && decision !== undefined && !hasPending ? (
        <div className="command-form intelligence-recommendation-feedback">
          <label className="field" htmlFor={`recommendation-note-${recommendation.id}`}>
            <span>
              {decision === 'reject' ? 'Why should this not run?' : 'What should the agent change?'}
            </span>
            <textarea
              id={`recommendation-note-${recommendation.id}`}
              maxLength={decision === 'reject' ? 500 : 1_000}
              onChange={(event) => setNote(event.target.value)}
              readOnly={hasPending}
              rows={3}
              value={note}
            />
          </label>
          <div className="button-row">
            <button
              className="primary"
              disabled={confirming}
              onClick={() => void submitDecision()}
              type="button"
            >
              {decision === 'reject' ? 'Reject' : 'Send guidance'}
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
    </article>
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
    <div className="intelligence-recommendation-citations">
      <p className="board-section-label">Evidence used</p>
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
    <section>
      <header className="section-heading">
        <div>
          <p className="eyebrow">Autonomous observation</p>
          <h5>{observation.statement}</h5>
        </div>
        <time dateTime={new Date(observation.observedAt).toISOString()}>
          {formatCompactDateTime(observation.observedAt)}
        </time>
      </header>
      <p>{observation.reasoning}</p>
      <dl className="review-progress intelligence-recommendation-evidence">
        <div>
          <dt>Agent</dt>
          <dd>{observation.agentVersion} · {observation.model}</dd>
        </div>
        <div>
          <dt>Run</dt>
          <dd><code>{observation.runId}</code></dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>{observation.evidenceSet.leafCount} exact citations</dd>
        </div>
        <div>
          <dt>Root</dt>
          <dd><code>{observation.evidenceSet.rootHash}</code></dd>
        </div>
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
  return (
    <ul className="review-list">
      {citations.map((citation) => (
        <li
          key={`${citation.read}:${citation.generatedAt}:${citation.keys.join(':')}:${
            'operationId' in citation ? citation.operationId : ''
          }`}
        >
          <div>
            <strong>{readLabel(citation.read)}</strong>
            <time dateTime={new Date(citation.generatedAt).toISOString()}>
              {formatCompactDateTime(citation.generatedAt)}
            </time>
          </div>
          <p><code>{citation.keys.join(' · ')}</code></p>
          {'operationId' in citation ? (
            <p>
              Receipt <code>{citation.operationId}</code> · snapshot{' '}
              <code>{citation.snapshot}</code>
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function RecommendationCommand({
  arguments: command,
}: {
  arguments: Recommendation['arguments']
}) {
  if (command.kind === 'hold_review_team') {
    return (
      <dl className="criteria-list intelligence-recommendation-command">
        <CommandField label="Target team-round state" value={command.teamRoundStateId} code />
        <CommandField label="Expected target version" value={command.expectedTeamRoundStateVersion} />
        <CommandField label="Reason" value={command.reason} />
      </dl>
    )
  }
  if (command.kind === 'page_reserve_reviewer') {
    return (
      <dl className="criteria-list intelligence-recommendation-command">
        <CommandField label="Vacant panel seat" value={command.missingPanelMemberId} code />
        <CommandField label="Expected panel version" value={command.expectedPanelVersion} />
        <CommandField label="Reason" value={command.reason} />
      </dl>
    )
  }
  if (command.kind === 'open_support_case') {
    return (
      <dl className="criteria-list intelligence-recommendation-command">
        <CommandField label="Category" value={command.category.replaceAll('_', ' ')} />
        <CommandField label="Description" value={command.description} />
        {command.roundId === undefined ? null : (
          <CommandField label="Linked round" value={command.roundId} code />
        )}
        {command.teamId === undefined ? null : (
          <CommandField label="Linked team" value={command.teamId} code />
        )}
      </dl>
    )
  }
  if (command.kind === 'set_admission_minimum_human_reviews') {
    return (
      <dl className="criteria-list intelligence-recommendation-command">
        <CommandField label="New review minimum" value={command.minimumHumanReviews} />
        <CommandField label="Expected event version" value={command.expectedEventVersion} />
        <CommandField label="Base admission policy" value={command.expectedBasePolicyId} code />
        <CommandField label="New release" value={command.releaseVersion} />
        <CommandField label="Reason" value={command.reason} />
      </dl>
    )
  }
  return (
    <dl className="criteria-list intelligence-recommendation-command">
      <CommandField label="Attention item" value={command.itemId} code />
      <CommandField label="Expected item version" value={command.expectedItemVersion} />
      <CommandField label="Reason" value={command.reason} />
    </dl>
  )
}

function CommandField({
  code = false,
  label,
  value,
}: {
  code?: boolean
  label: string
  value: number | string
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{code ? <code>{value}</code> : value}</dd>
    </div>
  )
}

function kindLabel(kind: Recommendation['arguments']['kind']) {
  if (kind === 'hold_review_team') return 'Hold a review team'
  if (kind === 'page_reserve_reviewer') return 'Page a reserve reviewer'
  if (kind === 'open_support_case') return 'Open a support case'
  if (kind === 'set_admission_minimum_human_reviews') {
    return 'Change the admission human-review minimum'
  }
  return 'Dismiss an attention item'
}

function recommendationStatusLabel(status: Recommendation['status']) {
  if (status === 'proposed') return 'Needs decision'
  if (status === 'approved') return 'Executed'
  if (status === 'rejected') return 'Rejected'
  return 'Revision requested'
}

function readLabel(read: string) {
  return read.replaceAll('_', ' ')
}
