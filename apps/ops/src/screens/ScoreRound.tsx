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
import { useMutation, useQuery } from 'convex/react'
import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { LoadingLabel, SkeletonList, SkeletonStats } from '../components/Skeleton'
import { RoundExportControl } from '../components/RoundExportControl'

type Completeness = FunctionReturnType<typeof api.scoreGovernance.completeness>
type Review = Completeness['reviews'][number]
type Scorecard = Review['scorecards'][number]
type CorrectionCase = NonNullable<Scorecard['currentCase']>
type Values = FunctionReturnType<typeof api.scoreGovernance.roundValues>

export function ScoreRound() {
  const { roundId } = useParams<{ roundId: string }>()
  const rounds = useQuery(api.scoreGovernance.rounds, { eventSlug })
  const visibleRound = rounds?.find((round) => round.id === roundId)
  const completeness = useQuery(
    api.scoreGovernance.completeness,
    visibleRound ? { eventSlug, roundId: visibleRound.id } : 'skip',
  )
  const [showValues, setShowValues] = useState(false)
  const values = useQuery(
    api.scoreGovernance.roundValues,
    visibleRound && completeness?.canReadValues && showValues
      ? { eventSlug, roundId: visibleRound.id }
      : 'skip',
  )

  if (!roundId) return <p className="notice error">Round ID is missing.</p>
  if (rounds === undefined || (visibleRound && completeness === undefined)) {
    return (
      <section className="review-shell">
        <LoadingLabel>Loading this round’s results</LoadingLabel>
        <SkeletonStats columns={4} />
        <SkeletonList rows={5} />
      </section>
    )
  }
  if (!visibleRound) {
    return <p className="notice error">This results round is not visible to this account.</p>
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

  const openCorrections = completeness.reviews.reduce(
    (total, review) => total + review.cases.filter(
      (entry) => entry.state === 'requested' || entry.state === 'open',
    ).length,
    0,
  )
  // Teams whose result cannot be counted yet come first; settled ones sink. A
  // round is read to find what is still missing, not to admire what is done.
  const ordered = [...completeness.reviews].sort(
    (left, right) => reviewRank(left) - reviewRank(right) || left.teamName.localeCompare(right.teamName),
  )
  const blocked = ordered.filter((review) => reviewRank(review) === 0)
  // unresolvedTeamCount counts every team in the round without a countable
  // result, including teams no panel ever sat down with. Those never appear in
  // `reviews`, so the difference is the number nobody has judged at all.
  const unjudged = Math.max(0, completeness.unresolvedTeamCount - blocked.length)

  return (
    <section className="review-shell">
      <Link className="back-link" to="/scores">← Results</Link>
      <header className="page-heading">
        <div>
          <p className="eyebrow">{reviewRoundStatusLabels[completeness.round.status]}</p>
          <h1>{completeness.round.name}</h1>
          <p className="muted">
            {completeness.unresolvedTeamCount === 0
              ? 'Every team in this round has a countable result. Submitted scores are never overwritten; a correction keeps the original.'
              : `${completeness.unresolvedTeamCount} ${completeness.unresolvedTeamCount === 1 ? 'team has' : 'teams have'} no countable result, so this round cannot close.` +
                (blocked.length > 0
                  ? ` ${blocked.length} ${blocked.length === 1 ? 'is' : 'are'} short of scores and listed first below.`
                  : '') +
                (unjudged > 0
                  ? ` ${unjudged} ${unjudged === 1 ? 'has' : 'have'} no review session at all — no panel has sat down with ${unjudged === 1 ? 'it' : 'them'}.`
                  : '')}
          </p>
        </div>
        {completeness.canReadValues ? (
          <button className="secondary" type="button" onClick={() => setShowValues((current) => !current)}>
            {showValues ? 'Hide numeric values' : 'Open numeric values'}
          </button>
        ) : null}
      </header>

      <dl className="score-summary-grid governance-summary">
        <Summary label="Teams with a session" value={completeness.reviews.length} />
        <Summary label="Teams with no result" value={completeness.unresolvedTeamCount} />
        <Summary label="Paper sheets to enter" value={completeness.pendingManualReviewCount} />
        <Summary label="Corrections to decide" value={openCorrections} />
        <Summary
          label="Round export"
          value={completeness.exportState ? roundExportStateLabels[completeness.exportState] : 'Not started'}
        />
      </dl>

      {showValues ? (
        values === undefined ? (
          <>
            <LoadingLabel>Opening the numeric values</LoadingLabel>
            <SkeletonList rows={4} />
          </>
        ) : <NumericValues values={values} />
      ) : null}

      <div className="score-review-list">
        {ordered.map((review) => (
          <ReviewCompleteness
            criteria={completeness.criteria}
            key={review.id}
            review={review}
            roundStatus={completeness.round.status}
          />
        ))}
      </div>

      {completeness.reviews.length === 0 ? (
        <p className="empty">
          No panel has been given a team to judge in this round, so there is nothing to score yet.
          Set the round up under Review rounds before it opens.
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
  roundStatus,
}: {
  review: Review
  criteria: Completeness['criteria']
  roundStatus: Completeness['round']['status']
}) {
  const short = review.coverage.filter(
    (coverage) => coverage.submittedCount < coverage.requiredCount,
  )
  const disagreeing = review.coverage.filter((coverage) => coverage.spreadFlag)
  // Reviewers who have not submitted come first: they are the reason the
  // result is missing, and the finished cards are only here as evidence.
  const scorecards = [...review.scorecards].sort(
    (left, right) => Number(left.status !== 'draft') - Number(right.status !== 'draft'),
  )
  return (
    <article className="score-review-row">
      <div className="review-team-heading">
        <div>
          <strong>{review.teamName}</strong>
          <span>{review.panelName} · {review.tableLabel}</span>
        </div>
        <div className="review-team-state">
          <strong>{reviewSessionStatusLabels[review.status]}</strong>
          <span>
            {review.evaluationState
              ? reviewEvaluationStateLabels[review.evaluationState]
              : 'No result yet'}
            {review.manualReviewRecordId ? ' · entered from paper' : ''}
          </span>
        </div>
      </div>

      <p className="review-team-shortfall">
        {short.length === 0
          ? disagreeing.length > 0
            ? `Fully scored, but the reviewers are far apart on ${listNames(disagreeing.map((coverage) => criterionLabel(criteria, coverage.criterionId)))}. Check before the round closes.`
            : 'Every criterion has the scores it needs.'
          : `${listNames(short.map((coverage) => criterionLabel(criteria, coverage.criterionId)))} ${short.length === 1 ? 'is' : 'are'} short of the ${short[0]?.requiredCount ?? 0} scores needed. This team gets no result until they are in.`}
      </p>

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
              {scorecard.currentCase?.state === 'requested' && scorecard.canOpenCorrection ? (
                <CorrectionDecision correctionCase={scorecard.currentCase} scorecard={scorecard} />
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
    </article>
  )
}

function CorrectionDecision({
  correctionCase,
  scorecard,
}: {
  correctionCase: CorrectionCase
  scorecard: Scorecard
}) {
  const decideCorrection = useMutation(api.scoreGovernance.decideCorrection)
  const [open, setOpen] = useState(false)
  const [decision, setDecision] = useState<'open' | 'reject'>('open')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const changed = () => {
    operationRef.current = null
    setError(null)
  }

  const submit = async () => {
    if (busy || reason.trim().length < 5) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await decideCorrection({
        eventSlug,
        correctionCaseId: correctionCase.id,
        expectedCaseVersion: correctionCase.version,
        expectedScorecardVersion: scorecard.version,
        decision,
        reason,
        clientOperationId,
      })
      operationRef.current = null
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
          disabled={busy}
          value={decision}
          onChange={(event) => {
            setDecision(event.target.value === 'reject' ? 'reject' : 'open')
            changed()
          }}
        >
          <option value="open">Open correction</option>
          <option value="reject">Decline request</option>
        </select>
      </label>
      <label className="field">
        <span>Reason</span>
        <textarea
          disabled={busy}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value)
            changed()
          }}
        />
      </label>
      <div className="button-row">
        <button className="primary" disabled={busy || reason.trim().length < 5} type="button" onClick={() => void submit()}>
          {busy ? 'Saving…' : decision === 'open' ? 'Open correction' : 'Decline'}
        </button>
        <button className="secondary" disabled={busy} type="button" onClick={() => setOpen(false)}>Cancel</button>
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
  const operationRef = useRef<string | null>(null)

  const changed = () => {
    operationRef.current = null
    setError(null)
  }

  const submit = async () => {
    if (busy || !confirmed || evidenceReference.trim().length < 3 || reason.trim().length < 5) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await voidScorecard({
        eventSlug,
        scorecardId: scorecard.id,
        expectedScorecardVersion: scorecard.version,
        category,
        disposition,
        evidenceReference,
        reason,
        clientOperationId,
      })
      operationRef.current = null
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
      <p>Voiding invalidates this review result. It never deletes the submitted version.</p>
      <div className="form-grid">
        <label className="field">
          <span>Category</span>
          <select
            disabled={busy}
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
            <option value="judge_ineligible">Reviewer ineligible</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="field">
          <span>Outcome</span>
          <select
            disabled={busy}
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
        <span>Evidence reference</span>
        <input disabled={busy} value={evidenceReference} onChange={(event) => { setEvidenceReference(event.target.value); changed() }} />
      </label>
      <label className="field">
        <span>Reason</span>
        <textarea disabled={busy} value={reason} onChange={(event) => { setReason(event.target.value); changed() }} />
      </label>
      <label className="check-filter">
        <input
          checked={confirmed}
          disabled={busy}
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
          {busy ? 'Voiding…' : 'Void scorecard'}
        </button>
        <button className="secondary" disabled={busy} type="button" onClick={() => setOpen(false)}>Cancel</button>
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
  const operationRef = useRef<string | null>(null)
  const hasContent = criterionScores || totalScore || sharedFindings || sharedCommitments

  const changed = () => {
    operationRef.current = null
    setError(null)
  }

  const submit = async () => {
    if (busy || !confirmed || !hasContent || policyVersion.trim().length < 3 || reason.trim().length < 5) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await publishRelease({
        eventSlug,
        roundId: completeness.round.id,
        expectedRoundVersion: completeness.round.version,
        policyVersion,
        includeCriterionScores: criterionScores,
        includeTotalScore: totalScore,
        includeSharedFindings: sharedFindings,
        includeSharedCommitments: sharedCommitments,
        reason,
        clientOperationId,
      })
      operationRef.current = null
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="score-final-command score-command release-command">
      <h2>Release participant feedback</h2>
      <p>The release is immutable. Nothing is selected by default.</p>
      <label className="field">
        <span>Feedback policy name</span>
        <input disabled={busy} value={policyVersion} onChange={(event) => { setPolicyVersion(event.target.value); changed() }} />
      </label>
      <div className="release-fields">
        <Check label="Criterion scores" checked={criterionScores} disabled={busy} onChange={(value) => { setCriterionScores(value); changed() }} />
        <Check label="Total score" checked={totalScore} disabled={busy} onChange={(value) => { setTotalScore(value); changed() }} />
        <Check label="Shared findings" checked={sharedFindings} disabled={busy} onChange={(value) => { setSharedFindings(value); changed() }} />
        <Check label="Next-checkpoint commitments" checked={sharedCommitments} disabled={busy} onChange={(value) => { setSharedCommitments(value); changed() }} />
      </div>
      <label className="field">
        <span>Release reason</span>
        <textarea disabled={busy} value={reason} onChange={(event) => { setReason(event.target.value); changed() }} />
      </label>
      <label className="check-filter">
        <input checked={confirmed} disabled={busy} type="checkbox" onChange={(event) => { setConfirmed(event.target.checked); changed() }} />
        I confirm these are the fields approved by the published participant-feedback policy.
      </label>
      <button
        className="primary"
        disabled={busy || !confirmed || !hasContent || policyVersion.trim().length < 3 || reason.trim().length < 5}
        type="button"
        onClick={() => void submit()}
      >
        {busy ? 'Publishing…' : 'Publish feedback'}
      </button>
      {error ? <p className="notice error">{error}</p> : null}
    </section>
  )
}

function NumericValues({ values }: { values: Values }) {
  return (
    <section className="numeric-values">
      <div className="section-heading">
        <div>
          <h2>Numeric values</h2>
          <p className="muted">Alphabetical by team. This is not a live leaderboard.</p>
        </div>
      </div>
      {values.reviews.map((review) => (
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
                const criterion = values.criteria.find((candidate) => candidate.id === result.criterionId)
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
                  const criterion = values.criteria.find((candidate) => candidate.id === rating.criterionId)
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

/**
 * Teams with no countable result sort first, then teams whose result is
 * disputed, then everything settled.
 */
function reviewRank(review: Review) {
  if (review.evaluationState !== 'complete') return 0
  if (review.cases.some((entry) => entry.state === 'requested' || entry.state === 'open')) return 1
  return 2
}

function criterionLabel(criteria: Completeness['criteria'], criterionId: string) {
  return criteria.find((candidate) => candidate.id === criterionId)?.label ?? 'A criterion'
}

function listNames(values: string[]) {
  if (values.length <= 1) return values[0] ?? 'Nothing'
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

function formatScore(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
}
