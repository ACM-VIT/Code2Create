import { api } from '@code2create/backend/api'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import { useMutation, useQuery } from 'convex/react'
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
  const access = useQuery(api.access.mine, { eventSlug })
  const team = useQuery(api.teams.current, { eventSlug })
  const intake = useQuery(api.intake.current, { eventSlug })

  if (me === undefined || access === undefined || team === undefined || intake === undefined) {
    return <PortalLoading />
  }

  const signOut = () => void authClient.signOut()
  const canReadSupport = Boolean(access?.grants.some(
    (grant) =>
      grant.permissionKey === 'support.case.read' &&
      (grant.scopeType === 'self' || grant.scopeType === 'event'),
  ))
  const canCreateSupport = Boolean(access?.grants.some(
    (grant) =>
      grant.permissionKey === 'support.case.create' &&
      (grant.scopeType === 'self' || grant.scopeType === 'event'),
  ))

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

  if (!me.profile?.isComplete) {
    const profileKey = `${me.participantPolicy.id}:${me.profile?.profileVersion ?? 0}`
    return (
      <>
        <PortalHeader name={me.person.displayName} email={me.person.verifiedEmail} onSignOut={signOut} showSupport={canReadSupport} />
        {location.pathname === '/support'
          ? canReadSupport
            ? <SupportScreen canCreate={canCreateSupport} />
            : <Navigate replace to="/" />
          : !me.participantPolicy.accepted
            ? team
              ? (
                  <div className="portal-grid">
                    <TeamPanel team={team} />
                    <PolicyConsentScreen me={me} />
                  </div>
                )
              : <PolicyConsentScreen me={me} />
          : team
            ? (
                <div className="portal-grid">
                  <TeamPanel team={team} />
                  <ProfileScreen key={profileKey} me={me} />
                </div>
              )
            : (
                <div className="portal-grid">
                  <TeamScreen embedded />
                  <ProfileScreen key={profileKey} me={me} />
                </div>
              )}
      </>
    )
  }

  if (!team) {
    return (
      <>
        <PortalHeader name={me.person.displayName} email={me.person.verifiedEmail} onSignOut={signOut} showSupport={canReadSupport} />
        {location.pathname === '/support'
          ? canReadSupport
            ? <SupportScreen canCreate={canCreateSupport} />
            : <Navigate replace to="/" />
          : <TeamScreen />}
      </>
    )
  }

  if (!intake) return <PortalLoading />

  const portalContent = location.pathname === '/integrations/github/callback'
    ? <GitHubCallbackScreen />
      : location.pathname === '/integrations/figma/callback'
      ? <FigmaCallbackScreen />
      : location.pathname === '/support'
        ? canReadSupport
          ? <SupportScreen canCreate={canCreateSupport} />
          : <Navigate replace to="/" />
      : location.pathname === '/music'
        ? <SynesthesiaScreen />
      : location.pathname === '/integrations'
        ? <IntegrationsScreen />
        : intake.application
          ? <SubmittedScreen publicState={publicState} intake={intake} />
          : <IntakeScreen team={team} intake={intake} />
  const applicationFlow = !intake.application && location.pathname === '/'
  const acceptedFeatures = intake.application
    ? ['accepted', 'offer_sent', 'confirmed'].includes(intake.application.state)
    : false

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
        showAcceptedFeatures={acceptedFeatures}
        showSupport={canReadSupport}
      />
      {applicationFlow ? (
        <div className="minimal-application-flow">
          <details className="minimal-team-access">
            <summary>
              <span>Team</span>
              <strong>{team.name}</strong>
              <small>{team.members.length} of {team.teamMaximumSize}</small>
            </summary>
            <TeamPanel team={team} />
          </details>
          <main className="minimal-flow-main">
            <Suspense fallback={<PortalContentLoading />}>{portalContent}</Suspense>
          </main>
        </div>
      ) : intake.application ? (
        <div className="participant-home">
          <details className="minimal-team-access submitted-team-access">
            <summary>
              <span>Team</span>
              <strong>{team.name}</strong>
              <small>{team.members.length} {team.members.length === 1 ? 'member' : 'members'}</small>
            </summary>
            <TeamPanel team={team} />
          </details>
          <main className="portal-main participant-home-main">
            <Suspense fallback={<PortalContentLoading />}>{portalContent}</Suspense>
          </main>
        </div>
      ) : (
        <div className="portal-grid">
          <TeamPanel team={team} />
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
  showAcceptedFeatures = false,
  showSupport = false,
}: {
  name?: string
  email?: string
  onSignOut: () => void
  showNavigation?: boolean
  showAcceptedFeatures?: boolean
  showSupport?: boolean
}) {
  return (
    <header className="portal-header">
      <Link to="/" className="wordmark">Code2Create</Link>
      <div className="header-actions">
        {showNavigation || showSupport ? (
          <nav className="portal-navigation" aria-label="Portal">
            {showNavigation ? <NavLink end to="/">Home</NavLink> : null}
            {showAcceptedFeatures ? (
              <NavLink to="/integrations" onFocus={preloadIntegrations} onMouseEnter={preloadIntegrations}>Code and design</NavLink>
            ) : null}
            {showAcceptedFeatures ? (
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

function PortalContentLoading() {
  return <p className="muted" role="status">Loading…</p>
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
        <p className="muted">Choose VIT Student only when Google can verify your VIT Workspace account.</p>
        <div className="choice-stack">
          <button type="button" className={participantClass === 'vit_student' ? 'choice selected' : 'choice'} onClick={() => choose('vit_student')}>
            <span>VIT Student</span><small>Your verified email must use an approved VIT domain.</small>
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
