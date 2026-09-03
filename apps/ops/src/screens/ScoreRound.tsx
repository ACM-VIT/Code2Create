import { api } from '@code2create/backend/api'
import {
  reviewEvaluationStateLabels,
  reviewRoundStatusLabels,
  reviewSessionStatusLabels,
  roundExportStateLabels,
  scorecardCorrectionCategoryLabels,
  scorecardCorrectionKindLabels,
  scorecardCorrectionStateLabels,
  scorecardStatusLabels,
} from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { eventSlug } from '../lib/config'
import { formatMonthDayTime as formatTime } from '../lib/dateTime'
import { readableError } from '../lib/errors'
import { useMutationAttempt } from '../lib/operations'
import { useEstimatedServerNow } from '../lib/useEstimatedServerNow'
import { LoadingLabel, SkeletonList, SkeletonStats } from '../components/Skeleton'
import { RoundExportControl } from '../components/RoundExportControl'

type Completeness = FunctionReturnType<typeof api.scoreGovernance.completeness>
type Review = FunctionReturnType<typeof api.scoreGovernance.completenessReviews>['page'][number]
type Scorecard = Review['scorecards'][number]
type CorrectionCase = NonNullable<Scorecard['currentCase']>
type ValueReview = FunctionReturnType<typeof api.scoreGovernance.roundValues>['page'][number]
type ValueCriteria = FunctionReturnType<typeof api.scoreGovernance.roundValueCriteria>
type ReviewView = 'needs_action' | 'settled' | 'all'

const scoreGovernancePageSize = 20

export function ScoreRound() {
  const { roundId } = useParams<{ roundId: string }>()
  const rounds = useQuery(api.scoreGovernance.rounds, { eventSlug })
  const visibleRound = rounds?.find((round) => round.id === roundId)
  const completeness = useQuery(
    api.scoreGovernance.completeness,
    visibleRound ? { eventSlug, roundId: visibleRound.id } : 'skip',
  )
  const reviews = usePaginatedQuery(
    api.scoreGovernance.completenessReviews,
    visibleRound ? { eventSlug, roundId: visibleRound.id } : 'skip',
    { initialNumItems: scoreGovernancePageSize },
  )
  const [showValues, setShowValues] = useState(false)
  const [reviewView, setReviewView] = useState<ReviewView>('needs_action')
  const estimatedServerNow = useEstimatedServerNow(completeness?.serverNow)
  const valueCriteria = useQuery(
    api.scoreGovernance.roundValueCriteria,
    visibleRound && completeness?.canReadValues && showValues
      ? { eventSlug, roundId: visibleRound.id }
      : 'skip',
  )
  const values = usePaginatedQuery(
    api.scoreGovernance.roundValues,
    visibleRound && completeness?.canReadValues && showValues
      ? { eventSlug, roundId: visibleRound.id }
      : 'skip',
    { initialNumItems: scoreGovernancePageSize },
  )

  if (!roundId) return <p className="notice error">Round ID is missing.</p>
  if (
    rounds === undefined ||
    (visibleRound && (
      completeness === undefined ||
      reviews.status === 'LoadingFirstPage'
    ))
  ) {
    return (
      <section className="review-shell">
        <LoadingLabel>Loading this round’s results</LoadingLabel>
        <SkeletonStats columns={4} />
        <SkeletonList rows={5} />
      </section>
    )
  }
  if (!visibleRound) {
    return <p className="notice error">This results round is not visible to you.</p>
  }
  if (!completeness) {
    return (
      <section className="review-shell">
        <LoadingLabel>Loading this round’s results</LoadingLabel>
        <SkeletonStats columns={4} />
        <SkeletonList rows={5} />
      </section>
    )
  }

  const ordered = [...reviews.results].sort(
    (left, right) => reviewRank(left) - reviewRank(right) || left.teamName.localeCompare(right.teamName),
  )
  const needsActionCount = ordered.filter(reviewNeedsAction).length
  const settledCount = ordered.length - needsActionCount
  const visibleReviews = ordered.filter((review) => {
    if (reviewView === 'needs_action') return reviewNeedsAction(review)
    if (reviewView === 'settled') return !reviewNeedsAction(review)
    return true
  })
  const correctionRequestsOpen =
    completeness.round.status === 'open' &&
    estimatedServerNow <= completeness.round.correctionRequestsCloseAt

  return (
    <section className="review-shell">
      <Link className="back-link" to="/scores">← Results</Link>
      <header className="page-heading">
        <div>
          <p className="eyebrow">{reviewRoundStatusLabels[completeness.round.status]}</p>
          <h1>{completeness.round.name}</h1>
          <p className="muted">
            {completeness.unresolvedTeamCount === 0
              ? 'Every team in this round has a countable result.'
              : `${completeness.unresolvedTeamCount} ${completeness.unresolvedTeamCount === 1 ? 'team has' : 'teams have'} no countable result, so this round cannot close.`}
            {' '}Correction requests close {formatTime(completeness.round.correctionRequestsCloseAt)}.
          </p>
        </div>
        {completeness.canReadValues ? (
          <button className="secondary" type="button" onClick={() => setShowValues((current) => !current)}>
            {showValues ? 'Hide numeric values' : 'Open numeric values'}
          </button>
        ) : null}
      </header>

      <dl className="score-summary-grid governance-summary">
        <Summary
          label="Sessions loaded"
          value={`${reviews.results.length}${reviews.status === 'CanLoadMore' ? '+' : ''}`}
        />
        <Summary label="Teams with no result" value={completeness.unresolvedTeamCount} />
        <Summary label="Paper sheets to enter" value={completeness.pendingManualReviewCount} />
        <Summary label="Corrections to decide" value={completeness.unresolvedCorrectionCount} />
        <Summary
          label="Round export"
          value={completeness.exportState ? roundExportStateLabels[completeness.exportState] : 'Not started'}
        />
      </dl>

      {showValues ? (
        valueCriteria === undefined || values.status === 'LoadingFirstPage' ? (
          <>
            <LoadingLabel>Opening the scores</LoadingLabel>
            <SkeletonList rows={4} />
          </>
        ) : (
          <>
            <NumericValues criteria={valueCriteria} reviews={values.results} />
            {values.status === 'CanLoadMore' || values.status === 'LoadingMore' ? (
              <button
                className="secondary"
                type="button"
                disabled={values.status === 'LoadingMore'}
                onClick={() => values.loadMore(scoreGovernancePageSize)}
              >
                {values.status === 'LoadingMore' ? 'Loading values…' : 'Load more numeric values'}
              </button>
            ) : null}
          </>
        )
      ) : null}

      <section className="score-team-workspace">
        <div className="section-heading score-team-workspace-heading">
          <div>
            <h2>Team results</h2>
            <p className="muted">Start with missing scores, disagreements, and correction requests.</p>
          </div>
          <div className="configuration-tabs score-team-tabs" role="group" aria-label="Team result view">
            <button
              aria-pressed={reviewView === 'needs_action'}
              className={reviewView === 'needs_action' ? 'active' : ''}
              type="button"
              onClick={() => setReviewView('needs_action')}
            >Needs action · {needsActionCount}</button>
            <button
              aria-pressed={reviewView === 'settled'}
              className={reviewView === 'settled' ? 'active' : ''}
              type="button"
              onClick={() => setReviewView('settled')}
            >Settled · {settledCount}</button>
            <button
              aria-pressed={reviewView === 'all'}
              className={reviewView === 'all' ? 'active' : ''}
              type="button"
              onClick={() => setReviewView('all')}
            >All · {ordered.length}</button>
          </div>
        </div>
        <div className="score-review-list">
        {visibleReviews.map((review) => (
          <ReviewCompleteness
            criteria={completeness.criteria}
            key={review.id}
            review={review}
            correctionRequestsOpen={correctionRequestsOpen}
            roundStatus={completeness.round.status}
          />
        ))}
        </div>
        {visibleReviews.length === 0 && ordered.length > 0 ? (
          <p className="empty">No team matches this result view.</p>
        ) : null}
      </section>

      {reviews.status === 'CanLoadMore' || reviews.status === 'LoadingMore' ? (
        <button
          className="secondary"
          type="button"
          disabled={reviews.status === 'LoadingMore'}
          onClick={() => reviews.loadMore(scoreGovernancePageSize)}
        >
          {reviews.status === 'LoadingMore' ? 'Loading sessions…' : 'Load more review sessions'}
        </button>
      ) : null}

      {reviews.results.length === 0 ? (
        <p className="empty">
          No panel has been given a team to judge in this round.
        </p>
      ) : null}

      <RoundExportControl roundId={completeness.round.id} />
      {completeness.canRelease && completeness.round.status === 'closed' && !completeness.releasedAt ? (
        <ReleaseRound completeness={completeness} />
      ) : null}
      {completeness.releasedAt ? (
        <p className="notice">Participant feedback was released {formatTime(completeness.releasedAt)}.</p>
      ) : null}
    </section>
  )
}

function ReviewCompleteness({
  review,
  criteria,
  correctionRequestsOpen,
  roundStatus,
}: {
  review: Review
  criteria: Completeness['criteria']
  correctionRequestsOpen: boolean
  roundStatus: Completeness['round']['status']
}) {
  const short = review.coverage.filter(
    (coverage) => coverage.submittedCount < coverage.requiredCount,
  )
  const disagreeing = review.coverage.filter((coverage) => coverage.spreadFlag)
  const scorecards = [...review.scorecards].sort(
    (left, right) => Number(left.status !== 'draft') - Number(right.status !== 'draft'),
  )
  const hasDecision = scorecards.some(
    (scorecard) => scorecard.currentCase?.state === 'requested' && scorecard.canDecideCorrection,
  )
  const [open, setOpen] = useState(hasDecision)
  const resultLabel = review.evaluationState
    ? reviewEvaluationStateLabels[review.evaluationState]
    : 'No result yet'
  const shortfall = short.length === 0
    ? disagreeing.length > 0
      ? `Reviewers are far apart on ${listNames(disagreeing.map((coverage) => criterionLabel(criteria, coverage.criterionId)))}.`
      : 'Every criterion has the scores it needs.'
    : `${listNames(short.map((coverage) => criterionLabel(criteria, coverage.criterionId)))} ${short.length === 1 ? 'is' : 'are'} short of the ${short[0]?.requiredCount ?? 0} scores needed.`
  return (
    <article className="score-review-row">
      <button
        aria-expanded={open}
        className="score-review-summary"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="score-review-summary-copy">
          <strong>{review.teamName}</strong>
          <small>
            {review.panelName} · {reviewSessionStatusLabels[review.status]} · {resultLabel}
            {review.manualReviewRecordId ? ' · entered from paper' : ''}
          </small>
          <span className={reviewNeedsAction(review) ? 'needs-attention' : ''}>{shortfall}</span>
        </span>
        <span className="panel-row-chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>

      {open ? <div className="score-review-body">
      <div className="coverage-strip">
        {review.coverage.map((coverage) => (
          <span className={coverage.submittedCount < coverage.requiredCount ? 'needs-attention' : ''} key={coverage.criterionId}>
            {criterionLabel(criteria, coverage.criterionId)} · {coverage.submittedCount} of {coverage.requiredCount}
            {coverage.spreadFlag ? ' · far apart' : ''}
          </span>
        ))}
      </div>

      <div className="scorecard-list">
        {scorecards.map((scorecard) => (
          <div className="scorecard-row" key={scorecard.id}>
            <div>
              <strong>{scorecard.reviewerName}</strong>
              <span>
                {scorecardStatusLabels[scorecard.status]}
                {scorecard.submittedAt ? ` · ${formatTime(scorecard.submittedAt)}` : ''}
              </span>
            </div>
            <div className="scorecard-actions">
              {scorecard.currentCase?.state === 'requested' && scorecard.canDecideCorrection ? (
                <CorrectionDecision
                  canOpen={scorecard.canOpenCorrection}
                  correctionRequestsOpen={correctionRequestsOpen}
                  correctionCase={scorecard.currentCase}
                  scorecard={scorecard}
                />
              ) : null}
              {scorecard.status === 'submitted' && scorecard.canVoid && !scorecard.currentCase && roundStatus === 'open' ? (
                <VoidScorecard scorecard={scorecard} />
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {review.cases.length > 0 ? (
        <details className="case-history">
          <summary>
            {review.cases.length === 1
              ? 'One scorecard was corrected or voided'
              : `${review.cases.length} scorecards were corrected or voided`}
          </summary>
          <ul>
            {review.cases.map((entry) => (
              <li key={entry.id}>
                <strong>
                  {scorecardCorrectionKindLabels[entry.kind]} · {scorecardCorrectionStateLabels[entry.state]}
                </strong>
                <span>{scorecardCorrectionCategoryLabels[entry.category]} · {entry.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      </div> : null}
    </article>
  )
}

function CorrectionDecision({
  canOpen,
  correctionRequestsOpen,
  correctionCase,
  scorecard,
}: {
  canOpen: boolean
  correctionRequestsOpen: boolean
  correctionCase: CorrectionCase
  scorecard: Scorecard
}) {
  const decideCorrection = useMutation(api.scoreGovernance.decideCorrection)
  const [open, setOpen] = useState(false)
  const openDecisionAvailable = canOpen && correctionRequestsOpen
  const [decision, setDecision] = useState<'open' | 'reject'>(openDecisionAvailable ? 'open' : 'reject')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationAttempt = useMutationAttempt<FunctionReturnType<typeof api.scoreGovernance.decideCorrection>>()
  const operationSlot = `score-correction-decision:${correctionCase.id}`
  const operationPending = operationAttempt.hasPending(operationSlot)
  const effectiveDecision = openDecisionAvailable ? decision : 'reject'

  const submit = async () => {
    if (busy || reason.trim().length < 5) return
    setBusy(true)
    setError(null)
    try {
      await operationAttempt.run(operationSlot, () => {
        const args = {
          eventSlug,
          correctionCaseId: correctionCase.id,
          expectedCaseVersion: correctionCase.version,
          expectedScorecardVersion: scorecard.version,
          decision: effectiveDecision,
          reason,
          clientOperationId: crypto.randomUUID(),
        }
        return () => decideCorrection(args)
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return <button className="secondary compact-link" type="button" onClick={() => setOpen(true)}>Review request</button>
  }
  return (
    <div className="score-command">
      <p>{correctionCase.reason}</p>
      <label className="field">
        <span>Decision</span>
        <select
          disabled={busy || operationPending}
          value={effectiveDecision}
          onChange={(event) => {
            setDecision(event.target.value === 'reject' ? 'reject' : 'open')
            setError(null)
          }}
        >
          {openDecisionAvailable ? <option value="open">Open correction</option> : null}
          <option value="reject">Decline request</option>
        </select>
      </label>
      <label className="field">
        <span>Reason</span>
        <textarea
          disabled={busy || operationPending}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value)
            setError(null)
          }}
        />
      </label>
      <div className="button-row">
        <button className="primary" disabled={busy || reason.trim().length < 5} type="button" onClick={() => void submit()}>
          {busy ? 'Saving…' : operationPending ? 'Confirm earlier decision' : effectiveDecision === 'open' ? 'Open correction' : 'Decline'}
        </button>
        <button className="secondary" disabled={busy || operationPending} type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  )
}

function VoidScorecard({ scorecard }: { scorecard: Scorecard }) {
  const voidScorecard = useMutation(api.scoreGovernance.voidScorecard)
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<'wrong_team' | 'duplicate_review' | 'confirmed_conflict' | 'judge_ineligible' | 'technical_error' | 'other'>('technical_error')
  const [disposition, setDisposition] = useState<'exclude' | 'replacement_review'>('replacement_review')
  const [evidenceReference, setEvidenceReference] = useState('')
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationAttempt = useMutationAttempt<FunctionReturnType<typeof api.scoreGovernance.voidScorecard>>()
  const operationSlot = `scorecard-void:${scorecard.id}`
  const operationPending = operationAttempt.hasPending(operationSlot)

  const changed = () => setError(null)

  const submit = async () => {
    if (busy || !confirmed || evidenceReference.trim().length < 3 || reason.trim().length < 5) return
    setBusy(true)
    setError(null)
    try {
      await operationAttempt.run(operationSlot, () => {
        const args = {
          eventSlug,
          scorecardId: scorecard.id,
          expectedScorecardVersion: scorecard.version,
          category,
          disposition,
          evidenceReference,
          reason,
          clientOperationId: crypto.randomUUID(),
        }
        return () => voidScorecard(args)
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return <button className="text-button" type="button" onClick={() => setOpen(true)}>Void</button>
  }
  return (
    <div className="score-command destructive-command">
      <p>Voiding throws out this review’s result.</p>
      <div className="form-grid">
        <label className="field">
          <span>Category</span>
          <select
            disabled={busy || operationPending}
            value={category}
            onChange={(event) => {
              const value = event.target.value
              if (
                value === 'wrong_team' ||
                value === 'duplicate_review' ||
                value === 'confirmed_conflict' ||
                value === 'judge_ineligible' ||
                value === 'technical_error' ||
                value === 'other'
              ) setCategory(value)
              changed()
            }}
          >
            <option value="technical_error">Technical error</option>
            <option value="wrong_team">Wrong team</option>
            <option value="duplicate_review">Duplicate review</option>
            <option value="confirmed_conflict">Confirmed conflict</option>
            <option value="judge_ineligible">Reviewer not allowed</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="field">
          <span>Outcome</span>
          <select
            disabled={busy || operationPending}
            value={disposition}
            onChange={(event) => {
              setDisposition(event.target.value === 'exclude' ? 'exclude' : 'replacement_review')
              changed()
            }}
          >
            <option value="replacement_review">Replacement review required</option>
            <option value="exclude">Exclude this review from the round</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>Where the evidence is</span>
        <input disabled={busy || operationPending} value={evidenceReference} onChange={(event) => { setEvidenceReference(event.target.value); changed() }} />
      </label>
      <label className="field">
        <span>Reason</span>
        <textarea disabled={busy || operationPending} value={reason} onChange={(event) => { setReason(event.target.value); changed() }} />
      </label>
      <label className="check-filter">
        <input
          checked={confirmed}
          disabled={busy || operationPending}
          type="checkbox"
          onChange={(event) => {
            setConfirmed(event.target.checked)
            changed()
          }}
        />
        I confirm the evidence and replacement decision are correct.
      </label>
      <div className="button-row">
        <button
          className="primary"
          disabled={busy || !confirmed || evidenceReference.trim().length < 3 || reason.trim().length < 5}
          type="button"
          onClick={() => void submit()}
        >
          {busy ? 'Voiding…' : operationPending ? 'Confirm earlier void' : 'Void scorecard'}
        </button>
        <button className="secondary" disabled={busy || operationPending} type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  )
}

function ReleaseRound({ completeness }: { completeness: Completeness }) {
  const publishRelease = useMutation(api.scoreGovernance.publishRelease)
  const [policyVersion, setPolicyVersion] = useState('')
  const [criterionScores, setCriterionScores] = useState(false)
  const [totalScore, setTotalScore] = useState(false)
  const [sharedFindings, setSharedFindings] = useState(false)
  const [sharedCommitments, setSharedCommitments] = useState(false)
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationAttempt = useMutationAttempt<FunctionReturnType<typeof api.scoreGovernance.publishRelease>>()
  const operationSlot = `score-release:${completeness.round.id}`
  const operationPending = operationAttempt.hasPending(operationSlot)
  const hasContent = criterionScores || totalScore || sharedFindings || sharedCommitments

  const changed = () => {
    setError(null)
  }

  const submit = async () => {
    if (busy || !confirmed || !hasContent || policyVersion.trim().length < 3 || reason.trim().length < 5) return
    setBusy(true)
    setError(null)
    try {
      await operationAttempt.run(operationSlot, () => {
        const args = {
          eventSlug,
          roundId: completeness.round.id,
          expectedRoundVersion: completeness.round.version,
          policyVersion,
          includeCriterionScores: criterionScores,
          includeTotalScore: totalScore,
          includeSharedFindings: sharedFindings,
          includeSharedCommitments: sharedCommitments,
          reason,
          clientOperationId: crypto.randomUUID(),
        }
        return () => publishRelease(args)
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="score-final-command score-command release-command">
      <h2>Release participant feedback</h2>
      <p>The release cannot be undone.</p>
      <label className="field">
        <span>Feedback rules name</span>
        <input disabled={busy || operationPending} value={policyVersion} onChange={(event) => { setPolicyVersion(event.target.value); changed() }} />
      </label>
      <div className="release-fields">
        <Check label="Criterion scores" checked={criterionScores} disabled={busy || operationPending} onChange={(value) => { setCriterionScores(value); changed() }} />
        <Check label="Total score" checked={totalScore} disabled={busy || operationPending} onChange={(value) => { setTotalScore(value); changed() }} />
        <Check label="Shared findings" checked={sharedFindings} disabled={busy || operationPending} onChange={(value) => { setSharedFindings(value); changed() }} />
        <Check label="What the team committed to next" checked={sharedCommitments} disabled={busy || operationPending} onChange={(value) => { setSharedCommitments(value); changed() }} />
      </div>
      <label className="field">
        <span>Why it’s being released</span>
        <textarea disabled={busy || operationPending} value={reason} onChange={(event) => { setReason(event.target.value); changed() }} />
      </label>
      <label className="check-filter">
        <input checked={confirmed} disabled={busy || operationPending} type="checkbox" onChange={(event) => { setConfirmed(event.target.checked); changed() }} />
        I confirm these are the fields the published feedback rules allow.
      </label>
      <button
        className="primary"
        disabled={busy || !confirmed || !hasContent || policyVersion.trim().length < 3 || reason.trim().length < 5}
        type="button"
        onClick={() => void submit()}
      >
        {busy ? 'Publishing…' : operationPending ? 'Confirm earlier release' : 'Publish feedback'}
      </button>
      {error ? <p className="notice error">{error}</p> : null}
    </section>
  )
}

function NumericValues({
  criteria,
  reviews,
}: {
  criteria: ValueCriteria
  reviews: ValueReview[]
}) {
  const ordered = [...reviews].sort((left, right) => left.teamName.localeCompare(right.teamName))
  return (
    <section className="numeric-values">
      <div className="section-heading">
        <div>
          <h2>Scores</h2>
          <p className="muted">Alphabetical by team.</p>
        </div>
      </div>
      {ordered.map((review) => (
        <details key={review.reviewSessionId}>
          <summary>
            <span>{review.teamName}</span>
            <strong>
              {review.evaluation?.state === 'complete'
                ? formatScore(review.evaluation.totalPoints)
                : review.evaluation
                  ? reviewEvaluationStateLabels[review.evaluation.state]
                  : 'No result'}
            </strong>
          </summary>
          {review.evaluation?.state === 'complete' ? (
            <dl className="numeric-criteria">
              {review.evaluation.criterionResults.map((result) => {
                const criterion = criteria.find((candidate) => candidate.id === result.criterionId)
                return (
                  <div key={result.criterionId}>
                    <dt>{criterion?.label ?? 'Criterion'}{result.spreadFlag ? ' · reviewers far apart' : ''}</dt>
                    <dd>{formatScore(result.meanScore)} average · {formatScore(result.weightedPoints)} weighted</dd>
                  </div>
                )
              })}
            </dl>
          ) : null}
          <div className="raw-scorecards">
            {review.scorecards.map((scorecard) => (
              <div key={`${review.reviewSessionId}-${scorecard.reviewerName}-${scorecard.version}`}>
                <strong>
                  {scorecard.reviewerName} · submission {scorecard.version}
                  {scorecard.manualReviewRecordId ? ' · entered from paper' : ''}
                </strong>
                {scorecard.ratings.map((rating) => {
                  const criterion = criteria.find((candidate) => candidate.id === rating.criterionId)
                  return (
                    <p key={rating.criterionId}>
                      {criterion?.label ?? 'Criterion'}: {rating.score}
                      {rating.evidenceNote ? ` · ${rating.evidenceNote}` : ''}
                    </p>
                  )
                })}
              </div>
            ))}
          </div>
        </details>
      ))}
      {reviews.length === 0 ? <p className="empty">No completed review has scores yet.</p> : null}
    </section>
  )
}

function Check({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="check-filter">
      <input checked={checked} disabled={disabled} type="checkbox" onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  )
}

function Summary({ label, value }: { label: string; value: number | string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function reviewRank(review: Review) {
  if (review.evaluationState !== 'complete') return 0
  if (review.cases.some((entry) => entry.state === 'requested' || entry.state === 'open')) return 1
  return 2
}

function reviewNeedsAction(review: Review) {
  return review.evaluationState !== 'complete' ||
    review.coverage.some(
      (coverage) => coverage.submittedCount < coverage.requiredCount || coverage.spreadFlag,
    ) ||
    review.cases.some((entry) => entry.state === 'requested' || entry.state === 'open')
}

function criterionLabel(criteria: Completeness['criteria'], criterionId: string) {
  return criteria.find((candidate) => candidate.id === criterionId)?.label ?? 'A criterion'
}

function listNames(values: string[]) {
  if (values.length <= 1) return values[0] ?? 'Nothing'
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`
}

function formatScore(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
}
