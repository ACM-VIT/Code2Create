import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useState, type FormEvent } from 'react'

import type { PublicState, SubmittedIntake } from '../types'
import { AttendancePanel } from '../components/AttendancePanel'
import { ReviewQueuePanel } from '../components/ReviewQueuePanel'
import { ReleasedFeedbackPanel } from '../components/ReleasedFeedbackPanel'
import { TeamLocationPanel } from '../components/TeamLocationPanel'
import { ProjectCheckpointsPanel } from '../components/ProjectCheckpointsPanel'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useMutationAttempt } from '../lib/operations'

type ParticipantDelivery = FunctionReturnType<typeof api.participantNotifications.mine>
type ParticipantDeliveryState = NonNullable<ParticipantDelivery>['state']
type CurrentApplication = SubmittedIntake['application']
type InformationRequest = NonNullable<CurrentApplication['informationRequest']>

const deliveryStatusCopy: Record<ParticipantDeliveryState, string> = {
  pending: 'Email queued.',
  sending: 'Email is being sent.',
  retry_wait: 'Email queued for another delivery attempt.',
  sent: 'Email accepted by the mail provider.',
  delivery_delayed: 'Email delivery is delayed.',
  delivered: 'Email reached your mail server. This does not confirm it was read.',
  bounced: 'Email could not be delivered. Your portal status above is authoritative.',
  failed: 'Email delivery failed. Your portal status above is authoritative.',
  suppressed: 'Email is disabled for this address. Your portal status above is authoritative.',
  unknown: 'Email delivery could not be confirmed. Your portal status above is authoritative.',
  superseded: 'A newer portal update replaced this email.',
}

export function SubmittedScreen({
  publicState,
}: {
  publicState: PublicState
}) {
  const intake = useQuery(api.intake.submitted, { eventSlug })
  if (intake === undefined) return <p className="muted">Loading your application…</p>
  if (intake === null) return null
  return <SubmittedWorkspace publicState={publicState} intake={intake} />
}

function SubmittedWorkspace({
  publicState,
  intake,
}: {
  publicState: PublicState
  intake: SubmittedIntake
}) {
  const application = intake.application
  const selected = ['accepted', 'offer_sent', 'confirmed'].includes(application.state)
  const delivery = useQuery(api.participantNotifications.mine, { eventSlug })
  const communications = useQuery(
    api.participantCommunications.current,
    selected ? { eventSlug } : 'skip',
  )
  const respondToOffer = useMutation(api.admissions.respondToOffer)
  const responseAttempt = useMutationAttempt<FunctionReturnType<typeof api.admissions.respondToOffer>>()
  const [pendingResponse, setPendingResponse] = useState<'confirm' | 'decline' | null>(null)
  const responsePending = responseAttempt.hasPending('offer-response')
  const [busy, setBusy] = useState<'confirm' | 'decline' | null>(null)
  const [confirmDecline, setConfirmDecline] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const event = publicState.event
  const [phaseTime, setPhaseTime] = useState(Date.now)
  const phases = event?.phases
  useEffect(() => {
    const nextBoundary = phases
      ?.flatMap((phase) => [phase.startsAt, phase.endsAt])
      .filter((timestamp) => timestamp > phaseTime)
      .toSorted((left, right) => left - right)[0]
    if (nextBoundary === undefined) return
    const timer = window.setTimeout(
      () => setPhaseTime(Date.now()),
      Math.min(nextBoundary - phaseTime + 100, 2_147_000_000),
    )
    return () => window.clearTimeout(timer)
  }, [phaseTime, phases])
  if (!event) return null
  const confirmed = application.state === 'confirmed'
  const track = intake.project.coreTrack
  const sponsorTracks = intake.project.sponsorTracks
  const currentPhase = event.phases.find(
    (phase) => phase.startsAt <= phaseTime && phaseTime < phase.endsAt,
  )
  const nextPhase = event.phases.find((phase) => phase.startsAt > phaseTime)
  const visiblePhase = currentPhase ?? nextPhase
  const discordIsNextStep = communications?.nextSteps.some(
    (step) => step.actionUrl === communications.discordUrl,
  ) ?? false

  const respond = async (response: 'confirm' | 'decline') => {
    const offer = application.currentOffer
    if (!offer || (pendingResponse !== null && pendingResponse !== response)) return
    if (!responsePending) setPendingResponse(response)
    setBusy(response)
    setError(null)
    try {
      await responseAttempt.run('offer-response', () => {
        const args = {
          eventSlug,
          applicationId: application.id,
          expectedApplicationVersion: application.version,
          expectedOfferVersion: offer.version,
          response,
          clientOperationId: crypto.randomUUID(),
        }
        return () => respondToOffer(args)
      })
      setPendingResponse(null)
      setConfirmDecline(false)
    } catch (caught) {
      if (!responseAttempt.hasPending('offer-response')) setPendingResponse(null)
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="intake-panel submitted-panel">
      <p className="eyebrow">{applicationStateName(application.state)}</p>
      <h1>{applicationHeading(application.state)}</h1>
      <p className="lead">
        {applicationMessage(application.state)}
      </p>
      <dl className="detail-list">
        {track ? <div><dt>Track</dt><dd>{track.displayName}</dd></div> : null}
        {sponsorTracks.length > 0 ? (
          <div><dt>Sponsor tracks</dt><dd>{sponsorTracks.map((sponsorTrack) => sponsorTrack.displayName).join(', ')}</dd></div>
        ) : null}
        {communications ? <div><dt>Venue</dt><dd>{communications.venueName}</dd></div> : null}
        {communications ? <div><dt>Starts</dt><dd>{formatEventTime(communications.startsAt, event.timezone)}</dd></div> : null}
      </dl>
      {application.state === 'needs_information' && application.informationRequest?.state === 'open' ? (
        <InformationResponsePanel
          application={application}
          currentRole={intake.currentRole}
          request={application.informationRequest}
        />
      ) : null}
      {application.state === 'offer_sent' && application.currentOffer ? (
        <div className="offer-response" aria-live="polite">
          <h2>Confirm your place</h2>
          <p>
            This offer covers your locked team. It expires on{' '}
            <strong>{formatEventTime(application.currentOffer.expiresAt, event.timezone)}</strong>.
          </p>
          {intake.currentRole === 'lead' ? (
            confirmDecline ? (
              <div className="offer-actions">
                <p>Declining releases the whole team’s places. You cannot undo this in the portal.</p>
                <button type="button" className="secondary" disabled={busy !== null || responsePending} onClick={() => setConfirmDecline(false)}>Keep offer</button>
                <button type="button" className="secondary danger-confirm" disabled={busy !== null || pendingResponse === 'confirm'} onClick={() => void respond('decline')}>
                  {busy === 'decline' ? 'Declining…' : pendingResponse === 'decline' ? 'Confirm earlier decline' : 'Decline for team'}
                </button>
              </div>
            ) : (
              <div className="offer-actions">
                <button type="button" className="primary" disabled={busy !== null || pendingResponse === 'decline'} onClick={() => void respond('confirm')}>
                  {busy === 'confirm' ? 'Confirming…' : pendingResponse === 'confirm' ? 'Confirm earlier response' : 'Confirm for team'}
                </button>
                <button type="button" className="text-button" disabled={busy !== null || responsePending} onClick={() => setConfirmDecline(true)}>Decline offer</button>
              </div>
            )
          ) : (
            <p className="fine-print">Your team lead must confirm for the team.</p>
          )}
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </div>
      ) : null}
      {selected && visiblePhase ? (
        <section className="event-phase-status">
          <p className="eyebrow">{currentPhase ? 'Current phase' : 'Next phase'}</p>
          <div>
            <h2>{visiblePhase.displayName}</h2>
            <time>
              {currentPhase ? 'Ends' : 'Starts'} {formatEventTime(
                currentPhase ? visiblePhase.endsAt : visiblePhase.startsAt,
                event.timezone,
              )}
            </time>
          </div>
          <p>{visiblePhase.description}</p>
        </section>
      ) : null}
      {selected && communications ? (
        <section className="accepted-next-steps">
          <h2>{confirmed ? 'Event details' : 'Next steps'}</h2>
          {communications.venueAddress ? (
            <p>
              {communications.venueAddress}
              {communications.venueMapUrl ? (
                <> · <a href={communications.venueMapUrl} target="_blank" rel="noreferrer">Map</a></>
              ) : null}
            </p>
          ) : null}
          <ol>
            {communications.nextSteps.map((step) => (
              <li key={step.stableKey}>
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
                {step.dueAt ? <time>By {formatEventTime(step.dueAt, event.timezone)}</time> : null}
                {step.actionUrl ? (
                  <a href={step.actionUrl}>
                    {step.actionUrl === communications.discordUrl ? 'Open Discord' : 'Open'}
                  </a>
                ) : null}
              </li>
            ))}
          </ol>
          {!discordIsNextStep ? (
            <a className="primary link-button" href={communications.discordUrl} target="_blank" rel="noreferrer">
              {communications.discordLabel}
            </a>
          ) : null}
        </section>
      ) : null}
      {confirmed ? (
        <div className="event-tools">
          <AttendancePanel />
          <ReviewQueuePanel />
          <ProjectCheckpointsPanel timezone={event.timezone} />
          <TeamLocationPanel />
          <ReleasedFeedbackPanel />
        </div>
      ) : null}
      {intake.project.initialIdea ? (
        <details className="submitted-summary">
          <summary>Your project</summary>
          <p>{intake.project.initialIdea}</p>
        </details>
      ) : null}
      {delivery && deliveryNeedsAttention(delivery.state) ? (
        <p className="notice error" role="status">{deliveryStatusCopy[delivery.state]}</p>
      ) : null}
    </section>
  )
}

function InformationResponsePanel({
  application,
  currentRole,
  request,
}: {
  application: CurrentApplication
  currentRole: SubmittedIntake['currentRole']
  request: InformationRequest
}) {
  const respondToInformationRequest = useMutation(api.admissions.respondToInformationRequest)
  const responseAttempt = useMutationAttempt<FunctionReturnType<typeof api.admissions.respondToInformationRequest>>()
  const responsePending = responseAttempt.hasPending(`information-response:${request.id}`)
  const [draft, setDraft] = useState(() => ({
    requestId: request.id,
    answers: request.questions.map((question) => ({
      questionKey: question.questionKey,
      answer: '',
    })),
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (draft.requestId === request.id) return
    setDraft({
      requestId: request.id,
      answers: request.questions.map((question) => ({
        questionKey: question.questionKey,
        answer: '',
      })),
    })
  }, [draft.requestId, request])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await responseAttempt.run(`information-response:${request.id}`, () => {
        const args = {
          eventSlug,
          applicationId: application.id,
          expectedApplicationVersion: application.version,
          requestId: request.id,
          expectedRequestVersion: request.version,
          answers: draft.answers.map((answer) => ({ ...answer })),
          clientOperationId: crypto.randomUUID(),
        }
        return () => respondToInformationRequest(args)
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="information-response">
      <h2>A quick follow-up</h2>
      <p>Answer only these questions. Your team and track stay locked.</p>
      {currentRole === 'lead' ? (
        <form onSubmit={submit}>
          {request.questions.map((question, index) => (
            <label className="field" key={question.questionKey}>
              <span>{question.question}</span>
              <textarea
                required
                minLength={2}
                maxLength={1200}
                disabled={responsePending}
                value={draft.answers[index]?.answer ?? ''}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  answers: current.answers.map((answer, answerIndex) => (
                    answerIndex === index
                      ? { ...answer, answer: event.currentTarget.value }
                      : answer
                  )),
                }))}
              />
            </label>
          ))}
          {error ? <p className="notice error" role="alert">{error}</p> : null}
          <button
            className="primary"
            type="submit"
            disabled={busy || draft.answers.some((answer) => answer.answer.trim().length < 2)}
          >
            {busy ? 'Submitting…' : responsePending ? 'Confirm earlier answers' : 'Submit answers'}
          </button>
        </form>
      ) : <p className="fine-print">The locked team lead submits these answers for the team.</p>}
    </section>
  )
}

function formatEventTime(timestamp: number, timezone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}

function applicationHeading(state: string) {
  if (state === 'accepted' || state === 'offer_sent') return 'You’re selected.'
  if (state === 'confirmed') return 'You’re confirmed.'
  if (state === 'waitlisted') return 'You’re on the waitlist.'
  if (state === 'declined') return 'Application update.'
  if (state === 'offer_expired') return 'The offer expired.'
  if (state === 'withdrawn') return 'The offer was declined.'
  if (state === 'needs_information') return 'A quick follow-up.'
  return 'Submitted.'
}

function applicationMessage(state: string) {
  if (state === 'accepted') return 'Your team has been selected. Your offer will appear here.'
  if (state === 'offer_sent') return 'Your team’s places are held until the deadline below.'
  if (state === 'confirmed') return 'Your team has a place at Code2Create.'
  if (state === 'submitted' || state === 'under_review') return 'We have your application. Your team and track are locked.'
  if (state === 'needs_information') return 'Answer the questions below so the review can continue.'
  if (state === 'offer_expired') return 'The reserved places were released when the response deadline passed.'
  if (state === 'withdrawn') return 'The team declined its offer, so the reserved places were released.'
  return 'This is the current application state.'
}

function applicationStateName(state: string) {
  if (state === 'submitted') return 'Application received'
  if (state === 'under_review') return 'Under review'
  if (state === 'needs_information') return 'Your response is needed'
  if (state === 'accepted' || state === 'offer_sent') return 'Selected'
  if (state === 'confirmed') return 'Confirmed'
  if (state === 'waitlisted') return 'Waitlisted'
  if (state === 'declined') return 'Decision published'
  if (state === 'offer_expired') return 'Offer expired'
  if (state === 'withdrawn') return 'Offer declined'
  return 'Application'
}

function deliveryNeedsAttention(state: ParticipantDeliveryState) {
  return state === 'delivery_delayed' ||
    state === 'bounced' ||
    state === 'failed' ||
    state === 'suppressed' ||
    state === 'unknown'
}
