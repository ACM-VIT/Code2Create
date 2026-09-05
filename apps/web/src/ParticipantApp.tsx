import { api } from "@code2create/backend/api";
import type { Code2CreateAuthClient } from "@code2create/web-auth";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { AccountBadge } from "./components/portal/AccountBadge";
import { TeamCluster } from "./components/portal/TeamCluster";
import { ClassCard } from "./components/portal/ClassCard";
import { DelayedBonsai } from "./components/portal/DelayedBonsai";
import { PetalCard } from "./components/portal/PetalCard";
import { PortalButton, PortalTextButton } from "./components/portal/PortalButton";
import { PortalError } from "./components/portal/PortalField";
import { PortalScene } from "./components/portal/PortalScene";
import { clientConfiguration, eventSlug } from "./lib/config";
import { readableError } from "./lib/errors";
import { useOperationRunner } from "./lib/operations";
import { canLeaveByTeamRule, canLeaveCurrentTeam } from "./lib/teamLeave";
import { useDeadlineReached } from "./lib/useDeadlineReached";
import { participantClassStorageKey } from "./screens/EntryScreen";
import { DetailsScreen } from "./screens/DetailsScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { ImportedTeamChoiceScreen } from "./screens/ImportedTeamChoiceScreen";
import { MoreScreen } from "./screens/MoreScreen";
import { SglangInterlude } from "./screens/SglangInterlude";
import { TeamLobbyScreen } from "./screens/TeamLobbyScreen";
import { TeamScreen } from "./screens/TeamScreen";
import type { CurrentTeam, ParticipantClass, PublicState } from "./types";

const loadFigmaCallbackScreen = () => import("./screens/FigmaCallbackScreen");
const loadGitHubCallbackScreen = () => import("./screens/GitHubCallbackScreen");
const loadIntegrationsScreen = () => import("./screens/IntegrationsScreen");
const loadIntakeScreen = () => import("./screens/IntakeScreen");
const loadSubmittedScreen = () => import("./screens/SubmittedScreen");
const loadSynesthesiaScreen = () => import("./screens/SynesthesiaScreen");
const loadSupportScreen = () => import("./screens/SupportScreen");
const loadUpdatesScreen = () => import("./screens/UpdatesScreen");

function prepareIntakeScreen() {
  // Let the lazy route report import failures when it is actually opened.
  void loadIntakeScreen().catch(() => {});
}

const FigmaCallbackScreen = lazy(() =>
  loadFigmaCallbackScreen().then((module) => ({ default: module.FigmaCallbackScreen })),
);
const GitHubCallbackScreen = lazy(() =>
  loadGitHubCallbackScreen().then((module) => ({ default: module.GitHubCallbackScreen })),
);
const IntegrationsScreen = lazy(() =>
  loadIntegrationsScreen().then((module) => ({ default: module.IntegrationsScreen })),
);
const IntakeScreen = lazy(() =>
  loadIntakeScreen().then((module) => ({ default: module.IntakeScreen })),
);
const SubmittedScreen = lazy(() =>
  loadSubmittedScreen().then((module) => ({ default: module.SubmittedScreen })),
);
const SynesthesiaScreen = lazy(() =>
  loadSynesthesiaScreen().then((module) => ({ default: module.SynesthesiaScreen })),
);
const SupportScreen = lazy(() =>
  loadSupportScreen().then((module) => ({ default: module.SupportScreen })),
)
const UpdatesScreen = lazy(() =>
  loadUpdatesScreen().then((module) => ({ default: module.UpdatesScreen })),
);

export function ParticipantApp({
  publicState,
  authClient,
}: {
  publicState: PublicState;
  authClient: Code2CreateAuthClient;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { code: joinCodeParam } = useParams<{ code?: string }>();
  const [pendingTeamSwitchCode, setPendingTeamSwitchCode] = useState<string | null>(null);
  const entryAllowed = useQuery(api.participants.entryAllowed, { eventSlug });
  const me = useQuery(api.participants.me, { eventSlug });
  const access = useQuery(api.access.participantCapabilities, { eventSlug });
  const hasTeamMembership = access?.hasTeamMembership ?? false;
  const shouldLoadGitHubStarGate =
    access !== undefined && Boolean(me?.membership && me.profile?.isComplete) && !hasTeamMembership;
  const githubStarGate = useQuery(
    api.githubStarGate.current,
    shouldLoadGitHubStarGate ? { eventSlug } : "skip",
  );
  const canReadProfile = access?.profileRead ?? false;
  const canWriteProfile = access?.profileWrite ?? false;
  const canJoinTeam = access?.teamJoin ?? false;
  const canReadTeam = access?.teamRead ?? false;
  const teamQuery = useQuery(api.teams.current, canReadTeam ? { eventSlug } : "skip");
  const teamDeadlineReached = useDeadlineReached(
    publicState.serverNow,
    teamQuery?.membershipEditableUntil,
  );
  const teamMembers = usePaginatedQuery(api.teams.members, canReadTeam ? { eventSlug } : "skip", {
    initialNumItems: 25,
  });
  const intakeStatusQuery = useQuery(api.intake.status, canReadTeam ? { eventSlug } : "skip");

  if (entryAllowed === undefined || me === undefined || access === undefined) {
    return <PortalLoading />;
  }
  const signOut = () => void authClient.signOut();
  const gateHeader = (
    <AccountBadge
      name={me?.person.displayName ?? me?.person.verifiedEmail ?? "you"}
      seed={me?.membership?.id ?? me?.person.verifiedEmail ?? "account"}
      {...(me?.person.verifiedEmail ? { email: me.person.verifiedEmail } : {})}
      onSignOut={signOut}
    />
  );
  if (!entryAllowed) {
    const staging = clientConfiguration.deploymentEnvironment === "staging";
    return (
      <PortalNotice
        header={gateHeader}
        title={staging ? "This account is not on the tester list." : "Registration not found."}
        body={
          staging
            ? "Use one of the email addresses invited to staging."
            : "Use the email address registered for Code2Create."
        }
      />
    );
  }
  if (canReadTeam && (teamQuery === undefined || intakeStatusQuery === undefined)) {
    return <PortalLoading />;
  }

  const team = canReadTeam ? (teamQuery ?? null) : null;
  const intakeStatus = canReadTeam ? (intakeStatusQuery ?? null) : null;
  const teamAccessUnavailable = hasTeamMembership && !canReadTeam;
  const canReadIntegrations = access?.integrations ?? false;
  const canReadSupport = access?.supportRead ?? false;
  const applicationState = intakeStatus?.applicationState ?? null;
  const acceptedPortal =
    applicationState !== null && ["accepted", "offer_sent", "confirmed"].includes(applicationState);

  if (!me?.membership) {
    return (
      <ProvisionScreen
        publicState={publicState}
        email={me?.person.verifiedEmail ?? null}
        onSignOut={signOut}
      />
    );
  }
  if (
    me.membership.participantClass === "vit_student" &&
    me.membership.vitStudentIdentity === null
  ) {
    return (
      <PortalNotice
        header={gateHeader}
        title="Verify your VIT account again."
        body="Sign out, then continue with Google. Your saved profile, team, and proposal stay unchanged."
      />
    );
  }

  const accountHeader = (
    <AccountBadge
      name={me.person.displayName}
      seed={me.membership.id}
      email={me.person.verifiedEmail}
      onSignOut={signOut}
    />
  );
  // ---- one participant conversation with the Guide and event team ---------
  if (location.pathname === "/support") {
    if (!canReadSupport) return <Navigate replace to="/" />;
    return (
      <Suspense fallback={<PortalLoading />}>
        <SupportScreen header={accountHeader} />
      </Suspense>
    );
  }

  const joinCode = joinCodeParam?.trim().toUpperCase() ?? "";
  const finishTeamSwitch = () => {
    setPendingTeamSwitchCode(null);
    void navigate("/", { replace: true, viewTransition: true });
  };
  const requestedTeamSwitchCode = pendingTeamSwitchCode ?? joinCode;
  const teamSwitch =
    team &&
    requestedTeamSwitchCode.length > 0 &&
    requestedTeamSwitchCode !== team.publicCode &&
    !teamDeadlineReached
      ? { code: requestedTeamSwitchCode, team }
      : null;

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
    );
  }

  if (team && joinCode.length > 0 && teamSwitch === null) return <Navigate replace to="/" />;

  if (hasTeamMembership && canReadTeam && !team) return <PortalLoading />;

  const hasSubmittedApplication = intakeStatus !== null && intakeStatus.applicationState !== null;
  const canContinueWithoutProfileProjection = !canReadProfile && hasSubmittedApplication;

  // ---- f0b · details, with policy consent inline ---------------------------
  if (!me.profile?.isComplete && !canContinueWithoutProfileProjection) {
    if (!canReadProfile) {
      return (
        <PortalNotice
          header={accountHeader}
          title="Profile access is unavailable."
          body="Your saved profile has not been removed. Ask an organizer to restore profile access before submitting."
        />
      );
    }
    const profileKey = `${me.participantPolicy.id}:${me.profile?.profileVersion ?? 0}`;
    return (
      <DetailsScreen
        key={profileKey}
        me={me}
        profileSeed={me.membership.id}
        canWriteProfile={canWriteProfile}
        onSignOut={signOut}
        verificationOnly={me.profile?.requiresPhoneVerification === true}
      />
    );
  }

  // ---- f12 · everything else, one quiet list -------------------------------
  const moreHeader = team ? (
    <TeamCluster
      team={team}
      members={teamMembers.results}
      editable={!teamDeadlineReached}
      canManage={team.currentRole === "lead" && !teamDeadlineReached}
    />
  ) : (
    accountHeader
  );
  if (location.pathname === "/more") {
    return (
      <MoreScreen
        me={me}
        capabilities={access}
        showIntegrations={acceptedPortal && canReadIntegrations}
        showMusic={acceptedPortal}
        header={moreHeader}
        onSignOut={signOut}
      />
    );
  }
  if (location.pathname === "/more/profile") {
    return (
      <DetailsScreen
        me={me}
        profileSeed={me.membership.id}
        canWriteProfile={canWriteProfile}
        onSignOut={signOut}
        variant="profile"
        header={moreHeader}
        onDone={() => navigate("/more", { replace: true, viewTransition: true })}
      />
    );
  }

  if (!hasTeamMembership) {
    if (githubStarGate === undefined || githubStarGate === null) return <PortalLoading />;
    if (!githubStarGate.completed) {
      return (
        <SglangInterlude
          state={githubStarGate}
          callback={location.pathname === "/onboarding/github/callback"}
          header={accountHeader}
        />
      );
    }
  }

  if (teamAccessUnavailable) {
    return (
      <PortalNotice
        header={accountHeader}
        title="Team access is unavailable."
        body="You are still on your team. You cannot create or join another team until an organizer restores access."
      />
    );
  }

  if (team && me.pendingTeam) {
    return (
      <ImportedTeamChoiceScreen
        header={accountHeader}
        currentTeam={team}
        importedTeam={me.pendingTeam}
      />
    );
  }

  // ---- f0c · team start ----------------------------------------------------
  if (!team) {
    if (!canJoinTeam) {
      return (
        <PortalNotice
          header={accountHeader}
          title="Team setup is unavailable."
          body="This account cannot create or join a team. Ask an organizer to restore team setup access."
        />
      );
    }
    if (me.pendingTeam) {
      return <ImportedTeamChoiceScreen header={accountHeader} importedTeam={me.pendingTeam} />;
    }
    return <TeamScreen header={accountHeader} />;
  }

  if (!intakeStatus) return <PortalLoading />;
  const teamEditable = !teamDeadlineReached;

  // ---- f10 · the squad lobby, any time a team exists -----------------------
  if (location.pathname === "/team") {
    return (
      <TeamLobbyScreen
        team={team}
        members={teamMembers.results}
        rosterStatus={teamMembers.status}
        loadMore={teamMembers.loadMore}
        editable={teamEditable}
        onSignOut={signOut}
      />
    );
  }

  // ---- f1-f6 · home, then the writing flow, full-bleed on the night scene --
  if (
    intakeStatus.revisionInProgress &&
    team.currentRole === "lead" &&
    (location.pathname === "/" || location.pathname === "/write")
  ) {
    return (
      <Suspense fallback={<PortalLoading />}>
        <IntakeScreen
          team={team}
          members={teamMembers.results}
          teamEditable={teamEditable}
          serverNow={publicState.serverNow}
          submissionInProgress={false}
          onSignOut={signOut}
        />
      </Suspense>
    );
  }
  if (intakeStatus.applicationState === null && location.pathname === "/") {
    return (
      <HomeScreen
        team={team}
        members={teamMembers.results}
        teamEditable={teamEditable}
        onSignOut={signOut}
        onPrepareIntake={prepareIntakeScreen}
      />
    );
  }
  if (intakeStatus.applicationState === null && location.pathname === "/write") {
    return (
      <Suspense fallback={<PortalLoading />}>
        <IntakeScreen
          team={team}
          members={teamMembers.results}
          teamEditable={teamEditable}
          serverNow={publicState.serverNow}
          submissionInProgress={intakeStatus.submissionState === "validating"}
          onSignOut={signOut}
          {...(intakeStatus.submissionFailureMessage === undefined
            ? {}
            : { submissionFailureMessage: intakeStatus.submissionFailureMessage })}
        />
      </Suspense>
    );
  }

  // The queue screen (mockup f7) is a full-bleed night scene, so it renders
  // outside the panelled shell the post-decision screens still use.
  const queued =
    intakeStatus.applicationState !== null &&
    ["submitted", "under_review"].includes(intakeStatus.applicationState);
  if (queued && location.pathname === "/") {
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
    );
  }

  const acceptedFeatures = acceptedPortal;
  const canOpenIntegrations = acceptedFeatures && canReadIntegrations;

  // ---- f11 · connected tools, full-bleed on the scene ----------------------
  if (location.pathname === "/integrations") {
    if (!canOpenIntegrations) return <Navigate replace to="/" />;
    return (
      <Suspense fallback={<PortalLoading />}>
        <IntegrationsScreen team={team} members={teamMembers.results} onSignOut={signOut} />
      </Suspense>
    );
  }

  // ---- team updates: the checkpoint forms, on the scene --------------------
  if (location.pathname === '/updates') {
    if (!acceptedFeatures || !(access?.projectCheckpoints ?? false) || !publicState.event) {
      return <Navigate replace to="/" />
    }
    return (
      <Suspense fallback={<PortalLoading />}>
        <UpdatesScreen
          team={team}
          members={teamMembers.results}
          teamEditable={teamEditable}
          timezone={publicState.event.timezone}
          onSignOut={signOut}
        />
      </Suspense>
    )
  }

  // ---- f8 / f9 / closed states, full-bleed ---------------------------------
  if (
    intakeStatus.applicationState !== null &&
    !["/integrations/github/callback", "/integrations/figma/callback", "/music"].includes(
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
    );
  }

  // ---- callbacks and music: on the scene, not a separate shell ----------
  const tenant =
    location.pathname === "/integrations/github/callback" ? (
      canOpenIntegrations ? (
        <GitHubCallbackScreen />
      ) : null
    ) : location.pathname === "/integrations/figma/callback" ? (
      canOpenIntegrations ? (
        <FigmaCallbackScreen />
      ) : null
    ) : location.pathname === "/music" ? (
      acceptedFeatures ? (
        <SynesthesiaScreen />
      ) : null
    ) : null;
  if (!tenant) return <Navigate replace to="/" />;
  return (
    <PortalScene
      tree="left"
      onSignOut={signOut}
      header={
        <TeamCluster
          team={team}
          members={teamMembers.results}
          editable={teamEditable}
          canManage={team.currentRole === "lead" && teamEditable}
        />
      }
    >
      <div className="w-full max-w-[720px] text-left">
        <Suspense fallback={null}>{tenant}</Suspense>
      </div>
    </PortalScene>
  );
}

/** A single-message stop on the night scene — access gates and waits. */
function PortalNotice({
  header,
  title,
  body,
}: {
  header?: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <PortalScene tree="right" {...(header ? { header } : {})}>
      <div className="w-full max-w-[560px]">
        <PetalCard className="px-8 py-7">
          <h1 className="mb-3 font-display font-light tracking-[-.01em] text-2xl lg:text-3xl">
            {title}
          </h1>
          <p className="text-[13px] leading-relaxed text-fg/60">{body}</p>
        </PetalCard>
      </div>
    </PortalScene>
  );
}

function PortalLoading() {
  return (
    <PortalScene tree="left">
      <DelayedBonsai />
    </PortalScene>
  );
}

function SwitchTeamScreen({
  header,
  team,
  code,
  onStarted,
  onFinished,
  onStay,
}: {
  header: ReactNode;
  team: CurrentTeam;
  code: string;
  onStarted: () => void;
  onFinished: () => void;
  onStay: () => void;
}) {
  const switchTeam = useMutation(api.teams.switchTeam);
  const [error, setError] = useState<string | null>(null);
  const operations = useOperationRunner();
  const switchPending = operations.hasPending("team-switch");
  const canLeave = canLeaveCurrentTeam(team);
  const needsTransfer = team.canLeave && !canLeaveByTeamRule(team);

  const confirmSwitch = async () => {
    if (!switchPending && !canLeave) return;
    setError(null);
    onStarted();
    try {
      await operations.run(
        "team-switch",
        (clientOperationId) => () =>
          switchTeam({
            eventSlug,
            fromTeamId: team.id,
            expectedFromTeamVersion: team.version,
            code,
            clientOperationId,
          }),
      );
      onFinished();
    } catch (caught) {
      setError(readableError(caught));
    }
  };

  const prompt =
    team.activeMemberCount === 1
      ? `Leave and close ${team.name}, then join the team ${code}?`
      : `Leave ${team.name} and join the team ${code}?`;

  return (
    <PortalScene tree="both" header={header}>
      <PetalCard className="w-full max-w-[600px] px-7 py-7 sm:px-9">
        <p className="mb-2 text-[11px] tracking-[.08em] text-rose-light">switch team</p>
        <h1 className="font-display font-light tracking-[-.01em] text-3xl">{team.name}</h1>
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
        <div className="mt-6">
          {!switchPending && (needsTransfer || !canLeave) ? null : (
            <PortalButton
              type="button"
              size="sm"
              className="w-full"
              onClick={() => void confirmSwitch()}
            >
              {switchPending ? "Confirm earlier switch" : "Leave and join"}
            </PortalButton>
          )}
          <PortalTextButton
            type="button"
            disabled={switchPending}
            onClick={onStay}
            className="mx-auto mt-2 block px-4 py-2"
          >
            stay on this team
          </PortalTextButton>
        </div>
        <PortalError message={error} />
      </PetalCard>
    </PortalScene>
  );
}

function ProvisionScreen({
  publicState,
  email,
  onSignOut,
}: {
  publicState: PublicState;
  email: string | null;
  onSignOut: () => void;
}) {
  const provision = useMutation(api.participants.provision);
  const recovery = useQuery(api.rosterRecovery.current, { eventSlug, now: publicState.serverNow });
  const provisioningRef = useRef(false);
  const attemptedClassRef = useRef<ParticipantClass | null>(null);
  const [participantClass, setParticipantClass] = useState<ParticipantClass | null>(() => {
    const stored = sessionStorage.getItem(participantClassStorageKey);
    return stored === "vit_student" || stored === "external_participant" ? stored : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const vitOpen = Boolean(
    recovery || (publicState.event?.registrationOpen &&
    publicState.serverNow < publicState.event.applicationsCloseAt),
  );
  const externalOpen = Boolean(
    publicState.event?.registrationOpen &&
    publicState.serverNow < publicState.event.externalApplicationsCloseAt,
  );
  const selectedClassOpen = participantClass === "vit_student" ? vitOpen : externalOpen;

  const choose = (value: ParticipantClass) => {
    sessionStorage.setItem(participantClassStorageKey, value);
    setParticipantClass(value);
    setError(null);
  };

  const provisionParticipant = useCallback(
    async (selectedClass: ParticipantClass) => {
      if (provisioningRef.current) return;
      provisioningRef.current = true;
      attemptedClassRef.current = selectedClass;
      setBusy(true);
      setError(null);
      try {
        await provision({ eventSlug, participantClass: selectedClass });
        sessionStorage.removeItem(participantClassStorageKey);
      } catch (caught) {
        setError(readableError(caught));
      } finally {
        provisioningRef.current = false;
        setBusy(false);
      }
    },
    [provision],
  );

  useEffect(() => {
    if (!participantClass || !selectedClassOpen || attemptedClassRef.current === participantClass)
      return;
    void provisionParticipant(participantClass);
  }, [participantClass, provisionParticipant, selectedClassOpen]);

  if (participantClass && selectedClassOpen && !error) {
    return (
      <PortalScene tree="both">
        <p role="status" className="font-ui font-normal text-xl text-rose-light">
          Finishing your participant setup…
        </p>
      </PortalScene>
    );
  }

  return (
    <PortalScene
      tree="both"
      header={
        <AccountBadge
          name={email ?? "you"}
          seed={email ?? "account"}
          {...(email ? { email } : {})}
          onSignOut={onSignOut}
        />
      }
    >
      <div className="flex w-full max-w-[640px] flex-col items-center text-center">
        <h1 className="mb-2 font-display font-light tracking-[-.01em] text-balance text-3xl lg:text-[40px]">
          Choose your participant type.
        </h1>
        {recovery ? (
          <p className="mb-4 text-sm text-fg/75">
            The event team approved recovery of your existing {recovery.teamName} roster entry.
            Complete your profile, accept the participant policy, and confirm your team to continue.
            Registration remains closed for new applications.
          </p>
        ) : null}
        {/* The class is settled from the verified identity, so the account is
            the one fact worth showing: whoever signed in with the wrong one
            can see it here and use the door in the corner. */}
        <p className="mb-7 text-[12.5px] text-fg/50">
          {email ? (
            <>
              signed in as <span className="text-fg/75">{email}</span>
            </>
          ) : (
            "VIT students must use their @vitstudent.ac.in Google account."
          )}
        </p>
        <div className="mb-6 flex w-full flex-col gap-3 sm:flex-row sm:justify-center sm:gap-4">
          <ClassCard
            title="VIT student"
            detail="only @vitstudent.ac.in Google accounts are accepted"
            disabled={!vitOpen}
            selected={participantClass === "vit_student"}
            onSelect={() => choose("vit_student")}
          />
          <ClassCard
            title="external participant"
            detail={
              externalOpen
                ? "college students and other eligible applicants"
                : "applications have closed"
            }
            disabled={!externalOpen}
            selected={participantClass === "external_participant"}
            onSelect={() => choose("external_participant")}
          />
        </div>
        <PortalError message={error} reserve />
        {participantClass && error ? (
          <PortalButton
            type="button"
            className="mt-4"
            disabled={busy || !selectedClassOpen}
            onClick={() => void provisionParticipant(participantClass)}
          >
            {busy ? "Checking…" : "Try again"}
          </PortalButton>
        ) : null}
      </div>
    </PortalScene>
  );
}
