import { api } from '@code2create/backend/api'
import { useProductAnalytics } from '@code2create/client-observability'
import {
  admissionAiDispositionLabels,
  admissionInformationRequestStateLabels,
  admissionOfferStateLabels,
  admissionRecommendationStateLabels,
  admissionReviewAssignmentStateLabels,
  applicationDecisionLabels,
  applicationDecisionOutcomeLabels,
  applicationDecisions,
  applicationStateLabels,
  criterionAssessmentLabels,
  type AdmissionAiDisposition,
  type ApplicationDecision,
} from '@code2create/domain'
import { TZDateMini } from '@date-fns/tz'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { useMemo, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  cohortSummary,
  memberContextLine,
  nextAssignmentId,
  remainingAssignmentsLine,
  teamLine,
} from '../lib/admissionsPresentation'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import { useEstimatedServerNow } from '../lib/useEstimatedServerNow'
import { Icon } from '../components/Icon'
import { LoadingLabel, SkeletonCard, SkeletonList } from '../components/Skeleton'
import { ParticipantDeliveryStatus } from '../components/ParticipantDeliveryStatus'

type AdmissionDetailData = NonNullable<FunctionReturnType<typeof api.admissions.detail>>
type AiDisposition = AdmissionAiDisposition

export function AdmissionDetail() {
  const { applicationId } = useParams()
  const detail = useQuery(
    api.admissions.detail,
    applicationId ? { eventSlug, applicationId } : 'skip',
  )
  const serverNow = useEstimatedServerNow(detail?.serverNow)
  const memberPage = usePaginatedQuery(
    api.admissions.members,
    detail ? { eventSlug, applicationId: detail.application.id } : 'skip',
    { initialNumItems: 25 },
  )
  const members = memberPage.results

  if (!applicationId) return <p className="notice error">Application ID is missing.</p>
  if (detail === undefined) {
    return (
      <article className="application-detail">
        <LoadingLabel>Loading this application</LoadingLabel>
        <SkeletonCard lines={3} />
        <SkeletonList rows={4} />
      </article>
    )
  }
  if (!detail) return <p className="notice error">You do not have access to this application.</p>

  const canReview = detail.permissions.review
  const canAssign = detail.permissions.assign
  const canDecide = detail.permissions.decide
  const canManageOffer = detail.permissions.offerManage
  const hasRequiredReviews = detail.application.completedReviewCount >= detail.policy.minimumHumanReviews
  const canReadParticipantDelivery = detail.permissions.participantDeliveryRead
  const reviewOpen = canAcceptAdmissionReview(detail.application.state)
  const applicationsOpen = serverNow < detail.applicationsCloseAt
  const step = nextStep(
    detail,
    { canReview, canDecide, canManageOffer },
    applicationsOpen,
  )
  const offerActionable = canManageOffer &&
    (detail.currentOffer !== null || detail.application.state === 'accepted')
  const canRecordDecision = canDecide && !applicationsOpen && reviewOpen && hasRequiredReviews
  const canManageAssignments = canAssign && reviewOpen && detail.reviewAssignments !== null
  const canReadDelivery = detail.application.humanDecision !== null && canReadParticipantDelivery
  const hasActionPanel = canRecordDecision || offerActionable || canManageAssignments ||
    (canReview && reviewOpen) || canReadDelivery

  return (
    <article className="application-detail">
      <div className="application-nav">
        <Link className="back-link" to="/admissions">← Applications</Link>
        <NextAssignmentLink
          className="text-button"
          currentApplicationId={detail.application.id}
          label="Next to review →"
        />
      </div>
      <header className="application-heading">
        <div>
          <p className="eyebrow">Application</p>
          <h1>{detail.team.name}</h1>
          <p className="muted">
            {teamLine(detail.team.memberCount, detail.application.cohort)} · applied {formatEventTime(detail.application.submittedAt, detail.eventTimezone)}
          </p>
        </div>
        <span className="state-label">{applicationStateLabels[detail.application.state]}</span>
      </header>

      <section className="application-next-step">
        <p className="eyebrow">What happens next</p>
        <h2>{step.title}</h2>
        <p>{step.detail}</p>
        {step.blocker ? <p className="application-blocker">{step.blocker}</p> : null}
      </section>

      <div className={hasActionPanel ? 'application-review-layout' : 'application-review-layout single'}>
      <div className="application-evidence">
      <section className="detail-section">
        <h2>Team · {detail.team.memberCount}</h2>
        {members.length > 0 && members.every((member) => member.profileContext === null) ? (
          <p className="muted">Year and institution are not available to this account.</p>
        ) : null}
        <div className="member-list">
          {members.map((member) => (
            <div className="list-row" key={member.membershipId}>
              <span className="row-glyph"><Icon name="users" /></span>
              <div className="row-text">
                <strong>{member.displayName}</strong>
                <small>
                  {member.profileContext
                    ? memberContextLine(member.profileContext)
                    : 'No year or institution in scope'}
                </small>
              </div>
            </div>
          ))}
        </div>
        {memberPage.status === 'LoadingFirstPage' ? (
          <><LoadingLabel>Loading submitted team</LoadingLabel><SkeletonList rows={3} /></>
        ) : null}
        {memberPage.status === 'CanLoadMore' || memberPage.status === 'LoadingMore' ? (
          <button
            className="secondary"
            type="button"
            disabled={memberPage.status === 'LoadingMore'}
            onClick={() => memberPage.loadMore(25)}
          >
            {memberPage.status === 'LoadingMore' ? 'Loading members…' : 'Load more members'}
          </button>
        ) : null}
      </section>

      <section className="detail-section prose-section">
        <h2>Project</h2>
        <div className="answer">
          <span>Initial idea</span>
          <p>{detail.project.initialIdea}</p>
        </div>
        {detail.project.intakeResponses.map((response) => (
          <div className="answer" key={response.ordinal}>
            <span>{response.question}</span>
            <p>{response.answer}</p>
          </div>
        ))}
        {detail.project.additionalInformation ? (
          <div className="answer">
            <span>Any additional information or links you want to share (please, no PPTs)</span>
            <p>{detail.project.additionalInformation}</p>
          </div>
        ) : null}
        {detail.project.informationResponses.flatMap((response) =>
          response.answers.map((answer) => (
            <div className="answer" key={`${response.requestId}:${answer.questionKey}`}>
              <span>{answer.question}</span>
              <p>{answer.answer}</p>
            </div>
          )),
        )}
      </section>

      {reviewOpen ? (
        <section className="detail-section">
          <div className="section-heading">
            <div>
              <h2>What to look for</h2>
              <p className="muted">
                {detail.application.cohort
                  ? `${cohortSummary(detail.application.cohort)} team`
                  : 'You do not have access to year context.'}
              </p>
            </div>
            <span className="state-label">Admissions only</span>
          </div>
          <dl className="criteria-list">
            {detail.policy.criteria.map((criterion) => (
              <div key={criterion.criterionKey}>
                <dt>{criterion.label}</dt>
                <dd>{criterion.guidance ?? 'You do not have access to year context.'}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      {detail.aiRecommendationVisible && detail.aiRecommendation ? (
        <AiRecommendation
          recommendation={detail.aiRecommendation}
          detail={detail}
          rerun={detail.aiRecommendationRerun}
        />
      ) : detail.aiRecommendationRerun ? (
        <section className="detail-section ai-section">
          <h2>AI recommendation</h2>
          <p className="muted">The previous analysis did not finish. Human review can continue without it.</p>
          <AdmissionAnalysisRetry detail={detail} rerun={detail.aiRecommendationRerun} />
        </section>
      ) : null}
      {detail.currentInformationRequest?.state === 'open' ? <InformationRequest detail={detail} /> : null}
      <HumanReviews detail={detail} reviewOpen={reviewOpen} />
      </div>
      {hasActionPanel ? (
        <aside className="application-actions" aria-label="Application actions">
          {canRecordDecision ? <DecisionForm detail={detail} /> : null}
          {canReview && reviewOpen ? <ReviewForm detail={detail} /> : null}
          {offerActionable ? <OfferControl detail={detail} /> : null}
          {canManageAssignments ? <ReviewAssignmentControl detail={detail} /> : null}
          {canReadDelivery ? (
            <ParticipantDeliveryStatus applicationId={detail.application.id} teamName={detail.team.name} />
          ) : null}
        </aside>
      ) : null}
      </div>
    </article>
  )
}

function OfferControl({ detail }: { detail: AdmissionDetailData }) {
  const sendOffer = useMutation(api.admissions.sendOffer)
  const revokeOffer = useMutation(api.admissions.revokeOffer)
  const operations = useOperationRunner()
  const [deadline, setDeadline] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<'send' | 'revoke' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submitOffer = async (event: FormEvent) => {
    event.preventDefault()
    setBusy('send')
    setError(null)
    try {
      await operations.run('send', (clientOperationId) => {
        const expiresAt = zonedTimestamp(deadline, detail.eventTimezone, 'Offer deadline')
        const command = {
          eventSlug,
          applicationId: detail.application.id,
          expectedApplicationVersion: detail.application.version,
          expiresAt,
          clientOperationId,
        }
        return () => sendOffer(command)
      })
      setDeadline('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const revoke = async (event: FormEvent) => {
    event.preventDefault()
    const offer = detail.currentOffer
    if (!operations.hasPending('revoke') && (!offer || !reason.trim())) return
    setBusy('revoke')
    setError(null)
    try {
      await operations.run('revoke', (clientOperationId) => {
        if (!offer) throw new Error('The offer is no longer available to withdraw.')
        const command = {
          eventSlug,
          applicationId: detail.application.id,
          expectedApplicationVersion: detail.application.version,
          expectedOfferVersion: offer.version,
          reason: reason.trim(),
          clientOperationId,
        }
        return () => revokeOffer(command)
      })
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const offer = detail.currentOffer
  const sendPending = operations.hasPending('send')
  const revokePending = operations.hasPending('revoke')
  const operationPending = sendPending || revokePending
  const showSend = sendPending || (!offer && !revokePending)
  return (
    <section className="detail-section command-section">
      <h2>Offer</h2>
      {!showSend ? (
        <>
          {offer ? (
            <p className="muted">{offerStatusLine(offer, detail.eventTimezone)}</p>
          ) : null}
          {offer?.state === 'offered' || revokePending ? (
            <form className="command-form" onSubmit={revoke}>
              <Field
                label="Why the offer is being withdrawn"
                hint="Releases the reserved places and returns the application to accepted."
              >
                <textarea
                  required
                  minLength={3}
                  maxLength={300}
                  value={reason}
                  disabled={operationPending || busy !== null}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              <button
                className="secondary"
                type="submit"
                disabled={busy !== null || sendPending || (!revokePending && !reason.trim())}
              >
                {busy === 'revoke' ? 'Withdrawing…' : revokePending ? 'Confirm earlier withdrawal' : 'Withdraw offer'}
              </button>
            </form>
          ) : null}
        </>
      ) : (
        <form className="command-form" onSubmit={submitOffer}>
          <p className="muted">
            Sending reserves {placesLabel(detail.team.memberCount)} until the deadline.
            The places go back to the pool if the team lead does not respond.
          </p>
          <Field label={`Answer by · ${detail.eventTimezone}`}>
            <input
              required
              type="datetime-local"
              value={deadline}
              disabled={operationPending || busy !== null}
              onChange={(event) => setDeadline(event.target.value)}
            />
          </Field>
          {detail.capacity ? (
            <p className="capacity-line">{detail.capacity.reserved} of {detail.capacity.capacity} places are held or confirmed.</p>
          ) : null}
          <button
            className="primary"
            type="submit"
            disabled={busy !== null || revokePending || (!sendPending && !deadline)}
          >
            {busy === 'send' ? 'Sending…' : sendPending ? 'Confirm earlier offer' : 'Send offer'}
          </button>
        </form>
      )}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

type AiRecommendationData = NonNullable<AdmissionDetailData['aiRecommendation']>

function AiRecommendation(
  {
    recommendation,
    detail,
    rerun,
  }: {
    recommendation: AiRecommendationData
    detail: AdmissionDetailData
    rerun: AdmissionDetailData['aiRecommendationRerun']
  },
) {
  return (
    <section className="detail-section ai-section">
      <div className="section-heading">
        <div>
          <h2>AI recommendation</h2>
          <p className="muted">
            Prepared automatically by the durable idea agent. Input to the human admission decision;
            never used in judging.
          </p>
        </div>
        <span className="state-label">{admissionRecommendationStateLabels[recommendation.state]}</span>
      </div>
      {recommendation.recommendation ? (
        <p className="recommendation-line">{applicationDecisionLabels[recommendation.recommendation]}</p>
      ) : null}
      {recommendation.criterionAssessments.length ? (
        <dl className="criteria-list compact-criteria">
          {recommendation.criterionAssessments.map((assessment) => {
            const policyCriterion = detail.policy.criteria.find(
              (criterion) => criterion.criterionKey === assessment.criterionKey,
            )
            return (
              <div key={assessment.criterionKey}>
                <dt>{policyCriterion?.label ?? assessment.criterionKey}</dt>
                <dd>{criterionAssessmentLabels[assessment.assessment]} · read from the {assessment.sourceRefs.map(sourceName).join(' and the ')}</dd>
              </div>
            )
          })}
        </dl>
      ) : null}
      {recommendation.strengths.length ? <TextList label="Strengths" values={recommendation.strengths} /> : null}
      {recommendation.concerns.length ? <TextList label="Concerns" values={recommendation.concerns} /> : null}
      {recommendation.proposedQuestions.length ? <TextList label="Questions for humans" values={recommendation.proposedQuestions} /> : null}
      {recommendation.limitations.length ? <TextList label="Limitations" values={recommendation.limitations} /> : null}
      {recommendation.agentVersion ? (
        <p className="muted">
          {recommendation.agentVersion}{recommendation.agentModel ? ` · ${recommendation.agentModel}` : ''}
        </p>
      ) : null}
      {rerun ? <AdmissionAnalysisRetry detail={detail} rerun={rerun} /> : null}
    </section>
  )
}

function AdmissionAnalysisRetry({
  detail,
  rerun,
}: {
  detail: AdmissionDetailData
  rerun: NonNullable<AdmissionDetailData['aiRecommendationRerun']>
}) {
  const rerunAnalysis = useMutation(api.admissions.rerunAiRecommendation)
  const operations = useOperationRunner()
  const { capture } = useProductAnalytics()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rerunPending = operations.hasPending('rerun-analysis')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!rerunPending && reason.trim().length < 8) return
    setBusy(true)
    setError(null)
    try {
      await operations.run('rerun-analysis', (clientOperationId) => {
        const command = {
          eventSlug,
          applicationId: detail.application.id,
          expectedApplicationVersion: detail.application.version,
          expectedRecommendationId: rerun.recommendationId,
          reason: reason.trim(),
          clientOperationId,
        }
        return () => rerunAnalysis(command)
      })
      capture('c2c_admission_ai_recommendation_rerun')
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="command-form compact-command" onSubmit={submit}>
      <Field label="Reason for retry">
        <input
          required
          minLength={8}
          maxLength={240}
          value={reason}
          disabled={busy || rerunPending}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <button
        className="secondary"
        type="submit"
        disabled={busy || (!rerunPending && reason.trim().length < 8)}
      >
        {busy ? 'Starting…' : rerunPending ? 'Confirm earlier retry' : 'Run analysis again'}
      </button>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </form>
  )
}

function HumanReviews({ detail, reviewOpen }: { detail: AdmissionDetailData; reviewOpen: boolean }) {
  const outstanding = detail.policy.minimumHumanReviews - detail.application.completedReviewCount
  const decision = detail.application.humanDecision
  const reviews = [...detail.humanReviews].sort((left, right) => right.createdAt - left.createdAt)
  if (!reviewOpen && reviews.length === 0 && !decision) return null
  return (
    <section className="detail-section">
      <h2>{reviewOpen ? 'Organizer reviews' : 'How this was decided'}</h2>
      <p className="muted">
        {!reviewOpen && decision
          ? decidedSentence(detail, decision)
          : outstanding > 0
            ? `Still to come: ${outstanding} of ${detail.policy.minimumHumanReviews}. A final decision cannot be recorded until they are in.`
            : `All ${detail.policy.minimumHumanReviews} required reviews are in.`}
      </p>
      {reviews.length ? (
        <ul className="review-list">
          {reviews.map((review) => (
            <li key={review.id}>
              <div>
                <strong>{review.reviewerName}</strong>
                <span>{[applicationDecisionLabels[review.recommendation], reasonLabel(detail, review.reasonCode)].filter(Boolean).join(' · ')}</span>
              </div>
              {review.note ? <p>{review.note}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function InformationRequest({ detail }: { detail: AdmissionDetailData }) {
  const request = detail.currentInformationRequest
  if (!request) return null
  return (
    <section className="detail-section">
      <div className="section-heading">
        <h2>Requested information</h2>
        <span className="state-label">{admissionInformationRequestStateLabels[request.state]}</span>
      </div>
      <dl className="criteria-list">
        {request.questions.map((question) => {
          const answer = request.answers?.find((candidate) => candidate.questionKey === question.questionKey)
          return (
            <div key={question.questionKey}>
              <dt>{question.question}</dt>
              <dd>{answer?.answer ?? 'Waiting for the locked team lead.'}</dd>
            </div>
          )
        })}
      </dl>
    </section>
  )
}

function ReviewAssignmentControl({ detail }: { detail: AdmissionDetailData }) {
  const assignReview = useMutation(api.admissions.assignReview)
  const cancelAssignment = useMutation(api.admissions.cancelReviewAssignment)
  const operations = useOperationRunner()
  const [reviewerEmail, setReviewerEmail] = useState('')
  const [cancelTargetId, setCancelTargetId] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [busy, setBusy] = useState<'assign' | 'cancel' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const assignments = detail.reviewAssignments ?? []
  const cancelTarget = assignments.find((assignment) => assignment.id === cancelTargetId)

  const assign = async (event: FormEvent) => {
    event.preventDefault()
    const normalizedEmail = reviewerEmail.trim().toLowerCase()
    if (!operations.hasPending('assign') && !normalizedEmail) return
    setBusy('assign')
    setError(null)
    try {
      await operations.run('assign', (clientOperationId) => {
        const command = {
          eventSlug,
          applicationId: detail.application.id,
          expectedApplicationVersion: detail.application.version,
          reviewerEmail: normalizedEmail,
          clientOperationId,
        }
        return () => assignReview(command)
      })
      setReviewerEmail('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const cancel = async (event: FormEvent) => {
    event.preventDefault()
    if (!operations.hasPending('cancel') && (!cancelTarget || !cancelReason.trim())) return
    setBusy('cancel')
    setError(null)
    try {
      await operations.run('cancel', (clientOperationId) => {
        if (!cancelTarget) throw new Error('The review assignment is no longer available to cancel.')
        const command = {
          eventSlug,
          applicationId: detail.application.id,
          expectedApplicationVersion: detail.application.version,
          assignmentId: cancelTarget.id,
          expectedAssignmentVersion: cancelTarget.version,
          reason: cancelReason.trim(),
          clientOperationId,
        }
        return () => cancelAssignment(command)
      })
      setCancelTargetId(null)
      setCancelReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const assignmentOrder = { active: 0, completed: 1, cancelled: 2 }
  const ordered = [...assignments].sort(
    (left, right) => assignmentOrder[left.state] - assignmentOrder[right.state] ||
      left.assignedAt - right.assignedAt,
  )
  const owing = assignments.filter((assignment) => assignment.state === 'active').length
  const assignPending = operations.hasPending('assign')
  const cancelPending = operations.hasPending('cancel')
  const operationPending = assignPending || cancelPending

  return (
    <section className="detail-section command-section">
      <h2>Assigned reviewers</h2>
      <p className="muted">
        {assignments.length === 0
          ? 'Nobody is assigned. Anyone added here sees this in their queue.'
          : owing === 0
            ? 'Everyone assigned has reviewed.'
            : `${owing} of ${assignments.length} assigned reviewers still owe a review.`}
      </p>
      <form className="command-form compact-command" onSubmit={assign}>
        <Field label="Reviewer Google email">
          <input
            required
            type="email"
            value={reviewerEmail}
            disabled={operationPending || busy !== null}
            onChange={(event) => setReviewerEmail(event.target.value)}
          />
        </Field>
        <button
          className="secondary"
          type="submit"
          disabled={busy !== null || cancelPending || (!assignPending && !reviewerEmail.trim())}
        >
          {busy === 'assign' ? 'Assigning…' : assignPending ? 'Confirm earlier assignment' : 'Assign review'}
        </button>
      </form>
      {ordered.length > 0 ? (
        <ul className="review-list assignment-list">
          {ordered.map((assignment) => (
            <li key={assignment.id}>
              <div>
                <strong>{assignment.reviewerName}</strong>
                <span>{admissionReviewAssignmentStateLabels[assignment.state]} · {assignment.reviewerEmail}</span>
              </div>
              {assignment.state === 'active' && cancelTargetId !== assignment.id ? (
                <button className="text-button" type="button" disabled={operationPending || busy !== null} onClick={() => {
                  setCancelTargetId(assignment.id)
                  setCancelReason('')
                  setError(null)
                }}>Cancel</button>
              ) : null}
              {(assignment.state === 'active' || cancelPending) && cancelTargetId === assignment.id ? (
                <form className="inline-cancel-form" onSubmit={cancel}>
                  <input
                    required
                    minLength={3}
                    maxLength={240}
                    placeholder="Cancellation reason"
                    value={cancelReason}
                    disabled={operationPending || busy !== null}
                    onChange={(event) => setCancelReason(event.target.value)}
                  />
                  <button
                    className="secondary"
                    type="submit"
                    disabled={busy !== null || assignPending || (!cancelPending && cancelReason.trim().length < 3)}
                  >
                    {busy === 'cancel' ? 'Cancelling…' : cancelPending ? 'Confirm earlier cancellation' : 'Confirm'}
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    disabled={operationPending || busy !== null}
                    onClick={() => setCancelTargetId(null)}
                  >Keep</button>
                </form>
              ) : null}
              {assignment.cancellationReason ? <p>{assignment.cancellationReason}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function NextAssignmentLink({ className, currentApplicationId, fallback, label }: {
  className: string
  currentApplicationId: string
  fallback?: React.ReactNode
  label: string
}) {
  const assignments = usePaginatedQuery(
    api.admissions.myReviewAssignments,
    { eventSlug, state: 'active' },
    { initialNumItems: 10 },
  )
  const nextId = nextAssignmentId(assignments.results, currentApplicationId)
  if (nextId === null) {
    return assignments.status === 'LoadingFirstPage' ? null : fallback ?? null
  }
  return <Link className={className} to={`/admissions/${nextId}`}>{label}</Link>
}

function ReviewForm({ detail }: { detail: AdmissionDetailData }) {
  const saveReview = useMutation(api.admissions.saveReview)
  const operations = useOperationRunner()
  const { capture } = useProductAnalytics()
  const assignmentCounts = useQuery(api.admissions.myReviewAssignmentCounts, { eventSlug })
  const ownReview = detail.humanReviews.find((review) => review.own) ?? null
  const [editing, setEditing] = useState(ownReview === null)
  const [recommendation, setRecommendation] = useState<ApplicationDecision | null>(
    ownReview?.recommendation ?? null,
  )
  const reasons = useMemo(
    () => recommendation === null
      ? []
      : detail.policy.decisionReasonCodes.filter((reason) => reason.allowedDecisions.includes(recommendation)),
    [detail.policy.decisionReasonCodes, recommendation],
  )
  const [reason, setReason] = useState(ownReview?.reasonCode ?? '')
  const [note, setNote] = useState(ownReview?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedReason = reasons.some((candidate) => candidate.key === reason)
    ? reason
    : reasons[0]?.key ?? ''
  const savePending = operations.hasPending('save')

  const choose = (next: ApplicationDecision) => {
    setRecommendation(next)
    setReason(
      detail.policy.decisionReasonCodes.find((candidate) => candidate.allowedDecisions.includes(next))?.key ?? '',
    )
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (savePending) {
        await operations.retryPending('save')
      } else {
        if (recommendation === null || !selectedReason) return
        await operations.run('save', (clientOperationId) => {
          const command = {
            eventSlug,
            applicationId: detail.application.id,
            expectedApplicationContentVersion: detail.application.contentVersion,
            recommendation,
            reasonCode: selectedReason,
            ...(note.trim() ? { note: note.trim() } : {}),
            clientOperationId,
          }
          return () => saveReview(command)
        })
      }
      capture('c2c_admission_review_saved', {
        c2c_recommendation: recommendation ?? 'retried',
      })
      setSaved(true)
      setEditing(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <section className="detail-section command-section admission-own-review">
        <h2>{saved ? 'Review saved' : 'Your review'}</h2>
        {ownReview ? (
          <>
            <p className="admission-own-verdict">
              <strong>{applicationDecisionLabels[ownReview.recommendation]}</strong>
              {reasonLabel(detail, ownReview.reasonCode) ? <span> · {reasonLabel(detail, ownReview.reasonCode)}</span> : null}
            </p>
            {ownReview.note ? <p className="muted">{ownReview.note}</p> : null}
          </>
        ) : (
          <p className="muted">Whoever records the decision can see it now.</p>
        )}
        {remainingAssignmentsLine(assignmentCounts) ? (
          <p className="muted">{remainingAssignmentsLine(assignmentCounts)}</p>
        ) : null}
        <div className="button-row">
          <NextAssignmentLink
            className="primary"
            currentApplicationId={detail.application.id}
            fallback={<p className="muted">Nothing else is assigned to you.</p>}
            label="Next to review →"
          />
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setSaved(false)
              setEditing(true)
            }}
          >
            Change review
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="detail-section command-section">
      <h2>{ownReview ? 'Change your review' : 'Your review'}</h2>
      <p className="muted">Pick one, choose the reason that fits, and save. Whoever records the decision sees both.</p>
      <form className="command-form" onSubmit={submit}>
        <fieldset disabled={savePending || busy} style={{ display: 'contents' }}>
          <div className="field">
            <span>Recommendation</span>
            <div aria-label="Recommendation" className="admission-choices" role="radiogroup">
              {applicationDecisions.map((decision) => (
                <button
                  aria-checked={recommendation === decision}
                  className={recommendation === decision ? 'admission-choice active' : 'admission-choice'}
                  key={decision}
                  role="radio"
                  type="button"
                  onClick={() => choose(decision)}
                >
                  {applicationDecisionLabels[decision]}
                </button>
              ))}
            </div>
          </div>
          {recommendation !== null ? (
            <Field label="Reason" hint="The team may be told this if the decision follows your review.">
              <select value={selectedReason} onChange={(event) => setReason(event.target.value)}>
                {reasons.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            </Field>
          ) : null}
          <Field label="Note for the decision maker" hint="Optional.">
            <textarea value={note} maxLength={600} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </fieldset>
        {error ? <p className="notice error" role="alert">{error}</p> : null}
        <div className="button-row">
          <button
            className="primary"
            type="submit"
            disabled={busy || (!savePending && (recommendation === null || !selectedReason))}
          >
            {busy
              ? 'Saving…'
              : savePending
                ? 'Confirm earlier review'
                : recommendation === null
                  ? 'Pick a recommendation'
                  : 'Save review'}
          </button>
          {ownReview ? (
            <button
              className="secondary"
              disabled={busy}
              type="button"
              onClick={() => {
                setRecommendation(ownReview.recommendation)
                setReason(ownReview.reasonCode)
                setNote(ownReview.note ?? '')
                setEditing(false)
              }}
            >
              Keep current
            </button>
          ) : null}
        </div>
      </form>
    </section>
  )
}

function DecisionForm({ detail }: { detail: AdmissionDetailData }) {
  const decide = useMutation(api.admissions.decide)
  const operations = useOperationRunner()
  const { capture } = useProductAnalytics()
  const [decision, setDecision] = useState<ApplicationDecision | null>(
    detail.application.decisionStage === 'recorded'
      ? detail.application.humanDecision ?? null
      : null,
  )
  const reasons = useMemo(
    () => decision === null
      ? []
      : detail.policy.decisionReasonCodes.filter((reason) => reason.allowedDecisions.includes(decision)),
    [decision, detail.policy.decisionReasonCodes],
  )
  const [reason, setReason] = useState(
    detail.application.decisionStage === 'recorded'
      ? detail.application.humanReasonCode ?? ''
      : '',
  )
  const [aiDisposition, setAiDisposition] = useState<AiDisposition | null>(
    detail.application.decisionStage === 'recorded'
      ? detail.application.aiDisposition ?? null
      : null,
  )
  const [informationQuestions, setInformationQuestions] = useState([''])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedReason = reasons.some((candidate) => candidate.key === reason)
    ? reason
    : reasons[0]?.key ?? ''
  const availableAiDispositions = decision === null ? [] : aiDispositionOptions(detail, decision)
  const selectedAiDisposition = decision === null
    ? null
    : aiDisposition !== null && availableAiDispositions.includes(aiDisposition)
      ? aiDisposition
      : availableAiDispositions[0] ?? null
  const recordPending = operations.hasPending('record')

  const record = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (recordPending) {
        await operations.retryPending('record')
      } else {
        if (decision === null || !selectedReason || selectedAiDisposition === null) return
        await operations.run('record', (clientOperationId) => {
          const command = {
            eventSlug,
            applicationId: detail.application.id,
            expectedApplicationVersion: detail.application.version,
            decision,
            reasonCode: selectedReason,
            informationQuestions: decision === 'needs_information' ? [...informationQuestions] : [],
            aiDisposition: selectedAiDisposition,
            clientOperationId,
          }
          return () => decide(command)
        })
      }
      capture('c2c_admission_decision_recorded', {
        c2c_decision: decision ?? 'retried',
        c2c_ai_disposition: selectedAiDisposition,
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="detail-section command-section final-command">
      <h2>{detail.application.decisionStage === 'recorded' ? 'Update the recorded decision' : 'Record the decision'}</h2>
      <p className="muted">
        Accept, waitlist, and decline stay internal until a Supreme reviews and releases all results together. A request for more information is sent to the team immediately.
      </p>
      <form className="command-form" onSubmit={record}>
        <fieldset disabled={recordPending || busy} style={{ display: 'contents' }}>
          <Field label="Decision">
          <select
            required
            value={decision ?? ''}
            onChange={(event) => {
              const next = parseDecision(event.target.value)
              setDecision(next)
              setReason(next === null
                ? ''
                : detail.policy.decisionReasonCodes.find(
                    (candidate) => candidate.allowedDecisions.includes(next),
                  )?.key ?? '')
              setAiDisposition(next === null ? null : defaultAiDisposition(detail, next))
            }}
          >
            <option value="">Choose a decision</option>
            {applicationDecisions.map((value) => <option key={value} value={value}>{applicationDecisionLabels[value]}</option>)}
          </select>
          </Field>
          <Field label="Decision reason">
          <select value={selectedReason} onChange={(event) => setReason(event.target.value)}>
            {reasons.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
          </Field>
          {decision === 'needs_information' ? (
          <div className="field">
            <span>Questions for the team</span>
            <small>This action is immediate. The team lead will see these questions and receive the configured email.</small>
            {informationQuestions.map((question, index) => (
              <textarea
                key={`question_${index + 1}`}
                required
                minLength={8}
                maxLength={240}
                value={question}
                aria-label={`Question ${index + 1}`}
                onChange={(event) => setInformationQuestions((current) => current.map((value, currentIndex) => (
                  currentIndex === index ? event.currentTarget.value : value
                )))}
              />
            ))}
            <div className="button-row">
              {informationQuestions.length === 1 ? (
                <button className="text-button" type="button" onClick={() => setInformationQuestions((current) => [...current, ''])}>Add second question</button>
              ) : (
                <button className="text-button" type="button" onClick={() => setInformationQuestions((current) => current.slice(0, 1))}>Remove second question</button>
              )}
            </div>
          </div>
          ) : null}
          {selectedAiDisposition ? (
            <Field label="How you used the AI recommendation" hint="Recorded in the audit trail.">
            <select value={selectedAiDisposition} onChange={(event) => setAiDisposition(parseAiDisposition(event.target.value))}>
              {availableAiDispositions.map((value) => <option key={value} value={value}>{admissionAiDispositionLabels[value]}</option>)}
            </select>
            </Field>
          ) : null}
          {detail.capacity ? (
            <p className="capacity-line">{detail.capacity.reserved} of {detail.capacity.capacity} places are held or confirmed.</p>
          ) : null}
        </fieldset>
        {error ? <p className="notice error" role="alert">{error}</p> : null}
        <button
          className="primary"
          type="submit"
          disabled={busy || (!recordPending && (
            decision === null ||
            !selectedReason ||
            selectedAiDisposition === null ||
            (decision === 'needs_information' && informationQuestions.some((question) => question.trim().length < 8))
          ))}
        >
          {busy
            ? 'Saving…'
            : recordPending
              ? 'Confirm earlier decision'
              : decision === null
                ? 'Choose a decision'
                : decision === 'needs_information'
                  ? 'Send questions now'
                  : `Record ${applicationDecisionLabels[decision].toLowerCase()}`}
        </button>
      </form>
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>
}

function TextList({ label, values }: { label: string; values: string[] }) {
  return <div className="text-list"><strong>{label}</strong><ul>{values.map((value) => <li key={value}>{value}</li>)}</ul></div>
}

function canAcceptAdmissionReview(state: string) {
  return state === 'submitted' || state === 'under_review' || state === 'needs_information'
}

function nextStep(
  detail: AdmissionDetailData,
  permissions: { canReview: boolean; canDecide: boolean; canManageOffer: boolean },
  applicationsOpen: boolean,
): { title: string; detail: string; blocker?: string } {
  const state = detail.application.state
  const { completedReviewCount } = detail.application
  const { minimumHumanReviews } = detail.policy
  const outstanding = minimumHumanReviews - completedReviewCount

  if (state === 'submitted' || state === 'under_review') {
    if (outstanding > 0) {
      return {
        title: `${outstanding} more ${outstanding === 1 ? 'review' : 'reviews'} needed`,
        detail: `${completedReviewCount} of ${minimumHumanReviews} organizer reviews are in.`,
        ...(permissions.canReview ? {} : { blocker: 'You can read this application but not review it.' }),
      }
    }
    if (applicationsOpen) {
      return {
        title: 'Waiting for the application deadline',
        detail: 'The team can still edit this proposal. Record a decision after applications close.',
      }
    }
    return {
      title: 'Ready for a decision',
      detail: `All ${minimumHumanReviews} required reviews are in.`,
      ...(permissions.canDecide ? {} : { blocker: 'You do not have access to record a decision.' }),
    }
  }
  if (state === 'needs_information') {
    const asked = detail.currentInformationRequest?.questions.length ?? 0
    return {
      title: 'Waiting for the team',
      detail: `The team was asked ${asked === 1 ? 'a question' : `${asked} questions`}. Review continues once it answers.`,
    }
  }
  if (state === 'accepted') {
    return {
      title: 'Send the offer',
      detail: `${detail.team.name} was accepted but has no offer, so no places are reserved.`,
      ...(permissions.canManageOffer ? {} : { blocker: 'You do not have access to send offers.' }),
    }
  }
  if (state === 'offer_sent') {
    const expiresAt = detail.currentOffer?.expiresAt
    return {
      title: 'Waiting for the team to accept',
      detail: expiresAt
        ? `The team lead must accept by ${formatEventTime(expiresAt, detail.eventTimezone)}.`
        : 'The team lead must accept before the deadline.',
    }
  }
  if (state === 'confirmed') {
    return {
      title: 'Nothing left to do',
      detail: `${detail.team.name} confirmed ${placesLabel(detail.team.memberCount)} and appears at check-in.`,
    }
  }
  if (state === 'waitlisted') {
    return {
      title: 'On the waitlist',
      detail: 'The team has been told. It moves only if an offer expires or is declined.',
    }
  }
  if (state === 'declined') {
    return { title: 'Nothing left to do', detail: 'The team was told it was not selected.' }
  }
  if (state === 'offer_expired') {
    return {
      title: 'Offer expired',
      detail: 'Nobody answered before the deadline and the reserved places went back to the pool.',
    }
  }
  return {
    title: 'Team withdrew',
    detail: 'The team declined its offer and the reserved places went back to the pool.',
  }
}

function parseDecision(value: string): ApplicationDecision | null {
  return applicationDecisions.find((decision) => decision === value) ?? null
}

function parseAiDisposition(value: string): AiDisposition {
  if (value === 'used' || value === 'cleared' || value === 'overridden' || value === 'stale' || value === 'unavailable') return value
  return 'unavailable'
}

function aiDispositionOptions(detail: AdmissionDetailData, decision: ApplicationDecision): AiDisposition[] {
  const recommendation = detail.aiRecommendation
  if (recommendation?.state === 'succeeded' && recommendation.recommendation) {
    return recommendation.recommendation === decision ? ['used', 'cleared'] : ['overridden', 'cleared']
  }
  return [recommendation?.state === 'stale' ? 'stale' : 'unavailable']
}

function defaultAiDisposition(detail: AdmissionDetailData, decision: ApplicationDecision): AiDisposition {
  return aiDispositionOptions(detail, decision)[0] ?? 'unavailable'
}

function placesLabel(count: number) {
  return `${count} ${count === 1 ? 'place' : 'places'}`
}

function offerStatusLine(
  offer: NonNullable<AdmissionDetailData['currentOffer']>,
  timezone: string,
) {
  const state = admissionOfferStateLabels[offer.state]
  const places = placesLabel(offer.participantCount)
  if (offer.state === 'offered') {
    return `${state} · ${places} held until ${formatEventTime(offer.expiresAt, timezone)}.`
  }
  if (offer.state === 'confirmed') return `${state} · ${places} reserved for this team.`
  return `${state} · ${places} released.`
}

function sourceName(value: string) {
  if (value === 'initial_idea') return 'initial idea'
  if (value.startsWith('requested_information_')) return 'requested information'
  return 'follow-up answer'
}

function reasonLabel(detail: AdmissionDetailData, key: string): string | null {
  return detail.policy.decisionReasonCodes.find((reason) => reason.key === key)?.label ?? null
}

function decidedSentence(detail: AdmissionDetailData, decision: ApplicationDecision) {
  const outcome = applicationDecisionOutcomeLabels[decision]
  const reason = detail.application.humanReasonCode
    ? reasonLabel(detail, detail.application.humanReasonCode)
    : null
  if (detail.application.decisionStage === 'recorded') {
    return reason
      ? `${outcome} recorded with reason: ${reason}. It is not visible to the team yet.`
      : `${outcome} recorded. It is not visible to the team yet.`
  }
  return reason ? `${outcome}. The team was told: ${reason}.` : `${outcome}.`
}

function zonedTimestamp(value: string, timezone: string, label: string) {
  const [datePart, timePart] = value.split('T')
  const datePieces = datePart?.split('-')
  const timePieces = timePart?.split(':')
  const year = Number(datePieces?.[0])
  const month = Number(datePieces?.[1])
  const day = Number(datePieces?.[2])
  const hour = Number(timePieces?.[0])
  const minute = Number(timePieces?.[1])
  if ([year, month, day, hour, minute].some((part) => !Number.isInteger(part))) {
    throw new Error(`${label} is incomplete.`)
  }
  const date = new TZDateMini(year, month - 1, day, hour, minute, timezone)
  if (
    !Number.isFinite(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    throw new Error(`${label} is not a valid local time in ${timezone}.`)
  }
  return date.getTime()
}

function formatEventTime(timestamp: number, timezone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}
