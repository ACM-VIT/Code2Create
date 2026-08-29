import { api } from '@code2create/backend/api'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Navigate, useLocation } from 'react-router-dom'
import { TeamPanel } from './components/TeamPanel'
import { ErrorNotice } from './components/Form'
import { eventSlug } from './lib/config'
import { readableError } from './lib/errors'
import { participantClassStorageKey } from './screens/EntryScreen'
import { IntakeScreen } from './screens/IntakeScreen'
import { PolicyConsentScreen } from './screens/PolicyConsentScreen'
import { ProfileScreen } from './screens/ProfileScreen'
import { TeamScreen } from './screens/TeamScreen'
import type { ParticipantClass, PublicState } from './types'

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

export function ParticipantApp({
  publicState,
  authClient,
}: {
  publicState: PublicState
  authClient: Code2CreateAuthClient
}) {
  const location = useLocation()
  const me = useQuery(api.participants.me, { eventSlug })
  const access = useQuery(api.access.participantCapabilities, { eventSlug })
  const hasTeamMembership = access?.hasTeamMembership ?? false
  const canReadProfile = access?.profileRead ?? false
  const canWriteProfile = access?.profileWrite ?? false
  const canJoinTeam = access?.teamJoin ?? false
  const canReadTeam = access?.teamRead ?? false
  const teamQuery = useQuery(api.teams.current, canReadTeam ? { eventSlug } : 'skip')
  const teamMembers = usePaginatedQuery(api.teams.members, canReadTeam ? { eventSlug } : 'skip', { initialNumItems: 25 })
  const intakeStatusQuery = useQuery(api.intake.status, canReadTeam ? { eventSlug } : 'skip')

  if (me === undefined || access === undefined) {
    return <PortalLoading />
  }
  if (canReadTeam && (teamQuery === undefined || intakeStatusQuery === undefined)) {
    return <PortalLoading />
  }

  const team = canReadTeam ? teamQuery ?? null : null
  const intakeStatus = canReadTeam ? intakeStatusQuery ?? null : null
  const teamAccessUnavailable = hasTeamMembership && !canReadTeam
  const signOut = () => void authClient.signOut()
  const canReadIntegrations = access?.integrations ?? false
  const canReadSupport = access?.supportRead ?? false
  const canCreateSupport = access?.supportCreate ?? false

  if (!me?.membership) {
    return (
      <>
        <PortalHeader
          {...(me
            ? { name: me.person.displayName, email: me.person.verifiedEmail }
            : {})}
          onSignOut={signOut}
        />
        <ProvisionScreen publicState={publicState} />
      </>
    )
  }

  if (hasTeamMembership && canReadTeam && !team) return <PortalLoading />

  const hasSubmittedApplication = intakeStatus !== null && intakeStatus.applicationState !== null
  const canContinueWithoutProfileProjection = !canReadProfile && hasSubmittedApplication
  if (!me.profile?.isComplete && !canContinueWithoutProfileProjection) {
    const profileKey = `${me.participantPolicy.id}:${me.profile?.profileVersion ?? 0}`
    const teamContext = team
      ? <TeamPanel team={team} members={teamMembers.results} rosterStatus={teamMembers.status} loadMore={teamMembers.loadMore} />
      : teamAccessUnavailable
        ? <TeamAccessNotice />
        : null
    const teamSetup = canJoinTeam
      ? me.pendingTeam
        ? <PendingTeamPanel pendingTeam={me.pendingTeam} />
        : <TeamScreen embedded />
      : <TeamJoinAccessNotice />
    const profileContext = !canReadProfile
      ? <ProfileAccessNotice mode="read" />
      : canWriteProfile
        ? <ProfileScreen key={profileKey} me={me} />
        : <ProfileAccessNotice mode="write" />
    return (
      <>
        <PortalHeader name={me.person.displayName} email={me.person.verifiedEmail} onSignOut={signOut} showSupport={canReadSupport} />
        {location.pathname === '/support'
          ? canReadSupport
            ? <SupportScreen canCreate={canCreateSupport} />
            : <Navigate replace to="/" />
          : !me.participantPolicy.accepted
            ? teamContext
              ? (
                  <div className="portal-grid">
                    {teamContext}
                    <PolicyConsentScreen canAccept={canWriteProfile} me={me} />
                  </div>
                )
              : <PolicyConsentScreen canAccept={canWriteProfile} me={me} />
            : (
                <div className="portal-grid">
                  {teamContext ?? teamSetup}
                  {profileContext}
                </div>
              )}
      </>
    )
  }

  if (teamAccessUnavailable) {
    return (
      <>
        <PortalHeader name={me.person.displayName} email={me.person.verifiedEmail} onSignOut={signOut} showSupport={canReadSupport} />
        {location.pathname === '/support'
          ? canReadSupport
            ? <SupportScreen canCreate={canCreateSupport} />
            : <Navigate replace to="/" />
          : (
              <main className="portal-main">
                <TeamAccessNotice />
              </main>
            )}
      </>
    )
  }

  if (!team) {
    if (canJoinTeam && me.pendingTeam) {
      return (
        <>
          <PortalHeader name={me.person.displayName} email={me.person.verifiedEmail} onSignOut={signOut} showSupport={canReadSupport} />
          {location.pathname === '/support'
            ? canReadSupport
              ? <SupportScreen canCreate={canCreateSupport} />
              : <Navigate replace to="/" />
            : (
                <main className="portal-main">
                  <PendingTeamPanel pendingTeam={me.pendingTeam} />
                </main>
              )}
        </>
      )
    }
    return (
      <>
        <PortalHeader name={me.person.displayName} email={me.person.verifiedEmail} onSignOut={signOut} showSupport={canReadSupport} />
        {location.pathname === '/support'
          ? canReadSupport
            ? <SupportScreen canCreate={canCreateSupport} />
            : <Navigate replace to="/" />
          : canJoinTeam
            ? <TeamScreen />
            : (
                <main className="portal-main">
                  <TeamJoinAccessNotice />
                </main>
              )}
      </>
    )
  }

  if (!intakeStatus) return <PortalLoading />

  if (intakeStatus.submissionState === 'validating') {
    return (
      <>
        <PortalHeader name={me.person.displayName} email={me.person.verifiedEmail} onSignOut={signOut} showSupport={canReadSupport} />
        <main className="portal-main">
          <section className="intake-panel">
            <p className="eyebrow">Final submission</p>
            <h1>Submitting your idea…</h1>
            <p className="lead">We are confirming your team and answers. You can leave this page; the result appears here automatically.</p>
          </section>
        </main>
      </>
    )
  }

  const applicationFlow = intakeStatus.applicationState === null && location.pathname === '/'
  const acceptedFeatures = intakeStatus.applicationState !== null
    ? ['accepted', 'offer_sent', 'confirmed'].includes(intakeStatus.applicationState)
    : false
  const canOpenIntegrations = acceptedFeatures && canReadIntegrations
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
      : location.pathname === '/integrations'
        ? canOpenIntegrations ? <IntegrationsScreen /> : <Navigate replace to="/" />
        : intakeStatus.applicationState !== null
          ? <SubmittedScreen capabilities={access} publicState={publicState} team={team} members={teamMembers.results} />
          : (
              <IntakeScreen
                team={team}
                members={teamMembers.results}
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
        showNavigation={!applicationFlow}
        showIntegrations={acceptedFeatures && canReadIntegrations}
        showMusic={acceptedFeatures}
        showSupport={canReadSupport}
      />
      {applicationFlow ? (
        <div className="minimal-application-flow">
          <details className="minimal-team-access">
            <summary>
              <span>Team</span>
              <strong>{team.name}</strong>
              <small>{team.activeMemberCount} of {team.teamMaximumSize}</small>
            </summary>
            <TeamPanel team={team} members={teamMembers.results} rosterStatus={teamMembers.status} loadMore={teamMembers.loadMore} />
          </details>
          <main className="minimal-flow-main">
            <Suspense fallback={<PortalContentLoading />}>{portalContent}</Suspense>
          </main>
        </div>
      ) : intakeStatus.applicationState !== null ? (
        <div className="participant-home">
          <details className="minimal-team-access submitted-team-access">
            <summary>
              <span>Team</span>
              <strong>{team.name}</strong>
              <small>{team.activeMemberCount} {team.activeMemberCount === 1 ? 'member' : 'members'}</small>
            </summary>
            <TeamPanel team={team} members={teamMembers.results} rosterStatus={teamMembers.status} loadMore={teamMembers.loadMore} />
          </details>
          <main className="portal-main participant-home-main">
            <Suspense fallback={<PortalContentLoading />}>{portalContent}</Suspense>
          </main>
        </div>
      ) : (
        <div className="portal-grid">
          <TeamPanel team={team} members={teamMembers.results} rosterStatus={teamMembers.status} loadMore={teamMembers.loadMore} />
          <main className="portal-main">
            <Suspense fallback={<PortalContentLoading />}>{portalContent}</Suspense>
          </main>
        </div>
      )}
    </div>
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
      <Link to="/" className="wordmark">Code2Create</Link>
      <div className="header-actions">
        {showNavigation || showIntegrations || showMusic || showSupport ? (
          <nav className="portal-navigation" aria-label="Portal">
            {showNavigation ? <NavLink end to="/">Home</NavLink> : null}
            {showIntegrations ? (
              <NavLink to="/integrations" onFocus={preloadIntegrations} onMouseEnter={preloadIntegrations}>Build</NavLink>
            ) : null}
            {showMusic ? (
              <NavLink to="/music" onFocus={preloadSynesthesia} onMouseEnter={preloadSynesthesia}>Music</NavLink>
            ) : null}
            {showSupport ? (
              <NavLink to="/support" onFocus={preloadSupport} onMouseEnter={preloadSupport}>Help</NavLink>
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
  return (
    <main className="centered-shell">
      <p className="muted" role="status">Loading your portal…</p>
    </main>
  )
}

type PendingTeam = NonNullable<FunctionReturnType<typeof api.participants.me>>['pendingTeam']

function PendingTeamPanel({ pendingTeam }: { pendingTeam: NonNullable<PendingTeam> }) {
  return (
    <section className="intake-panel">
      <p className="eyebrow">Your team</p>
      <h1>You&rsquo;re assigned to {pendingTeam.teamName}.</h1>
      {pendingTeam.status === 'waiting_for_lead' ? (
        <p className="lead">
          Your team lead has not signed in yet. You can stay on this page; you&rsquo;ll join
          automatically after they do.
        </p>
      ) : (
        <p className="lead">
          You&rsquo;ll join {pendingTeam.teamName} as its {pendingTeam.role === 'lead' ? 'lead' : 'member'} shortly.
        </p>
      )}
    </section>
  )
}

function PortalContentLoading() {
  return <p className="muted" role="status">Loading…</p>
}

function TeamAccessNotice() {
  return (
    <section className="intake-panel">
      <p className="eyebrow">Team</p>
      <h1>Team access is unavailable.</h1>
      <p className="lead">You are still on your team. You cannot create or join another team until an organizer restores access.</p>
    </section>
  )
}

function TeamJoinAccessNotice() {
  return (
    <section className="intake-panel">
      <p className="eyebrow">Team</p>
      <h1>Team setup is unavailable.</h1>
      <p className="lead">This account cannot create or join a team. Ask an organizer to restore team setup access.</p>
    </section>
  )
}

function ProfileAccessNotice({ mode }: { mode: 'read' | 'write' }) {
  return (
    <section className="intake-panel">
      <p className="eyebrow">Profile</p>
      <h1>{mode === 'read' ? 'Profile access is unavailable.' : 'Profile changes are unavailable.'}</h1>
      <p className="lead">
        {mode === 'read'
          ? 'Your saved profile has not been removed. Ask an organizer to restore profile access before submitting.'
          : 'Ask an organizer to restore profile changes before submitting.'}
      </p>
    </section>
  )
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

function ProvisionScreen({ publicState }: { publicState: PublicState }) {
  const provision = useMutation(api.participants.provision)
  const provisioningRef = useRef(false)
  const attemptedClassRef = useRef<ParticipantClass | null>(null)
  const [participantClass, setParticipantClass] = useState<ParticipantClass | null>(() => {
    const stored = sessionStorage.getItem(participantClassStorageKey)
    return stored === 'vit_student' || stored === 'external_participant' ? stored : null
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    if (!participantClass || attemptedClassRef.current === participantClass) return
    void provisionParticipant(participantClass)
  }, [participantClass, provisionParticipant])

  if (participantClass && !error) {
    return (
      <main className="centered-shell">
        <p className="muted" role="status">Finishing your participant setup…</p>
      </main>
    )
  }

  return (
    <main className="centered-shell">
      <section className="narrow-panel">
        <p className="eyebrow">{publicState.event?.name ?? 'Code2Create'}</p>
        <h1>Choose your participant type.</h1>
        <p className="muted">Choose VIT student if you signed in with your VIT email.</p>
        <div className="choice-stack">
          <button type="button" className={participantClass === 'vit_student' ? 'choice selected' : 'choice'} onClick={() => choose('vit_student')}>
            <span>VIT student</span><small>Your VIT email is required.</small>
          </button>
          <button type="button" className={participantClass === 'external_participant' ? 'choice selected' : 'choice'} onClick={() => choose('external_participant')}>
            <span>External participant</span><small>College students and other eligible applicants.</small>
          </button>
        </div>
        <ErrorNotice message={error} />
        {participantClass && error ? (
          <button
            type="button"
            className="secondary full-width"
            disabled={busy}
            onClick={() => void provisionParticipant(participantClass)}
          >
            {busy ? 'Checking…' : 'Try again'}
          </button>
        ) : null}
      </section>
    </main>
  )
}
