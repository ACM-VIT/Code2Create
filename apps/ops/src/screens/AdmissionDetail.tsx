import { api } from '@code2create/backend/api'
import {
  admissionAiDispositionLabels,
  admissionExperienceBandLabels,
  admissionInformationRequestStateLabels,
  admissionOfferStateLabels,
  admissionRecommendationStateLabels,
  admissionReviewAssignmentStateLabels,
  applicationDecisionLabels,
  applicationDecisions,
  applicationStateLabels,
  criterionAssessmentLabels,
  participantClassLabels,
  studyYearLabels,
  type AdmissionAiDisposition,
  type ApplicationDecision,
} from '@code2create/domain'
import { TZDateMini } from '@date-fns/tz'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { Icon } from '../components/Icon'
import { LoadingLabel, SkeletonCard, SkeletonList } from '../components/Skeleton'
import { ParticipantDeliveryStatus } from '../components/ParticipantDeliveryStatus'

type AdmissionDetailData = NonNullable<FunctionReturnType<typeof api.admissions.detail>>
type Access = NonNullable<FunctionReturnType<typeof api.access.mine>>
type AiDisposition = AdmissionAiDisposition

export function AdmissionDetail({ access }: { access: Access }) {
  const { applicationId } = useParams()
  const detail = useQuery(
    api.admissions.detail,
    applicationId ? { eventSlug, applicationId } : 'skip',
  )

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
  if (!detail) return <p className="notice error">This application is not available to your permission scope.</p>

  const canReview = can(access, 'application.review', detail.application.id)
  const canAssign = can(access, 'application.assign', detail.application.id)
  const canDecide = can(access, 'application.decide', detail.application.id)
  const canManageOffer = can(access, 'application.offer.manage', detail.application.id)
  const hasRequiredReviews = detail.application.completedReviewCount >= detail.policy.minimumHumanReviews
  const canReadParticipantDelivery = access.grants.some(
    (grant) => grant.permissionKey === 'communications.delivery.read',
  )
  const reviewOpen = canAcceptAdmissionReview(detail.application.state)
  const step = nextStep(detail, { canReview, canDecide, canManageOffer })
  const offerActionable = canManageOffer &&
    (detail.currentOffer !== null || detail.application.state === 'accepted')

  return (
    <article className="application-detail">
      <Link className="back-link" to="/admissions">← Applications</Link>
      <header className="application-heading">
        <div>
          <p className="eyebrow">{detail.project.trackName}</p>
          <h1>{detail.team.name}</h1>
          <p className="muted">
            {experienceBandName(detail.application.experienceBand)} · {teamSizeLabel(detail.team.members.length)}
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

      <section className="detail-section">
        <h2>Team · {detail.team.members.length}</h2>
        {detail.team.members.every((member) => member.profileContext === null) ? (
          <p className="muted">
            Names only. Year and institution are outside this account’s permission scope, so
            judge the project on what it says rather than on who wrote it.
          </p>
        ) : null}
        <div className="member-list">
          {detail.team.members.map((member) => (
            <div className="list-row" key={member.membershipId}>
              <span className="row-glyph"><Icon name="users" /></span>
              <div className="row-text">
                <strong>{member.displayName}</strong>
                <small>
                  {member.profileContext
                    ? `${participantClassLabels[member.profileContext.participantClass]} · ${studyYearLabels[member.profileContext.yearOfStudy]} · ${member.profileContext.institution}`
                    : 'No year or institution in scope'}
                </small>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="detail-section prose-section">
        <h2>Project</h2>
        {detail.project.sponsorTracks.length > 0 ? (
          <div className="answer">
            <span>Sponsor tracks</span>
            {detail.project.sponsorTracks.map((track) => (
              <p key={track.id}><strong>{track.name}</strong> · {track.eligibilityText}</p>
            ))}
          </div>
        ) : null}
        <div className="answer">
          <span>Initial idea</span>
          <p>{detail.project.initialIdea}</p>
        </div>
        {detail.project.intakeResponses.map((response) => (
          <div className="answer" key={response.ordinal}>
            <span>{response.question}</span>
            <p>{response.skipped ? 'Skipped by team' : response.answer}</p>
          </div>
        ))}
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
              <p className="muted">{experienceBandName(detail.application.experienceBand)}</p>
            </div>
            <span className="state-label">Admissions only</span>
          </div>
          <dl className="criteria-list">
            {detail.policy.criteria.map((criterion) => (
              <div key={criterion.criterionKey}>
                <dt>{criterion.label}</dt>
                <dd>{criterion.guidance ?? 'Year context is outside this account’s permission scope.'}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      {detail.aiRecommendationVisible && detail.aiRecommendation ? (
        <AiRecommendation recommendation={detail.aiRecommendation} detail={detail} />
      ) : null}
      {detail.currentInformationRequest?.state === 'open' ? <InformationRequest detail={detail} /> : null}
      <HumanReviews detail={detail} reviewOpen={reviewOpen} />
      {canAssign && reviewOpen && detail.reviewAssignments ? <ReviewAssignmentControl detail={detail} /> : null}
      {canReview && reviewOpen ? <ReviewForm detail={detail} /> : null}
      {canDecide && reviewOpen && hasRequiredReviews ? <DecisionForm detail={detail} /> : null}
      {detail.application.humanDecision && canReadParticipantDelivery ? (
        <ParticipantDeliveryStatus applicationId={detail.application.id} />
      ) : null}
      {offerActionable ? <OfferControl detail={detail} /> : null}
    </article>
  )
}

function OfferControl({ detail }: { detail: AdmissionDetailData }) {
  const sendOffer = useMutation(api.admissions.sendOffer)
  const revokeOffer = useMutation(api.admissions.revokeOffer)
  const operationRef = useRef<{ key: string; id: string } | null>(null)
  const [deadline, setDeadline] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<'send' | 'revoke' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submitOffer = async (event: FormEvent) => {
    event.preventDefault()
    let expiresAt: number
    try {
      expiresAt = zonedTimestamp(deadline, detail.eventTimezone, 'Offer deadline')
    } catch (caught) {
      setError(readableError(caught))
      return
    }
    const operationKey = `send:${detail.application.version}:${expiresAt}`
    const operation = operationRef.current?.key === operationKey
      ? operationRef.current
      : { key: operationKey, id: crypto.randomUUID() }
    operationRef.current = operation
    setBusy('send')
    setError(null)
    try {
      await sendOffer({
        eventSlug,
        applicationId: detail.application.id,
        expectedApplicationVersion: detail.application.version,
        expiresAt,
        clientOperationId: operation.id,
      })
      operationRef.current = null
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
    if (!offer || !reason.trim()) return
    const operationKey = `revoke:${detail.application.version}:${offer.version}:${reason}`
    const operation = operationRef.current?.key === operationKey
      ? operationRef.current
      : { key: operationKey, id: crypto.randomUUID() }
    operationRef.current = operation
    setBusy('revoke')
    setError(null)
    try {
      await revokeOffer({
        eventSlug,
        applicationId: detail.application.id,
        expectedApplicationVersion: detail.application.version,
        expectedOfferVersion: offer.version,
        reason,
        clientOperationId: operation.id,
      })
      operationRef.current = null
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const offer = detail.currentOffer
  return (
    <section className="detail-section command-section">
      <h2>Offer</h2>
      {offer ? (
        <>
          <p className="muted">
            {admissionOfferStateLabels[offer.state]} · {placesLabel(offer.participantCount)} held until{' '}
            {formatEventTime(offer.expiresAt, detail.eventTimezone)}.
          </p>
          {offer.state === 'offered' ? (
            <form className="command-form" onSubmit={revoke}>
              <Field
                label="Why the offer is being withdrawn"
                hint="Withdrawing releases the reserved places and returns the application to accepted, so a corrected offer can be sent."
              >
                <textarea required minLength={3} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} />
              </Field>
              <button className="secondary" type="submit" disabled={busy !== null || !reason.trim()}>
                {busy === 'revoke' ? 'Withdrawing…' : 'Withdraw offer'}
              </button>
            </form>
          ) : null}
        </>
      ) : (
        <form className="command-form" onSubmit={submitOffer}>
          <p className="muted">
            Sending reserves {placesLabel(detail.team.members.length)} for this team until the deadline
            below. If the team does not answer in time the places go back to the pool.
          </p>
          <Field label={`Answer by · ${detail.eventTimezone}`}>
            <input required type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
          </Field>
          {detail.capacity ? (
            <p className="capacity-line">{detail.capacity.reserved} of {detail.capacity.capacity} places are held or confirmed.</p>
          ) : null}
          <button className="primary" type="submit" disabled={busy !== null || !deadline}>
            {busy === 'send' ? 'Sending…' : 'Send offer'}
          </button>
        </form>
      )}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

type AiRecommendationData = NonNullable<AdmissionDetailData['aiRecommendation']>

function AiRecommendation(
  { recommendation, detail }: { recommendation: AiRecommendationData; detail: AdmissionDetailData },
) {
  return (
    <section className="detail-section ai-section">
      <div className="section-heading">
        <div>
          <h2>AI recommendation</h2>
          <p className="muted">Input to the human admission decision. Never used in judging.</p>
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
    </section>
  )
}

function HumanReviews({ detail, reviewOpen }: { detail: AdmissionDetailData; reviewOpen: boolean }) {
  const outstanding = detail.policy.minimumHumanReviews - detail.application.completedReviewCount
  const decision = detail.application.humanDecision
  // Newest first: the most recent opinion is the one a decider argues with.
  const reviews = [...detail.humanReviews].sort((left, right) => right.createdAt - left.createdAt)
  if (!reviewOpen && reviews.length === 0 && !decision) return null
  return (
    <section className="detail-section">
      <h2>{reviewOpen ? 'Organizer reviews' : 'How this was decided'}</h2>
      <p className="muted">
        {!reviewOpen && decision
          ? `Published as ${applicationDecisionLabels[decision].toLowerCase()}${detail.application.humanReasonCode ? `: ${reasonLabel(detail, detail.application.humanReasonCode)}` : ''}.`
          : outstanding > 0
            ? `Still to come: ${outstanding} of ${detail.policy.minimumHumanReviews}. A decision cannot be published until they are in.`
            : `All ${detail.policy.minimumHumanReviews} required reviews are in.`}
      </p>
      {reviews.length ? (
        <ul className="review-list">
          {reviews.map((review) => (
            <li key={review.id}>
              <div>
                <strong>{review.reviewerName}</strong>
                <span>{applicationDecisionLabels[review.recommendation]} · {reasonLabel(detail, review.reasonCode)}</span>
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
  const operationRef = useRef<{ key: string; id: string } | null>(null)
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
    if (!normalizedEmail) return
    const operationKey = `assign:${detail.application.version}:${normalizedEmail}`
    const operation = operationRef.current?.key === operationKey
      ? operationRef.current
      : { key: operationKey, id: crypto.randomUUID() }
    operationRef.current = operation
    setBusy('assign')
    setError(null)
    try {
      await assignReview({
        eventSlug,
        applicationId: detail.application.id,
        expectedApplicationVersion: detail.application.version,
        reviewerEmail: normalizedEmail,
        clientOperationId: operation.id,
      })
      operationRef.current = null
      setReviewerEmail('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const cancel = async (event: FormEvent) => {
    event.preventDefault()
    if (!cancelTarget || !cancelReason.trim()) return
    const operationKey = `cancel:${detail.application.version}:${cancelTarget.id}:${cancelTarget.version}:${cancelReason.trim()}`
    const operation = operationRef.current?.key === operationKey
      ? operationRef.current
      : { key: operationKey, id: crypto.randomUUID() }
    operationRef.current = operation
    setBusy('cancel')
    setError(null)
    try {
      await cancelAssignment({
        eventSlug,
        applicationId: detail.application.id,
        expectedApplicationVersion: detail.application.version,
        assignmentId: cancelTarget.id,
        expectedAssignmentVersion: cancelTarget.version,
        reason: cancelReason,
        clientOperationId: operation.id,
      })
      operationRef.current = null
      setCancelTargetId(null)
      setCancelReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  // Reviewers who still owe a review come first; finished and cancelled work sinks.
  const assignmentOrder = { active: 0, completed: 1, cancelled: 2 }
  const ordered = [...assignments].sort(
    (left, right) => assignmentOrder[left.state] - assignmentOrder[right.state] ||
      left.assignedAt - right.assignedAt,
  )
  const owing = assignments.filter((assignment) => assignment.state === 'active').length

  return (
    <section className="detail-section command-section">
      <h2>Assigned reviewers</h2>
      <p className="muted">
        {assignments.length === 0
          ? 'Nobody is assigned. Add a reviewer by their Google email and the application appears in their queue.'
          : owing === 0
            ? `Everyone assigned has reviewed. ${detail.application.completedReviewCount} of ${detail.policy.minimumHumanReviews} required reviews are in.`
            : `${owing} of ${assignments.length} assigned reviewers still owe a review.`}
      </p>
      <form className="command-form compact-command" onSubmit={assign}>
        <Field label="Reviewer Google email">
          <input required type="email" value={reviewerEmail} onChange={(event) => setReviewerEmail(event.target.value)} />
        </Field>
        <button className="secondary" type="submit" disabled={busy !== null || !reviewerEmail.trim()}>
          {busy === 'assign' ? 'Assigning…' : 'Assign review'}
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
                <button className="text-button" type="button" onClick={() => {
                  setCancelTargetId(assignment.id)
                  setCancelReason('')
                  setError(null)
                }}>Cancel</button>
              ) : null}
              {assignment.state === 'active' && cancelTargetId === assignment.id ? (
                <form className="inline-cancel-form" onSubmit={cancel}>
                  <input
                    required
                    minLength={3}
                    maxLength={240}
                    placeholder="Cancellation reason"
                    value={cancelReason}
                    onChange={(event) => setCancelReason(event.target.value)}
                  />
                  <button className="secondary" type="submit" disabled={busy !== null || cancelReason.trim().length < 3}>
                    {busy === 'cancel' ? 'Cancelling…' : 'Confirm'}
                  </button>
                  <button className="text-button" type="button" onClick={() => setCancelTargetId(null)}>Keep</button>
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

function ReviewForm({ detail }: { detail: AdmissionDetailData }) {
  const saveReview = useMutation(api.admissions.saveReview)
  const operationRef = useRef<{ key: string; id: string } | null>(null)
  const [recommendation, setRecommendation] = useState<ApplicationDecision>('accept')
  const reasons = useMemo(
    () => detail.policy.decisionReasonCodes.filter((reason) => reason.allowedDecisions.includes(recommendation)),
    [detail.policy.decisionReasonCodes, recommendation],
  )
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setReason(reasons[0]?.key ?? ''), [reasons])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!reason) return
    const operationKey = JSON.stringify([
      detail.application.contentVersion,
      recommendation,
      reason,
      note.trim(),
    ])
    const operation = operationRef.current?.key === operationKey
      ? operationRef.current
      : { key: operationKey, id: crypto.randomUUID() }
    operationRef.current = operation
    setBusy(true)
    setError(null)
    try {
      await saveReview({
        eventSlug,
        applicationId: detail.application.id,
        expectedApplicationContentVersion: detail.application.contentVersion,
        recommendation,
        reasonCode: reason,
        ...(note.trim() ? { note } : {}),
        clientOperationId: operation.id,
      })
      operationRef.current = null
      setNote('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="detail-section command-section">
      <h2>Add your review</h2>
      <p className="muted">Your recommendation and reason are visible to whoever publishes the decision.</p>
      <form className="command-form" onSubmit={submit}>
        <Field label="Recommendation">
          <select value={recommendation} onChange={(event) => setRecommendation(parseDecision(event.target.value))}>
            {applicationDecisions.map((decision) => <option key={decision} value={decision}>{applicationDecisionLabels[decision]}</option>)}
          </select>
        </Field>
        <Field label="Published reason">
          <select value={reason} onChange={(event) => setReason(event.target.value)}>
            {reasons.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </Field>
        <Field label="Note" hint="Optional; keep it concrete and application-specific.">
          <textarea value={note} maxLength={600} onChange={(event) => setNote(event.target.value)} />
        </Field>
        {error ? <p className="notice error" role="alert">{error}</p> : null}
        <button className="primary" type="submit" disabled={busy || !reason}>{busy ? 'Saving…' : 'Save review'}</button>
      </form>
    </section>
  )
}

function DecisionForm({ detail }: { detail: AdmissionDetailData }) {
  const decide = useMutation(api.admissions.decide)
  const operationRef = useRef<{ key: string; id: string } | null>(null)
  const [decision, setDecision] = useState<ApplicationDecision>('accept')
  const reasons = useMemo(
    () => detail.policy.decisionReasonCodes.filter((reason) => reason.allowedDecisions.includes(decision)),
    [decision, detail.policy.decisionReasonCodes],
  )
  const [reason, setReason] = useState('')
  const [aiDisposition, setAiDisposition] = useState<AiDisposition>(() => defaultAiDisposition(detail, 'accept'))
  const [informationQuestions, setInformationQuestions] = useState([''])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setReason(reasons[0]?.key ?? '')
    setAiDisposition(defaultAiDisposition(detail, decision))
  }, [decision, detail, reasons])

  const publish = async (event: FormEvent) => {
    event.preventDefault()
    if (!reason) return
    const submittedQuestions = decision === 'needs_information' ? informationQuestions : []
    const operationKey = JSON.stringify([
      detail.application.version,
      decision,
      reason,
      submittedQuestions,
      aiDisposition,
    ])
    const operation = operationRef.current?.key === operationKey
      ? operationRef.current
      : { key: operationKey, id: crypto.randomUUID() }
    operationRef.current = operation
    setBusy(true)
    setError(null)
    try {
      await decide({
        eventSlug,
        applicationId: detail.application.id,
        expectedApplicationVersion: detail.application.version,
        decision,
        reasonCode: reason,
        informationQuestions: submittedQuestions,
        aiDisposition,
        clientOperationId: operation.id,
      })
      operationRef.current = null
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="detail-section command-section final-command">
      <h2>Publish the decision</h2>
      <p className="muted">
        The team is emailed as soon as this is published, and it cannot be taken back. It decides
        admission only; it has no effect on hackathon judging.
      </p>
      <form className="command-form" onSubmit={publish}>
        <Field label="Decision">
          <select value={decision} onChange={(event) => setDecision(parseDecision(event.target.value))}>
            {applicationDecisions.map((value) => <option key={value} value={value}>{applicationDecisionLabels[value]}</option>)}
          </select>
        </Field>
        <Field label="Published reason">
          <select value={reason} onChange={(event) => setReason(event.target.value)}>
            {reasons.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </Field>
        {decision === 'needs_information' ? (
          <div className="field">
            <span>Questions for the team</span>
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
        <Field label="How you used the AI recommendation" hint="Recorded with the decision so the audit trail shows whether a person or a model drove it.">
          <select value={aiDisposition} onChange={(event) => setAiDisposition(parseAiDisposition(event.target.value))}>
            {aiDispositionOptions(detail, decision).map((value) => <option key={value} value={value}>{admissionAiDispositionLabels[value]}</option>)}
          </select>
        </Field>
        {detail.capacity ? (
          <p className="capacity-line">{detail.capacity.reserved} of {detail.capacity.capacity} places are held or confirmed.</p>
        ) : null}
        {error ? <p className="notice error" role="alert">{error}</p> : null}
        <button
          className="primary"
          type="submit"
          disabled={busy || !reason || (decision === 'needs_information' && informationQuestions.some((question) => question.trim().length < 8))}
        >
          {busy ? 'Publishing…' : `Publish ${applicationDecisionLabels[decision].toLowerCase()}`}
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

function can(access: Access, permissionKey: string, applicationId: string) {
  return access.grants.some(
    (grant) => grant.permissionKey === permissionKey &&
      (grant.scopeType === 'event' || (grant.scopeType === 'application' && grant.scopeId === applicationId)),
  )
}

function canAcceptAdmissionReview(state: string) {
  return state === 'submitted' || state === 'under_review' || state === 'needs_information'
}

/**
 * The one thing this application is waiting on, and who it is waiting on.
 *
 * The dossier used to open with a bare state name, which told a reader where
 * the record sat but never whether it was their move. Each branch below names
 * the action, and when the reader cannot take it, why not.
 */
function nextStep(
  detail: AdmissionDetailData,
  permissions: { canReview: boolean; canDecide: boolean; canManageOffer: boolean },
): { title: string; detail: string; blocker?: string } {
  const state = detail.application.state
  const { completedReviewCount } = detail.application
  const { minimumHumanReviews } = detail.policy
  const outstanding = minimumHumanReviews - completedReviewCount

  if (state === 'submitted' || state === 'under_review') {
    if (outstanding > 0) {
      return {
        title: `${outstanding} more ${outstanding === 1 ? 'review' : 'reviews'} needed`,
        detail: `${completedReviewCount} of ${minimumHumanReviews} organizer reviews are in. Read the project below, then add yours.`,
        ...(permissions.canReview ? {} : { blocker: 'You can read this application but not review it.' }),
      }
    }
    return {
      title: 'Ready for a decision',
      detail: `All ${minimumHumanReviews} required reviews are in. Publishing the decision emails the team.`,
      ...(permissions.canDecide ? {} : { blocker: 'Publishing a decision is outside your permission scope.' }),
    }
  }
  if (state === 'needs_information') {
    const asked = detail.currentInformationRequest?.questions.length ?? 0
    return {
      title: 'Waiting for the team',
      detail: `The team was asked ${asked === 1 ? 'a question' : `${asked} questions`}. Review continues once it answers; nothing is due from you.`,
    }
  }
  if (state === 'accepted') {
    return {
      title: 'Send the offer',
      detail: `${detail.team.name} was accepted but has not been offered a place. The places are not reserved until the offer goes out.`,
      ...(permissions.canManageOffer ? {} : { blocker: 'Sending offers is outside your permission scope.' }),
    }
  }
  if (state === 'offer_sent') {
    const expiresAt = detail.currentOffer?.expiresAt
    return {
      title: 'Waiting for the team to accept',
      detail: expiresAt
        ? `The team lead must accept by ${formatEventTime(expiresAt, detail.eventTimezone)}. If nobody answers, the reserved places go back to the pool.`
        : 'The team lead must accept before the deadline. If nobody answers, the reserved places go back to the pool.',
    }
  }
  if (state === 'confirmed') {
    return {
      title: 'Nothing left to do',
      detail: `${detail.team.name} accepted its place. Its ${placesLabel(detail.team.members.length)} are confirmed and it will appear at check-in.`,
    }
  }
  if (state === 'waitlisted') {
    return {
      title: 'On the waitlist',
      detail: 'The team has been told. It only moves if places are released by an expired or declined offer.',
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

function parseDecision(value: string): ApplicationDecision {
  return applicationDecisions.find((decision) => decision === value) ?? 'needs_information'
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

/** Team size stated in places, so a reader knows what an offer reserves. */
function placesLabel(count: number) {
  return `${count} ${count === 1 ? 'place' : 'places'}`
}

function teamSizeLabel(count: number) {
  return `${count} ${count === 1 ? 'member' : 'members'}`
}

function experienceBandName(band: AdmissionDetailData['application']['experienceBand']) {
  return band ? admissionExperienceBandLabels[band] : 'Experience band is outside your permission scope'
}

function sourceName(value: string) {
  if (value === 'initial_idea') return 'initial idea'
  if (value.startsWith('requested_information_')) return 'requested information'
  return 'follow-up answer'
}

function reasonLabel(detail: AdmissionDetailData, key: string) {
  return detail.policy.decisionReasonCodes.find((reason) => reason.key === key)?.label ?? key
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
