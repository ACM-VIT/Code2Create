import { api } from '@code2create/backend/api'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { TeamPanel } from './components/TeamPanel'
import { AccountBadge } from './components/portal/AccountBadge'
import { PetalCard } from './components/portal/PetalCard'
import { PortalButton, PortalTextButton } from './components/portal/PortalButton'
import { PortalError } from './components/portal/PortalField'
import { PortalScene } from './components/portal/PortalScene'
import { eventSlug } from './lib/config'
import { readableError } from './lib/errors'
import { useOperationRunner } from './lib/operations'
import { canLeaveByTeamRule, canLeaveCurrentTeam } from './lib/teamLeave'
import { participantClassStorageKey } from './screens/EntryScreen'
import { DetailsScreen } from './screens/DetailsScreen'
import { HomeScreen } from './screens/HomeScreen'
import { MoreScreen } from './screens/MoreScreen'
import { IntakeScreen } from './screens/IntakeScreen'
import { TeamLobbyScreen } from './screens/TeamLobbyScreen'
import { TeamScreen } from './screens/TeamScreen'
import type { CurrentTeam, ParticipantClass, PublicState } from './types'

const loadFigmaCallbackScreen = () => import('./screens/FigmaCallbackScreen')
const loadGitHubCallbackScreen = () => import('./screens/GitHubCallbackScreen')
const loadIntegrationsScreen = () => import('./screens/IntegrationsScreen')
const loadSubmittedScreen = () => import('./screens/SubmittedScreen')
const loadSynesthesiaScreen = () => import('./screens/SynesthesiaScreen')
const loadSupportScreen = () => import('./screens/SupportScreen')

const FigmaCallbackScreen = lazy(() =>
  loadFigmaCallbackScreen().then((module) => ({ default: module.FigmaCallbackScreen })),
)
const GitHubCallbackScreen = lazy(() =>
  loadGitHubCallbackScreen().then((module) => ({ default: module.GitHubCallbackScreen })),
)
const IntegrationsScreen = lazy(() =>
  loadIntegrationsScreen().then((module) => ({ default: module.IntegrationsScreen })),
)
const SubmittedScreen = lazy(() =>
  loadSubmittedScreen().then((module) => ({ default: module.SubmittedScreen })),
)
const SynesthesiaScreen = lazy(() =>
  loadSynesthesiaScreen().then((module) => ({ default: module.SynesthesiaScreen })),
)
const SupportScreen = lazy(() =>
  loadSupportScreen().then((module) => ({ default: module.SupportScreen })),
)

function useDeadlineReached(serverNow: number, deadline: number | undefined) {
  const [elapsedDeadline, setElapsedDeadline] = useState<number | null>(null)
  useEffect(() => {
    if (deadline === undefined || serverNow >= deadline) return
    const timer = window.setTimeout(
      () => setElapsedDeadline(deadline),
      Math.min(deadline - serverNow + 100, 2_147_000_000),
    )
    return () => window.clearTimeout(timer)
  }, [deadline, serverNow])
  return deadline !== undefined && (serverNow >= deadline || elapsedDeadline === deadline)
}

export function ParticipantApp({
  publicState,
  authClient,
}: {
  publicState: PublicState
  authClient: Code2CreateAuthClient
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const { code: joinCodeParam } = useParams<{ code?: string }>()
  const [pendingTeamSwitchCode, setPendingTeamSwitchCode] = useState<string | null>(null)
  const entryAllowed = useQuery(api.participants.entryAllowed, { eventSlug })
  const me = useQuery(api.participants.me, { eventSlug })
  const access = useQuery(api.access.participantCapabilities, { eventSlug })
  const hasTeamMembership = access?.hasTeamMembership ?? false
  const canReadProfile = access?.profileRead ?? false
  const canWriteProfile = access?.profileWrite ?? false
  const canJoinTeam = access?.teamJoin ?? false
  const canReadTeam = access?.teamRead ?? false
  const teamQuery = useQuery(api.teams.current, canReadTeam ? { eventSlug } : 'skip')
  const teamDeadlineReached = useDeadlineReached(
    publicState.serverNow,
    teamQuery?.membershipEditableUntil,
  )
  const teamMembers = usePaginatedQuery(api.teams.members, canReadTeam ? { eventSlug } : 'skip', { initialNumItems: 25 })
  const intakeStatusQuery = useQuery(api.intake.status, canReadTeam ? { eventSlug } : 'skip')

  if (entryAllowed === undefined || me === undefined || access === undefined) {
    return <PortalLoading />
  }
  const signOut = () => void authClient.signOut()
  if (!entryAllowed) {
    return (
      <PortalNotice
        header={(
          <button
            type="button"
            onClick={signOut}
            className="text-[12px] text-fg/45 transition-colors hover:text-rose-light"
          >
            Sign out
          </button>
        )}
        title="This account is not on the tester list."
        body="Use one of the Google accounts invited to staging."
      />
    )
  }
  if (canReadTeam && (teamQuery === undefined || intakeStatusQuery === undefined)) {
    return <PortalLoading />
  }

  const team = canReadTeam ? teamQuery ?? null : null
  const intakeStatus = canReadTeam ? intakeStatusQuery ?? null : null
  const teamAccessUnavailable = hasTeamMembership && !canReadTeam
  const canReadIntegrations = access?.integrations ?? false
  const canReadSupport = access?.supportRead ?? false
  const canCreateSupport = access?.supportCreate ?? false

  if (!me?.membership) {
    return <ProvisionScreen publicState={publicState} onSignOut={signOut} />
  }
  if (
    me.membership.participantClass === 'vit_student' &&
    me.membership.vitStudentIdentity === null
  ) {
    return (
      <PortalNotice
        header={(
          <button
            type="button"
            onClick={signOut}
            className="text-[12px] text-fg/45 transition-colors hover:text-rose-light"
          >
            Sign out
          </button>
        )}
        title="Verify your VIT account again."
        body="Sign out, then continue with Google. Your saved profile, team, and proposal stay unchanged."
      />
    )
  }

  const accountHeader = (
    <AccountBadge
      name={me.person.displayName}
      email={me.person.verifiedEmail}
      onSignOut={signOut}
    />
  )
  const supportRoute = location.pathname === '/support'
  const joinCode = joinCodeParam?.trim().toUpperCase() ?? ''
  const finishTeamSwitch = () => {
    setPendingTeamSwitchCode(null)
    navigate('/', { replace: true, viewTransition: true })
  }
  const requestedTeamSwitchCode = pendingTeamSwitchCode ?? joinCode
  const teamSwitch =
    team &&
    requestedTeamSwitchCode.length > 0 &&
    requestedTeamSwitchCode !== team.publicCode &&
    !teamDeadlineReached
      ? { code: requestedTeamSwitchCode, team }
      : null

  if (teamSwitch !== null) {
    return (
      <SwitchTeamScreen
        header={accountHeader}
        team={teamSwitch.team}
        code={teamSwitch.code}
        onStarted={() => setPendingTeamSwitchCode(teamSwitch.code)}
        onFinished={finishTeamSwitch}
        onStay={finishTeamSwitch}
      />
    )
  }

  if (hasTeamMembership && canReadTeam && !team) return <PortalLoading />

  const hasSubmittedApplication = intakeStatus !== null && intakeStatus.applicationState !== null
  const canContinueWithoutProfileProjection = !canReadProfile && hasSubmittedApplication

  // ---- f0b · details, with policy consent inline ---------------------------
  if (!me.profile?.isComplete && !canContinueWithoutProfileProjection) {
    if (supportRoute) {
      return canReadSupport ? <SupportRoute canCreate={canCreateSupport} /> : <Navigate replace to="/" />
    }
    if (!canReadProfile) {
      return <PortalNotice header={accountHeader} title="Profile access is unavailable." body="Your saved profile has not been removed. Ask an organizer to restore profile access before submitting." />
    }
    const profileKey = `${me.participantPolicy.id}:${me.profile?.profileVersion ?? 0}`
    return (
      <DetailsScreen key={profileKey} me={me} canWriteProfile={canWriteProfile} onSignOut={signOut} />
    )
  }

  if (teamAccessUnavailable) {
    if (supportRoute) {
      return canReadSupport ? <SupportRoute canCreate={canCreateSupport} /> : <Navigate replace to="/" />
    }
    return <PortalNotice header={accountHeader} title="Team access is unavailable." body="You are still on your team. You cannot create or join another team until an organizer restores access." />
  }

  // ---- f0c · team start ----------------------------------------------------
  if (!team) {
    if (supportRoute) {
      return canReadSupport ? <SupportRoute canCreate={canCreateSupport} /> : <Navigate replace to="/" />
    }
    if (!canJoinTeam) {
      return <PortalNotice header={accountHeader} title="Team setup is unavailable." body="This account cannot create or join a team. Ask an organizer to restore team setup access." />
    }
    if (me.pendingTeam) {
      return <PendingTeamScreen header={accountHeader} pendingTeam={me.pendingTeam} />
    }
    return <TeamScreen header={accountHeader} />
  }

  if (!intakeStatus) return <PortalLoading />
  const teamEditable = !teamDeadlineReached

  if (intakeStatus.submissionState === 'validating') {
    return (
      <PortalNotice
        header={accountHeader}
        title="Submitting your idea…"
        body="We are confirming your team and answers. You can leave this page; the result appears here automatically."
      />
    )
  }

  const acceptedPortal = intakeStatus.applicationState !== null
    ? ['accepted', 'offer_sent', 'confirmed'].includes(intakeStatus.applicationState)
    : false

  // ---- f12 · everything else, one quiet list -------------------------------
  if (location.pathname === '/more') {
    return (
      <MoreScreen
        me={me}
        capabilities={access}
        showIntegrations={acceptedPortal && canReadIntegrations}
        showMusic={acceptedPortal}
        onSignOut={signOut}
      />
    )
  }
  if (location.pathname === '/more/profile') {
    return <DetailsScreen me={me} canWriteProfile={canWriteProfile} onSignOut={signOut} />
  }

  // ---- f10 · the squad lobby, any time a team exists -----------------------
  if (location.pathname === '/team') {
    return (
      <TeamLobbyScreen
        team={team}
        members={teamMembers.results}
        rosterStatus={teamMembers.status}
        loadMore={teamMembers.loadMore}
        editable={teamEditable}
        onSignOut={signOut}
      />
    )
  }

  // ---- f1-f6 · home, then the writing flow, full-bleed on the night scene --
  if (intakeStatus.applicationState === null && location.pathname === '/') {
    return <HomeScreen team={team} members={teamMembers.results} teamEditable={teamEditable} onSignOut={signOut} />
  }
  if (intakeStatus.applicationState === null && location.pathname === '/write') {
    return (
      <Suspense fallback={<PortalLoading />}>
        <IntakeScreen
          team={team}
          members={teamMembers.results}
          teamEditable={teamEditable}
          onSignOut={signOut}
          {...(intakeStatus.submissionFailureMessage === undefined
            ? {}
            : { submissionFailureMessage: intakeStatus.submissionFailureMessage })}
        />
      </Suspense>
    )
  }

  // The queue screen (mockup f7) is a full-bleed night scene, so it renders
  // outside the panelled shell the post-decision screens still use.
  const queued =
    intakeStatus.applicationState !== null &&
    ['submitted', 'under_review', 'needs_information'].includes(intakeStatus.applicationState)
  if (queued && location.pathname === '/') {
    return (
      <Suspense fallback={<PortalLoading />}>
        <SubmittedScreen
          capabilities={access}
          publicState={publicState}
          team={team}
          members={teamMembers.results}
          onSignOut={signOut}
        />
      </Suspense>
    )
  }

  const acceptedFeatures = acceptedPortal
  const canOpenIntegrations = acceptedFeatures && canReadIntegrations

  // ---- f11 · connected tools, full-bleed on the scene ----------------------
  if (location.pathname === '/integrations') {
    if (!canOpenIntegrations) return <Navigate replace to="/" />
    return (
      <Suspense fallback={<PortalLoading />}>
        <IntegrationsScreen teamName={team.name} onSignOut={signOut} />
      </Suspense>
    )
  }

  // ---- f8 / f9 / closed states, full-bleed ---------------------------------
  if (
    intakeStatus.applicationState !== null &&
    !['/integrations/github/callback', '/integrations/figma/callback', '/support', '/music'].includes(
      location.pathname,
    )
  ) {
    return (
      <Suspense fallback={<PortalLoading />}>
        <SubmittedScreen
          capabilities={access}
          publicState={publicState}
          team={team}
          members={teamMembers.results}
          onSignOut={signOut}
        />
      </Suspense>
    )
  }

  const portalContent = location.pathname === '/integrations/github/callback'
    ? canOpenIntegrations ? <GitHubCallbackScreen /> : <Navigate replace to="/" />
      : location.pathname === '/integrations/figma/callback'
      ? canOpenIntegrations ? <FigmaCallbackScreen /> : <Navigate replace to="/" />
      : location.pathname === '/support'
        ? canReadSupport
          ? <SupportScreen canCreate={canCreateSupport} />
          : <Navigate replace to="/" />
      : location.pathname === '/music'
        ? acceptedFeatures ? <SynesthesiaScreen /> : <Navigate replace to="/" />
        : (
              <IntakeScreen
                team={team}
                members={teamMembers.results}
                teamEditable={teamEditable}
                onSignOut={signOut}
                {...(intakeStatus.submissionFailureMessage === undefined
                  ? {}
                  : { submissionFailureMessage: intakeStatus.submissionFailureMessage })}
              />
            )
  return (
    <div
      className="portal-shell"
      data-account-email={me.person.verifiedEmail}
      data-app-surface="participant"
    >
      <PortalHeader
        name={me.person.displayName}
        email={me.person.verifiedEmail}
        onSignOut={signOut}
        showNavigation
        showIntegrations={acceptedFeatures && canReadIntegrations}
        showMusic={acceptedFeatures}
        showSupport={canReadSupport}
      />
      {intakeStatus.applicationState !== null ? (
        <div className="participant-home">
          <details className="minimal-team-access submitted-team-access">
            <summary>
              <span>Team</span>
              <strong>{team.name}</strong>
              <small>{team.activeMemberCount} {team.activeMemberCount === 1 ? 'member' : 'members'}</small>
            </summary>
            <TeamPanel team={team} members={teamMembers.results} rosterStatus={teamMembers.status} loadMore={teamMembers.loadMore} editable={teamEditable} />
          </details>
          <main className="portal-main participant-home-main">
            <Suspense fallback={<PortalContentLoading />}>{portalContent}</Suspense>
          </main>
        </div>
      ) : (
        <div className="portal-grid">
          <TeamPanel team={team} members={teamMembers.results} rosterStatus={teamMembers.status} loadMore={teamMembers.loadMore} editable={teamEditable} />
          <main className="portal-main">
            <Suspense fallback={<PortalContentLoading />}>{portalContent}</Suspense>
          </main>
        </div>
      )}
    </div>
  )
}

function SupportRoute({ canCreate }: { canCreate: boolean }) {
  return (
    <div className="portal-shell" data-app-surface="participant">
      <main className="portal-main">
        <Suspense fallback={<PortalContentLoading />}>
          <SupportScreen canCreate={canCreate} />
        </Suspense>
      </main>
    </div>
  )
}

/** A single-message stop on the night scene — access gates and waits. */
function PortalNotice({
  header,
  title,
  body,
}: {
  header?: ReactNode
  title: string
  body: string
}) {
  return (
    <PortalScene tree="right" {...(header ? { header } : {})}>
      <div className="w-full max-w-[560px]">
        <PetalCard className="px-8 py-7">
          <h1 className="mb-3 font-display font-light tracking-[-.01em] text-2xl lg:text-3xl">{title}</h1>
          <p className="text-[13px] leading-relaxed text-fg/60">{body}</p>
        </PetalCard>
      </div>
    </PortalScene>
  )
}

function PortalHeader({
  name,
  email,
  onSignOut,
  showNavigation = false,
  showIntegrations = false,
  showMusic = false,
  showSupport = false,
}: {
  name?: string
  email?: string
  onSignOut: () => void
  showNavigation?: boolean
  showIntegrations?: boolean
  showMusic?: boolean
  showSupport?: boolean
}) {
  return (
    <header className="portal-header">
      <Link to="/" viewTransition className="wordmark">Code2Create</Link>
      <div className="header-actions">
        {showNavigation || showIntegrations || showMusic || showSupport ? (
          <nav className="portal-navigation" aria-label="Portal">
            {showNavigation ? <NavLink end to="/" viewTransition>Home</NavLink> : null}
            {showIntegrations ? (
              <NavLink to="/integrations" viewTransition onFocus={preloadIntegrations} onMouseEnter={preloadIntegrations}>Build</NavLink>
            ) : null}
            {showMusic ? (
              <NavLink to="/music" viewTransition onFocus={preloadSynesthesia} onMouseEnter={preloadSynesthesia}>Music</NavLink>
            ) : null}
            {showSupport ? (
              <NavLink to="/support" viewTransition onFocus={preloadSupport} onMouseEnter={preloadSupport}>Help</NavLink>
            ) : null}
          </nav>
        ) : null}
        <div className="account-line">
          <span>{name ?? email ?? 'Signed in'}</span>
          <button type="button" className="text-button" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </header>
  )
}

function PortalLoading() {
  return <PortalScene tree="left">{null}</PortalScene>
}

function SwitchTeamScreen({
  header,
  team,
  code,
  onStarted,
  onFinished,
  onStay,
}: {
  header: ReactNode
  team: CurrentTeam
  code: string
  onStarted: () => void
  onFinished: () => void
  onStay: () => void
}) {
  const switchTeam = useMutation(api.teams.switchTeam)
  const [error, setError] = useState<string | null>(null)
  const operations = useOperationRunner()
  const switchPending = operations.hasPending('team-switch')
  const canLeave = canLeaveCurrentTeam(team)
  const needsTransfer = team.canLeave && !canLeaveByTeamRule(team)

  const confirmSwitch = async () => {
    if (!switchPending && !canLeave) return
    setError(null)
    onStarted()
    try {
      await operations.run('team-switch', (clientOperationId) => () =>
        switchTeam({
          eventSlug,
          fromTeamId: team.id,
          expectedFromTeamVersion: team.version,
          code,
          clientOperationId,
        }),
      )
      onFinished()
    } catch (caught) {
      setError(readableError(caught))
    }
  }

  const prompt = team.activeMemberCount === 1
    ? `Leave and close ${team.name}, then join the team ${code}?`
    : `Leave ${team.name} and join the team ${code}?`

  return (
    <PortalScene tree="both" header={header}>
      <PetalCard className="w-full max-w-[600px] px-7 py-7 sm:px-9">
        <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-rose-light">Switch team</p>
        <h1 className="font-display font-light tracking-[-.01em] text-3xl">
          {team.name}
        </h1>
        {needsTransfer ? (
          <p className="mt-3 text-[13px] leading-relaxed text-fg/58">
            Transfer leadership before leaving this team.
          </p>
        ) : !canLeave ? (
          <p className="mt-3 text-[13px] leading-relaxed text-fg/58">
            Leaving this team is unavailable.
          </p>
        ) : (
          <p className="mt-3 text-[13px] leading-relaxed text-fg/58">{prompt}</p>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          {!switchPending && (needsTransfer || !canLeave) ? null : (
            <PortalButton type="button" onClick={() => void confirmSwitch()}>
              {switchPending ? 'Confirm earlier switch' : 'Leave and join'}
            </PortalButton>
          )}
          <PortalTextButton type="button" disabled={switchPending} onClick={onStay}>
            Stay on this team
          </PortalTextButton>
        </div>
        <PortalError message={error} />
      </PetalCard>
    </PortalScene>
  )
}

type PendingTeam = NonNullable<FunctionReturnType<typeof api.participants.me>>['pendingTeam']

function PendingTeamScreen({
  header,
  pendingTeam,
}: {
  header: ReactNode
  pendingTeam: NonNullable<PendingTeam>
}) {
  const declineAssignedTeam = useMutation(api.participants.declineAssignedTeam)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operations = useOperationRunner()
  const leavePending = operations.hasPending('team-assignment-leave')

  const leaveAssignment = async () => {
    setError(null)
    try {
      await operations.run('team-assignment-leave', (clientOperationId) => () =>
        declineAssignedTeam({
          eventSlug,
          teamRosterEntryId: pendingTeam.id,
          expectedVersion: pendingTeam.version,
          clientOperationId,
        }),
      )
      setConfirmLeave(false)
    } catch (caught) {
      setError(readableError(caught))
    }
  }

  return (
    <PortalScene tree="both" header={header}>
      <PetalCard className="w-full max-w-[600px] px-7 py-7 sm:px-9">
        <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-rose-light">Your team</p>
        <h1 className="font-display font-light tracking-[-.01em] text-3xl">{pendingTeam.teamName}</h1>
        <p className="mt-3 text-[13px] leading-relaxed text-fg/58">
          {pendingTeam.status === 'waiting_for_lead'
            ? 'Your team lead has not signed in yet. You will join automatically when they do.'
            : `You will join as ${pendingTeam.role === 'lead' ? 'the lead' : 'a member'} shortly.`}
        </p>
        <ul className="m-0 mt-6 list-none divide-y divide-fg/10 p-0">
          {pendingTeam.assignees.map((assignee, index) => (
            <li className="flex items-center justify-between gap-4 py-3" key={`${assignee.role}:${index}`}>
              <span className="text-sm text-fg/86">{assignee.displayName}</span>
              <small className="text-right text-[11px] text-fg/42">
                {assignee.role === 'lead' ? 'Lead' : 'Member'}
                {assignee.isYou ? ' · You' : ''}
                {` · ${assignee.signedIn ? 'Signed in' : 'Waiting'}`}
              </small>
            </li>
          ))}
        </ul>
        {confirmLeave ? (
          <div className="mt-6 border-t border-fg/10 pt-5">
            <p className="text-[13px] text-fg/65">
              Leave this assignment? You can create or join another team afterward.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <PortalButton type="button" disabled={leavePending} onClick={() => void leaveAssignment()}>
                {leavePending ? 'Leaving…' : 'Leave team'}
              </PortalButton>
              <PortalTextButton type="button" disabled={leavePending} onClick={() => setConfirmLeave(false)}>
                Keep assignment
              </PortalTextButton>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="mt-6 text-[12px] text-fg/40 underline-offset-4 hover:text-rose-light hover:underline"
            disabled={leavePending}
            onClick={() => setConfirmLeave(true)}
          >
            Leave assignment
          </button>
        )}
        <PortalError message={error} />
      </PetalCard>
    </PortalScene>
  )
}

function PortalContentLoading() {
  return null
}

function preloadIntegrations() {
  void loadIntegrationsScreen()
}

function preloadSynesthesia() {
  void loadSynesthesiaScreen()
}

function preloadSupport() {
  void loadSupportScreen()
}

function ProvisionScreen({
  publicState,
  onSignOut,
}: {
  publicState: PublicState
  onSignOut: () => void
}) {
  const provision = useMutation(api.participants.provision)
  const provisioningRef = useRef(false)
  const attemptedClassRef = useRef<ParticipantClass | null>(null)
  const [participantClass, setParticipantClass] = useState<ParticipantClass | null>(() => {
    const stored = sessionStorage.getItem(participantClassStorageKey)
    return stored === 'vit_student' || stored === 'external_participant' ? stored : null
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const vitOpen = Boolean(
    publicState.event?.registrationOpen &&
    publicState.serverNow < publicState.event.applicationsCloseAt,
  )
  const externalOpen = Boolean(
    publicState.event?.registrationOpen &&
    publicState.serverNow < publicState.event.externalApplicationsCloseAt,
  )
  const selectedClassOpen = participantClass === 'vit_student' ? vitOpen : externalOpen

  const choose = (value: ParticipantClass) => {
    sessionStorage.setItem(participantClassStorageKey, value)
    setParticipantClass(value)
    setError(null)
  }

  const provisionParticipant = useCallback(async (selectedClass: ParticipantClass) => {
    if (provisioningRef.current) return
    provisioningRef.current = true
    attemptedClassRef.current = selectedClass
    setBusy(true)
    setError(null)
    try {
      await provision({ eventSlug, participantClass: selectedClass })
      sessionStorage.removeItem(participantClassStorageKey)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      provisioningRef.current = false
      setBusy(false)
    }
  }, [provision])

  useEffect(() => {
    if (
      !participantClass ||
      !selectedClassOpen ||
      attemptedClassRef.current === participantClass
    ) return
    void provisionParticipant(participantClass)
  }, [participantClass, provisionParticipant, selectedClassOpen])

  if (participantClass && selectedClassOpen && !error) {
    return (
      <PortalScene tree="both">
        <p role="status" className="font-ui font-normal text-xl text-rose-light">
          Finishing your participant setup…
        </p>
      </PortalScene>
    )
  }

  return (
    <PortalScene
      tree="both"
      header={
        <button
          type="button"
          onClick={onSignOut}
          className="text-[12px] text-fg/45 transition-colors hover:text-rose-light"
        >
          Sign out
        </button>
      }
    >
      <div className="flex w-full max-w-[560px] flex-col items-center text-center">
        <h1 className="mb-2 font-display font-light tracking-[-.01em] text-3xl lg:text-[40px]">
          Choose your participant type.
        </h1>
        <p className="mb-7 text-[12.5px] text-fg/50">
          VIT students must use their @vitstudent.ac.in Google account.
        </p>
        <div className="mb-6 flex w-full flex-col gap-3 sm:flex-row sm:justify-center sm:gap-4">
          <ProvisionChoice
            title="VIT student"
            detail="Only @vitstudent.ac.in accounts are accepted."
            disabled={!vitOpen}
            selected={participantClass === 'vit_student'}
            onSelect={() => choose('vit_student')}
          />
          <ProvisionChoice
            title="External participant"
            detail={externalOpen ? 'College students and other eligible applicants.' : 'Applications have closed.'}
            disabled={!externalOpen}
            selected={participantClass === 'external_participant'}
            onSelect={() => choose('external_participant')}
          />
        </div>
        <PortalError message={error} />
        {participantClass && error ? (
          <PortalButton
            type="button"
            className="mt-4"
            disabled={busy || !selectedClassOpen}
            onClick={() => void provisionParticipant(participantClass)}
          >
            {busy ? 'Checking…' : 'Try again'}
          </PortalButton>
        ) : null}
      </div>
    </PortalScene>
  )
}

function ProvisionChoice({
  title,
  detail,
  selected,
  disabled,
  onSelect,
}: {
  title: string
  detail: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onSelect}
      className={`w-full rounded-petal-sm px-6 py-5 text-left backdrop-blur-md transition-all hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-45 sm:w-[250px] ${
        selected
          ? 'border-[1.5px] border-ring-lead bg-[image:var(--tile-bg-active)] shadow-[0_24px_50px_-18px_var(--shade-2),0_0_26px_var(--glow-rose-soft)]'
          : 'border border-petal-edge-soft bg-[image:var(--tile-bg)] shadow-[0_24px_50px_-18px_var(--shade-2)]'
      }`}
    >
      <p className={`mb-1 font-display font-light tracking-[-.01em] text-[19px] ${selected ? 'text-rose-light' : 'text-fg/85'}`}>
        {title}
      </p>
      <p className="text-xs text-fg/55">{detail}</p>
    </button>
  )
}
