import { api } from '@code2create/backend/api'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import type { FunctionReturnType } from 'convex/server'
import { AuthLoading, Authenticated, Unauthenticated, useAction, useMutation, useQuery } from 'convex/react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { lazy, Suspense, useState } from 'react'

import { OperationsLayout, type OperationsNavigationGroup } from './components/OperationsLayout'
import type { ConfigurationTabsVisibility } from './components/ConfigurationTabs'
import { eventSlug } from './lib/config'
import { readableError } from './lib/errors'
import { InitialEventSetup } from './screens/InitialEventSetup'

const AdmissionDetail = lazy(() =>
  import('./screens/AdmissionDetail').then((module) => ({ default: module.AdmissionDetail })),
)
const AdmissionsQueue = lazy(() =>
  import('./screens/AdmissionsQueue').then((module) => ({ default: module.AdmissionsQueue })),
)
const AttendanceOverview = lazy(() =>
  import('./screens/AttendanceOverview').then((module) => ({ default: module.AttendanceOverview })),
)
const AttendanceSession = lazy(() =>
  import('./screens/AttendanceSession').then((module) => ({ default: module.AttendanceSession })),
)
const AttendanceSetup = lazy(() =>
  import('./screens/AttendanceSetup').then((module) => ({ default: module.AttendanceSetup })),
)
const AccessDirectory = lazy(() =>
  import('./screens/AccessDirectory').then((module) => ({ default: module.AccessDirectory })),
)
const AccessPerson = lazy(() =>
  import('./screens/AccessPerson').then((module) => ({ default: module.AccessPerson })),
)
const IntegrationOverview = lazy(() =>
  import('./screens/IntegrationOverview').then((module) => ({ default: module.IntegrationOverview })),
)
const HealthOverview = lazy(() =>
  import('./screens/HealthOverview').then((module) => ({ default: module.HealthOverview })),
)
const EventSetupOverview = lazy(() =>
  import('./screens/EventSetupOverview').then((module) => ({ default: module.EventSetupOverview })),
)
const Rehearsal = lazy(() =>
  import('./screens/Rehearsal').then((module) => ({ default: module.Rehearsal })),
)
const SupportDesk = lazy(() =>
  import('./screens/SupportDesk').then((module) => ({ default: module.SupportDesk })),
)
const FloorOverview = lazy(() =>
  import('./screens/FloorOverview').then((module) => ({ default: module.FloorOverview })),
)
const ReviewOverview = lazy(() =>
  import('./screens/ReviewOverview').then((module) => ({ default: module.ReviewOverview })),
)
const ReviewRoundBoard = lazy(() =>
  import('./screens/ReviewRoundBoard').then((module) => ({ default: module.ReviewRoundBoard })),
)
const ReviewSetup = lazy(() =>
  import('./screens/ReviewSetup').then((module) => ({ default: module.ReviewSetup })),
)
const ScoreOverview = lazy(() =>
  import('./screens/ScoreOverview').then((module) => ({ default: module.ScoreOverview })),
)
const ScoreRound = lazy(() =>
  import('./screens/ScoreRound').then((module) => ({ default: module.ScoreRound })),
)
const Synesthesia = lazy(() =>
  import('./screens/Synesthesia').then((module) => ({ default: module.Synesthesia })),
)
const ProjectCheckpointOverview = lazy(() =>
  import('./screens/ProjectCheckpointOverview').then((module) => ({ default: module.ProjectCheckpointOverview })),
)

const Roster = lazy(() =>
  import('./screens/Roster').then((module) => ({ default: module.Roster })),
)
const PermissionBundles = lazy(() =>
  import('./screens/PermissionBundles').then((module) => ({ default: module.PermissionBundles })),
)
const EmergencyPack = lazy(() =>
  import('./screens/EmergencyPack').then((module) => ({ default: module.EmergencyPack })),
)
const TrackConfiguration = lazy(() =>
  import('./screens/TrackConfiguration').then((module) => ({ default: module.TrackConfiguration })),
)
const IntakePolicyConfiguration = lazy(() =>
  import('./screens/IntakePolicyConfiguration').then((module) => ({ default: module.IntakePolicyConfiguration })),
)
const NoveltyConfiguration = lazy(() =>
  import('./screens/NoveltyConfiguration').then((module) => ({ default: module.NoveltyConfiguration })),
)
const ParticipantPolicyConfiguration = lazy(() =>
  import('./screens/ParticipantPolicyConfiguration').then((module) => ({ default: module.ParticipantPolicyConfiguration })),
)
const AdmissionPolicyConfiguration = lazy(() =>
  import('./screens/AdmissionPolicyConfiguration').then((module) => ({ default: module.AdmissionPolicyConfiguration })),
)
const CommunicationsPolicyConfiguration = lazy(() =>
  import('./screens/CommunicationsPolicyConfiguration').then((module) => ({ default: module.CommunicationsPolicyConfiguration })),
)
const IntelligencePolicyConfiguration = lazy(() =>
  import('./screens/IntelligencePolicyConfiguration').then((module) => ({ default: module.IntelligencePolicyConfiguration })),
)
const PhaseConfiguration = lazy(() =>
  import('./screens/PhaseConfiguration').then((module) => ({ default: module.PhaseConfiguration })),
)
const CheckpointConfiguration = lazy(() =>
  import('./screens/CheckpointConfiguration').then((module) => ({ default: module.CheckpointConfiguration })),
)

export default function App({ authClient }: { authClient: Code2CreateAuthClient }) {
  const publicState = useQuery(api.system.getPublicState, { eventSlug })
  if (publicState === undefined) return <Centered>Loading…</Centered>

  return (
    <>
      <AuthLoading><Centered>Checking access…</Centered></AuthLoading>
      <Unauthenticated>
        <SignIn
          authClient={authClient}
          googleConfigured={publicState.auth.googleConfigured}
          localDevelopmentFixturesEnabled={publicState.auth.localDevelopmentFixturesEnabled}
        />
      </Unauthenticated>
      <Authenticated>
        {publicState.event
          ? <Operations authClient={authClient} />
          : <InitialEventSetup authClient={authClient} />}
      </Authenticated>
    </>
  )
}

function Operations({ authClient }: { authClient: Code2CreateAuthClient }) {
  const access = useQuery(api.access.mine, { eventSlug })
  const invitation = useQuery(api.accessInvitations.mine, { eventSlug })
  const roster = useQuery(api.rosters.mine, { eventSlug })
  const { data: session } = authClient.useSession()
  if (access === undefined || invitation === undefined || roster === undefined) {
    return <Centered>Loading your event access…</Centered>
  }
  if (roster) {
    return <RosterClaim authClient={authClient} roster={roster} />
  }
  if (!access && invitation) {
    return <InvitationClaim authClient={authClient} invitation={invitation} />
  }
  if (!access) {
    return <NoOperationsAccess authClient={authClient} />
  }
  const canViewAdmissions = access.grants.some((grant) => grant.permissionKey.startsWith('application.'))
  const canViewEventLifecycle = access.grants.some(
    (grant) => grant.permissionKey === 'event.lifecycle.read' && grant.scopeType === 'event',
  )
  const canViewTrackConfiguration = access.grants.some(
    (grant) => grant.permissionKey === 'configuration.read' && grant.scopeType === 'event',
  )
  const canViewPhaseConfiguration = access.grants.some(
    (grant) => grant.permissionKey === 'configuration.phase.read' && grant.scopeType === 'event',
  )
  const canViewIntakeConfiguration = access.grants.some(
    (grant) => grant.permissionKey === 'configuration.intake.read' && grant.scopeType === 'event',
  )
  const canViewNoveltyConfiguration = access.grants.some(
    (grant) => grant.permissionKey === 'configuration.novelty.read' && grant.scopeType === 'event',
  )
  const canViewParticipantConfiguration = access.grants.some(
    (grant) => grant.permissionKey === 'configuration.participant.read' && grant.scopeType === 'event',
  )
  const canViewAdmissionConfiguration = access.grants.some(
    (grant) => grant.permissionKey === 'configuration.admission.read' && grant.scopeType === 'event',
  )
  const canViewCommunicationsConfiguration = access.grants.some(
    (grant) => grant.permissionKey === 'configuration.communications.read' && grant.scopeType === 'event',
  )
  const canViewIntelligenceConfiguration = access.grants.some(
    (grant) => grant.permissionKey === 'configuration.intelligence.read' && grant.scopeType === 'event',
  )
  const canViewCheckpointConfiguration = access.grants.some(
    (grant) => grant.permissionKey === 'configuration.checkpoint.read' && grant.scopeType === 'event',
  )
  const canViewAttendance = access.grants.some(
    (grant) => grant.permissionKey.startsWith('attendance.') || grant.permissionKey === 'configuration.manage',
  )
  const canSetupAttendance = access.grants.some(
    (grant) => grant.permissionKey === 'configuration.manage' || grant.permissionKey === 'attendance.plan.publish',
  )
  const canReadPeople = access.grants.some(
    (grant) => grant.permissionKey === 'access.permissions.read',
  )
  const canInvite = access.grants.some(
    (grant) => grant.permissionKey === 'access.subjects.invite' && grant.scopeType === 'event',
  )
  const canReadBundles = access.grants.some(
    (grant) => grant.permissionKey === 'access.permission_bundles.read',
  )
  const canReadRoster = access.grants.some(
    (grant) => grant.permissionKey.startsWith('access.roster.'),
  )
  const canViewAccess = canReadPeople || canInvite || canReadBundles || canReadRoster
  const canViewIntegrations = access.grants.some(
    (grant) => grant.permissionKey === 'integration.read',
  )
  const canViewProjectCheckpoints = access.grants.some(
    (grant) => grant.permissionKey === 'project.checkpoint.read' && grant.scopeType === 'event',
  )
  const canViewReviews = access.grants.some(
    (grant) =>
      grant.permissionKey.startsWith('review.') ||
      grant.permissionKey.startsWith('reviewer.') ||
      grant.permissionKey.startsWith('round.') ||
      grant.permissionKey.startsWith('panel.') ||
      grant.permissionKey.startsWith('queue.'),
  )
  const canViewScores = access.grants.some(
    (grant) => grant.permissionKey === 'score.completeness.read',
  )
  const canViewSynesthesia = access.grants.some(
    (grant) => grant.permissionKey.startsWith('synesthesia.'),
  )
  const canViewHealth = access.grants.some(
    (grant) => grant.permissionKey === 'operations.health.read' && grant.scopeType === 'event',
  )
  const canReadIntelligence = access.grants.some(
    (grant) => grant.permissionKey === 'operations.intelligence.read' && grant.scopeType === 'event',
  )
  const canGenerateIntelligence = access.grants.some(
    (grant) => grant.permissionKey === 'operations.intelligence.generate' && grant.scopeType === 'event',
  )
  const canViewSupport = access.grants.some(
    (grant) =>
      (grant.permissionKey === 'support.case.create' && grant.scopeType === 'event') ||
      ((grant.permissionKey === 'support.case.read' || grant.permissionKey === 'support.case.manage') &&
        (grant.scopeType === 'event' || grant.scopeType === 'support_case')),
  )
  const canViewRehearsal = access.grants.some(
    (grant) => grant.permissionKey.startsWith('rehearsal.'),
  )
  const canReadEmergencyPack = access.grants.some(
    (grant) => grant.permissionKey === 'emergency_pack.read' && grant.scopeType === 'event',
  )
  const canPrepareEmergencyPack = access.grants.some(
    (grant) => grant.permissionKey === 'emergency_pack.prepare' && grant.scopeType === 'event',
  )
  const canPrintEmergencyPack = access.grants.some(
    (grant) => grant.permissionKey === 'emergency_pack.print' && grant.scopeType === 'event',
  )
  const canViewEmergencyPack =
    canReadEmergencyPack || canPrepareEmergencyPack || canPrintEmergencyPack
  const canReadFloorLocations = access.grants.some(
    (grant) => grant.permissionKey === 'floor.location.read',
  )
  const canReadFloorConfiguration = access.grants.some(
    (grant) => grant.permissionKey.startsWith('floor.plan.'),
  )
  const configurationPath = canViewEventLifecycle ||
    canViewTrackConfiguration ||
    canViewParticipantConfiguration ||
    canViewAdmissionConfiguration ||
    canViewIntakeConfiguration ||
    canViewNoveltyConfiguration ||
    canViewCommunicationsConfiguration ||
    canViewIntelligenceConfiguration ||
    canViewPhaseConfiguration ||
    canViewCheckpointConfiguration ||
    canSetupAttendance ||
    canReadFloorConfiguration ||
    canViewIntegrations
    ? '/configuration'
    : null
  const configurationTabs: ConfigurationTabsVisibility = {
    showLifecycle: canViewEventLifecycle,
    showAttendance: canSetupAttendance,
    showTracks: canViewTrackConfiguration,
    showIntake: canViewIntakeConfiguration,
    showNovelty: canViewNoveltyConfiguration,
    showParticipants: canViewParticipantConfiguration,
    showAdmissions: canViewAdmissionConfiguration,
    showCommunications: canViewCommunicationsConfiguration,
    showFloor: canReadFloorConfiguration,
    showIntegrations: canViewIntegrations,
    showIntelligence: canViewIntelligenceConfiguration,
    showPhases: canViewPhaseConfiguration,
    showCheckpoints: canViewCheckpointConfiguration,
  }
  const canReadReviewConfiguration = access.grants.some(
    (grant) => grant.permissionKey === 'review.configuration.read' && grant.scopeType === 'event',
  )
  const canPublishReviewConfiguration = access.grants.some(
    (grant) => grant.permissionKey === 'review.configuration.publish' && grant.scopeType === 'event',
  )
  const canReadReviewerProfiles = access.grants.some(
    (grant) => grant.permissionKey === 'reviewer.profile.read' && grant.scopeType === 'event',
  )
  const canOpenReviewSetup = canReadReviewConfiguration || canReadReviewerProfiles
  const navigation: OperationsNavigationGroup[] = [
    {
      label: 'Now',
      items: [
        ...(canViewHealth ? [{ label: 'Overview', to: '/' }] : []),
        ...(canViewSupport ? [{ label: 'Help desk', to: '/support' }] : []),
      ],
    },
    {
      label: 'Applications',
      items: canViewAdmissions ? [{ label: 'Review applications', to: '/admissions' }] : [],
    },
    {
      label: 'Event day',
      items: [
        ...(canViewAttendance ? [{ label: 'Check-in', to: '/attendance' }] : []),
        ...(canReadFloorLocations ? [{ label: 'Hall', to: '/floor' }] : []),
        ...(canViewSynesthesia ? [{ label: 'Music desk', to: '/synesthesia' }] : []),
      ],
    },
    {
      label: 'Judging',
      items: [
        ...(canViewReviews ? [{ label: 'Review rounds', to: '/reviews' }] : []),
        ...(canViewScores ? [{ label: 'Results', to: '/scores' }] : []),
        ...(canViewProjectCheckpoints ? [{ label: 'Team updates', to: '/checkpoints' }] : []),
        ...(canViewIntegrations ? [{ label: 'Code and design', to: '/integrations' }] : []),
      ],
    },
    {
      label: 'Manage',
      items: [
        ...(configurationPath ? [{ label: 'Event setup', to: configurationPath }] : []),
        ...(canViewAccess ? [{ label: 'People and permissions', to: '/access' }] : []),
        ...(canViewRehearsal ? [{ label: 'Test run', to: '/rehearsal' }] : []),
        ...(canViewEmergencyPack ? [{ label: 'Recovery', to: '/emergency-pack' }] : []),
      ],
    },
  ].filter((group) => group.items.length > 0)
  const homeActions = {
    complete: [
      ...(canViewScores ? [{ label: 'Open results', to: '/scores' }] : []),
      ...(canViewReviews ? [{ label: 'Review judging', to: '/reviews' }] : []),
      ...(canViewSupport ? [{ label: 'Open help desk', to: '/support' }] : []),
    ],
    draft: [
      ...(configurationPath ? [{ label: 'Set up the event', to: configurationPath }] : []),
      ...(canViewAccess ? [{ label: 'Add event staff', to: '/access' }] : []),
      ...(canViewRehearsal ? [{ label: 'Run a test', to: '/rehearsal' }] : []),
    ],
    live: [
      ...(canViewAttendance ? [{ label: 'Run check-in', to: '/attendance' }] : []),
      ...(canReadFloorLocations ? [{ label: 'Open hall', to: '/floor' }] : []),
      ...(canViewReviews ? [{ label: 'Run judging', to: '/reviews' }] : []),
      ...(canViewSupport ? [{ label: 'Open help desk', to: '/support' }] : []),
    ],
    registration: [
      ...(canViewAdmissions ? [{ label: 'Review applications', to: '/admissions' }] : []),
      ...(configurationPath ? [{ label: 'Manage event setup', to: configurationPath }] : []),
      ...(canViewAccess ? [{ label: 'Manage event staff', to: '/access' }] : []),
      ...(canViewSupport ? [{ label: 'Open help desk', to: '/support' }] : []),
    ],
  }
  const defaultPath = firstAvailablePath(
    [canViewHealth, '/'],
    [canViewAdmissions, '/admissions'],
    [canViewAttendance, '/attendance'],
    [canReadFloorLocations, '/floor'],
    [canReadFloorConfiguration, '/floor-setup'],
    [canViewReviews, '/reviews'],
    [canViewSupport, '/support'],
    [canViewScores, '/scores'],
    [canViewProjectCheckpoints, '/checkpoints'],
    [canViewIntegrations, '/integrations'],
    [configurationPath !== null, configurationPath ?? '/configuration'],
    [canViewAccess, '/access'],
    [canViewRehearsal, '/rehearsal'],
    [canViewEmergencyPack, '/emergency-pack'],
    [canViewSynesthesia, '/synesthesia'],
  )
  if (!defaultPath) {
    return <Centered>This account is active, but it has no operations workspace permissions.</Centered>
  }
  return (
    <OperationsLayout
      accountEmail={session?.user.email ?? ''}
      authClient={authClient}
      identity={session?.user.name || session?.user.email || 'Signed in'}
      navigation={navigation}
    >
      <Suspense fallback={<p className="muted" role="status">Loading workspace…</p>}>
        <Routes>
        {canViewHealth ? (
          <Route
            path="/"
            element={(
              <HealthOverview
                actions={homeActions}
                canGenerateIntelligence={canGenerateIntelligence}
                canReadIntelligence={canReadIntelligence}
              />
            )}
          />
        ) : null}
        {canViewRehearsal ? <Route path="/rehearsal" element={<Rehearsal />} /> : null}
        {canViewSupport ? <Route path="/support" element={<SupportDesk />} /> : null}
        {canViewAdmissions ? <Route path="/admissions" element={<AdmissionsQueue access={access} />} /> : null}
        {canViewAdmissions ? (
          <Route path="/admissions/:applicationId" element={<AdmissionDetail access={access} />} />
        ) : null}
        {configurationPath ? (
          <Route
            path="/configuration"
            element={(
              <Suspense fallback={<p className="muted">Loading event setup…</p>}>
                <EventSetupOverview tabs={configurationTabs} />
              </Suspense>
            )}
          />
        ) : null}
        {canViewTrackConfiguration ? (
          <Route
            path="/configuration/tracks"
            element={(
              <Suspense fallback={<p className="muted">Loading tracks…</p>}>
                <TrackConfiguration tabs={configurationTabs} />
              </Suspense>
            )}
          />
        ) : null}
        {canViewIntakeConfiguration ? (
          <Route
            path="/configuration/intake"
            element={(
              <Suspense fallback={<p className="muted">Loading intake configuration…</p>}>
                <IntakePolicyConfiguration tabs={configurationTabs} />
              </Suspense>
            )}
          />
        ) : null}
        {canViewNoveltyConfiguration ? (
          <Route
            path="/configuration/novelty"
            element={(
              <Suspense fallback={<p className="muted">Loading novelty configuration…</p>}>
                <NoveltyConfiguration tabs={configurationTabs} />
              </Suspense>
            )}
          />
        ) : null}
        {canViewParticipantConfiguration ? (
          <Route
            path="/configuration/participants"
            element={(
              <Suspense fallback={<p className="muted">Loading participant policy…</p>}>
                <ParticipantPolicyConfiguration tabs={configurationTabs} />
              </Suspense>
            )}
          />
        ) : null}
        {canViewAdmissionConfiguration ? (
          <Route
            path="/configuration/admissions"
            element={(
              <Suspense fallback={<p className="muted">Loading admission policy…</p>}>
                <AdmissionPolicyConfiguration tabs={configurationTabs} />
              </Suspense>
            )}
          />
        ) : null}
        {canViewCommunicationsConfiguration ? (
          <Route
            path="/configuration/communications"
            element={(
              <Suspense fallback={<p className="muted">Loading accepted-team communications…</p>}>
                <CommunicationsPolicyConfiguration tabs={configurationTabs} />
              </Suspense>
            )}
          />
        ) : null}
        {canViewIntelligenceConfiguration ? (
          <Route
            path="/configuration/intelligence"
            element={(
              <Suspense fallback={<p className="muted">Loading intelligence configuration…</p>}>
                <IntelligencePolicyConfiguration tabs={configurationTabs} />
              </Suspense>
            )}
          />
        ) : null}
        {canViewPhaseConfiguration ? (
          <Route
            path="/configuration/phases"
            element={(
              <Suspense fallback={<p className="muted">Loading phase configuration…</p>}>
                <PhaseConfiguration tabs={configurationTabs} />
              </Suspense>
            )}
          />
        ) : null}
        {canViewCheckpointConfiguration ? (
          <Route
            path="/configuration/checkpoints"
            element={(
              <Suspense fallback={<p className="muted">Loading checkpoint configuration…</p>}>
                <CheckpointConfiguration tabs={configurationTabs} />
              </Suspense>
            )}
          />
        ) : null}
        {canViewAttendance ? <Route path="/attendance" element={<AttendanceOverview />} /> : null}
        {canViewAttendance ? (
          <Route path="/attendance/:sessionId" element={<AttendanceSession />} />
        ) : null}
        {canReadFloorLocations ? (
          <Route
            path="/floor"
            element={(
              <FloorOverview
                canReadConfiguration={canReadFloorConfiguration}
                canReadLocations
                view="operations"
              />
            )}
          />
        ) : null}
        {canReadFloorConfiguration ? (
          <Route
            path="/floor-setup"
            element={(
              <FloorOverview
                canReadConfiguration
                canReadLocations={canReadFloorLocations}
                view="configuration"
              />
            )}
          />
        ) : null}
        {canViewEmergencyPack ? (
          <Route
            path="/emergency-pack"
            element={(
              <Suspense fallback={<p className="muted">Loading emergency pack…</p>}>
                <EmergencyPack
                  canPrepare={canPrepareEmergencyPack}
                  canPrint={canPrintEmergencyPack}
                  canRead={canReadEmergencyPack}
                />
              </Suspense>
            )}
          />
        ) : null}
        {canViewSynesthesia ? <Route path="/synesthesia" element={<Synesthesia />} /> : null}
        {canSetupAttendance ? <Route path="/attendance-setup" element={<AttendanceSetup />} /> : null}
        {canViewReviews ? <Route path="/reviews" element={<ReviewOverview showSetup={canOpenReviewSetup} />} /> : null}
        {canViewReviews ? <Route path="/reviews/:roundId" element={<ReviewRoundBoard />} /> : null}
        {canViewScores ? <Route path="/scores" element={<ScoreOverview />} /> : null}
        {canViewScores ? <Route path="/scores/:roundId" element={<ScoreRound />} /> : null}
        {canViewProjectCheckpoints ? <Route path="/checkpoints" element={<ProjectCheckpointOverview />} /> : null}
        {canOpenReviewSetup ? (
          <Route
            path="/review-setup"
            element={(
              <ReviewSetup
                access={access}
                canPublish={canPublishReviewConfiguration}
                canReadConfiguration={canReadReviewConfiguration}
                canReadProfiles={canReadReviewerProfiles}
              />
            )}
          />
        ) : null}
        {canViewIntegrations ? <Route path="/integrations" element={<IntegrationOverview />} /> : null}
        {canViewAccess ? (
          <Route
            path="/access"
            element={(
              <AccessDirectory
                canInvite={canInvite}
                canReadBundles={canReadBundles}
                canReadPeople={canReadPeople}
                canReadRoster={canReadRoster}
              />
            )}
          />
        ) : null}
        {canReadBundles ? (
          <Route
            path="/access/bundles"
            element={(
              <Suspense fallback={<p className="muted">Loading permission bundles…</p>}>
                <PermissionBundles />
              </Suspense>
            )}
          />
        ) : null}
        {canReadRoster ? (
          <Route
            path="/access/roster"
            element={(
              <Suspense fallback={<p className="muted">Loading roster…</p>}>
                <Roster />
              </Suspense>
            )}
          />
        ) : null}
        {canReadPeople ? (
          <Route path="/access/:personId" element={<AccessPerson access={access} />} />
        ) : null}
          <Route path="*" element={<Navigate replace to={defaultPath} />} />
        </Routes>
      </Suspense>
    </OperationsLayout>
  )
}

function firstAvailablePath(...options: readonly (readonly [enabled: boolean, path: string])[]) {
  return options.find(([enabled]) => enabled)?.[1] ?? null
}

type Invitation = NonNullable<FunctionReturnType<typeof api.accessInvitations.mine>>
type RosterEntry = NonNullable<FunctionReturnType<typeof api.rosters.mine>>

function RosterClaim({
  authClient,
  roster,
}: {
  authClient: Code2CreateAuthClient
  roster: RosterEntry
}) {
  const claim = useMutation(api.rosters.claim)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const accept = async () => {
    setBusy(true)
    setError(null)
    try {
      await claim({
        eventSlug,
        rosterEntryId: roster.id,
        expectedVersion: roster.version,
        clientOperationId: crypto.randomUUID(),
      })
    } catch (caught) {
      setError(readableError(caught))
      setBusy(false)
    }
  }

  return (
    <main className="centered">
      <section className="sign-in roster-claim">
        <p className="eyebrow">{roster.eventName}</p>
        <h1>Join the event team</h1>
        <p className="muted">
          You are listed as {roster.displayName} · {roster.roleLabel} under {roster.email}.
        </p>
        {roster.bundles.length > 0 ? (
          <ul className="claim-bundle-list">
            {roster.bundles.map((bundle) => (
              <li key={`${bundle.label}:${bundle.version}`}>{bundle.label}</li>
            ))}
          </ul>
        ) : (
          <p className="notice">You will start with a role label only. An organizer can add exact permissions after you join.</p>
        )}
        <button className="primary" type="button" disabled={busy} onClick={() => void accept()}>
          {busy ? 'Joining…' : 'Join operations'}
        </button>
        <p className="claim-expiry">This invitation expires {formatDateTime(roster.validUntil)}</p>
        <button className="text-button" type="button" disabled={busy} onClick={() => void authClient.signOut()}>
          Use another Google account
        </button>
        {error ? <p className="notice error" role="alert">{error}</p> : null}
      </section>
    </main>
  )
}

function InvitationClaim({
  authClient,
  invitation,
}: {
  authClient: Code2CreateAuthClient
  invitation: Invitation
}) {
  const claim = useMutation(api.accessInvitations.claim)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const accept = async () => {
    setBusy(true)
    setError(null)
    try {
      await claim({
        eventSlug,
        invitationId: invitation.id,
        expectedVersion: invitation.version,
        clientOperationId: crypto.randomUUID(),
      })
    } catch (caught) {
      setError(readableError(caught))
      setBusy(false)
    }
  }

  return (
    <main className="centered">
      <section className="sign-in invitation-claim">
        <p className="eyebrow">{invitation.eventName}</p>
        <h1>Join the event</h1>
        <p className="muted">
          This invitation is for {invitation.email}. Claiming it links this Google account to the event;
          it does not assign a role or permission.
        </p>
        <button className="primary" type="button" disabled={busy} onClick={() => void accept()}>
          {busy ? 'Joining…' : 'Claim invitation'}
        </button>
        <p className="claim-expiry">Expires {formatDateTime(invitation.validUntil)}</p>
        <button className="text-button" type="button" disabled={busy} onClick={() => void authClient.signOut()}>
          Use another Google account
        </button>
        {error ? <p className="notice error" role="alert">{error}</p> : null}
      </section>
    </main>
  )
}

function NoOperationsAccess({ authClient }: { authClient: Code2CreateAuthClient }) {
  return (
    <main className="centered">
      <section className="sign-in">
        <p className="eyebrow">Code2Create</p>
        <h1>No event access</h1>
        <p className="muted">This Google account has no current invitation or active event account.</p>
        <button className="text-button" type="button" onClick={() => void authClient.signOut()}>
          Use another Google account
        </button>
      </section>
    </main>
  )
}

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}

function SignIn({
  authClient,
  googleConfigured,
  localDevelopmentFixturesEnabled,
}: {
  authClient: Code2CreateAuthClient
  googleConfigured: boolean
  localDevelopmentFixturesEnabled: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createBrowserSession = useAction(api.localDevelopment.createBrowserSession)
  const signIn = async () => {
    setBusy(true)
    setError(null)
    const result = await authClient.signIn.social({ provider: 'google', callbackURL: window.location.href })
    if (result.error) setError(result.error.message || 'Google sign-in could not be completed.')
    setBusy(false)
  }
  const signInLocally = async () => {
    setBusy(true)
    setError(null)
    try {
      const session = await createBrowserSession({
        confirmation: 'create-code2create-local-browser-session',
        actor: 'supreme',
        surface: 'operations',
      })
      window.location.assign(session.url)
    } catch (caught) {
      setError(readableError(caught))
      setBusy(false)
    }
  }
  return (
    <main className="centered">
      <section className="sign-in">
        <p className="eyebrow">Code2Create</p>
        <h1>Operations</h1>
        <p className="muted">Sign in with the Google account assigned to your event permissions.</p>
        <button className="primary" type="button" disabled={!googleConfigured || busy} onClick={() => void signIn()}>
          {busy ? 'Opening Google…' : 'Continue with Google'}
        </button>
        {localDevelopmentFixturesEnabled ? (
          <button className="secondary" type="button" disabled={busy} onClick={() => void signInLocally()}>
            {busy ? 'Opening…' : 'Use local Supreme account'}
          </button>
        ) : null}
        {!googleConfigured && !localDevelopmentFixturesEnabled ? (
          <p className="notice">Google sign-in is not configured in this environment.</p>
        ) : null}
        {error ? <p className="notice error" role="alert">{error}</p> : null}
      </section>
    </main>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="centered"><p className="muted" role="status">{children}</p></main>
}
