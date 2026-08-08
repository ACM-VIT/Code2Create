import { api } from '@code2create/backend/api'
import { applicationDecisions, type ApplicationDecision } from '@code2create/domain'
import { TZDateMini } from '@date-fns/tz'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { ParticipantDeliveryStatus } from '../components/ParticipantDeliveryStatus'

type AdmissionDetailData = NonNullable<FunctionReturnType<typeof api.admissions.detail>>
type Access = NonNullable<FunctionReturnType<typeof api.access.mine>>
type AiDisposition = 'used' | 'cleared' | 'overridden' | 'stale' | 'unavailable'

export function AdmissionDetail({ access }: { access: Access }) {
  const { applicationId } = useParams()
  const detail = useQuery(
    api.admissions.detail,
    applicationId ? { eventSlug, applicationId } : 'skip',
  )

  if (!applicationId) return <p className="notice error">Application ID is missing.</p>
  if (detail === undefined) return <p className="muted">Loading application…</p>
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
  const reviewRecord = (
    <details className="application-record" open={reviewOpen || undefined}>
      <summary>
        <span>Admission review</span>
        <small>{detail.application.completedReviewCount} of {detail.policy.minimumHumanReviews} reviews complete</small>
      </summary>
      <div>
        <section className="detail-section">
          <div className="section-heading">
            <div>
              <h2>What to look for</h2>
              <p className="muted">{experienceName(detail.application.experienceBand ?? 'mixed_or_external')}</p>
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
        {detail.aiRecommendationVisible ? <AiRecommendation detail={detail} /> : null}
        {detail.currentInformationRequest?.state === 'open' ? <InformationRequest detail={detail} /> : null}
        <HumanReviews detail={detail} />
        {canAssign && detail.reviewAssignments ? <ReviewAssignmentControl detail={detail} /> : null}
      </div>
    </details>
  )

  return (
    <article className="application-detail">
      <Link className="back-link" to="/admissions">← Applications</Link>
      <header className="application-heading">
        <div>
          <p className="eyebrow">{detail.project.trackName}</p>
          <h1>{detail.team.name}</h1>
          <p className="muted">
            {detail.application.experienceBand ? experienceName(detail.application.experienceBand) : 'Application'}
          </p>
        </div>
        <span className="state-label">{applicationStateName(detail.application.state)}</span>
      </header>

      <ApplicationState detail={detail} />

      <section className="detail-section">
        <h2>Team</h2>
        <ul className="member-grid">
          {detail.team.members.map((member) => (
            <li key={member.membershipId}>
              <strong>{member.displayName}</strong>
              {member.profileContext ? (
                <>
                  <span>{participantClassName(member.profileContext.participantClass)} · {yearName(member.profileContext.yearOfStudy)}</span>
                  <span>{member.profileContext.institution}</span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
        {detail.team.members.every((member) => member.profileContext === null) ? (
          <p className="muted">Profile and year context is outside this permission scope.</p>
        ) : null}
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

      {reviewOpen ? reviewRecord : null}
      {canReview && canAcceptAdmissionReview(detail.application.state) ? <ReviewForm detail={detail} /> : null}
      {canDecide && canAcceptAdmissionReview(detail.application.state) && hasRequiredReviews ? (
        <DecisionForm detail={detail} />
      ) : null}
      {detail.application.humanDecision && canReadParticipantDelivery ? (
        <ParticipantDeliveryStatus applicationId={detail.application.id} />
      ) : null}
      {canManageOffer && detail.application.humanDecision === 'accept' ? <OfferControl detail={detail} /> : null}
      {!reviewOpen ? reviewRecord : null}
    </article>
  )
}

function ApplicationState({ detail }: { detail: AdmissionDetailData }) {
  const state = applicationStateCopy(detail)
  return (
    <section className="application-state-summary">
      <div>
        <span>Current step</span>
        <strong>{state.title}</strong>
      </div>
      <p>{state.detail}</p>
    </section>
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

  return (
    <section className="detail-section command-section">
      <h2>Offer</h2>
      {detail.currentOffer ? (
        <>
          <dl className="criteria-list compact-criteria">
            <div><dt>Status</dt><dd>{offerStateName(detail.currentOffer.state)}</dd></div>
            <div><dt>Places</dt><dd>{detail.currentOffer.participantCount}</dd></div>
            <div><dt>Deadline</dt><dd>{formatEventTime(detail.currentOffer.expiresAt, detail.eventTimezone)}</dd></div>
          </dl>
          {detail.currentOffer.state === 'offered' ? (
            <form className="command-form" onSubmit={revoke}>
              <Field label="Revoke reason" hint="Revocation releases capacity and returns the application to accepted so a corrected offer can be sent.">
                <textarea required minLength={3} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} />
              </Field>
              <button className="secondary" type="submit" disabled={busy !== null || !reason.trim()}>
                {busy === 'revoke' ? 'Revoking…' : 'Revoke offer'}
              </button>
            </form>
          ) : null}
        </>
      ) : detail.application.state === 'accepted' ? (
        <form className="command-form" onSubmit={submitOffer}>
          <Field label={`Response deadline · ${detail.eventTimezone}`} hint="Sending reserves the locked team’s places until this event-local time.">
            <input required type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
          </Field>
          {detail.capacity ? (
            <p className="capacity-line">{detail.capacity.reserved} of {detail.capacity.capacity} places are held or confirmed.</p>
          ) : null}
          <button className="primary" type="submit" disabled={busy !== null || !deadline}>
            {busy === 'send' ? 'Sending…' : 'Send offer'}
          </button>
        </form>
      ) : (
        <p className="muted">No open offer action is available for this application state.</p>
      )}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function AiRecommendation({ detail }: { detail: AdmissionDetailData }) {
  const recommendation = detail.aiRecommendation
  return (
    <section className="detail-section ai-section">
      <div className="section-heading">
        <div>
          <h2>AI recommendation</h2>
          <p className="muted">Input to the human admission decision. Never used in judging.</p>
        </div>
        <span className="state-label">{recommendationStateName(recommendation?.state)}</span>
      </div>
      {recommendation?.recommendation ? (
        <p className="recommendation-line">Recommend {decisionName(recommendation.recommendation)}</p>
      ) : null}
      {recommendation?.criterionAssessments.length ? (
        <dl className="criteria-list compact-criteria">
          {recommendation.criterionAssessments.map((assessment) => {
            const policyCriterion = detail.policy.criteria.find(
              (criterion) => criterion.criterionKey === assessment.criterionKey,
            )
            return (
              <div key={assessment.criterionKey}>
                <dt>{policyCriterion?.label ?? assessment.criterionKey}</dt>
                <dd>{assessmentName(assessment.assessment)} · sources: {assessment.sourceRefs.map(sourceName).join(', ')}</dd>
              </div>
            )
          })}
        </dl>
      ) : null}
      {recommendation?.strengths.length ? <TextList label="Strengths" values={recommendation.strengths} /> : null}
      {recommendation?.concerns.length ? <TextList label="Concerns" values={recommendation.concerns} /> : null}
      {recommendation?.proposedQuestions.length ? <TextList label="Questions for humans" values={recommendation.proposedQuestions} /> : null}
      {recommendation?.limitations.length ? <TextList label="Limitations" values={recommendation.limitations} /> : null}
    </section>
  )
}

function HumanReviews({ detail }: { detail: AdmissionDetailData }) {
  return (
    <section className="detail-section">
      <div className="section-heading">
        <h2>Organizer reviews</h2>
        <span className="state-label">{detail.application.completedReviewCount} / {detail.policy.minimumHumanReviews} required</span>
      </div>
      {detail.humanReviews.length ? (
        <ul className="review-list">
          {detail.humanReviews.map((review) => (
            <li key={review.id}>
              <div><strong>{review.reviewerName}</strong><span>{decisionName(review.recommendation)} · {reasonLabel(detail, review.reasonCode)}</span></div>
              {review.note ? <p>{review.note}</p> : null}
            </li>
          ))}
        </ul>
      ) : <p className="muted">No human review has been saved yet.</p>}
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
        <span className="state-label">{informationStateName(request.state)}</span>
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

  return (
    <section className="detail-section command-section">
      <div className="section-heading">
        <div>
          <h2>Assign reviewers</h2>
        </div>
        <span className="state-label">{detail.application.assignedReviewCount} assigned · {detail.application.completedReviewCount} complete</span>
      </div>
      <form className="command-form compact-command" onSubmit={assign}>
        <Field label="Reviewer Google email">
          <input required type="email" value={reviewerEmail} onChange={(event) => setReviewerEmail(event.target.value)} />
        </Field>
        <button className="secondary" type="submit" disabled={busy !== null || !reviewerEmail.trim()}>
          {busy === 'assign' ? 'Assigning…' : 'Assign review'}
        </button>
      </form>
      {assignments.length > 0 ? (
        <ul className="review-list assignment-list">
          {assignments.map((assignment) => (
            <li key={assignment.id}>
              <div>
                <strong>{assignment.reviewerName}</strong>
                <span>{assignment.reviewerEmail} · {assignment.state}</span>
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
      ) : <p className="muted">No review work is assigned yet.</p>}
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
      <form className="command-form" onSubmit={submit}>
        <Field label="Recommendation">
          <select value={recommendation} onChange={(event) => setRecommendation(parseDecision(event.target.value))}>
            {applicationDecisions.map((decision) => <option key={decision} value={decision}>{decisionName(decision)}</option>)}
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
      <h2>Publish decision</h2>
      <p className="muted">This admission decision does not affect hackathon judging.</p>
      <form className="command-form" onSubmit={publish}>
        <Field label="Decision">
          <select value={decision} onChange={(event) => setDecision(parseDecision(event.target.value))}>
            {applicationDecisions.map((value) => <option key={value} value={value}>{decisionName(value)}</option>)}
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
        <Field label="AI recommendation use">
          <select value={aiDisposition} onChange={(event) => setAiDisposition(parseAiDisposition(event.target.value))}>
            {aiDispositionOptions(detail, decision).map((value) => <option key={value} value={value}>{aiDispositionName(value)}</option>)}
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
          {busy ? 'Publishing…' : `Publish ${decisionName(decision)}`}
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

function applicationStateName(state: string) {
  if (state === 'submitted') return 'Submitted'
  if (state === 'under_review') return 'Under review'
  if (state === 'needs_information') return 'Waiting on team'
  if (state === 'accepted') return 'Accepted'
  if (state === 'waitlisted') return 'Waitlisted'
  if (state === 'declined') return 'Not selected'
  if (state === 'offer_sent') return 'Offer sent'
  if (state === 'confirmed') return 'Confirmed'
  if (state === 'offer_expired') return 'Offer expired'
  if (state === 'withdrawn') return 'Offer declined'
  return state.replaceAll('_', ' ')
}

function applicationStateCopy(detail: AdmissionDetailData) {
  const state = detail.application.state
  if (state === 'submitted') {
    return { title: 'Needs a first review', detail: 'Read the project, then add an organizer review.' }
  }
  if (state === 'under_review') {
    if (detail.application.completedReviewCount >= detail.policy.minimumHumanReviews) {
      return {
        title: 'Choose an admission decision',
        detail: 'The required organizer review is complete.',
      }
    }
    return {
      title: 'Review in progress',
      detail: `${detail.application.completedReviewCount} of ${detail.policy.minimumHumanReviews} required reviews are complete.`,
    }
  }
  if (state === 'needs_information') {
    return { title: 'Waiting for the team', detail: 'The admission review continues after the team answers the open questions.' }
  }
  if (state === 'accepted') {
    return { title: 'Send the offer', detail: 'Set a response deadline to reserve places for this locked team.' }
  }
  if (state === 'offer_sent') {
    return { title: 'Waiting for confirmation', detail: 'The team lead must accept before the offer deadline.' }
  }
  if (state === 'confirmed') {
    return { title: 'Team confirmed', detail: 'The team accepted its offer. No admission action is due.' }
  }
  if (state === 'waitlisted') {
    return { title: 'On the waitlist', detail: 'The published decision is visible to the team.' }
  }
  if (state === 'declined') {
    return { title: 'Decision published', detail: 'The team was not selected.' }
  }
  if (state === 'offer_expired') {
    return { title: 'Offer expired', detail: 'The reserved places were released.' }
  }
  if (state === 'withdrawn') {
    return { title: 'Offer declined', detail: 'The team declined and its reserved places were released.' }
  }
  return { title: applicationStateName(state), detail: 'The application record is current.' }
}

function offerStateName(state: string) {
  if (state === 'offered') return 'Waiting for team'
  if (state === 'confirmed') return 'Confirmed'
  if (state === 'declined') return 'Declined'
  if (state === 'expired') return 'Expired'
  if (state === 'revoked') return 'Revoked'
  return state.replaceAll('_', ' ')
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

function decisionName(value: string) {
  if (value === 'accept') return 'Accept'
  if (value === 'waitlist') return 'Waitlist'
  if (value === 'decline') return 'Decline'
  return 'Needs information'
}

function aiDispositionName(value: AiDisposition) {
  if (value === 'used') return 'Use recommendation'
  if (value === 'cleared') return 'Do not use recommendation'
  if (value === 'overridden') return 'Override recommendation'
  if (value === 'stale') return 'Recommendation is stale'
  return 'Recommendation unavailable'
}

function assessmentName(value: string) {
  if (value === 'meets') return 'Meets'
  if (value === 'partly_meets') return 'Partly meets'
  return 'Not yet clear'
}

function recommendationStateName(value: string | undefined) {
  if (value === 'succeeded') return 'Ready'
  if (value === 'pending' || value === 'running') return 'Preparing'
  if (value === 'stale') return 'Outdated'
  if (value === 'rate_limited' || value === 'timed_out') return 'Try again later'
  if (value === 'disabled') return 'Turned off'
  if (value === 'refused' || value === 'invalid' || value === 'failed') return 'Could not prepare'
  return 'Unavailable'
}

function informationStateName(value: string) {
  if (value === 'open') return 'Waiting for team'
  if (value === 'answered') return 'Answered'
  if (value === 'superseded') return 'Replaced'
  const label = value.replaceAll('_', ' ')
  return `${label.slice(0, 1).toUpperCase()}${label.slice(1)}`
}

function sourceName(value: string) {
  if (value === 'initial_idea') return 'initial idea'
  if (value.startsWith('requested_information_')) return 'requested information'
  return 'follow-up answer'
}

function reasonLabel(detail: AdmissionDetailData, key: string) {
  return detail.policy.decisionReasonCodes.find((reason) => reason.key === key)?.label ?? key
}

function participantClassName(value: string) {
  return value === 'vit_student' ? 'VIT student' : 'External participant'
}

function yearName(value: string) {
  if (value === 'first') return 'First year'
  if (value === 'second') return 'Second year'
  if (value === 'third') return 'Third year'
  if (value === 'fourth') return 'Fourth year'
  if (value === 'fifth_or_later') return 'Fifth year or later'
  if (value === 'postgraduate') return 'Postgraduate'
  return 'Not a student'
}

function experienceName(value: string) {
  if (value === 'first_year') return 'First-year expectations'
  if (value === 'early_year') return 'Early-year expectations'
  if (value === 'later_year') return 'Later-year expectations'
  if (value === 'postgraduate_or_professional') return 'Postgraduate or professional expectations'
  return 'Mixed or external expectations'
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
