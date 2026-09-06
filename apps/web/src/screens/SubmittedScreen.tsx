import { LiveNumber } from "../components/LiveNumber";
import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import type { CurrentTeam, CurrentTeamMember, PublicState, SubmittedIntake } from "../types";
import { DelayedBonsai } from "../components/portal/DelayedBonsai";
import { EditingPresence } from "../components/EditingPresence";
import { useEditingPresence } from "../hooks/useEditingPresence";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { initialIdeaMaximumLength } from "../lib/ideaSubmission";
import { useMutationAttempt } from "../lib/operations";
import { PortalScene } from "../components/portal/PortalScene";
import { PetalCard } from "../components/portal/PetalCard";
import { TeamCluster } from "../components/portal/TeamCluster";
import { PortalButton, PortalTextButton } from "../components/portal/PortalButton";
import { PortalError, PortalTextarea } from "../components/portal/PortalField";
import { AdmissionResultReveal } from "../components/portal/AdmissionResultReveal";
import {
  admissionResultOutcome,
  admissionResultRevealKey,
} from "../lib/admissionResultReveal";
import { normalizedIdeaLength, useNoveltyPreview } from "../hooks/useNoveltyPreview";
import { DashboardLive } from "./DashboardLive";
import { NoveltyPill, ReviewEditRow } from "../components/ProposalReview";
import {
  AccordionItem,
  AccordionItemContent,
  AccordionItemHeader,
  AccordionItemTrigger,
  AccordionRoot,
} from "../components/portal/Accordion";
import { SubmitCelebration } from "../components/portal/SubmitCelebration";
import { consumeSubmissionCelebration } from "../lib/submissionCelebration";
import {
  clearSessionDraft,
  readVersionedSessionDraft,
  sessionDraftConflicts,
  writeVersionedSessionDraft,
} from "../lib/sessionDraft";
import {
  proposalRevisionBase,
  proposalRevisionBaseFingerprint,
  proposalRevisionRegeneratesQuestions,
} from "../lib/proposalRevision";

type ParticipantDelivery = FunctionReturnType<typeof api.participantNotifications.mine>;
type ParticipantDeliveryState = NonNullable<ParticipantDelivery>["state"];
type ParticipantCapabilities = FunctionReturnType<typeof api.access.participantCapabilities>;
type CurrentApplication = SubmittedIntake["application"];
type ApplicationState = CurrentApplication["state"];

const additionalInformationLabel = "Additional information or links (optional, please no PPTs)";

const deliveryStatusCopy: Record<ParticipantDeliveryState, string> = {
  pending: "Email queued.",
  sending: "Email is being sent.",
  retry_wait: "We will try to send the email again.",
  sent: "Email sent.",
  delivery_delayed: "The email is taking longer than expected.",
  delivered: "Email delivered.",
  bounced: "The email could not be delivered. Check this page for the latest status.",
  failed: "The email could not be sent. Check this page for the latest status.",
  suppressed:
    "Email updates are turned off for this address. Check this page for the latest status.",
  unknown: "We could not confirm email delivery. Check this page for the latest status.",
  superseded: "A newer update replaced this email.",
};

const applicationCopy: Record<
  ApplicationState,
  {
    heading: string;
    message: string;
    status: string;
  }
> = {
  submitted: {
    status: "Application received",
    heading: "Submitted.",
    message: "We have your application. Your team and proposal can change until the deadline.",
  },
  under_review: {
    status: "Under review",
    heading: "Your idea is submitted.",
    message: "Review is underway. Changes before the deadline create a new review version.",
  },
  accepted: {
    status: "Selected",
    heading: "You’re selected.",
    message: "Your team has been selected. Your offer will appear here.",
  },
  waitlisted: {
    status: "Waitlisted",
    heading: "You’re on the waitlist.",
    message: "Your application is still active. We will send an update if a place opens.",
  },
  declined: {
    status: "Decision published",
    heading: "Unfortunately you didn’t make the cut.",
    message: "But hey, that’s no reason to stop building your project :)",
  },
  offer_sent: {
    status: "Selected",
    heading: "You’re selected.",
    message: "Your team’s places are held until the deadline below.",
  },
  confirmed: {
    status: "Confirmed",
    heading: "You’re confirmed.",
    message: "Your team has a place at Code2Create.",
  },
  offer_expired: {
    status: "Offer expired",
    heading: "The offer expired.",
    message: "The reserved places were released when the response deadline passed.",
  },
  withdrawn: {
    status: "Offer declined",
    heading: "The offer was declined.",
    message: "The team declined its offer, so the reserved places were released.",
  },
};

/** The states the quiet queue screen (mockup f7) covers, before any decision. */
const QUEUED_STATES: readonly ApplicationState[] = [
  "submitted",
  "under_review",
];

export function SubmittedScreen({
  capabilities,
  publicState,
  team,
  members,
  onSignOut,
  view,
}: {
  capabilities: ParticipantCapabilities;
  publicState: PublicState;
  team: CurrentTeam;
  members: CurrentTeamMember[];
  onSignOut: () => void;
  /** Open straight on the proposal (the /idea route); "back" then returns home. */
  view?: "proposal";
}) {
  const intake = useQuery(api.intake.submitted, { eventSlug });
  if (intake === undefined) {
    return (
      <PortalScene tree="left">
        <DelayedBonsai />
      </PortalScene>
    );
  }
  if (intake === null) {
    return (
      <p className="notice notice-error" role="alert">
        Your application could not be opened. Refresh or ask an organizer for help.
      </p>
    );
  }
  return (
    <SubmittedWorkspace
      capabilities={capabilities}
      publicState={publicState}
      intake={intake}
      team={team}
      members={members}
      onSignOut={onSignOut}
      {...(view ? { view } : {})}
    />
  );
}

function SubmittedWorkspace({
  capabilities,
  publicState,
  intake,
  team,
  members,
  onSignOut,
  view,
}: {
  capabilities: ParticipantCapabilities;
  publicState: PublicState;
  intake: SubmittedIntake;
  team: CurrentTeam;
  members: CurrentTeamMember[];
  onSignOut: () => void;
  view?: "proposal";
}) {
  const navigate = useNavigate();
  const application = intake.application;
  const copy = applicationCopy[application.state];
  const selected = ["accepted", "offer_sent", "confirmed"].includes(application.state);
  const delivery = useQuery(
    api.participantNotifications.mine,
    capabilities?.notifications ? { eventSlug } : "skip",
  );
  const communications = useQuery(
    api.participantCommunications.current,
    selected ? { eventSlug } : "skip",
  );
  const respondToOffer = useMutation(api.admissions.respondToOffer);
  const responseAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.admissions.respondToOffer>>();
  const [pendingResponse, setPendingResponse] = useState<"confirm" | "decline" | null>(null);
  const responsePending = responseAttempt.hasPending("offer-response");
  const [busy, setBusy] = useState<"confirm" | "decline" | null>(null);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [viewingProposal, setViewingProposal] = useState(view === "proposal");
  const resultOutcome = admissionResultOutcome(application.state);
  const resultRevealKey = resultOutcome
    ? admissionResultRevealKey(application.id, resultOutcome)
    : null;
  const [dismissedResultKey, setDismissedResultKey] = useState<string | null>(() =>
    resultRevealKey && window.sessionStorage.getItem(resultRevealKey) === "seen"
      ? resultRevealKey
      : null,
  );
  // Set by the submit button; consumed here so the bloom plays exactly once.
  const [celebrating, setCelebrating] = useState(consumeSubmissionCelebration);
  const [error, setError] = useState<string | null>(null);
  const event = publicState.event;
  const [phaseClock, setPhaseClock] = useState(() => ({
    sourceServerNow: intake.serverNow,
    phaseTime: intake.serverNow,
  }));
  const phaseTime =
    phaseClock.sourceServerNow === intake.serverNow ? phaseClock.phaseTime : intake.serverNow;
  const phases = event?.phases;
  useEffect(() => {
    const nextBoundary = [
      ...(phases?.flatMap((phase) => [phase.startsAt, phase.endsAt]) ?? []),
      intake.applicationsCloseAt,
    ]
      .filter((timestamp) => timestamp > phaseTime)
      .toSorted((left, right) => left - right)[0];
    const observedAt = performance.now();
    const observedServerNow = phaseTime;
    const nextTickIn = Math.min(
      30_000,
      nextBoundary === undefined ? 30_000 : nextBoundary - phaseTime + 100,
      2_147_000_000,
    );
    const timer = window.setTimeout(
      () => {
        setPhaseClock({
          sourceServerNow: intake.serverNow,
          phaseTime: observedServerNow + performance.now() - observedAt,
        });
      },
      nextTickIn,
    );
    return () => window.clearTimeout(timer);
  }, [intake.applicationsCloseAt, intake.serverNow, phaseTime, phases]);
  if (!event) {
    return (
      <p className="notice notice-error" role="alert">
        Event details are unavailable right now.
      </p>
    );
  }
  const confirmed = application.state === "confirmed";
  const currentPhase = event.phases.find(
    (phase) => phase.startsAt <= phaseTime && phaseTime < phase.endsAt,
  );
  const eventIsLive = confirmed && currentPhase !== undefined;
  const canEditProposal = intake.canEdit && phaseTime < intake.applicationsCloseAt;
  const proposalEditStatus = canEditProposal
    ? `editable until ${formatEventTime(intake.applicationsCloseAt, event.timezone)}`
    : phaseTime >= intake.applicationsCloseAt
      ? "submission window closed"
      : intake.currentRole !== "lead"
        ? "only team leader can edit"
        : "submission is read-only";
  const teamEditable = phaseTime < team.membershipEditableUntil;
  const canManageTeam = team.currentRole === "lead" && teamEditable;
  const resultWasSeen =
    resultRevealKey !== null && window.sessionStorage.getItem(resultRevealKey) === "seen";
  const showingResultReveal =
    resultOutcome !== null &&
    resultRevealKey !== null &&
    dismissedResultKey !== resultRevealKey &&
    !resultWasSeen;

  if (showingResultReveal) {
    return (
      <AdmissionResultReveal
        outcome={resultOutcome}
        eventName={event.name}
        teamName={team.name}
        onSignOut={onSignOut}
        header={
          <TeamCluster
            team={team}
            members={members}
            editable={teamEditable}
            canManage={canManageTeam}
          />
        }
        onContinue={() => {
          window.sessionStorage.setItem(resultRevealKey, "seen");
          setDismissedResultKey(resultRevealKey);
        }}
      />
    );
  }

  const respond = async (response: "confirm" | "decline") => {
    const offer = application.currentOffer;
    if (!offer || (pendingResponse !== null && pendingResponse !== response)) return;
    if (!responsePending) setPendingResponse(response);
    setBusy(response);
    setError(null);
    try {
      await responseAttempt.run("offer-response", () => {
        const args = {
          eventSlug,
          applicationId: application.id,
          expectedApplicationVersion: application.version,
          expectedOfferVersion: offer.version,
          response,
          clientOperationId: crypto.randomUUID(),
        };
        return () => respondToOffer(args);
      });
      setPendingResponse(null);
      setConfirmDecline(false);
    } catch (caught) {
      if (!responseAttempt.hasPending("offer-response")) setPendingResponse(null);
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  const proposalButton = (
    <PortalButton type="button" onClick={() => setViewingProposal(true)}>
      {canEditProposal ? "Edit submission" : "View submission"}
    </PortalButton>
  );
  const deliveryNotice =
    delivery && deliveryNeedsAttention(delivery.state) ? (
      <p role="status" className="mt-6 text-[12.5px] text-rose-light">
        {deliveryStatusCopy[delivery.state]}
      </p>
    ) : null;
  const proposalLink = (
    <>
      <div className="mt-8">{proposalButton}</div>
      {deliveryNotice}
    </>
  );

  // ---- the proposal as its own view, swapped in place of the hero ----------
  if (viewingProposal) {
    return (
      <PortalScene
        onSignOut={onSignOut}
        tree="left"
        logoGlow={resultOutcome !== null}
        header={
          <TeamCluster
            team={team}
            members={members}
            editable={teamEditable}
            canManage={canManageTeam}
          />
        }
      >
        <div className="flex w-full max-w-[840px] flex-col items-center">
          <h1 className="mb-2 text-center font-display font-light tracking-[-.01em] text-3xl text-shadow-[0_6px_40px_var(--scene-text-glow)] lg:text-[44px]">
            {team.name}
          </h1>
          <p className="mb-7 text-xs text-fg/50">
            {proposalEditStatus} ·{" "}
            <button
              type="button"
              onClick={() => {
                if (view === "proposal") void navigate("/", { viewTransition: true });
                else setViewingProposal(false);
              }}
              className="text-rose-light underline-offset-4 hover:underline"
            >
              back
            </button>
          </p>
          <div className="w-full text-left">
            <PetalCard className="px-6 py-2 sm:px-8">
              <ProposalSummary
                application={application}
                canEdit={canEditProposal}
                intake={intake}
                members={members}
              />
            </PetalCard>
          </div>
        </div>
      </PortalScene>
    );
  }

  const celebration = celebrating ? (
    <SubmitCelebration onDone={() => setCelebrating(false)} />
  ) : null;

  // ---- f7 · the quiet queue state ----------------------------------------
  // Everything before a decision reads as one still screen; the proposal
  // editor stays one click away rather than sitting open under the hero.
  if (!selected && QUEUED_STATES.includes(application.state)) {
    return (
      <PortalScene
        onSignOut={onSignOut}
        tree="left"
        header={
          <TeamCluster
            team={team}
            members={members}
            editable={teamEditable}
            canManage={canManageTeam}
          />
        }
      >
        {celebration}
        <div className="flex w-full max-w-[760px] flex-col items-center text-center">
          <h1
            className={`mb-3.5 font-display font-light tracking-[-.01em] text-5xl leading-none text-shadow-[0_8px_50px_var(--scene-text-glow)] lg:text-[70px] ${
              /* Named only once the overlay is gone, so the celebration's
                 closing line can morph into this heading — two live elements
                 sharing the name would cancel the transition. */
              celebrating ? "" : "[view-transition-name:submitted-heading]"
            }`}
          >
            {copy.heading}
          </h1>
          <p className="mb-8 font-ui font-normal text-base text-rose-light lg:text-[19px]">
            {team.name} is in the review queue
          </p>
          {proposalButton}

          {/* The facts stay one quiet line under the action: boxes here turn
              a still screen into a dashboard. */}
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-[13px] text-fg/65">
            <span>
              status <span className="text-fg">{copy.status.toLowerCase()}</span>
            </span>
            <span aria-hidden className="hidden h-3.5 w-px bg-rose/40 sm:block" />
            <span>
              team{" "}
              <Link
                to="/team"
                viewTransition
                className="text-rose-light underline-offset-4 hover:underline"
              >
                {canManageTeam ? "manage team" : "view team"}
              </Link>
            </span>
            {canEditProposal ? (
              <>
                <span aria-hidden className="hidden h-3.5 w-px bg-rose/40 sm:block" />
                <span>
                  editable until{" "}
                  <span className="text-fg">
                    {formatEventTime(intake.applicationsCloseAt, event.timezone)}
                  </span>
                </span>
              </>
            ) : null}
          </div>


          {delivery && deliveryNeedsAttention(delivery.state) ? (
            <p role="status" className="mt-6 text-[12.5px] text-rose-light">
              {deliveryStatusCopy[delivery.state]}
            </p>
          ) : null}
        </div>
      </PortalScene>
    );
  }

  // ---- f9 · event live: the dashboard bento ------------------------------
  if (eventIsLive) {
    return (
      <DashboardLive
        capabilities={capabilities}
        event={event}
        phaseTime={phaseTime}
        discordUrl={communications?.discordUrl ?? null}
        team={team}
        members={members}
        teamEditable={teamEditable}
        onSignOut={onSignOut}
      />
    );
  }

  // ---- f8 · selected: lanterns rise, the ticket ---------------------------
  if (selected) {
    const offer = application.currentOffer;
    const canRespond =
      application.state === "offer_sent" &&
      offer !== null &&
      intake.currentRole === "lead" &&
      team.canRespondToOffer;
    return (
      <PortalScene
        onSignOut={onSignOut}
        tree="left"
        logoGlow
        header={
          <TeamCluster
            team={team}
            members={members}
            editable={teamEditable}
            canManage={canManageTeam}
          />
        }
        backdrop={
          <div aria-hidden className="pointer-events-none absolute inset-0 z-[2]">
            <img
              src="/assets/lantern-1.svg"
              alt=""
              className="absolute bottom-[-60px] left-[16%] w-[42px]"
              style={{ animation: "c2crise 16s linear -2s infinite" }}
            />
            <img
              src="/assets/lantern-2.svg"
              alt=""
              className="absolute right-[19%] bottom-[-60px] w-8"
              style={{ animation: "c2crise 20s linear -11s infinite" }}
            />
          </div>
        }
      >
        <div className="flex w-full max-w-[760px] flex-col items-center text-center">
          <p className="mb-2.5 font-ui text-lg text-rose-light text-shadow-[0_2px_14px_var(--scene-text-glow)] lg:text-xl">
            {copy.status} for {event.name}
          </p>
          <h1 className="mb-9 text-balance font-display font-light tracking-[-.01em] text-[clamp(2.5rem,9vw,3.75rem)] leading-[.96] text-shadow-[0_0_60px_var(--glow-rose-soft),0_10px_50px_var(--scene-text-glow)] lg:mb-[42px] lg:text-[92px]">
            {confirmed ? "You’re confirmed." : "Your team is selected."}
          </h1>

          <PetalCard className="flex flex-col overflow-hidden md:flex-row">
            <div className="grid min-w-0 flex-1 grid-cols-1 gap-5 px-6 py-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)] md:gap-0">
              <div className="min-w-0 md:border-r md:border-rose/35 md:pr-5">
                <p className="mb-1 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
                  venue
                </p>
                <p className="m-0 text-balance wrap-break-word font-display font-light tracking-[-.01em] text-[15px] leading-[1.45]">
                  {communications?.venueName ?? "announced with your offer"}
                </p>
              </div>
              <div className="min-w-0 md:border-r md:border-rose/35 md:px-5">
                <p className="mb-1 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">when</p>
                {communications ? (
                  <div className="flex items-center justify-center gap-2.5 font-display text-[14px] font-light leading-[1.45] tracking-[-.01em]">
                    <EventDateTime timestamp={communications.startsAt} timezone={event.timezone} stacked />
                    <span aria-hidden className="text-xs text-fg/40">→</span>
                    <span className="sr-only">to</span>
                    <EventDateTime timestamp={communications.endsAt} timezone={event.timezone} stacked />
                  </div>
                ) : <p className="m-0 text-[15px]">—</p>}
              </div>
              <div className="min-w-0 md:pl-5">
                <p className="mb-1 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
                  {confirmed || !offer ? "status" : "confirm by"}
                </p>
                <p className="m-0 text-balance font-display font-light tracking-[-.01em] text-[15px] leading-[1.45] text-rose-light">
                  {confirmed
                    ? "place held"
                    : offer
                      ? <EventDateTime timestamp={offer.expiresAt} timezone={event.timezone} stacked />
                      : "RSVP pending"}
                </p>
              </div>
            </div>
            <div
              aria-hidden
              className="mx-6 border-0 border-t-2 border-dashed border-rose/55 md:mx-0 md:my-4 md:border-t-0 md:border-l-2"
            />
            <div className="flex flex-none items-center justify-center gap-3 px-5 py-4 md:w-[108px] md:flex-col md:gap-[7px]">
              <div className="flex size-12 -rotate-4 items-center justify-center rounded-[10px] bg-rose text-[15px] font-bold text-wash shadow-[0_8px_20px_var(--shade-1)]">
                C2C
              </div>
              <p className="m-0 text-[11px] text-fg/60">
                admits {team.activeMemberCount === 1 ? "one" : team.activeMemberCount}
              </p>
            </div>
          </PetalCard>

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
                      disabled={busy !== null || pendingResponse === "confirm"}
                      onClick={() => void respond("decline")}
                    >
                      {busy === "decline"
                        ? "Declining…"
                        : pendingResponse === "decline"
                          ? "confirm earlier decline"
                          : "decline for team"}
                    </PortalTextButton>
                  </div>
                </div>
              ) : (
                <>
                  <PortalButton
                    type="button"
                    disabled={busy !== null || pendingResponse === "decline"}
                    onClick={() => void respond("confirm")}
                  >
                    {busy === "confirm"
                      ? "Confirming…"
                      : pendingResponse === "confirm"
                        ? "Confirm earlier response"
                        : "Confirm RSVP"}
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
            ) : application.state === "offer_sent" && intake.currentRole !== "lead" ? (
              <p className="m-0 text-[12.5px] text-fg/60">
                Your team lead confirms for the team
                {offer ? <> · by <EventDateTime timestamp={offer.expiresAt} timezone={event.timezone} /></> : null}.
              </p>
            ) : null}
            {communications?.discordUrl ? (
              <a
                href={communications.discordUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[13.5px] text-rose-light underline-offset-4 hover:underline"
              >
                {communications.discordLabel || "join the Discord"}
              </a>
            ) : null}
          </div>

          {communications?.nextSteps.length ? (
            <div className="mt-7 w-full max-w-[560px] text-left">
              {communications.nextSteps.map((step) => (
                <div
                  key={step.stableKey}
                  className="flex flex-col gap-1.5 border-b border-petal-line py-2.5 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
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
                      <EventDateTime timestamp={step.dueAt} timezone={event.timezone} />
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <PortalError message={error} />
          {proposalLink}
        </div>
      </PortalScene>
    );
  }

  // ---- closed states: declined, waitlisted, expired, withdrawn ------------
  return (
    <PortalScene
      onSignOut={onSignOut}
      tree="left"
      logoGlow={resultOutcome !== null}
      header={
        <TeamCluster
          team={team}
          members={members}
          editable={teamEditable}
          canManage={canManageTeam}
        />
      }
    >
      <div className="flex w-full max-w-[760px] flex-col items-center text-center">
        <h1 className="mb-3.5 text-balance font-display font-light tracking-[-.01em] text-[clamp(2rem,7vw,3rem)] leading-tight text-shadow-[0_8px_50px_var(--scene-text-glow)] lg:text-[64px]">
          {copy.heading}
        </h1>
        <p className="mb-6 max-w-[520px] font-ui text-base text-rose-light lg:text-[19px]">
          {copy.message}
        </p>
        {application.state === "declined" ? (
          <>
            <p className="mb-8 max-w-[520px] text-sm leading-relaxed text-fg/70 sm:text-base">
              You can keep building and share updates with the community on our Discord server.
            </p>
            <div className="flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
              <PortalButton
                type="button"
                onClick={() => window.open("https://discord.gg/xWyjKPe3S", "_blank", "noopener,noreferrer")}
              >
                Join our Discord
              </PortalButton>
              <PortalButton type="button" onClick={() => navigate("/")}>
                Return Home
              </PortalButton>
            </div>
            {deliveryNotice}
          </>
        ) : (
          <>
            <p className="m-0 text-[13px] text-fg/65">
              status <span className="text-fg">{copy.status.toLowerCase()}</span>
            </p>
            {proposalLink}
          </>
        )}
      </div>
    </PortalScene>
  );
}

function ProposalSummary({
  application,
  canEdit,
  intake,
  members,
}: {
  application: CurrentApplication;
  canEdit: boolean;
  intake: SubmittedIntake;
  members: CurrentTeamMember[];
}) {
  const navigate = useNavigate();
  const reviseSubmission = useMutation(api.intake.reviseSubmission);
  const beginSubmittedRevision = useMutation(api.intake.beginSubmittedRevision);
  const revisionAttempt = useMutationAttempt<
    | FunctionReturnType<typeof api.intake.reviseSubmission>
    | FunctionReturnType<typeof api.intake.beginSubmittedRevision>
  >();
  const pending = revisionAttempt.hasPending("proposal-revision");
  const proposalStorageKey = `c2c:${eventSlug}:${application.id}:proposal`;
  const [recoveredDraft] = useState(() => readVersionedSessionDraft(proposalStorageKey));
  const currentEditBase = proposalRevisionBase(application, intake.project);
  const [editing, setEditing] = useState(false);
  const [openSections, setOpenSections] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState(() =>
    recoveredDraft === null
      ? proposalDraft(intake)
      : recoverProposalDraft(intake, recoveredDraft.value),
  );
  const [hasRecoveredDraft, setHasRecoveredDraft] = useState(recoveredDraft !== null);
  const editBase = useRef(currentEditBase);
  const [editConflict, setEditConflict] = useState(
    sessionDraftConflicts(recoveredDraft, proposalRevisionBaseFingerprint(currentEditBase)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { editors, markEditing, stopEditing } = useEditingPresence(canEdit && editing);
  const noveltyIdea = editing ? draft.initialIdea : intake.project.initialIdea;
  const noveltyState = useNoveltyPreview({
    idea: noveltyIdea,
    ideaLength: normalizedIdeaLength(noveltyIdea),
    active: canEdit && editing,
    config: intake.novelty,
    saved: {
      // The saved idea remains the restoration target even when an older
      // submission has no durable novelty signal yet.
      idea: intake.project.initialIdea,
      score: intake.noveltySignal?.score ?? null,
      band: intake.noveltySignal?.band ?? null,
    },
  });
  const requiresQuestionRegeneration = proposalRevisionRegeneratesQuestions({
    savedIdea: intake.project.initialIdea,
    nextIdea: draft.initialIdea,
    savedResponses: intake.project.intakeResponses,
    nextResponses: draft.responses,
    deterministicFollowUpCount: intake.editRules.deterministicFollowUpCount,
    maximumFollowUpCount: intake.editRules.maximumFollowUpCount,
  });

  useEffect(() => {
    const latest = proposalRevisionBase(application, intake.project);
    if (
      proposalRevisionBaseFingerprint(editBase.current) === proposalRevisionBaseFingerprint(latest)
    )
      return;
    if (editing || hasRecoveredDraft) {
      // oxlint-disable-next-line react/set-state-in-effect -- A newer server revision must surface as a conflict without replacing the operator's local draft.
      setEditConflict(true);
      return;
    }
    editBase.current = latest;
    setDraft(proposalDraft(intake));
  }, [application, editing, hasRecoveredDraft, intake]);

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await revisionAttempt.run("proposal-revision", () => {
        const args = {
          eventSlug,
          applicationId: application.id,
          expectedApplicationContentVersion: editBase.current.applicationContentVersion,
          expectedProjectVersionId: editBase.current.projectVersionId,
          expectedProjectVersion: editBase.current.projectVersion,
          initialIdea: draft.initialIdea,
          additionalInformation: draft.additionalInformation,
          responses: draft.responses.map((response) => ({
            questionId: response.questionId,
            answer: response.answer,
          })),
          clientOperationId: crypto.randomUUID(),
        };
        return () =>
          requiresQuestionRegeneration ? beginSubmittedRevision(args) : reviseSubmission(args);
      });
      clearSessionDraft(proposalStorageKey);
      setHasRecoveredDraft(false);
      setEditConflict(false);
      stopEditing();
      setEditing(false);
      if (requiresQuestionRegeneration) {
        void navigate("/write", { replace: true, viewTransition: true });
      }
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  const ideaLength = draft.initialIdea.trim().length;
  const ideaMaximumLength = initialIdeaMaximumLength(intake.editRules.initialIdeaMaxLength);
  const invalidResponse = draft.responses.some(
    (response) =>
      response.answer.trim().length < intake.editRules.followUpAnswerMinLength ||
      response.answer.trim().length > intake.editRules.followUpAnswerMaxLength,
  );
  const invalidIdea =
    ideaLength < intake.editRules.initialIdeaMinLength ||
    draft.initialIdea.length > ideaMaximumLength;
  const invalidAdditionalInformation =
    draft.additionalInformation.trim().length > intake.editRules.additionalInformationMaxLength;
  const hasLocalChanges =
    serializeProposalDraft(draft) !== serializeProposalDraft(proposalDraft(intake));

  const locked = busy || pending;
  const ideaSectionId = "idea";
  const additionalSectionId = "additional-information";

  const beginEditing = (sectionId: string) => {
    editBase.current = proposalRevisionBase(application, intake.project);
    if (!hasRecoveredDraft) setDraft(proposalDraft(intake));
    setEditing(true);
    setError(null);
    setOpenSections((current) => (current.includes(sectionId) ? current : [...current, sectionId]));
  };

  const cancelEditing = () => {
    setDraft(proposalDraft(intake));
    clearSessionDraft(proposalStorageKey);
    setHasRecoveredDraft(false);
    setEditConflict(false);
    stopEditing();
    setEditing(false);
    setError(null);
  };

  const rememberDraft = (nextDraft: ProposalDraft) => {
    writeVersionedSessionDraft(proposalStorageKey, {
      base: proposalRevisionBaseFingerprint(editBase.current),
      value: serializeProposalDraft(nextDraft),
    });
  };

  const sectionTitle = (title: string) => (
    <AccordionItemTrigger>
      <AccordionItemHeader>
        <span className="text-[15px] font-semibold text-fg/85">{title}</span>
      </AccordionItemHeader>
    </AccordionItemTrigger>
  );
  const contentClass = "text-[15px] leading-relaxed wrap-anywhere text-fg";

  // The submitted proposal reads and edits in the same accordion as the
  // review before submission: every section closed until opened, an edit
  // row under each answer, and one versioned save for the whole revision.
  return (
    <section className="text-left">
      <EditingPresence editors={editors ?? []} members={members} />
      <form onSubmit={save}>
        {editing && hasRecoveredDraft ? (
          <p
            role="status"
            className="my-3 rounded-petal-xs bg-wash/50 px-4 py-3 text-[12.5px] text-fg/75"
          >
            Recovered your unsaved changes from this tab.
          </p>
        ) : null}
        {editing && editConflict ? (
          <div role="status" className="my-3 rounded-petal-xs bg-wash/50 px-4 py-3">
            <p className="text-[12.5px] text-fg/75">
              A newer submission was saved. Your changes are still here.
            </p>
            <div className="mt-2 flex gap-5">
              <PortalTextButton
                type="button"
                onClick={() => {
                  setDraft(proposalDraft(intake));
                  editBase.current = proposalRevisionBase(application, intake.project);
                  setEditConflict(false);
                  setHasRecoveredDraft(false);
                  clearSessionDraft(proposalStorageKey);
                }}
              >
                use the saved version
              </PortalTextButton>
              <PortalTextButton
                type="button"
                onClick={() => {
                  editBase.current = proposalRevisionBase(application, intake.project);
                  setEditConflict(false);
                  rememberDraft(draft);
                }}
              >
                keep mine
              </PortalTextButton>
            </div>
          </div>
        ) : null}

        {intake.novelty ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-petal-line py-4">
            <div>
              <p className="text-[15px] font-semibold text-fg/85">Idea comparison</p>
              <p className="mt-0.5 text-[11.5px] text-fg/45">
                {editing
                  ? "Updates while you edit your idea"
                  : "Compared with past and current projects"}
              </p>
            </div>
            <NoveltyPill
              state={noveltyState}
              currentLength={normalizedIdeaLength(noveltyIdea)}
              minimumLength={intake.novelty.minimumIdeaLength}
              idleLabel={editing ? "keep writing" : "score unavailable"}
            />
          </div>
        ) : null}

        <AccordionRoot allowMultiple value={openSections} onValueChange={setOpenSections}>
          <AccordionItem value={ideaSectionId}>
            {sectionTitle("The idea")}
            <AccordionItemContent className={contentClass}>
              {editing ? (
                <>
                  <PortalTextarea
                    aria-label="The idea"
                    autoFocus
                    required
                    rows={5}
                    minLength={intake.editRules.initialIdeaMinLength}
                    maxLength={ideaMaximumLength}
                    value={draft.initialIdea}
                    disabled={locked}
                    onChange={(event) => {
                      const nextDraft = { ...draft, initialIdea: event.currentTarget.value };
                      setDraft(nextDraft);
                      rememberDraft(nextDraft);
                      markEditing("proposal_revision");
                    }}
                  />
                  <p className="mt-1 text-right font-mono text-[11px] tracking-[.04em] text-fg/45">
                    <LiveNumber value={draft.initialIdea.length} /> / {ideaMaximumLength}
                  </p>
                  {draft.initialIdea.length > ideaMaximumLength ? (
                    <PortalError
                      message={`Keep the idea within ${ideaMaximumLength} characters.`}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <p className="whitespace-pre-line">{intake.project.initialIdea}</p>
                  {canEdit ? (
                    <ReviewEditRow busy={locked} onEdit={() => beginEditing(ideaSectionId)} />
                  ) : null}
                </>
              )}
            </AccordionItemContent>
          </AccordionItem>

          {intake.project.intakeResponses.map((response, index) => (
            <AccordionItem key={response.questionId} value={response.questionId}>
              {sectionTitle(response.question)}
              <AccordionItemContent className={contentClass}>
                {editing ? (
                  <PortalTextarea
                    aria-label={response.question}
                    required
                    rows={4}
                    minLength={intake.editRules.followUpAnswerMinLength}
                    maxLength={intake.editRules.followUpAnswerMaxLength}
                    value={draft.responses[index]?.answer ?? ""}
                    disabled={locked}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      const nextDraft = {
                        ...draft,
                        responses: draft.responses.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, answer: value } : item,
                        ),
                      };
                      setDraft(nextDraft);
                      rememberDraft(nextDraft);
                      markEditing("proposal_revision", response.questionId);
                    }}
                  />
                ) : (
                  <>
                    <p className="whitespace-pre-line">{response.answer}</p>
                    {canEdit ? (
                      <ReviewEditRow
                        busy={locked}
                        onEdit={() => beginEditing(response.questionId)}
                      />
                    ) : null}
                  </>
                )}
              </AccordionItemContent>
            </AccordionItem>
          ))}

          <AccordionItem value={additionalSectionId}>
            {sectionTitle(additionalInformationLabel)}
            <AccordionItemContent className={contentClass}>
              {editing ? (
                <PortalTextarea
                  aria-label={additionalInformationLabel}
                  rows={5}
                  maxLength={intake.editRules.additionalInformationMaxLength}
                  value={draft.additionalInformation}
                  disabled={locked}
                  placeholder="Optional: share some reference website, other documents or anything else useful."
                  onChange={(event) => {
                    const nextDraft = {
                      ...draft,
                      additionalInformation: event.currentTarget.value,
                    };
                    setDraft(nextDraft);
                    rememberDraft(nextDraft);
                    markEditing("proposal_revision");
                  }}
                />
              ) : (
                <>
                  {intake.project.additionalInformation ? (
                    <p className="whitespace-pre-line">{intake.project.additionalInformation}</p>
                  ) : (
                    <p className="text-fg/45">Nothing added.</p>
                  )}
                  {canEdit ? (
                    <ReviewEditRow busy={locked} onEdit={() => beginEditing(additionalSectionId)} />
                  ) : null}
                </>
              )}
            </AccordionItemContent>
          </AccordionItem>
        </AccordionRoot>

        {editing ? (
          <>
            {requiresQuestionRegeneration ? (
              <p className="mt-3 rounded-petal-xs bg-wash/50 px-4 py-3 text-[12.5px] leading-relaxed text-fg/75">
                This change affects later questions. We’ll keep the answers that still apply and ask
                the updated questions before saving a new submission version.
              </p>
            ) : null}
            <PortalError message={error} />
            <div className="mt-1 flex items-center gap-4 border-t border-petal-line py-3.5">
              <PortalTextButton type="button" disabled={locked} onClick={cancelEditing}>
                cancel
              </PortalTextButton>
              {hasLocalChanges ? (
                <span className="mr-auto text-[11.5px] text-fg/45">draft saved on this device</span>
              ) : (
                <span className="mr-auto" />
              )}
              <PortalButton
                type="submit"
                size="sm"
                disabled={
                  busy ||
                  editConflict ||
                  invalidIdea ||
                  invalidResponse ||
                  invalidAdditionalInformation
                }
              >
                {busy
                  ? "Saving…"
                  : pending
                    ? "Confirm earlier save"
                    : requiresQuestionRegeneration
                      ? "Update questions"
                      : "Save submission"}
              </PortalButton>
            </div>
          </>
        ) : null}
      </form>
    </section>
  );
}

function proposalDraft(intake: SubmittedIntake) {
  return {
    initialIdea: intake.project.initialIdea,
    additionalInformation: intake.project.additionalInformation ?? "",
    responses: intake.project.intakeResponses.map((response) => ({
      questionId: response.questionId,
      answer: response.answer,
    })),
  };
}

type ProposalDraft = ReturnType<typeof proposalDraft>;

function serializeProposalDraft(draft: ProposalDraft) {
  const values = new URLSearchParams();
  values.set("idea", draft.initialIdea);
  values.set("additionalInformation", draft.additionalInformation);
  for (const response of draft.responses) {
    values.set(`answer:${response.questionId}`, response.answer);
  }
  return values.toString();
}

function recoverProposalDraft(intake: SubmittedIntake, stored: string): ProposalDraft {
  const current = proposalDraft(intake);
  const values = new URLSearchParams(stored);
  return {
    initialIdea: values.get("idea") ?? current.initialIdea,
    additionalInformation: values.get("additionalInformation") ?? current.additionalInformation,
    responses: current.responses.map((response) => ({
      ...response,
      answer: values.get(`answer:${response.questionId}`) ?? response.answer,
    })),
  };
}

function EventDateTime({
  timestamp,
  timezone,
  stacked = false,
}: {
  timestamp: number;
  timezone: string;
  stacked?: boolean;
}) {
  const date = new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: "medium" });
  const time = new Intl.DateTimeFormat(undefined, { timeZone: timezone, timeStyle: "short" });
  return (
    <time
      dateTime={new Date(timestamp).toISOString()}
      className={`inline-flex gap-x-1.5 gap-y-0.5 ${stacked ? "flex-col items-center" : "flex-wrap"}`}
    >
      <span className="whitespace-nowrap">{date.format(timestamp)}</span>{" "}
      <span className={`whitespace-nowrap ${stacked ? "text-[0.9em] opacity-70" : ""}`}>
        {time.format(timestamp)}
      </span>
    </time>
  );
}

function formatEventTime(timestamp: number, timezone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function deliveryNeedsAttention(state: ParticipantDeliveryState) {
  return (
    state === "delivery_delayed" ||
    state === "bounced" ||
    state === "failed" ||
    state === "suppressed" ||
    state === "unknown"
  );
}
