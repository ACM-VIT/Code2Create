import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import type { CurrentTeam, CurrentTeamMember, PublicState, SubmittedIntake } from '../types'
import { AttendancePanel } from '../components/AttendancePanel'
import { ReviewQueuePanel } from '../components/ReviewQueuePanel'
import { ReleasedFeedbackPanel } from '../components/ReleasedFeedbackPanel'
import { EditingPresence } from '../components/EditingPresence'
import { useEditingPresence } from '../hooks/useEditingPresence'
import { TeamLocationPanel } from '../components/TeamLocationPanel'
import { ProjectCheckpointsPanel } from '../components/ProjectCheckpointsPanel'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useMutationAttempt } from '../lib/operations'
import { PortalScene } from '../components/portal/PortalScene'
import { PetalCard } from '../components/portal/PetalCard'
import { Petal } from '../components/portal/Petal'
import { TeamCluster } from '../components/portal/TeamCluster'
import {
  clearSessionDraft,
  readVersionedSessionDraft,
  sessionDraftConflicts,
  writeVersionedSessionDraft,
} from '../lib/sessionDraft'

type ParticipantDelivery = FunctionReturnType<typeof api.participantNotifications.mine>
type ParticipantDeliveryState = NonNullable<ParticipantDelivery>['state']
type ParticipantCapabilities = FunctionReturnType<typeof api.access.participantCapabilities>
type ParticipantCommunications = NonNullable<FunctionReturnType<typeof api.participantCommunications.current>>
type CurrentApplication = SubmittedIntake['application']
type ApplicationState = CurrentApplication['state']
type InformationRequest = NonNullable<CurrentApplication['informationRequest']>

const deliveryStatusCopy: Record<ParticipantDeliveryState, string> = {
  pending: 'Email queued.',
  sending: 'Email is being sent.',
  retry_wait: 'We will try to send the email again.',
  sent: 'Email sent.',
  delivery_delayed: 'The email is taking longer than expected.',
  delivered: 'Email delivered.',
  bounced: 'The email could not be delivered. Check this page for the latest status.',
  failed: 'The email could not be sent. Check this page for the latest status.',
  suppressed: 'Email updates are turned off for this address. Check this page for the latest status.',
  unknown: 'We could not confirm email delivery. Check this page for the latest status.',
  superseded: 'A newer update replaced this email.',
}

const applicationCopy: Record<ApplicationState, {
  heading: string
  message: string
  status: string
}> = {
  submitted: {
    status: 'Application received',
    heading: 'Submitted.',
    message: 'We have your application. Your team is locked; the lead can revise the proposal until the deadline.',
  },
  under_review: {
    status: 'Under review',
    heading: 'Your application is being reviewed.',
    message: 'Your team remains locked. We will post the decision here.',
  },
  needs_information: {
    status: 'Your response is needed',
    heading: 'A quick follow-up.',
    message: 'Answer the questions below so the review can continue.',
  },
  accepted: {
    status: 'Selected',
    heading: 'You’re selected.',
    message: 'Your team has been selected. Your offer will appear here.',
  },
  waitlisted: {
    status: 'Waitlisted',
    heading: 'You’re on the waitlist.',
    message: 'Your application is still active. We will send an update if a place opens.',
  },
  declined: {
    status: 'Decision published',
    heading: 'Application update.',
    message: 'Your team was not selected for this event. Thank you for sharing your idea.',
  },
  offer_sent: {
    status: 'Selected',
    heading: 'You’re selected.',
    message: 'Your team’s places are held until the deadline below.',
  },
  confirmed: {
    status: 'Confirmed',
    heading: 'You’re confirmed.',
    message: 'Your team has a place at Code2Create.',
  },
  offer_expired: {
    status: 'Offer expired',
    heading: 'The offer expired.',
    message: 'The reserved places were released when the response deadline passed.',
  },
  withdrawn: {
    status: 'Offer declined',
    heading: 'The offer was declined.',
    message: 'The team declined its offer, so the reserved places were released.',
  },
}

/** The states the quiet queue screen (mockup f7) covers, before any decision. */
const QUEUED_STATES: readonly ApplicationState[] = ['submitted', 'under_review', 'needs_information']

export function SubmittedScreen({
  capabilities,
  publicState,
  team,
  members,
  onSignOut,
}: {
  capabilities: ParticipantCapabilities
  publicState: PublicState
  team: CurrentTeam
  members: CurrentTeamMember[]
  onSignOut: () => void
}) {
  const intake = useQuery(api.intake.submitted, { eventSlug })
  if (intake === undefined) return <p className="muted">Loading your application…</p>
  if (intake === null) {
    return <p className="notice notice-error" role="alert">Your application could not be opened. Refresh or ask an organizer for help.</p>
  }
  return (
    <SubmittedWorkspace
      capabilities={capabilities}
      publicState={publicState}
      intake={intake}
      team={team}
      members={members}
      onSignOut={onSignOut}
    />
  )
}

function SubmittedWorkspace({
  capabilities,
  publicState,
  intake,
  team,
  members,
  onSignOut,
}: {
  capabilities: ParticipantCapabilities
  publicState: PublicState
  intake: SubmittedIntake
  team: CurrentTeam
  members: CurrentTeamMember[]
  onSignOut: () => void
}) {
  const application = intake.application
  const copy = applicationCopy[application.state]
  const selected = ['accepted', 'offer_sent', 'confirmed'].includes(application.state)
  const delivery = useQuery(
    api.participantNotifications.mine,
    capabilities?.notifications ? { eventSlug } : 'skip',
  )
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
  const [proposalOpen, setProposalOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const event = publicState.event
  const phaseClock = useRef({
    serverNow: intake.serverNow,
    clientNow: performance.now(),
  })
  const [phaseTime, setPhaseTime] = useState(intake.serverNow)
  const phases = event?.phases
  useEffect(() => {
    phaseClock.current = {
      serverNow: intake.serverNow,
      clientNow: performance.now(),
    }
    setPhaseTime(intake.serverNow)
  }, [intake.serverNow])
  useEffect(() => {
    const nextBoundary = [
      ...(phases?.flatMap((phase) => [phase.startsAt, phase.endsAt]) ?? []),
      intake.applicationsCloseAt,
    ]
      .filter((timestamp) => timestamp > phaseTime)
      .toSorted((left, right) => left - right)[0]
    if (nextBoundary === undefined) return
    const timer = window.setTimeout(
      () => {
        const currentClientNow = performance.now()
        setPhaseTime(
          phaseClock.current.serverNow + currentClientNow - phaseClock.current.clientNow,
        )
      },
      Math.min(nextBoundary - phaseTime + 100, 2_147_000_000),
    )
    return () => window.clearTimeout(timer)
  }, [intake.applicationsCloseAt, phaseTime, phases])
  if (!event) {
    return <p className="notice notice-error" role="alert">Event details are unavailable right now.</p>
  }
  const confirmed = application.state === 'confirmed'
  const currentPhase = event.phases.find(
    (phase) => phase.startsAt <= phaseTime && phaseTime < phase.endsAt,
  )
  const nextPhase = event.phases.find((phase) => phase.startsAt > phaseTime)
  const visiblePhase = currentPhase ?? nextPhase
  const eventIsLive = confirmed && currentPhase !== undefined
  const canEditProposal = intake.canEdit && phaseTime < intake.applicationsCloseAt

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

  // ---- f7 · the quiet queue state ----------------------------------------
  // Everything before a decision reads as one still screen; the proposal
  // editor stays one click away rather than sitting open under the hero.
  if (!selected && QUEUED_STATES.includes(application.state)) {
    return (
      <PortalScene
        tree="none"
        header={<TeamCluster team={team} members={members} locked onSignOut={onSignOut} />}
      >
        <div className="flex w-full max-w-[760px] flex-col items-center text-center">
          <div className="mb-5 drop-shadow-[0_0_14px_rgba(254,180,203,.5)]">
            <Petal size={34} />
          </div>
          <h1 className="mb-3.5 font-display text-5xl leading-none text-shadow-[0_8px_50px_rgba(0,0,0,.6)] lg:text-[70px]">
            {copy.heading}
          </h1>
          <p className="mb-8 font-display text-base italic text-rose-light lg:text-[19px]">
            {application.state === 'needs_information'
              ? copy.message
              : `${team.name} is in the review queue`}
          </p>

          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-[13px] text-[rgb(248_248_248/.65)]">
            <span>
              status <span className="text-paper">{copy.status.toLowerCase()}</span>
            </span>
            <span aria-hidden className="hidden h-3.5 w-px bg-[rgb(216_132_162/.4)] sm:block" />
            <span>
              team <span className="text-rose-light">locked</span>
            </span>
            {canEditProposal ? (
              <>
                <span aria-hidden className="hidden h-3.5 w-px bg-[rgb(216_132_162/.4)] sm:block" />
                <span>
                  editable until{' '}
                  <span className="text-paper">
                    {formatEventTime(intake.applicationsCloseAt, event.timezone)}
                  </span>
                </span>
              </>
            ) : null}
          </div>

          {application.state === 'needs_information' &&
          application.informationRequest?.state === 'open' ? (
            <div className="mt-9 w-full text-left">
              <PetalCard className="px-7 py-6">
                <InformationResponsePanel
                  application={application}
                  canRespond={intake.currentRole === 'lead' && team.canRespondToInformationRequest}
                  currentRole={intake.currentRole}
                  request={application.informationRequest}
                />
              </PetalCard>
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => setProposalOpen((open) => !open)}
            className="mt-8 rounded-sm text-[13.5px] text-rose-light underline-offset-4 hover:underline"
          >
            {proposalOpen
              ? 'hide proposal'
              : canEditProposal
                ? 'edit proposal'
                : 'view proposal'}
          </button>

          {proposalOpen ? (
            <div className="mt-6 w-full text-left">
              <PetalCard className="px-7 py-6">
                <ProposalSummary
                  application={application}
                  canEdit={canEditProposal}
                  intake={intake}
                  members={members}
                  timezone={event.timezone}
                />
              </PetalCard>
            </div>
          ) : null}

          {delivery && deliveryNeedsAttention(delivery.state) ? (
            <p role="status" className="mt-6 text-[12.5px] text-rose-light">
              {deliveryStatusCopy[delivery.state]}
            </p>
          ) : null}
        </div>
      </PortalScene>
    )
  }

  return (
    <section className="intake-panel submitted-panel">
      {eventIsLive ? (
        <header className="participant-now">
          <p className="eyebrow">Now</p>
          <h1>{currentPhase.displayName}</h1>
          <p className="lead">{currentPhase.description}</p>
          <div className="participant-now-meta">
            <span>Confirmed</span>
            <time>Ends {formatEventTime(currentPhase.endsAt, event.timezone)}</time>
          </div>
        </header>
      ) : (
        <>
          <p className="eyebrow">{copy.status}</p>
          <h1>{copy.heading}</h1>
          <p className="lead">{copy.message}</p>
          {communications ? (
            <dl className="detail-list">
              <div><dt>Venue</dt><dd>{communications.venueName}</dd></div>
              <div><dt>Starts</dt><dd>{formatEventTime(communications.startsAt, event.timezone)}</dd></div>
            </dl>
          ) : null}
        </>
      )}
      {application.state === 'needs_information' && application.informationRequest?.state === 'open' ? (
        <InformationResponsePanel
          application={application}
          canRespond={intake.currentRole === 'lead' && team.canRespondToInformationRequest}
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
          {intake.currentRole === 'lead' && team.canRespondToOffer ? (
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
          ) : intake.currentRole !== 'lead' ? (
            <p className="fine-print">Your team lead must confirm for the team.</p>
          ) : (
            <p className="fine-print">Offer response is unavailable. Ask an organizer if this looks wrong.</p>
          )}
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </div>
      ) : null}
      {selected && visiblePhase && !eventIsLive ? (
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
      {eventIsLive ? (
        <EventTools capabilities={capabilities} timezone={event.timezone} />
      ) : null}
      {selected && communications ? (
        <AcceptedTeamDetails
          communications={communications}
          compact={eventIsLive}
          heading={confirmed ? 'Event details' : 'Next steps'}
          timezone={event.timezone}
        />
      ) : null}
      {confirmed && !eventIsLive ? (
        <EventTools capabilities={capabilities} timezone={event.timezone} />
      ) : null}
      <ProposalSummary
        application={application}
        canEdit={canEditProposal}
        intake={intake}
        members={members}
        timezone={event.timezone}
      />
      {delivery && deliveryNeedsAttention(delivery.state) ? (
        <p className="notice error" role="status">{deliveryStatusCopy[delivery.state]}</p>
      ) : null}
    </section>
  )
}

function EventTools({
  capabilities,
  timezone,
}: {
  capabilities: ParticipantCapabilities
  timezone: string
}) {
  return (
    <div className="event-tools">
      {capabilities?.attendance ? <AttendancePanel /> : null}
      {capabilities?.floor ? <TeamLocationPanel /> : null}
      {capabilities?.projectCheckpoints ? (
        <ProjectCheckpointsPanel timezone={timezone} />
      ) : null}
      {capabilities?.reviewQueue ? <ReviewQueuePanel /> : null}
      {capabilities?.scoreFeedback ? <ReleasedFeedbackPanel /> : null}
    </div>
  )
}

function AcceptedTeamDetails({
  communications,
  compact,
  heading,
  timezone,
}: {
  communications: ParticipantCommunications
  compact: boolean
  heading: string
  timezone: string
}) {
  const discordIsNextStep = communications.nextSteps.some(
    (step) => step.actionUrl === communications.discordUrl,
  )
  const content = (
    <>
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
            {step.dueAt ? <time>By {formatEventTime(step.dueAt, timezone)}</time> : null}
            {step.actionUrl ? (
              <a href={step.actionUrl} target="_blank" rel="noreferrer">
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
    </>
  )

  if (compact) {
    return (
      <details className="accepted-next-steps accepted-next-steps-compact">
        <summary>
          <span>{heading}</span>
          <small>{communications.venueName} · arrival and Discord</small>
        </summary>
        <div className="accepted-next-steps-body">{content}</div>
      </details>
    )
  }

  return (
    <section className="accepted-next-steps">
      <h2>{heading}</h2>
      {content}
    </section>
  )
}

function ProposalSummary({
  application,
  canEdit,
  intake,
  members,
  timezone,
}: {
  application: CurrentApplication
  canEdit: boolean
  intake: SubmittedIntake
  members: CurrentTeamMember[]
  timezone: string
}) {
  const reviseSubmission = useMutation(api.intake.reviseSubmission)
  const revisionAttempt = useMutationAttempt<FunctionReturnType<typeof api.intake.reviseSubmission>>()
  const pending = revisionAttempt.hasPending('proposal-revision')
  const proposalStorageKey = `c2c:${eventSlug}:${application.id}:proposal`
  const [recoveredDraft] = useState(() => readVersionedSessionDraft(proposalStorageKey))
  const currentEditBase = proposalEditBase(application, intake)
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState(() => (
    recoveredDraft === null
      ? proposalDraft(intake)
      : recoverProposalDraft(intake, recoveredDraft.value)
  ))
  const [hasRecoveredDraft, setHasRecoveredDraft] = useState(recoveredDraft !== null)
  const editBase = useRef(currentEditBase)
  const [editConflict, setEditConflict] = useState(
    sessionDraftConflicts(recoveredDraft, proposalEditBaseFingerprint(currentEditBase)),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { editors, markEditing, stopEditing } = useEditingPresence(canEdit && editing)

  useEffect(() => {
    const latest = proposalEditBase(application, intake)
    if (proposalEditBaseFingerprint(editBase.current) === proposalEditBaseFingerprint(latest)) return
    if (editing || hasRecoveredDraft) {
      setEditConflict(true)
      return
    }
    editBase.current = latest
    setDraft(proposalDraft(intake))
  }, [application, editing, hasRecoveredDraft, intake])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await revisionAttempt.run('proposal-revision', () => {
        const args = {
          eventSlug,
          applicationId: application.id,
          expectedApplicationVersion: editBase.current.applicationVersion,
          expectedApplicationContentVersion: editBase.current.applicationContentVersion,
          expectedProjectVersionId: editBase.current.projectVersionId,
          expectedProjectVersion: editBase.current.projectVersion,
          initialIdea: draft.initialIdea,
          responses: draft.responses.map((response) => ({
            questionId: response.questionId,
            ...(response.skipped ? {} : { answer: response.answer }),
            skipped: response.skipped,
          })),
          clientOperationId: crypto.randomUUID(),
        }
        return () => reviseSubmission(args)
      })
      clearSessionDraft(proposalStorageKey)
      setHasRecoveredDraft(false)
      setEditConflict(false)
      stopEditing()
      setEditing(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const ideaLength = draft.initialIdea.trim().length
  const invalidResponse = draft.responses.some((response) => (
    !response.skipped && (
      response.answer.trim().length < intake.editRules.followUpAnswerMinLength ||
      response.answer.trim().length > intake.editRules.followUpAnswerMaxLength
    )
  ))
  const invalidIdea =
    ideaLength < intake.editRules.initialIdeaMinLength ||
    ideaLength > intake.editRules.initialIdeaMaxLength

  return (
    <section className="submitted-summary">
      <div className="proposal-heading">
        <div>
          <h2>Your project</h2>
          <p className="fine-print">
            Edits close {formatEventTime(intake.applicationsCloseAt, timezone)}.
          </p>
        </div>
        {canEdit ? (
          <button
            type="button"
            className="text-button"
            disabled={busy || pending}
            onClick={() => {
              if (editing) {
                setDraft(proposalDraft(intake))
                clearSessionDraft(proposalStorageKey)
                setHasRecoveredDraft(false)
                setEditConflict(false)
                stopEditing()
              } else {
                editBase.current = proposalEditBase(application, intake)
                if (!hasRecoveredDraft) setDraft(proposalDraft(intake))
                setExpanded(true)
              }
              setEditing(!editing)
              setError(null)
            }}
          >
            {editing ? 'Cancel' : 'Edit proposal'}
          </button>
        ) : null}
      </div>
      <EditingPresence editors={editors ?? []} members={members} />
      {editing && canEdit ? (
        <form className="proposal-editor" onSubmit={save}>
          {hasRecoveredDraft ? (
            <p className="notice" role="status">Recovered your unsaved changes from this tab.</p>
          ) : null}
          {editConflict ? (
            <div className="notice" role="status">
              <p>A newer proposal was saved. Your changes are still here.</p>
              <div className="button-row">
                <button type="button" className="text-button" onClick={() => {
                  setDraft(proposalDraft(intake))
                  editBase.current = proposalEditBase(application, intake)
                  setEditConflict(false)
                  setHasRecoveredDraft(false)
                  clearSessionDraft(proposalStorageKey)
                }}>Use saved version</button>
                <button type="button" className="text-button" onClick={() => {
                  editBase.current = proposalEditBase(application, intake)
                  setEditConflict(false)
                  writeVersionedSessionDraft(proposalStorageKey, {
                    base: proposalEditBaseFingerprint(editBase.current),
                    value: serializeProposalDraft(draft),
                  })
                }}>Keep mine</button>
              </div>
            </div>
          ) : null}
          <label className="field">
            <span>What do you want to build?</span>
            <textarea
              autoFocus
              required
              minLength={intake.editRules.initialIdeaMinLength}
              maxLength={intake.editRules.initialIdeaMaxLength}
              value={draft.initialIdea}
              disabled={busy || pending}
              onChange={(event) => {
                const value = event.currentTarget.value
                setDraft((current) => ({
                  ...current,
                  initialIdea: value,
                }))
                const nextDraft = { ...draft, initialIdea: value }
                writeVersionedSessionDraft(proposalStorageKey, {
                  base: proposalEditBaseFingerprint(editBase.current),
                  value: serializeProposalDraft(nextDraft),
                })
                setHasRecoveredDraft(true)
                markEditing('proposal_revision')
              }}
            />
          </label>
          {intake.project.intakeResponses.map((response, index) => (
            <div className="proposal-response" key={response.questionId}>
              <label className="field">
                <span>{response.question}</span>
                <textarea
                  required={!draft.responses[index]?.skipped}
                  minLength={intake.editRules.followUpAnswerMinLength}
                  maxLength={intake.editRules.followUpAnswerMaxLength}
                  value={draft.responses[index]?.answer ?? ''}
                  disabled={busy || pending || draft.responses[index]?.skipped}
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    setDraft((current) => ({
                      ...current,
                      responses: current.responses.map((item, itemIndex) => (
                        itemIndex === index
                          ? { ...item, answer: value }
                          : item
                      )),
                    }))
                    const nextDraft = {
                      ...draft,
                      responses: draft.responses.map((item, itemIndex) => (
                        itemIndex === index
                          ? { ...item, answer: value }
                          : item
                      )),
                    }
                    writeVersionedSessionDraft(proposalStorageKey, {
                      base: proposalEditBaseFingerprint(editBase.current),
                      value: serializeProposalDraft(nextDraft),
                    })
                    setHasRecoveredDraft(true)
                    markEditing('proposal_revision')
                  }}
                />
              </label>
              <label className="proposal-skip">
                <input
                  type="checkbox"
                  checked={draft.responses[index]?.skipped ?? false}
                  disabled={busy || pending}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked
                    setDraft((current) => ({
                      ...current,
                      responses: current.responses.map((item, itemIndex) => (
                        itemIndex === index
                          ? { ...item, skipped: checked }
                          : item
                      )),
                    }))
                    const nextDraft = {
                      ...draft,
                      responses: draft.responses.map((item, itemIndex) => (
                        itemIndex === index
                          ? { ...item, skipped: checked }
                          : item
                      )),
                    }
                    writeVersionedSessionDraft(proposalStorageKey, {
                      base: proposalEditBaseFingerprint(editBase.current),
                      value: serializeProposalDraft(nextDraft),
                    })
                    setHasRecoveredDraft(true)
                    markEditing('proposal_revision')
                  }}
                />
                Skip this question
              </label>
            </div>
          ))}
          {error ? <p className="notice error" role="alert">{error}</p> : null}
          <button
            type="submit"
            className="primary"
            disabled={busy || editConflict || invalidIdea || invalidResponse}
          >
            {busy ? 'Saving…' : pending ? 'Confirm earlier save' : 'Save proposal'}
          </button>
        </form>
      ) : (
        <div className="proposal-copy">
          <p className="proposal-idea">{intake.project.initialIdea}</p>
          {intake.project.intakeResponses.length > 0 ? (
            <button
              type="button"
              className="text-button proposal-details-toggle"
              aria-controls="proposal-responses"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? 'Hide answers' : `View ${intake.project.intakeResponses.length} answers`}
            </button>
          ) : null}
          {expanded ? (
            <div className="proposal-responses" id="proposal-responses">
              {intake.project.intakeResponses.map((response) => (
                <div key={response.questionId}>
                  <strong>{response.question}</strong>
                  <p>{response.skipped ? 'Skipped' : response.answer}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

function proposalDraft(intake: SubmittedIntake) {
  return {
    initialIdea: intake.project.initialIdea,
    responses: intake.project.intakeResponses.map((response) => ({
      questionId: response.questionId,
      answer: response.answer ?? '',
      skipped: response.skipped,
    })),
  }
}

type ProposalDraft = ReturnType<typeof proposalDraft>

function proposalEditBase(application: CurrentApplication, intake: SubmittedIntake) {
  return {
    applicationVersion: application.version,
    applicationContentVersion: application.contentVersion,
    projectVersionId: intake.project.id,
    projectVersion: intake.project.version,
  }
}

function proposalEditBaseFingerprint(base: ReturnType<typeof proposalEditBase>) {
  return [
    base.applicationVersion,
    base.applicationContentVersion,
    base.projectVersionId,
    base.projectVersion,
  ].join(':')
}

function serializeProposalDraft(draft: ProposalDraft) {
  const values = new URLSearchParams()
  values.set('idea', draft.initialIdea)
  for (const response of draft.responses) {
    values.set(`answer:${response.questionId}`, response.answer)
    values.set(`skipped:${response.questionId}`, response.skipped ? '1' : '0')
  }
  return values.toString()
}

function recoverProposalDraft(intake: SubmittedIntake, stored: string): ProposalDraft {
  const current = proposalDraft(intake)
  const values = new URLSearchParams(stored)
  return {
    initialIdea: values.get('idea') ?? current.initialIdea,
    responses: current.responses.map((response) => {
      const storedSkipped = values.get(`skipped:${response.questionId}`)
      return {
        ...response,
        answer: values.get(`answer:${response.questionId}`) ?? response.answer,
        skipped: storedSkipped === null ? response.skipped : storedSkipped === '1',
      }
    }),
  }
}

function InformationResponsePanel({
  application,
  canRespond,
  currentRole,
  request,
}: {
  application: CurrentApplication
  canRespond: boolean
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
      <p>Answer only these questions. Your team stays locked.</p>
      {canRespond ? (
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
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setDraft((current) => ({
                    ...current,
                    answers: current.answers.map((answer, answerIndex) => (
                      answerIndex === index
                        ? { ...answer, answer: value }
                        : answer
                    )),
                  }))
                }}
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
      ) : currentRole !== 'lead' ? (
        <p className="fine-print">The locked team lead submits these answers for the team.</p>
      ) : (
        <p className="fine-print">Response access is unavailable. Ask an organizer if this looks wrong.</p>
      )}
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

function deliveryNeedsAttention(state: ParticipantDeliveryState) {
  return state === 'delivery_delayed' ||
    state === 'bounced' ||
    state === 'failed' ||
    state === 'suppressed' ||
    state === 'unknown'
}
