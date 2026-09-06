import { api } from "@code2create/backend/api";
import { ClientObservabilityIdentity } from "@code2create/client-observability";
import { type EventStage, eventRoleLabels, eventStageGuidance } from "@code2create/domain";
import {
  GoogleFedCmButton,
  signInWithGooglePopup,
  type Code2CreateAuthClient,
} from "@code2create/web-auth";
import type { FunctionReturnType } from "convex/server";
import { AuthLoading, Authenticated, Unauthenticated, useMutation, useQuery } from "convex/react";
import { Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import {
  OperationsLayout,
  type OperationsNavigationGroup,
  type OperationsNavigationItem,
} from "./components/OperationsLayout";
import type { ConfigurationTabsVisibility } from "./components/ConfigurationTabs";
import { Gate, GateAction, GateBoot } from "./components/AuthGate";
import { eventSlug } from "./lib/config";
import { formatMediumDateTime as formatDateTime } from "./lib/dateTime";
import { readableError } from "./lib/errors";
import { useOperationRunner } from "./lib/operations";
import { useEstimatedServerNow } from "./lib/useEstimatedServerNow";
import { InitialEventSetup } from "./screens/InitialEventSetup";

const AdmissionDetail = lazy(() =>
  import("./screens/AdmissionDetail").then((module) => ({ default: module.AdmissionDetail })),
);
const AdmissionsQueue = lazy(() =>
  import("./screens/AdmissionsQueue").then((module) => ({ default: module.AdmissionsQueue })),
);
const AttendanceOverview = lazy(() =>
  import("./screens/AttendanceOverview").then((module) => ({ default: module.AttendanceOverview })),
);
const AttendanceSession = lazy(() =>
  import("./screens/AttendanceSession").then((module) => ({ default: module.AttendanceSession })),
);
const AttendanceSetup = lazy(() =>
  import("./screens/AttendanceSetup").then((module) => ({ default: module.AttendanceSetup })),
);
const AccessDirectory = lazy(() =>
  import("./screens/AccessDirectory").then((module) => ({ default: module.AccessDirectory })),
);
const AccessPerson = lazy(() =>
  import("./screens/AccessPerson").then((module) => ({ default: module.AccessPerson })),
);
const IntegrationOverview = lazy(() =>
  import("./screens/IntegrationOverview").then((module) => ({
    default: module.IntegrationOverview,
  })),
);
const HealthOverview = lazy(() =>
  import("./screens/HealthOverview").then((module) => ({ default: module.HealthOverview })),
);
const EventMonitor = lazy(() =>
  import("./screens/EventMonitor").then((module) => ({ default: module.EventMonitor })),
);
const IntelligenceWorkspace = lazy(() =>
  import("./screens/IntelligenceWorkspace").then((module) => ({
    default: module.IntelligenceWorkspace,
  })),
);
const EventSetupOverview = lazy(() =>
  import("./screens/EventSetupOverview").then((module) => ({ default: module.EventSetupOverview })),
);
const Rehearsal = lazy(() =>
  import("./screens/Rehearsal").then((module) => ({ default: module.Rehearsal })),
);
const SupportDesk = lazy(() =>
  import("./screens/SupportDesk").then((module) => ({ default: module.SupportDesk })),
);
const ReviewOverview = lazy(() =>
  import("./screens/ReviewOverview").then((module) => ({ default: module.ReviewOverview })),
);
const ReviewRoundBoard = lazy(() =>
  import("./screens/ReviewRoundBoard").then((module) => ({ default: module.ReviewRoundBoard })),
);
const ReviewSetup = lazy(() =>
  import("./screens/ReviewSetup").then((module) => ({ default: module.ReviewSetup })),
);
const ScoreOverview = lazy(() =>
  import("./screens/ScoreOverview").then((module) => ({ default: module.ScoreOverview })),
);
const ScoreRound = lazy(() =>
  import("./screens/ScoreRound").then((module) => ({ default: module.ScoreRound })),
);
const Synesthesia = lazy(() =>
  import("./screens/Synesthesia").then((module) => ({ default: module.Synesthesia })),
);
const Benefits = lazy(() =>
  import("./screens/Benefits").then((module) => ({ default: module.Benefits })),
);
const Ambience = lazy(() =>
  import("./screens/Ambience").then((module) => ({ default: module.Ambience })),
);
const ProjectCheckpointOverview = lazy(() =>
  import("./screens/ProjectCheckpointOverview").then((module) => ({
    default: module.ProjectCheckpointOverview,
  })),
);

const Roster = lazy(() =>
  import("./screens/Roster").then((module) => ({ default: module.Roster })),
);
const TeamRoster = lazy(() =>
  import("./screens/TeamRoster").then((module) => ({ default: module.TeamRoster })),
);
const PermissionBundles = lazy(() =>
  import("./screens/PermissionBundles").then((module) => ({ default: module.PermissionBundles })),
);
const EmergencyPack = lazy(() =>
  import("./screens/EmergencyPack").then((module) => ({ default: module.EmergencyPack })),
);
const IntakePolicyConfiguration = lazy(() =>
  import("./screens/IntakePolicyConfiguration").then((module) => ({
    default: module.IntakePolicyConfiguration,
  })),
);
const NoveltyConfiguration = lazy(() =>
  import("./screens/NoveltyConfiguration").then((module) => ({
    default: module.NoveltyConfiguration,
  })),
);
const ParticipantPolicyConfiguration = lazy(() =>
  import("./screens/ParticipantPolicyConfiguration").then((module) => ({
    default: module.ParticipantPolicyConfiguration,
  })),
);
const AdmissionPolicyConfiguration = lazy(() =>
  import("./screens/AdmissionPolicyConfiguration").then((module) => ({
    default: module.AdmissionPolicyConfiguration,
  })),
);
const CommunicationsPolicyConfiguration = lazy(() =>
  import("./screens/CommunicationsPolicyConfiguration").then((module) => ({
    default: module.CommunicationsPolicyConfiguration,
  })),
);
const IntegrationPolicyConfiguration = lazy(() =>
  import("./screens/IntegrationPolicyConfiguration").then((module) => ({
    default: module.IntegrationPolicyConfiguration,
  })),
);
const IntelligencePolicyConfiguration = lazy(() =>
  import("./screens/IntelligencePolicyConfiguration").then((module) => ({
    default: module.IntelligencePolicyConfiguration,
  })),
);
const PhaseConfiguration = lazy(() =>
  import("./screens/PhaseConfiguration").then((module) => ({ default: module.PhaseConfiguration })),
);
const CheckpointConfiguration = lazy(() =>
  import("./screens/CheckpointConfiguration").then((module) => ({
    default: module.CheckpointConfiguration,
  })),
);

export default function App({ authClient }: { authClient: Code2CreateAuthClient }) {
  const { data: session } = authClient.useSession();
  const publicState = useQuery(api.system.getPublicShellState, { eventSlug });
  const serverNow = useEstimatedServerNow(publicState?.serverNow, 60_000);
  if (publicState === undefined) return <GateBoot status="Loading…" />;

  return (
    <>
      <ClientObservabilityIdentity distinctId={session?.user.id ?? null} />
      <AuthLoading>
        <GateBoot status="Checking access…" />
      </AuthLoading>
      <Unauthenticated>
        <SignIn
          authClient={authClient}
          googleConfigured={publicState.auth.googleConfigured}
          googleClientId={publicState.auth.googleClientId}
        />
      </Unauthenticated>
      <Authenticated>
        {publicState.event ? (
          <Operations
            authClient={authClient}
            eventStatus={publicState.event.status}
            serverNow={serverNow}
          />
        ) : (
          <InitialEventSetup authClient={authClient} />
        )}
      </Authenticated>
    </>
  );
}

function Operations({
  authClient,
  eventStatus,
  serverNow,
}: {
  authClient: Code2CreateAuthClient;
  eventStatus: EventStage;
  serverNow: number;
}) {
  const access = useQuery(api.access.operationsCapabilities, { eventSlug });
  const invitation = useQuery(api.accessInvitations.mine, { eventSlug });
  const roster = useQuery(api.rosters.mine, { eventSlug });
  const synchronizeSupremePermissions = useMutation(api.access.synchronizeSupremePermissions);
  const supremeSync = useOperationRunner();
  const supremeSyncStarted = useRef(false);
  const { data: session } = authClient.useSession();
  useEffect(() => {
    if (!access?.isSupreme || supremeSyncStarted.current) return;
    supremeSyncStarted.current = true;
    void supremeSync
      .run("supreme-permissions-sync", () => () => synchronizeSupremePermissions({ eventSlug }))
      .catch(() => undefined);
  }, [access, supremeSync, synchronizeSupremePermissions]);
  if (access === undefined || invitation === undefined || roster === undefined) {
    return <GateBoot status="Loading your event access…" />;
  }
  if (roster) {
    return <RosterClaim authClient={authClient} roster={roster} />;
  }
  if (!access && invitation) {
    return <InvitationClaim authClient={authClient} invitation={invitation} />;
  }
  if (!access) {
    return <NoOperationsAccess authClient={authClient} />;
  }
  const capabilities = access;
  const canViewAdmissions = capabilities.admissions;
  const canViewEventLifecycle = capabilities.eventLifecycle;
  const canViewPhaseConfiguration = capabilities.phaseConfiguration;
  const canViewIntakeConfiguration = capabilities.intakeConfiguration;
  const canViewNoveltyConfiguration = capabilities.noveltyConfiguration;
  const canViewParticipantConfiguration = capabilities.participantConfiguration;
  const canViewAdmissionConfiguration = capabilities.admissionConfiguration;
  const canViewCommunicationsConfiguration = capabilities.communicationsConfiguration;
  const canViewIntegrationConfiguration = capabilities.integrationConfiguration;
  const canViewIntelligenceConfiguration = capabilities.intelligenceConfiguration;
  const canViewCheckpointConfiguration = capabilities.checkpointConfiguration;
  const canViewAttendance = capabilities.attendance;
  const canSetupAttendance = capabilities.attendanceSetup;
  const canReadPeople = capabilities.accessPeople;
  const canBrowsePeople = capabilities.accessDirectory;
  const canInvite = capabilities.invitations;
  const canReadBundles = capabilities.bundles;
  const canReadRoster = capabilities.roster;
  const canReadTeamRoster = capabilities.teamRoster;
  const canViewAccess =
    canReadPeople || canInvite || canReadBundles || canReadRoster || canReadTeamRoster;
  const canViewIntegrations = capabilities.integrations;
  const canViewProjectCheckpoints = capabilities.projectCheckpoints;
  const canViewReviews = capabilities.reviews;
  const canViewScores = capabilities.scores;
  const canViewSynesthesia = capabilities.synesthesia;
  const canViewBenefits = capabilities.benefits;
  const canViewHealth = capabilities.health;
  const canReadIntelligence = capabilities.intelligenceRead;
  const canGenerateIntelligence = capabilities.intelligenceGenerate;
  const canViewIntelligence = capabilities.intelligence;
  const canManageAttention = capabilities.attentionManage;
  const canViewIncidents = capabilities.incidents;
  const canViewSupport = capabilities.support;
  const canViewRehearsal = capabilities.rehearsal;
  const canReadEmergencyPack = capabilities.emergencyPackRead;
  const canPrepareEmergencyPack = capabilities.emergencyPackPrepare;
  const canPrintEmergencyPack = capabilities.emergencyPackPrint;
  const canViewEmergencyPack = capabilities.emergencyRecovery;
  const configurationPath =
    canViewEventLifecycle ||
    canViewParticipantConfiguration ||
    canViewAdmissionConfiguration ||
    canViewIntakeConfiguration ||
    canViewNoveltyConfiguration ||
    canViewCommunicationsConfiguration ||
    canViewIntegrationConfiguration ||
    canViewIntelligenceConfiguration ||
    canViewPhaseConfiguration ||
    canViewCheckpointConfiguration ||
    canSetupAttendance
      ? "/configuration"
      : null;
  const configurationTabs: ConfigurationTabsVisibility = {
    showLifecycle: canViewEventLifecycle,
    showAttendance: canSetupAttendance,
    showIntake: canViewIntakeConfiguration,
    showNovelty: canViewNoveltyConfiguration,
    showParticipants: canViewParticipantConfiguration,
    showAdmissions: canViewAdmissionConfiguration,
    showCommunications: canViewCommunicationsConfiguration,
    showIntegrations: canViewIntegrationConfiguration,
    showIntelligence: canViewIntelligenceConfiguration,
    showPhases: canViewPhaseConfiguration,
    showCheckpoints: canViewCheckpointConfiguration,
  };
  const canReadReviewConfiguration = capabilities.reviewConfigurationRead;
  const canPublishReviewConfiguration = capabilities.reviewConfigurationPublish;
  const canReadReviewerProfiles = capabilities.reviewerProfilesRead;
  const canOpenReviewSetup = canReadReviewConfiguration || canReadReviewerProfiles;
  const availableBlockerPaths = [
    ...(configurationPath ? ["/configuration"] : []),
    ...(canViewParticipantConfiguration ? ["/configuration/participants"] : []),
    ...(canViewIntakeConfiguration ? ["/configuration/intake"] : []),
    ...(canViewAdmissionConfiguration ? ["/configuration/admissions"] : []),
    ...(canViewCommunicationsConfiguration ? ["/configuration/communications"] : []),
    ...(canViewIntegrationConfiguration ? ["/configuration/integrations"] : []),
    ...(canViewPhaseConfiguration ? ["/configuration/phases"] : []),
    ...(canViewCheckpointConfiguration ? ["/configuration/checkpoints"] : []),
    ...(canSetupAttendance ? ["/attendance-setup"] : []),
    ...(canViewAttendance ? ["/attendance"] : []),
    ...(canOpenReviewSetup ? ["/review-setup"] : []),
    ...(canViewReviews ? ["/reviews"] : []),
  ];
  const navigation: OperationsNavigationGroup[] = [
    {
      label: "Now",
      items: [
        ...(canViewHealth ? [{ label: "Overview", to: "/", icon: "home" as const }] : []),
        ...(canViewHealth
          ? [{ label: "Event monitor", to: "/event-monitor", icon: "alert" as const }]
          : []),
        ...(canViewIntelligence
          ? [{ label: "Operations agent", to: "/intelligence", icon: "pulse" as const }]
          : []),
        ...(canViewSupport
          ? [{ label: "Help desk", to: "/support", icon: "lifebuoy" as const }]
          : []),
      ],
    },
    {
      label: "Applications",
      items: canViewAdmissions
        ? [{
            label: capabilities.applicationRead || capabilities.applicationReviewRead ? "Review applications" : "Review deck",
            to: "/admissions", icon: "inbox" as const,
          }]
        : [],
    },
    {
      label: "Event day",
      items: [
        ...(canViewAttendance
          ? [{ label: "Check-in", to: "/attendance", icon: "scan" as const }]
          : []),
        ...(canViewSynesthesia
          ? [{ label: "Music desk", to: "/synesthesia", icon: "music" as const }]
          : []),
        ...(canViewBenefits ? [{ label: "Benefits", to: "/benefits", icon: "inbox" as const }] : []),
        ...(canViewEventLifecycle
          ? [{ label: "Chill mode", to: "/ambience", icon: "pulse" as const }]
          : []),
      ],
    },
    {
      label: "Judging",
      items: [
        ...(canViewReviews
          ? [{ label: "Review rounds", to: "/reviews", icon: "gavel" as const }]
          : []),
        ...(canViewScores ? [{ label: "Results", to: "/scores", icon: "chart" as const }] : []),
        ...(canViewProjectCheckpoints
          ? [{ label: "Team updates", to: "/checkpoints", icon: "notes" as const }]
          : []),
        ...(canViewIntegrations
          ? [{ label: "Code and design", to: "/integrations", icon: "code" as const }]
          : []),
      ],
    },
    {
      label: "Manage",
      items: [
        ...(configurationPath
          ? [{ label: "Event setup", to: configurationPath, icon: "sliders" as const }]
          : []),
        ...(canOpenReviewSetup && !canViewReviews
          ? [{ label: "Review setup", to: "/review-setup", icon: "gavel" as const }]
          : []),
        ...(canViewAccess
          ? [{ label: "People and permissions", to: "/access", icon: "users" as const }]
          : []),
        ...(canViewRehearsal
          ? [{ label: "Test run", to: "/rehearsal", icon: "flask" as const }]
          : []),
        ...(canViewEmergencyPack
          ? [{ label: "Recovery", to: "/emergency-pack", icon: "shield" as const }]
          : []),
      ],
    },
  ].filter((group) => group.items.length > 0);
  const stage = eventStageGuidance[eventStatus];
  const allItems = navigation.flatMap((group) => group.items);
  const nowItems = stage.primaryPaths
    .map((path) => allItems.find((item) => item.to === path || item.to.startsWith(`${path}/`)))
    .filter((item): item is OperationsNavigationItem => item !== undefined);
  const restGroups = navigation
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !nowItems.includes(item)),
    }))
    .filter((group) => group.items.length > 0);
  const defaultPath = firstAvailablePath(
    [canViewHealth, "/"],
    [canViewIntelligence, "/intelligence"],
    [canViewAdmissions, "/admissions"],
    [canViewAttendance, "/attendance"],
    [canViewReviews, "/reviews"],
    [canOpenReviewSetup, "/review-setup"],
    [canViewSupport, "/support"],
    [canViewScores, "/scores"],
    [canViewProjectCheckpoints, "/checkpoints"],
    [canViewIntegrations, "/integrations"],
    [configurationPath !== null, configurationPath ?? "/configuration"],
    [canViewAccess, "/access"],
    [canViewRehearsal, "/rehearsal"],
    [canViewEmergencyPack, "/emergency-pack"],
    [canViewSynesthesia, "/synesthesia"],
  );
  if (!defaultPath) {
    return <Centered>This account hasn’t been given any operations tools yet.</Centered>;
  }
  return (
    <OperationsLayout
      accountEmail={session?.user.email ?? ""}
      authClient={authClient}
      homePath={defaultPath}
      identity={session?.user.name || session?.user.email || "Signed in"}
      navigation={restGroups}
      nowItems={nowItems}
      showIncidents={canViewIncidents}
      stageLabel={stage.label}
    >
      <Suspense
        fallback={
          <p className="muted" role="status">
            Loading workspace…
          </p>
        }
      >
        <Routes>
          {canViewHealth ? (
            <Route
              path="/"
              element={
                <HealthOverview
                  availableBlockerPaths={availableBlockerPaths}
                  canManageAttention={canManageAttention}
                  canReadLifecycle={canViewEventLifecycle}
                />
              }
            />
          ) : null}
          {canViewHealth ? (
            <Route
              path="/event-monitor"
              element={<EventMonitor canManageAttention={canManageAttention} />}
            />
          ) : null}
          {canViewIntelligence ? (
            <Route
              path="/intelligence/*"
              element={
                <IntelligenceWorkspace
                  canConfigure={canViewIntelligenceConfiguration}
                  canGenerate={canGenerateIntelligence}
                  canRead={canReadIntelligence}
                />
              }
            />
          ) : null}
          {canViewRehearsal ? <Route path="/rehearsal" element={<Rehearsal />} /> : null}
          {canViewSupport ? <Route path="/support" element={<SupportDesk />} /> : null}
          {canViewSupport ? (
            <Route path="/support/new" element={<SupportDesk composing />} />
          ) : null}
          {canViewSupport ? (
            <Route path="/support/:supportCaseId" element={<SupportDesk />} />
          ) : null}
          {canViewAdmissions ? (
            <Route
              path="/admissions"
              element={
                <AdmissionsQueue
                  canAssign={capabilities.applicationAssign}
                  canReadApplications={capabilities.applicationRead}
                  canReadAssignments={capabilities.applicationReviewRead}
                />
              }
            />
          ) : null}
          {canViewAdmissions ? (
            <Route
              path="/admissions/:applicationId"
              element={<AdmissionDetail accountEmail={session?.user.email ?? ""} />}
            />
          ) : null}
          {configurationPath ? (
            <Route
              path="/configuration"
              element={
                <Suspense fallback={<p className="muted">Loading event setup…</p>}>
                  <EventSetupOverview tabs={configurationTabs} />
                </Suspense>
              }
            />
          ) : null}
          {canViewIntakeConfiguration ? (
            <Route
              path="/configuration/intake"
              element={
                <Suspense fallback={<p className="muted">Loading idea questions…</p>}>
                  <IntakePolicyConfiguration tabs={configurationTabs} />
                </Suspense>
              }
            />
          ) : null}
          {canViewNoveltyConfiguration ? (
            <Route
              path="/configuration/novelty"
              element={
                <Suspense fallback={<p className="muted">Loading idea comparison…</p>}>
                  <NoveltyConfiguration tabs={configurationTabs} />
                </Suspense>
              }
            />
          ) : null}
          {canViewParticipantConfiguration ? (
            <Route
              path="/configuration/participants"
              element={
                <Suspense fallback={<p className="muted">Loading participant form…</p>}>
                  <ParticipantPolicyConfiguration tabs={configurationTabs} />
                </Suspense>
              }
            />
          ) : null}
          {canViewAdmissionConfiguration ? (
            <Route
              path="/configuration/admissions"
              element={
                <Suspense fallback={<p className="muted">Loading admission rules…</p>}>
                  <AdmissionPolicyConfiguration tabs={configurationTabs} />
                </Suspense>
              }
            />
          ) : null}
          {canViewCommunicationsConfiguration ? (
            <Route
              path="/configuration/communications"
              element={
                <Suspense fallback={<p className="muted">Loading participant communications…</p>}>
                  <CommunicationsPolicyConfiguration
                    authClient={authClient}
                    tabs={configurationTabs}
                  />
                </Suspense>
              }
            />
          ) : null}
          {canViewIntegrationConfiguration ? (
            <Route
              path="/configuration/integrations"
              element={
                <Suspense fallback={<p className="muted">Loading code and design rules…</p>}>
                  <IntegrationPolicyConfiguration tabs={configurationTabs} />
                </Suspense>
              }
            />
          ) : null}
          {canViewIntelligenceConfiguration ? (
            <Route
              path="/configuration/intelligence"
              element={
                <Suspense fallback={<p className="muted">Loading operations agent setup…</p>}>
                  <IntelligencePolicyConfiguration tabs={configurationTabs} />
                </Suspense>
              }
            />
          ) : null}
          {canViewPhaseConfiguration ? (
            <Route
              path="/configuration/phases"
              element={
                <Suspense fallback={<p className="muted">Loading event schedule…</p>}>
                  <PhaseConfiguration tabs={configurationTabs} />
                </Suspense>
              }
            />
          ) : null}
          {canViewCheckpointConfiguration ? (
            <Route
              path="/configuration/checkpoints"
              element={
                <Suspense fallback={<p className="muted">Loading team update prompts…</p>}>
                  <CheckpointConfiguration tabs={configurationTabs} />
                </Suspense>
              }
            />
          ) : null}
          {canViewAttendance ? <Route path="/attendance" element={<AttendanceOverview />} /> : null}
          {canViewAttendance ? (
            <Route path="/attendance/:sessionId" element={<AttendanceSession />} />
          ) : null}
          {canViewEmergencyPack ? (
            <Route
              path="/emergency-pack"
              element={
                <Suspense fallback={<p className="muted">Loading recovery…</p>}>
                  <EmergencyPack
                    canPrepare={canPrepareEmergencyPack}
                    canPrint={canReadEmergencyPack && canPrintEmergencyPack}
                    canRead={canReadEmergencyPack}
                  />
                </Suspense>
              }
            />
          ) : null}
          {canViewSynesthesia ? <Route path="/synesthesia" element={<Synesthesia />} /> : null}
          {canViewBenefits ? <Route path="/benefits" element={<Benefits />} /> : null}
          {canViewEventLifecycle ? <Route path="/ambience" element={<Ambience />} /> : null}
          {canSetupAttendance ? (
            <Route
              path="/attendance-setup"
              element={<AttendanceSetup tabs={configurationTabs} />}
            />
          ) : null}
          {canViewReviews ? (
            <Route path="/reviews" element={<ReviewOverview showSetup={canOpenReviewSetup} canReadConfiguration={canReadReviewConfiguration} />} />
          ) : null}
          {canViewReviews ? (
            <Route path="/reviews/:roundId" element={<ReviewRoundBoard />} />
          ) : null}
          {canViewScores ? <Route path="/scores" element={<ScoreOverview />} /> : null}
          {canViewScores ? <Route path="/scores/:roundId" element={<ScoreRound />} /> : null}
          {canViewProjectCheckpoints ? (
            <Route path="/checkpoints" element={<ProjectCheckpointOverview />} />
          ) : null}
          {canOpenReviewSetup ? (
            <Route
              path="/review-setup"
              element={
                <ReviewSetup
                  canPublish={canPublishReviewConfiguration}
                  canReadConfiguration={canReadReviewConfiguration}
                  canReadProfiles={canReadReviewerProfiles}
                  canReadRounds={canViewReviews}
                />
              }
            />
          ) : null}
          {canViewIntegrations ? (
            <Route path="/integrations" element={<IntegrationOverview />} />
          ) : null}
          {canViewAccess ? (
            <Route
              path="/access"
              element={
                <AccessDirectory
                  canInvite={canInvite}
                  canReadBundles={canReadBundles}
                  canBrowsePeople={canBrowsePeople}
                  canReadPeople={canReadPeople}
                  canReadRoster={canReadRoster}
                  canReadTeamRoster={canReadTeamRoster}
                  serverNow={serverNow}
                />
              }
            />
          ) : null}
          {canReadBundles ? (
            <Route
              path="/access/bundles"
              element={
                <Suspense fallback={<p className="muted">Loading reusable access…</p>}>
                  <PermissionBundles />
                </Suspense>
              }
            />
          ) : null}
          {canReadRoster ? (
            <Route
              path="/access/roster"
              element={
                <Suspense fallback={<p className="muted">Loading roster…</p>}>
                  <Roster canReadBundles={canReadBundles} />
                </Suspense>
              }
            />
          ) : null}
          {canReadTeamRoster ? (
            <Route
              path="/access/team-roster"
              element={
                <Suspense fallback={<p className="muted">Loading participant teams…</p>}>
                  <TeamRoster />
                </Suspense>
              }
            />
          ) : null}
          {canReadPeople ? <Route path="/access/:personId" element={<AccessPerson />} /> : null}
          <Route path="*" element={<Navigate replace to={defaultPath} />} />
        </Routes>
      </Suspense>
    </OperationsLayout>
  );
}

type Invitation = NonNullable<FunctionReturnType<typeof api.accessInvitations.mine>>;
type RosterEntry = NonNullable<FunctionReturnType<typeof api.rosters.mine>>;

function RosterClaim({
  authClient,
  roster,
}: {
  authClient: Code2CreateAuthClient;
  roster: RosterEntry;
}) {
  const claim = useMutation(api.rosters.claim);
  const operations = useOperationRunner();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await operations.run(
        "roster-claim",
        (clientOperationId) => () =>
          claim({
            eventSlug,
            rosterEntryId: roster.id,
            expectedVersion: roster.version,
            clientOperationId,
          }),
      );
    } catch (caught) {
      setError(readableError(caught));
      setBusy(false);
    }
  };

  return (
    <main className="centered">
      <section className="sign-in roster-claim">
        <p className="eyebrow">{roster.eventName}</p>
        <h1>Join the event team</h1>
        <p className="muted">
          You are listed as {roster.displayName} · {eventRoleLabels[roster.role]} under{" "}
          {roster.email}.
        </p>
        {roster.role === "supreme" ? (
          <p className="notice">Supreme access includes every event permission.</p>
        ) : roster.bundles.length > 0 ? (
          <ul className="claim-bundle-list">
            {roster.bundles.map((bundle) => (
              <li key={`${bundle.label}:${bundle.version}`}>{bundle.label}</li>
            ))}
          </ul>
        ) : (
          <p className="notice">
            You’ll start with just a role label. An organiser can add permissions after you join.
          </p>
        )}
        <button className="primary" type="button" disabled={busy} onClick={() => void accept()}>
          {busy ? "Joining…" : "Join operations"}
        </button>
        <p className="claim-expiry">This invitation expires {formatDateTime(roster.validUntil)}</p>
        <button
          className="text-button"
          type="button"
          disabled={busy}
          onClick={() => void authClient.signOut()}
        >
          Use another Google account
        </button>
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}

function InvitationClaim({
  authClient,
  invitation,
}: {
  authClient: Code2CreateAuthClient;
  invitation: Invitation;
}) {
  const claim = useMutation(api.accessInvitations.claim);
  const operations = useOperationRunner();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await operations.run(
        "invitation-claim",
        (clientOperationId) => () =>
          claim({
            eventSlug,
            invitationId: invitation.id,
            expectedVersion: invitation.version,
            clientOperationId,
          }),
      );
    } catch (caught) {
      setError(readableError(caught));
      setBusy(false);
    }
  };

  return (
    <main className="centered">
      <section className="sign-in invitation-claim">
        <p className="eyebrow">{invitation.eventName}</p>
        <h1>Join the event</h1>
        <p className="muted">
          This invitation is for {invitation.email}. Claiming it links this Google account to the
          event; it does not assign a role or permission.
        </p>
        <button className="primary" type="button" disabled={busy} onClick={() => void accept()}>
          {busy ? "Joining…" : "Claim invitation"}
        </button>
        <p className="claim-expiry">Expires {formatDateTime(invitation.validUntil)}</p>
        <button
          className="text-button"
          type="button"
          disabled={busy}
          onClick={() => void authClient.signOut()}
        >
          Use another Google account
        </button>
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}

function NoOperationsAccess({ authClient }: { authClient: Code2CreateAuthClient }) {
  return (
    <Gate
      subtitle="This Google account hasn’t been invited and has no event account."
      title="No event access"
    >
      <GateAction
        label="Use another Google account"
        onClick={() => void authClient.signOut()}
        secondary
      />
    </Gate>
  );
}

function SignIn({
  authClient,
  googleConfigured,
  googleClientId,
}: {
  authClient: Code2CreateAuthClient;
  googleConfigured: boolean;
  googleClientId: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fallbackSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await signInWithGooglePopup(authClient, window.location.href);
      if (result.error) setError(popupErrorMessage(result.error.code));
    } catch {
      setError(popupErrorMessage(undefined));
    } finally {
      setBusy(false);
    }
  };

  function popupErrorMessage(code: string | undefined) {
    if (code === "POPUP_BLOCKED") return "Allow pop-ups for this site, then try again.";
    if (code === "POPUP_CLOSED") return "Google sign-in was closed before it finished.";
    if (code === "POPUP_TIMEOUT") return "Google sign-in took too long. Try again.";
    return "Google sign-in could not be completed. Try again.";
  }
  return (
    <Gate error={error} title="Operations">
      {googleClientId ? (
        <GoogleFedCmButton
          authClient={authClient}
          clientId={googleClientId}
          loading={<GateAction disabled label="Loading Google…" />}
          pending={<GateAction disabled label="Signing in…" />}
          fallback={
            <GateAction
              disabled={busy}
              label={busy ? "Opening Google…" : "Continue with Google"}
              onClick={() => void fallbackSignIn()}
            />
          }
          onError={(message) => setError(message)}
        />
      ) : (
        <GateAction
          disabled={!googleConfigured || busy}
          label={busy ? "Opening Google…" : "Continue with Google"}
          onClick={() => void fallbackSignIn()}
        />
      )}
      {!googleConfigured ? (
        <p className="gate-error">
          Google sign-in is unavailable. Check the event’s authentication setup.
        </p>
      ) : null}
    </Gate>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="centered">
      <p className="muted" role="status">
        {children}
      </p>
    </main>
  );
}

function firstAvailablePath(...options: readonly (readonly [enabled: boolean, path: string])[]) {
  return options.find(([enabled]) => enabled)?.[1] ?? null;
}
