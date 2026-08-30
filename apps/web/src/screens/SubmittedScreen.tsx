import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

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
import { PortalButton, PortalTextButton } from '../components/portal/PortalButton'
import { PortalError } from '../components/portal/PortalField'
import { Flower } from '../components/portal/FlowerAvatar'
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
    message: 'We have your application. Your team is locked; the lead can revise the submission until the deadline.',
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
  const [viewingProposal, setViewingProposal] = useState(false)
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

  const proposalLink = (
    <>
      <button
        type="button"
        onClick={() => setViewingProposal(true)}
        className="mt-8 rounded-sm text-[13.5px] text-rose-light underline-offset-4 hover:underline"
      >
        {canEditProposal ? 'edit submission →' : 'view submission →'}
      </button>
      {delivery && deliveryNeedsAttention(delivery.state) ? (
        <p role="status" className="mt-6 text-[12.5px] text-rose-light">
          {deliveryStatusCopy[delivery.state]}
        </p>
      ) : null}
    </>
  )

  // ---- the proposal as its own view, swapped in place of the hero ----------
  if (viewingProposal) {
    return (
      <PortalScene tree="none" header={<TeamCluster team={team} members={members} locked onSignOut={onSignOut} />}>
        <div className="flex w-full max-w-[840px] flex-col items-center">
          <h1 className="mb-2 text-center font-display font-light tracking-[-.01em] text-3xl text-shadow-[0_6px_40px_var(--scene-text-glow)] lg:text-[44px]">
            {team.name}
          </h1>
          <p className="mb-7 text-xs text-fg/50">
            {canEditProposal
              ? `editable until ${formatEventTime(intake.applicationsCloseAt, event.timezone)}`
              : 'submission window closed'}{' '}
            ·{' '}
            <button
              type="button"
              onClick={() => setViewingProposal(false)}
              className="text-rose-light underline-offset-4 hover:underline"
            >
              back
            </button>
          </p>
          <div className="w-full text-left">
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
        </div>
      </PortalScene>
    )
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
          <div className="mb-5 drop-shadow-[0_0_14px_var(--glow-rose)]">
            <Petal size={34} />
          </div>
          <h1 className="mb-3.5 font-display font-light tracking-[-.01em] text-5xl leading-none text-shadow-[0_8px_50px_var(--scene-text-glow)] lg:text-[70px]">
            {copy.heading}
          </h1>
          <p className="mb-8 font-ui font-normal text-base text-rose-light lg:text-[19px]">
            {application.state === 'needs_information'
              ? copy.message
              : `${team.name} is in the review queue`}
          </p>

          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-[13px] text-fg/65">
            <span>
              status <span className="text-fg">{copy.status.toLowerCase()}</span>
            </span>
            <span aria-hidden className="hidden h-3.5 w-px bg-rose/40 sm:block" />
            <span>
              team <span className="text-rose-light">locked</span>
            </span>
            {canEditProposal ? (
              <>
                <span aria-hidden className="hidden h-3.5 w-px bg-rose/40 sm:block" />
                <span>
                  editable until{' '}
                  <span className="text-fg">
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

          {proposalLink}

          {delivery && deliveryNeedsAttention(delivery.state) ? (
            <p role="status" className="mt-6 text-[12.5px] text-rose-light">
              {deliveryStatusCopy[delivery.state]}
            </p>
          ) : null}
        </div>
      </PortalScene>
    )
  }


  // ---- f9 · event live: one reactive bento --------------------------------
  if (eventIsLive) {
    return (
      <EventLiveScene
        team={team}
        members={members}
        communications={communications ?? null}
        event={event}
        currentPhase={currentPhase}
        phaseTime={phaseTime}
        onSignOut={onSignOut}
        proposalLink={proposalLink}
      />
    )
  }

  // ---- f8 · selected: lanterns rise, the ticket ---------------------------
  if (selected) {
    const offer = application.currentOffer
    const canRespond =
      application.state === 'offer_sent' &&
      offer !== null &&
      intake.currentRole === 'lead' &&
      team.canRespondToOffer
    return (
      <PortalScene
        tree="none"
        header={<TeamCluster team={team} members={members} locked onSignOut={onSignOut} />}
        backdrop={
          <div aria-hidden className="pointer-events-none absolute inset-0 z-[2]">
            <img
              src="/assets/lantern-1.svg"
              alt=""
              className="absolute bottom-[-60px] left-[16%] w-[42px]"
              style={{ animation: 'c2crise 16s linear -2s infinite' }}
            />
            <img
              src="/assets/lantern-2.svg"
              alt=""
              className="absolute right-[19%] bottom-[-60px] w-8"
              style={{ animation: 'c2crise 20s linear -11s infinite' }}
            />
          </div>
        }
      >
        <div className="flex w-full max-w-[760px] flex-col items-center text-center">
          <p className="mb-2.5 font-ui text-lg text-rose-light text-shadow-[0_2px_14px_var(--scene-text-glow)] lg:text-xl">
            {copy.status} for {event.name}
          </p>
          <h1 className="mb-9 font-display font-light tracking-[-.01em] text-6xl leading-[.96] text-shadow-[0_0_60px_var(--glow-rose-soft),0_10px_50px_var(--scene-text-glow)] lg:mb-[42px] lg:text-[92px]">
            {confirmed ? 'You’re confirmed.' : 'You’re in.'}
          </h1>

          <PetalCard className="flex flex-col sm:flex-row">
            <div className="grid flex-1 grid-cols-1 gap-4 px-7 py-[22px] sm:grid-cols-3 sm:gap-0">
              <div className="sm:border-r sm:border-rose/35 sm:pr-5">
                <p className="mb-1 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
                  venue
                </p>
                <p className="m-0 font-display font-light tracking-[-.01em] text-[16.5px] leading-[1.3]">
                  {communications?.venueName ?? 'announced with your offer'}
                </p>
              </div>
              <div className="sm:border-r sm:border-rose/35 sm:px-5">
                <p className="mb-1 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
                  when
                </p>
                <p className="m-0 font-display font-light tracking-[-.01em] text-[16.5px] leading-[1.3]">
                  {communications
                    ? `${formatEventTime(communications.startsAt, event.timezone)} – ${formatEventTime(communications.endsAt, event.timezone)}`
                    : '—'}
                </p>
              </div>
              <div className="sm:pl-5">
                <p className="mb-1 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
                  {confirmed ? 'status' : 'confirm by'}
                </p>
                <p className="m-0 font-display font-light tracking-[-.01em] text-[16.5px] leading-[1.3] text-rose-light">
                  {confirmed
                    ? 'place held'
                    : offer
                      ? formatEventTime(offer.expiresAt, event.timezone)
                      : 'offer on its way'}
                </p>
              </div>
            </div>
            <div className="flex flex-none items-center justify-center gap-3 border-t-2 border-dashed border-rose/55 px-5 py-4 sm:w-[140px] sm:flex-col sm:gap-[7px] sm:border-t-0 sm:border-l-2">
              <div className="flex size-12 -rotate-4 items-center justify-center rounded-[10px] bg-rose text-[15px] font-bold text-wash shadow-[0_8px_20px_var(--shade-1)]">
                C2C
              </div>
              <p className="m-0 text-[11px] text-fg/60">
                admits {team.activeMemberCount === 1 ? 'one' : team.activeMemberCount}
              </p>
            </div>
          </PetalCard>

          {communications?.nextSteps.length ? (
            <div className="mt-7 w-full max-w-[560px] text-left">
              {communications.nextSteps.map((step) => (
                <div
                  key={step.stableKey}
                  className="flex items-baseline justify-between gap-4 border-b border-petal-line py-2.5 last:border-b-0"
                >
                  <div>
                    <p className="m-0 text-[13px] font-semibold">
                      {step.actionUrl ? (
                        <a
                          href={step.actionUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-fg underline-offset-4 hover:text-rose-light hover:underline"
                        >
                          {step.title}
                        </a>
                      ) : (
                        step.title
                      )}
                    </p>
                    <p className="m-0 text-xs text-fg/55">{step.detail}</p>
                  </div>
                  {step.dueAt ? (
                    <span className="flex-none text-[11px] text-rose-light">
                      {formatEventTime(step.dueAt, event.timezone)}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <div className="mt-9 flex flex-col items-center gap-3.5 lg:mt-[42px]">
            {canRespond ? (
              confirmDecline ? (
                <div className="flex flex-col items-center gap-3">
                  <p className="m-0 max-w-[420px] text-[12.5px] text-fg/70">
                    Declining releases the whole team’s places. You cannot undo this in the portal.
                  </p>
                  <div className="flex items-center gap-4">
                    <PortalButton
                      type="button"
                      size="sm"
                      disabled={busy !== null || responsePending}
                      onClick={() => setConfirmDecline(false)}
                    >
                      Keep offer
                    </PortalButton>
                    <PortalTextButton
                      type="button"
                      disabled={busy !== null || pendingResponse === 'confirm'}
                      onClick={() => void respond('decline')}
                    >
                      {busy === 'decline'
                        ? 'Declining…'
                        : pendingResponse === 'decline'
                          ? 'confirm earlier decline'
                          : 'decline for team'}
                    </PortalTextButton>
                  </div>
                </div>
              ) : (
                <>
                  <PortalButton
                    type="button"
                    disabled={busy !== null || pendingResponse === 'decline'}
                    onClick={() => void respond('confirm')}
                  >
                    {busy === 'confirm'
                      ? 'Confirming…'
                      : pendingResponse === 'confirm'
                        ? 'Confirm earlier response'
                        : 'Confirm your spot'}
                  </PortalButton>
                  <PortalTextButton
                    type="button"
                    disabled={busy !== null || responsePending}
                    onClick={() => setConfirmDecline(true)}
                  >
                    decline offer
                  </PortalTextButton>
                </>
              )
            ) : application.state === 'offer_sent' && intake.currentRole !== 'lead' ? (
              <p className="m-0 text-[12.5px] text-fg/60">
                Your team lead confirms for the team
                {offer ? ` · by ${formatEventTime(offer.expiresAt, event.timezone)}` : ''}.
              </p>
            ) : null}
            {communications?.discordUrl ? (
              <a
                href={communications.discordUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[13.5px] text-rose-light underline-offset-4 hover:underline"
              >
                {communications.discordLabel || 'join the Discord'} →
              </a>
            ) : null}
          </div>

          <PortalError message={error} />
          {proposalLink}
        </div>
      </PortalScene>
    )
  }

  // ---- closed states: declined, waitlisted, expired, withdrawn ------------
  return (
    <PortalScene tree="none" header={<TeamCluster team={team} members={members} locked onSignOut={onSignOut} />}>
      <div className="flex w-full max-w-[760px] flex-col items-center text-center">
        <div className="mb-5 drop-shadow-[0_0_14px_var(--glow-rose)]">
          <Petal size={34} />
        </div>
        <h1 className="mb-3.5 font-display font-light tracking-[-.01em] text-5xl leading-none text-shadow-[0_8px_50px_var(--scene-text-glow)] lg:text-[64px]">
          {copy.heading}
        </h1>
        <p className="mb-6 max-w-[520px] font-ui text-base text-rose-light lg:text-[19px]">
          {copy.message}
        </p>
        <p className="m-0 text-[13px] text-fg/65">
          status <span className="text-fg">{copy.status.toLowerCase()}</span>
        </p>
        {proposalLink}
      </div>
    </PortalScene>
  )
}


function BentoBlock({
  title,
  meta,
  summary,
  children,
  defaultOpen = false,
}: {
  title: string
  meta?: string
  summary: ReactNode
  children?: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const expandable = children !== undefined
  return (
    <div
      className={`rounded-petal-sm border border-rose-light/45 bg-[image:var(--tile-bg)] px-[22px] py-[18px] shadow-[0_24px_50px_-18px_var(--shade-2),inset_0_1px_0_var(--card-topline)] backdrop-blur-[14px] transition-all duration-250 ${
        expandable ? 'cursor-pointer hover:-translate-y-[3px] hover:border-rose-light/80' : ''
      }`}
      {...(expandable
        ? {
            role: 'button',
            tabIndex: 0,
            onClick: () => setOpen((value) => !value),
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              setOpen((value) => !value)
            },
          }
        : {})}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-ui text-base text-rose-light">{title}</span>
        <span className="text-[11px] text-fg/45">
          {meta ?? (expandable ? (open ? 'tap to close' : 'tap to open') : '')}
        </span>
      </div>
      <div className="mt-2 text-sm text-fg/85">{summary}</div>
      {expandable && open ? (
        <div className="mt-3.5 cursor-auto" onClick={(event) => event.stopPropagation()}>
          {children}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Mockup f9: the live-event home — one reactive bento. Blocks open in place;
 * the existing tool panels render inside their blocks.
 */
function EventLiveScene({
  team,
  members,
  communications,
  event,
  currentPhase,
  phaseTime,
  onSignOut,
  proposalLink,
}: {
  team: CurrentTeam
  members: CurrentTeamMember[]
  communications: ParticipantCommunications | null
  event: NonNullable<PublicState['event']>
  currentPhase: NonNullable<PublicState['event']>['phases'][number]
  phaseTime: number
  onSignOut: () => void
  proposalLink: ReactNode
}) {
  const capabilities = useQuery(api.access.participantCapabilities, { eventSlug })
  const nextPhase = event.phases.find((phase) => phase.startsAt > phaseTime)
  const latestStep = communications?.nextSteps[0]
  return (
    <PortalScene tree="none" header={<TeamCluster team={team} members={members} locked onSignOut={onSignOut} />}>
      <div className="w-full max-w-[1048px] pt-2 pb-10 lg:pt-6">
        <p className="mb-2 flex items-center gap-2 font-ui text-base text-rose-light">
          <span aria-hidden className="inline-block size-[7px] animate-dot-pulse rounded-full bg-rose-light" />
          {currentPhase.displayName.toLowerCase()} · ends{' '}
          {formatEventTime(currentPhase.endsAt, event.timezone)}
        </p>
        <h1 className="mb-7 font-display font-light tracking-[-.01em] text-4xl leading-none text-shadow-[0_8px_50px_var(--scene-text-glow)] lg:text-[46px]">
          {nextPhase
            ? `${nextPhase.displayName} at ${formatEventTime(nextPhase.startsAt, event.timezone)}.`
            : currentPhase.description}
        </h1>

        <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {capabilities?.floor ? (
            <BentoBlock title="your hall" summary="your table cluster and location QR">
              <TeamLocationPanel />
            </BentoBlock>
          ) : null}
          {capabilities?.reviewQueue ? (
            <BentoBlock title="review queue" summary="where your team stands">
              <ReviewQueuePanel />
            </BentoBlock>
          ) : null}
          <BentoBlock
            title="schedule"
            {...(nextPhase
              ? { meta: `next ${formatEventTime(nextPhase.startsAt, event.timezone)}` }
              : {})}
            summary={currentPhase.description}
          >
            <div className="flex flex-col">
              {event.phases.map((phase) => {
                const now = phase.startsAt <= phaseTime && phaseTime < phase.endsAt
                const past = phase.endsAt <= phaseTime
                return (
                  <div
                    key={phase.phaseKey}
                    className="flex justify-between gap-3 border-b border-rose/20 py-2 text-xs last:border-b-0"
                  >
                    <span
                      className={
                        now
                          ? 'text-rose-light'
                          : past
                            ? 'text-fg/55'
                            : 'text-fg/75'
                      }
                    >
                      {phase.displayName}
                      {past ? ' ✓' : ''}
                    </span>
                    <span className={now ? 'text-rose-light' : 'text-fg/50'}>
                      {formatEventTime(phase.startsAt, event.timezone)}
                    </span>
                  </div>
                )
              })}
            </div>
          </BentoBlock>
          {capabilities?.projectCheckpoints || capabilities?.integrations ? (
            <BentoBlock title="connect tools" summary="repos, Figma, and checkpoints">
              {capabilities?.projectCheckpoints ? (
                <ProjectCheckpointsPanel timezone={event.timezone} />
              ) : null}
              {capabilities?.integrations ? (
                <p className="mt-3 mb-0 text-xs">
                  <Link to="/integrations" className="text-rose-light underline-offset-4 hover:underline">
                    manage repos + Figma →
                  </Link>
                </p>
              ) : null}
            </BentoBlock>
          ) : null}
          <BentoBlock
            title="squad"
            meta={`${team.activeMemberCount} of ${team.teamMaximumSize} · locked`}
            summary={
              <span className="mt-1 flex">
                {members.slice(0, 6).map((member, index) => (
                  <span
                    key={member.teamMemberId}
                    title={member.displayName}
                    className={`flex size-[30px] items-center justify-center rounded-full text-[10px] font-semibold ${
                      member.role === 'lead'
                        ? 'border-[1.5px] border-ring-lead bg-avatar-lead'
                        : 'border-[1.5px] border-rose/70 bg-avatar'
                    } ${index > 0 ? '-ml-2' : ''}`}
                  >
                    <Flower seed={member.membershipId} lead={member.role === 'lead'} size={16} />
                  </span>
                ))}
              </span>
            }
          >
            <div className="flex flex-col">
              {members.map((member) => (
                <div
                  key={member.teamMemberId}
                  className="flex justify-between gap-3 border-b border-rose/20 py-[7px] text-xs last:border-b-0"
                >
                  <span>
                    {member.displayName}
                    {member.role === 'lead' ? (
                      <span className="ml-1.5 text-[11px] text-rose-light">lead</span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </BentoBlock>
          {capabilities?.attendance ? (
            <BentoBlock title="my pass" summary="check-in QR and attendance">
              <AttendancePanel />
            </BentoBlock>
          ) : null}
          {capabilities?.scoreFeedback ? (
            <BentoBlock title="feedback" summary="released review feedback">
              <ReleasedFeedbackPanel />
            </BentoBlock>
          ) : null}
          {latestStep ? (
            <BentoBlock title="from organizers" summary={`“${latestStep.title}” · ${latestStep.detail}`} />
          ) : null}
          <BentoBlock
            title="help"
            summary={
              <span className="flex gap-[18px] pt-1 text-[13px]">
                {communications?.discordUrl ? (
                  <a
                    href={communications.discordUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-rose-light"
                  >
                    Discord
                  </a>
                ) : null}
                {capabilities?.supportRead ? (
                  <Link to="/support" className="text-rose-light">
                    support
                  </Link>
                ) : null}
                <Link to="/more" className="text-rose-light">
                  more
                </Link>
              </span>
            }
          />
        </div>
        <div className="text-center">{proposalLink}</div>
      </div>
    </PortalScene>
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
            {editing ? 'Cancel' : 'Edit submission'}
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
              <p>A newer submission was saved. Your changes are still here.</p>
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
            {busy ? 'Saving…' : pending ? 'Confirm earlier save' : 'Save submission'}
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
