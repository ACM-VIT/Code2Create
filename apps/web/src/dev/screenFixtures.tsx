import { outingFixture } from "./outingFixture";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccountBadge } from "../components/portal/AccountBadge";
import { ClassCard } from "../components/portal/ClassCard";
import { FadeText } from "../components/portal/FadeText";
import { EmailAddressStep, EmailCodeStep } from "../components/portal/EmailOtpSignIn";
import { PhoneCodePanel } from "../components/portal/PhoneCodePanel";
import { PetalCard } from "../components/portal/PetalCard";
import { Petal } from "../components/portal/Petal";
import {
  PortalButton,
  PortalTextButton,
  PortalTickButton,
} from "../components/portal/PortalButton";
import {
  PortalCheckRow,
  PortalError,
  PortalField,
  PortalInput,
  PortalInputTick,
  PortalSelect,
  PortalTextarea,
} from "../components/portal/PortalField";
import { GpuSky } from "../components/portal/GpuSky";
import { Flower } from "../components/portal/FlowerAvatar";
import { games as gameCatalogue } from "../games/catalog";
import { PortalScene } from "../components/portal/PortalScene";
import { StackedSheet } from "../components/portal/StackedSheet";
import { TreeLoader } from "../components/portal/TreeLoader";
import { releaseBalloons } from "../lib/balloons";
import type { BenefitsTileModel } from "../components/dashboard/BenefitsTile";
import type { EventTileModel } from "../components/dashboard/EventTile";
import type { HelpTileModel } from "../components/dashboard/HelpTile";
import type { IntegrationsTileModel } from "../components/dashboard/IntegrationsTile";
import type { MusicRequestView, MusicTileModel } from "../components/dashboard/MusicTile";
import type { ReviewTileModel } from "../components/dashboard/ReviewTile";
import type { ServiceQueuesTileModel } from "../components/dashboard/ServiceQueuesTile";
import type { UpdatesTileModel } from "../components/dashboard/UpdatesTile";
import { DashboardScreen } from "../screens/DashboardScreen";
import { MusicRoom } from "../screens/SynesthesiaScreen";
import { ShowcaseScreen } from "../screens/ShowcaseScreen";
import { showcaseSamples } from "./showcaseSamples";
import { PhotoGalleryFixture } from "./PhotoGalleryFixture";
import { ChillMode } from "../components/chill/ChillMode";
import { DisplayView } from "../screens/DisplayScreen";
import { IntegrationsScene } from "../screens/IntegrationsScreen";
import { FigmaMark, GitHubMark } from "../components/dashboard/IntegrationsTile";
import {
  ItemList,
  ItemRow,
  RowAction,
  RowNote,
  SectionLabel,
  ToolNotice,
  ToolSheet,
} from "../components/integrations/ToolKit";
import {
  ArcadeView,
  boardsOf,
  GameTile,
  StandingsColumn,
  standingOf,
  type BoardView,
} from "../screens/GamesScreen";
import { SglangInterlude } from "../screens/SglangInterlude";
import { ConfirmCard, RenameTeamCard } from "../screens/TeamLobbyScreen";
import { NoveltyPill, NoveltyReviewRow, ReviewEditRow } from "../components/ProposalReview";
import { IdeaPromptsLink } from "../components/portal/IdeaPromptsSheet";
import { JoinCodeBar } from "../components/portal/JoinCodeBar";
import {
  BringTeamTool,
  GuideComposer,
  type ComposerConfirm,
} from "../components/guide/GuideComposer";
import { GuideReasoning } from "../components/guide/GuideReasoning";
import { GuideStage } from "../components/guide/GuideStage";
import {
  GuideChip,
  GuideHeader,
  GuideHero,
  GuideTurn,
  LinkChip,
  SystemLine,
  TeamTurn,
  UserTurn,
} from "../components/guide/GuideTurns";
import {
  AccordionItem,
  AccordionItemContent,
  AccordionItemHeader,
  AccordionItemTrigger,
  AccordionRoot,
} from "../components/portal/Accordion";
import {
  TeamCluster,
  type ClusterMember,
  type ClusterTeam,
} from "../components/portal/TeamCluster";
import { SubmitCelebration } from "../components/portal/SubmitCelebration";
import { ImportedTeamChoiceView } from "../components/portal/ImportedTeamChoiceView";
import PacmanBoard from "../games/pacman/Map.tsx";
import MemoryBoard from "../games/memory/Board.tsx";
import StackBoard from "../games/stack/Board.tsx";

const team: ClusterTeam = {
  name: "Paper Cranes",
  publicCode: "C2C-PCRN",
  activeMemberCount: 5,
  teamMaximumSize: 5,
  currentMembershipId: "m2",
};

const members: ClusterMember[] = [
  { teamMemberId: "1", membershipId: "m1", role: "lead", displayName: "Ananya Iyer" },
  { teamMemberId: "2", membershipId: "m2", role: "member", displayName: "Rohan Mehta" },
  { teamMemberId: "3", membershipId: "m3", role: "member", displayName: "Sara Thomas" },
  { teamMemberId: "4", membershipId: "m4", role: "member", displayName: "Dev Patel" },
  { teamMemberId: "5", membershipId: "m5", role: "member", displayName: "Nikhil Rao" },
];

const noop = () => {};

const cluster = <TeamCluster team={team} members={members} />;
const account = (
  <AccountBadge
    name="Ananya Iyer"
    seed="m1"
    email="ananya@vitstudent.ac.in"
    detail="VIT student"
    onSignOut={() => {}}
  />
);

/** The star moment: the interlude as it stands the instant the star lands, balloons and all. */
function StarredFixture() {
  useEffect(() => {
    releaseBalloons();
    // The library mounts its layer at z-index 999, under the gallery's
    // takeover; lift it once it appears so the preview shows the release.
    const observer = new MutationObserver(() => {
      const layer = document.querySelector<HTMLElement>("balloons");
      if (!layer) return;
      layer.style.zIndex = "9999";
      observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true });
    return () => observer.disconnect();
  }, []);
  return (
    <SglangInterlude
      state={{ connected: true, completed: true, githubLogin: "freshman-builder" }}
      callback={false}
      header={account}
    />
  );
}

const guideAnswer = `The idea submission deadline for **Code2Create 7.0** is **23 September 2026 at 4:00 pm IST**.

Your team's proposal is already marked **submitted**, so you're done for this stage. Two things still help before then:

- keep the idea to one clear problem and one clear first user
- link anything a reviewer can open, not a deck`;

function ComposerFixture({ leading, confirm }: { leading?: ReactNode; confirm?: ComposerConfirm }) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  return (
    <GuideComposer
      value=""
      onChange={noop}
      onSend={noop}
      disabled={false}
      answering={false}
      {...(leading ? { leading } : {})}
      {...(confirm ? { confirm } : {})}
      textareaRef={textareaRef}
    />
  );
}

const guideReasoning = `The participant is asking about the submission deadline. Their team already has a submitted proposal, so the answer should give the date in their timezone and say clearly that nothing more is required from them right now, then offer what still helps before the deadline.`;

const fixtureHeader = (team?: string) => (
  <GuideHeader
    phaseLabel="Idea submission"
    deadline="Sep 23, 4:00 PM"
    {...(team ? { team } : {})}
  />
);

function HelpThreadFixture() {
  const [startedAt] = useState(() => Date.now() - 2_300);
  return (
    <PortalScene tree="left" header={account} fill>
      <GuideStage
        header={fixtureHeader("event team looking into it")}
        composer={<ComposerFixture />}
      >
        <UserTurn text="When is the idea submission deadline?" />
        <GuideTurn
          text={guideAnswer}
          streaming={false}
          officialLinks={[]}
          thinking={
            <GuideReasoning
              reasoning={guideReasoning}
              steps={[]}
              streaming={false}
              thoughtForMs={4_200}
            />
          }
          actions={
            <>
              <LinkChip href="https://discord.gg/code2create">Discord</LinkChip>
              <GuideChip>What do we still need before submitting?</GuideChip>
              <GuideChip>Help me make our idea clearer</GuideChip>
            </>
          }
        />
        <UserTurn text="My pass says it was already scanned, but I have not been through the gate yet." />
        <GuideTurn
          text="That needs a person at the gate, so I have brought the event team into this conversation. They can see what you told me and will reply here."
          streaming={false}
          officialLinks={[]}
          thinking={
            <GuideReasoning
              reasoning=""
              steps={[
                {
                  key: "s1",
                  label: "Brought the event team into this conversation",
                  state: "done",
                },
              ]}
              streaming={false}
              thoughtForMs={6_800}
            />
          }
        />
        <SystemLine>the event team joined · 2:23 PM</SystemLine>
        <TeamTurn body="Which gate are you at now? We can re-issue your pass there." />
        <UserTurn text="East gate, by the auditorium." />
        <GuideTurn
          text=""
          streaming
          officialLinks={[]}
          thinking={
            <GuideReasoning
              reasoning=""
              steps={[{ key: "s2", label: "Bringing in the event team", state: "running" }]}
              streaming
              startedAt={startedAt}
            />
          }
        />
      </GuideStage>
    </PortalScene>
  );
}

function HelpEmptyFixture() {
  return (
    <PortalScene tree="left" header={account} fill>
      <GuideStage
        header={fixtureHeader()}
        composer={<ComposerFixture leading={<BringTeamTool disabled={false} onClick={noop} />} />}
      >
        <div className="flex min-h-full flex-1 items-center py-6">
          <GuideHero
            description="Ask me about joining a team, shaping your proposal, and getting your idea submitted. I'll know the event-day details once the event starts."
            suggestions={[
              "What do we still need before submitting?",
              "Help me make our idea clearer",
              "When is the idea submission deadline?",
            ]}
            onPick={noop}
          />
        </div>
      </GuideStage>
    </PortalScene>
  );
}

/** The submit bloom, looping: each run remounts when the last one fades. */
function BloomFixture() {
  const [run, setRun] = useState(0);
  return <SubmitCelebration key={run} onDone={() => setRun((current) => current + 1)} />;
}

function RenameTeamFixture() {
  const [savedName, setSavedName] = useState("Paper Cranes");
  const [name, setName] = useState(savedName);
  return (
    <PortalScene
      tree="right"
      header={<p className="m-0 font-ui text-[13.5px] text-rose-light/80">4 of 4 seats</p>}
    >
      <div className="flex w-full max-w-[860px] flex-col items-center text-center">
        <p className="mb-2 text-[12px] text-rose-light/70">manage team</p>
        <h1 className="mb-11 font-display font-light tracking-[-.01em] wrap-anywhere text-4xl text-shadow-[0_6px_40px_var(--scene-text-glow)] lg:text-[54px]">
          {savedName}
        </h1>
        <RenameTeamCard
          currentName={savedName}
          name={name}
          onNameChange={setName}
          onSubmit={() => setSavedName(name.trim())}
          onCancel={() => setName(savedName)}
          busy={false}
        />
      </div>
    </PortalScene>
  );
}

function IdeaCard({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return (
    <PetalCard className="px-6 pt-[26px] pb-[18px] lg:px-[30px]">
      {children}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-petal-line pt-3.5">
        {footer}
      </div>
    </PetalCard>
  );
}

function DetailsFixture({ initialPhase }: { initialPhase: "idle" | "verified" }) {
  const [phase, setPhase] = useState<"idle" | "sent" | "verified">(initialPhase);
  const [code, setCode] = useState("");
  const [shake, setShake] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const verified = phase === "verified";
  return (
    <PortalScene tree="right" header={account}>
      <div className="flex w-full max-w-[640px] flex-col items-center">
        <h1 className="mb-7 text-center font-display font-normal tracking-[-.01em] text-3xl text-shadow-[0_4px_30px_var(--scene-text-glow)] lg:text-[40px]">
          A few details, once.
        </h1>
        <PetalCard className="px-6 pt-6 pb-4 lg:px-[30px]">
          <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-flow-row-dense sm:grid-cols-2">
            <PortalField label="full name" hint="verified">
              {(id) => <PortalInput id={id} readOnly value="Ananya Iyer" />}
            </PortalField>
            <PortalField label="phone" {...(verified ? { hint: "verified" } : {})}>
              {(id) => (
                <div className="flex items-stretch gap-2">
                  <div className="relative min-w-0 flex-1">
                    <PortalInput
                      id={id}
                      type="tel"
                      className={`min-w-0 ${verified ? "pr-10" : ""}`}
                      defaultValue="+919876543210"
                    />
                    {verified ? <PortalInputTick /> : null}
                  </div>
                  {phase === "idle" ? (
                    <PortalButton
                      type="button"
                      size="xs"
                      className="shrink-0 px-4"
                      onClick={() => setPhase("sent")}
                    >
                      Send code
                    </PortalButton>
                  ) : null}
                </div>
              )}
            </PortalField>
            {phase !== "sent" ? null : (
              <div className="sm:col-start-2">
                <PhoneCodePanel
                  maskedPhone="••••3210"
                  state="sent"
                  canVerify
                  expiresInMs={9 * 60_000 + 41_000}
                  resendInMs={42_000}
                  code={code}
                  onCodeChange={(next) => {
                    setError(null);
                    setCode(next);
                  }}
                  onVerify={(entered) => {
                    setCode("");
                    if (entered === "000000") {
                      setShake((count) => count + 1);
                      setError("wrong code · 4 tries left");
                      return;
                    }
                    setPhase("verified");
                  }}
                  onResend={noop}
                  busy={false}
                  error={error}
                  shakeKey={shake}
                />
              </div>
            )}
            <PortalField label="gender">
              {(id) => (
                <PortalSelect id={id} value="female" onValueChange={noop}>
                  <option value="female">Female</option>
                </PortalSelect>
              )}
            </PortalField>
            <PortalField label="college or university" hint="fixed">
              {(id) => (
                <PortalInput id={id} readOnly value="Vellore Institute of Technology, Vellore" />
              )}
            </PortalField>
            <PortalField label="year of study" hint="auto">
              {(id) => <PortalInput id={id} readOnly value="Third year" />}
            </PortalField>
            <PortalField label="registration number" hint="verified">
              {(id) => <PortalInput id={id} className="font-mono" readOnly value="23BCE1847" />}
            </PortalField>
            <PortalField label="programme code" hint="auto">
              {(id) => <PortalInput id={id} readOnly value="BCE" />}
            </PortalField>
            <PortalField label="residence">
              {(id) => (
                <PortalSelect id={id} value="hosteller" onValueChange={noop}>
                  <option value="hosteller">Hosteller</option>
                </PortalSelect>
              )}
            </PortalField>
            <PortalField label="hostel block">
              {(id) => (
                <PortalSelect id={id} value="lh_s" onValueChange={noop}>
                  <option value="lh_s">Ladies' hostel · S block</option>
                </PortalSelect>
              )}
            </PortalField>
            <PortalField label="room number">
              {(id) => <PortalInput id={id} className="font-mono" defaultValue="412" />}
            </PortalField>
          </div>
          <div className="mt-4.5 border-t border-petal-line pt-4">
            <PortalCheckRow checked onChange={noop}>
              I accept the{" "}
              <span className="text-rose-light underline decoration-rose-light/50 decoration-1 underline-offset-2">
                participant policy
              </span>{" "}
              and the{" "}
              <span className="text-rose-light underline decoration-rose-light/50 decoration-1 underline-offset-2">
                privacy notice
              </span>
            </PortalCheckRow>
          </div>
          <div className="mt-3.5 flex items-center justify-between border-t border-petal-line pt-3.5">
            <span className="text-xs text-fg/45">saved when you continue</span>
            <PortalButton size="sm">Continue</PortalButton>
          </div>
        </PetalCard>
      </div>
    </PortalScene>
  );
}

function EntryFixture() {
  const [participantClass, setParticipantClass] = useState<"vit" | "external" | null>("external");
  const external = participantClass === "external";
  const [step, setStep] = useState<"closed" | "email" | "code">("closed");
  const [email, setEmail] = useState("ananya@bmsce.ac.in");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("check spam too");
  const [shake, setShake] = useState(0);
  return (
    <PortalScene tree="both" logo="none">
      <a
        href="https://acmvit.in"
        className="absolute top-7 left-6 z-[6] opacity-85 lg:top-9 lg:left-11"
      >
        <img
          src="/assets/acm-mark.svg"
          alt="ACM-VIT"
          className="size-8 [filter:var(--mark-filter)] lg:size-9"
        />
      </a>
      <div className="flex w-full max-w-[640px] flex-col items-center text-center">
        <img
          src="/assets/logo.svg"
          alt="Code2Create"
          className="mb-3.5 w-11 drop-shadow-[0_0_20px_var(--logo-glow)] lg:mb-[18px] lg:w-[52px]"
        />
        <h1 className="mb-8 flex justify-center lg:mb-10">
          <img
            src="/assets/wordmark.svg"
            alt="Code2Create"
            className="h-9 w-auto [filter:var(--wordmark-filter)] sm:h-12 lg:h-[68px]"
          />
        </h1>
        <div className="mb-7 flex w-full flex-col gap-3 sm:flex-row sm:justify-center sm:gap-4">
          <ClassCard
            title="VIT student"
            detail="only @vitstudent.ac.in Google accounts are accepted"
            disabled={false}
            selected={participantClass === "vit"}
            onSelect={() => {
              setParticipantClass("vit");
              setStep("closed");
            }}
          />
          <ClassCard
            title="external participant"
            detail="continue with Google or a non-VIT email address"
            disabled={false}
            selected={external}
            onSelect={() => setParticipantClass("external")}
          />
        </div>
        <div className="flex w-full max-w-[320px] flex-col items-center gap-3">
          <div className="flex min-h-[60px] w-full items-center justify-center">
            <PortalButton className="w-full" disabled={participantClass === null}>
              Continue with Google
            </PortalButton>
          </div>
          <div className="flex w-full items-center gap-3 text-[10.5px] font-semibold tracking-[.08em] text-fg/40">
            <span className="h-px flex-1 bg-petal-edge-soft" />
            or
            <span className="h-px flex-1 bg-petal-edge-soft" />
          </div>
          <div className="flex min-h-[100px] w-full flex-col items-stretch">
            {step === "closed" || !external ? (
              <PortalButton
                className="w-full"
                disabled={!external}
                onClick={() => setStep("email")}
              >
                Continue with email
              </PortalButton>
            ) : step === "email" ? (
              <EmailAddressStep
                email={email}
                onEmailChange={setEmail}
                onSend={() => {
                  setCode("");
                  setError(null);
                  setStep("code");
                }}
                onBack={() => setStep("closed")}
                busy={false}
                error={null}
              />
            ) : (
              <EmailCodeStep
                email={email}
                code={code}
                onCodeChange={(next) => {
                  setError(null);
                  setCode(next);
                }}
                onVerify={(entered) => {
                  setCode("");
                  if (entered === "000000") {
                    setShake((count) => count + 1);
                    setError("wrong code");
                    return;
                  }
                  setNote("signed in");
                }}
                onResend={() => {
                  setError(null);
                  setNote("fresh code sent");
                }}
                onChangeEmail={() => setStep("email")}
                busy={false}
                error={error}
                note={note}
                shakeKey={shake}
              />
            )}
          </div>
        </div>
        <PortalError message={null} reserve />
      </div>
    </PortalScene>
  );
}

// ---- dashboard · the live-event bento ----------------------------------------
// Night one of the build: a track playing, a short queue, tools half linked.

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const dashboardMusic: MusicTileModel = {
  eligible: true,
  suspended: false,
  window: {
    name: "Night build",
    endsAt: Date.now() + 5 * 60 * 60_000,
    requestsOpen: true,
    votingOpen: true,
    playbackPaused: false,
    requestsUsed: 1,
    requestsAllowed: 5,
    votesUsed: 2,
  },
  nowPlaying: {
    id: "r1",
    videoId: "cuAG7DBJ37s",
    title: "Lofi Hip Hop Radio - Study Chill Beats",
    artist: "Lofi music sk",
    durationSeconds: 351,
    state: "playing",
    voteCount: 6,
    hasVoted: true,
    canVote: true,
    isMine: false,
    playbackStartedAt: Date.now() - 97_000,
  },
  queue: [
    {
      id: "r2",
      videoId: "jfKfPfyJRdk",
      title: "lofi hip hop radio 📚 beats to relax/study to",
      artist: "Lofi Girl",
      durationSeconds: 420,
      state: "queued",
      voteCount: 4,
      hasVoted: true,
      canVote: true,
      isMine: true,
    },
    {
      id: "r3",
      videoId: "5qap5aO4i9A",
      title: "Midnight City",
      artist: "M83",
      durationSeconds: 243,
      state: "approved",
      voteCount: 3,
      hasVoted: false,
      canVote: true,
      isMine: false,
    },
    {
      id: "r4",
      videoId: "hTWKbfoikeg",
      title: "Smells Like Teen Spirit",
      artist: "Nirvana",
      durationSeconds: 301,
      state: "pending",
      voteCount: 1,
      hasVoted: false,
      canVote: true,
      isMine: false,
    },
    {
      id: "r5",
      videoId: null,
      title: "Nightcall",
      artist: "Kavinsky",
      durationSeconds: 258,
      state: "played",
      voteCount: 5,
      hasVoted: false,
      canVote: false,
      isMine: false,
    },
  ],
  search: async (query) => {
    await wait(400);
    return [
      {
        videoId: "ysz5S6PUM-U",
        title: `${query} — official audio`,
        channelTitle: "Some Artist",
        durationSeconds: 214,
        thumbnailUrl: "https://i.ytimg.com/vi/ysz5S6PUM-U/mqdefault.jpg",
      },
      {
        videoId: "kJQP7kiw5Fk",
        title: `${query} (live session)`,
        channelTitle: "Another Channel",
        durationSeconds: 305,
      },
    ];
  },
  request: async () => {
    await wait(500);
    return { created: true };
  },
  toggleVote: async () => {
    await wait(300);
  },
};

const dashboardIntegrations: IntegrationsTileModel = {
  available: true,
  github: {
    connected: true,
    detail: "1 repository",
    repositories: [
      {
        id: "github-repository-code2create",
        fullName: "ACM-VIT/Code2Create",
        url: "https://github.com/ACM-VIT/Code2Create",
      },
    ],
  },
  figma: { connected: false, detail: "Link your design files" },
  open: noop,
};

const dashboardIntegrationsEmpty: IntegrationsTileModel = {
  available: true,
  github: {
    connected: true,
    detail: "Link your repositories",
    repositories: [],
  },
  figma: { connected: false, detail: "Link your design files" },
  open: noop,
};

// Night one of the build, on the event clock (IST).
const eventTimezone = "Asia/Kolkata";
const eventClock = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 5, minute - 30);
const eventPhases = [
  { phaseKey: "introduction", displayName: "Introduction", startsAt: eventClock(9, 18), endsAt: eventClock(9, 19) },
  { phaseKey: "ideation", displayName: "Ideation", startsAt: eventClock(9, 19), endsAt: eventClock(9, 22) },
  { phaseKey: "build", displayName: "Build", startsAt: eventClock(9, 22), endsAt: eventClock(10, 20) },
  { phaseKey: "intermediate_update", displayName: "Midpoint update", startsAt: eventClock(10, 20), endsAt: eventClock(10, 21) },
  { phaseKey: "final_update", displayName: "Final update", startsAt: eventClock(10, 21), endsAt: eventClock(11, 18) },
] as const;

const dashboardEvent: EventTileModel = {
  phases: eventPhases.map((phase) => ({ key: phase.phaseKey, name: phase.displayName, startsAt: phase.startsAt, endsAt: phase.endsAt })),
  now: eventClock(10, 2),
  timezone: eventTimezone,
};

const dashboardUpdates: UpdatesTileModel = {
  available: true,
  timezone: eventTimezone,
  checkpoints: [
    { key: "ideation", name: "Ideation update", state: "submitted", opensAt: eventClock(9, 19), dueAt: eventClock(9, 22) },
    { key: "intermediate_update", name: "Midpoint update", state: "open", opensAt: eventClock(10, 2), dueAt: eventClock(10, 21) },
    { key: "final_update", name: "Final update", state: "upcoming", opensAt: eventClock(10, 21), dueAt: eventClock(11, 18) },
  ],
  write: noop,
};

const dashboardReview: ReviewTileModel = {
  round: "Midpoint review",
  state: "called",
  paused: false,
  upNext: false,
  panel: "Panel 3",
  rank: null,
  notice: null,
  estimate: null,
  now: eventClock(10, 20, 30),
  session: { status: "awaiting_presence", present: 3, total: 5 },
  showCode: {
    sessionId: "fixture-review-session",
    mint: async () => {
      await wait(500);
      return { payload: "c2c:review:paper-cranes:staged", manualCode: "7K2P-4Q9M-3X2A", expiresAt: Date.now() + 120_000, serverNow: Date.now() };
    },
  },
};

const dashboardHelp: HelpTileModel = {
  discordUrl: "https://discord.gg/code2create",
  support: { open: 1 },
};

const dashboardBenefits: BenefitsTileModel = {
  available: true,
  benefits: [
    { id: "b1", name: "Cloud credits", description: "USD 200 on the event account.", link: "https://example.com/credits", scope: "team", code: "C2C-CLOUD-4F7Q" },
    { id: "b2", name: "Design tool seat", link: "https://example.com/seat", scope: "person", code: "SEAT-91KD-22" },
  ],
};

const quietMusic: MusicTileModel = { ...dashboardMusic, nowPlaying: null, queue: [], window: null };
const reviewMusic: MusicTileModel = { ...dashboardMusic, nowPlaying: null, queue: dashboardMusic.queue.slice(0, 2) };
const queuedReview: ReviewTileModel = {
  ...dashboardReview,
  state: "queued",
  rank: 3,
  estimate: { earliestAt: eventClock(10, 20, 40), latestAt: eventClock(10, 20, 48), basis: "observed" },
  session: null,
  showCode: null,
};

const reviewVariants = {
  queued: queuedReview,
  next: { ...queuedReview, upNext: true, rank: 1, estimate: { earliestAt: eventClock(10, 20, 30), latestAt: eventClock(10, 20, 35), basis: "observed" } },
  arriving: dashboardReview,
  review: { ...dashboardReview, state: "in_review", session: { status: "active", present: 5, total: 5 }, showCode: null },
  paused: { ...queuedReview, paused: true, estimate: null },
  scoring: { ...dashboardReview, state: "in_review", session: { status: "scoring", present: 5, total: 5 }, showCode: null },
} satisfies Record<string, ReviewTileModel>;

function IntegrationsFixture({ connected }: { connected: boolean }) {
  return (
    <IntegrationsScene team={team} members={members} onSignOut={noop}>
      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <ToolSheet
          mark={<GitHubMark className="size-7" />}
          name="GitHub"
          meta={connected ? "2 repositories · 128 commits · 41 pushes · +2,340 −812" : "the code your team is shipping"}
          action={<PortalButton size="xs">Connect GitHub</PortalButton>}
        >
          {connected ? (
            <ul className="m-0 flex list-none flex-col divide-y divide-petal-line p-0">
              <li className="flex items-center justify-between gap-4 py-2.5">
                <span className="min-w-0 truncate text-[12.5px] text-fg/70">ACM-VIT · organization · all repositories</span>
                <RowAction className="text-rose-light!">Choose repositories</RowAction>
              </li>
            </ul>
          ) : null}
          <div className="flex flex-col gap-1">
            <SectionLabel aside={<>{connected ? 2 : 0} / 10</>}>team repositories</SectionLabel>
            {connected ? (
              <ItemList>
                <ItemRow
                  title="ACM-VIT/Code2Create"
                  href="https://github.com/ACM-VIT/Code2Create"
                  meta="main · 96 commits · topic set"
                  status="up to date"
                  actions={<><RowAction disabled>Up</RowAction><RowAction>Down</RowAction><RowAction>Refresh</RowAction><RowAction tone="danger">Archive</RowAction></>}
                />
                <ItemRow
                  title="ACM-VIT/landing-page"
                  href="https://github.com/ACM-VIT/landing-page"
                  meta="main / apps/landing · 32 commits · topic missing"
                  status="waiting to read"
                  notes={<RowNote>Add <code className="text-fg/75">code2create-7</code> in GitHub, then refresh here.</RowNote>}
                  actions={<><RowAction>Up</RowAction><RowAction disabled>Down</RowAction><RowAction>Refresh</RowAction><RowAction tone="danger">Archive</RowAction></>}
                />
              </ItemList>
            ) : (
              <p className="m-0 mt-2 text-[12.5px] text-fg/55">No repositories have been added.</p>
            )}
          </div>
        </ToolSheet>
        <ToolSheet mark={connected ? <a href="https://www.figma.com/design/Example/Project" aria-label="View Figma design" target="_blank" rel="noopener noreferrer"><FigmaMark className="size-6" /></a> : <FigmaMark className="size-6" />} name="Figma" meta="your team's design file">
          <PortalField label="Figma file link">
            {id => <PortalInput id={id} type="url" placeholder="https://www.figma.com/design/…" defaultValue={connected ? "https://www.figma.com/design/Example/Project" : ""} />}
          </PortalField>
          <ToolNotice>Give reviewers access to view the file.</ToolNotice>
          <PortalButton size="xs" className="self-start">Save link</PortalButton>
        </ToolSheet>
      </div>
    </IntegrationsScene>
  );
}

function DisplayFixture() {
  const [now, setNow] = useState(() => eventClock(10, 2));
  useEffect(() => {
    const timer = window.setInterval(() => setNow((value) => value + 1_000), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const started = eventClock(10, 2) - 148_000;
  return (
    <DisplayView
      event={{ timezone: eventTimezone, phases: dashboardEvent.phases }}
      display={{
        serverNow: now,
        music: {
          windowName: "Night build",
          playbackPaused: false,
          nowPlaying: {
            title: "Lofi Hip Hop Radio - Study Chill Beats",
            artist: "Lofi music sk",
            videoId: "jfKfPfyJRdk",
            durationSeconds: 351,
            playbackStartedAt: started,
          },
          upNext: ["Midnight City", "Smells Like Teen Spirit", "Nightcall"],
        },
        review: {
          roundName: "Review 2",
          startsAt: eventClock(1, 20),
          endsAt: eventClock(5, 0),
          panels: [
            { name: "Panel 1", inReview: ["SYNC TECH"], called: ["DAHI VADA"], upNext: ["CHERRY"] },
            { name: "Panel 2", inReview: [], called: ["HACKIFIER"], upNext: ["NEURAL NINJAS"] },
            { name: "Panel 3", inReview: [], called: [], upNext: ["LATENCY", "CODE-BLOODED"] },
          ],
        },
      }}
      now={now}
    />
  );
}

function MusicRoomFixture({ quiet = false }: { quiet?: boolean }) {
  const [model, setModel] = useState(() => (quiet ? quietMusic : dashboardMusic));
  const room = {
    ...model,
    loaded: true,
    queue: model.queue.map((request, index) => ({
      ...request,
      canReport: !request.isMine,
      hasReported: index === 2,
    })),
    search: async (query: string) => {
      await wait(400);
      return dashboardMusic.search(query);
    },
    request: async (video: string) => {
      await wait(500);
      const created = !model.queue.some((request) => request.videoId === video);
      return { created };
    },
    toggleVote: async (request: MusicRequestView) => {
      await wait(250);
      setModel((current) => ({
        ...current,
        queue: current.queue.map((candidate) =>
          candidate.id === request.id
            ? {
                ...candidate,
                hasVoted: !candidate.hasVoted,
                voteCount: candidate.voteCount + (candidate.hasVoted ? -1 : 1),
              }
            : candidate,
        ),
      }));
    },
    report: async () => {
      await wait(400);
    },
    confirmPendingRequest: null,
  };
  return <MusicRoom team={team} members={members} teamEditable onSignOut={noop} model={room} />;
}

type DashboardVariant = "build" | "quiet" | keyof typeof reviewVariants;

function DashboardFixture({ variant = "build" }: { variant?: DashboardVariant }) {
  // Build night and quiet mode have no review scheduled. Review fixtures use
  // the midpoint clock and the exact participant state for that moment.
  const review = variant === "build" || variant === "quiet" ? null : reviewVariants[variant];
  const now = review?.now ?? eventClock(10, 2);
  const [services, setServices] = useState<ServiceQueuesTileModel["services"]>([
    outingFixture({ waitingCount: variant === "quiet" ? 0 : 7, occupiedCount: variant === "quiet" ? 0 : 15 }),
  ]);
  const queues: ServiceQueuesTileModel = {
    available: true, pending: false,
    services,
    setServiceQueue: async (kind, joined) => {
      await wait(250);
      setServices((current) => current.map((service) => {
        if (service.kind !== kind) return service;
        if (joined) return service.occupiedCount < (service.capacity ?? 0)
          ? { ...service, status: "permitted", canRequest: false, permissionExpiresAt: Date.now() + 900_000, occupiedCount: service.occupiedCount + 1 }
          : { ...service, status: "waiting", canRequest: false, position: service.waitingCount + 1, waitingCount: service.waitingCount + 1 };
        return { ...service, status: "available", canRequest: true, position: null, waitingCount: Math.max(0, service.waitingCount - 1) };
      }));
    },
  };
  return (
    <DashboardScreen
      team={team}
      members={members}
      teamEditable
      onSignOut={noop}
      event={{ ...dashboardEvent, now }}
      music={variant === "build" ? dashboardMusic : review ? reviewMusic : quietMusic}
      integrations={variant === "quiet" ? dashboardIntegrationsEmpty : dashboardIntegrations}
      updates={variant === "quiet" ? { ...dashboardUpdates, checkpoints: dashboardUpdates.checkpoints.map((c) => ({ ...c, state: c.key === "ideation" ? "upcoming" : c.state })) } : dashboardUpdates}
      review={review}
      queues={queues}
      help={dashboardHelp}
      benefits={variant === "quiet" ? { available: true, benefits: [] } : dashboardBenefits}
    />
  );
}

const screens: Record<string, () => ReactNode> = Object.fromEntries([
  ["f0a", () => <EntryFixture />],
  ["f0b", () => <DetailsFixture key="idle" initialPhase="idle" />],
  ["f0bv", () => <DetailsFixture key="verified" initialPhase="verified" />],
  [
    "f0d",
    () => (
      <PortalScene tree="both" header={account}>
        <div className="flex w-full max-w-[640px] flex-col items-center text-center">
          <h1 className="mb-2 font-display font-light tracking-[-.01em] text-balance text-3xl lg:text-[40px]">
            Choose your participant type.
          </h1>
          <p className="mb-7 text-[12.5px] text-fg/50">
            signed in as <span className="text-fg/75">ananya.iyer2023@vitstudent.ac.in</span>
          </p>
          <div className="mb-6 flex w-full flex-col gap-3 sm:flex-row sm:justify-center sm:gap-4">
            <ClassCard
              title="VIT student"
              detail="only @vitstudent.ac.in Google accounts are accepted"
              disabled={false}
              selected={false}
              onSelect={noop}
            />
            <ClassCard
              title="external participant"
              detail="continue with Google or a non-VIT email address"
              disabled={false}
              selected={false}
              onSelect={noop}
            />
          </div>
        </div>
      </PortalScene>
    ),
  ],
  [
    "f0c",
    () => (
      <PortalScene tree="left" header={account}>
        <div className="flex w-full max-w-[660px] flex-col items-center text-center">
          <h1 className="mb-2 font-display font-light tracking-[-.01em] text-3xl lg:text-[42px]">
            Find your people.
          </h1>
          <p className="mb-8 text-[12.5px] text-fg/50"></p>
          <div className="flex w-full flex-col items-stretch gap-4 sm:flex-row sm:justify-center sm:gap-[18px]">
            <div className="flex w-full flex-col rounded-petal-sm glass-tile px-7 py-6 text-left sm:w-[300px]">
              <p className="mb-1.5 font-display font-light tracking-[-.01em] text-[21px] text-fg/85">
                Create a team
              </p>
              <p className="mb-4.5 flex-1 text-[12.5px] leading-relaxed text-fg/60">
                you become the lead
              </p>
              <div className="flex gap-2.5">
                <PortalInput
                  placeholder="Paper Cranes"
                  aria-label="Team name"
                  className="min-w-0 flex-1"
                />
                <PortalTickButton label="Create the team" disabled />
              </div>
            </div>
            <div className="flex w-full flex-col rounded-petal-sm glass-tile px-7 py-6 text-left sm:w-[300px]">
              <p className="mb-1.5 font-display font-light tracking-[-.01em] text-[21px] text-fg/85">
                Join a team
              </p>
              <p className="mb-4.5 flex-1 text-[12.5px] leading-relaxed text-fg/60">
                paste the code your lead shared
              </p>
              <div className="flex gap-2.5">
                <PortalInput
                  placeholder="C2C7ABC"
                  aria-label="Team code"
                  className="min-w-0 flex-1 font-mono font-semibold tracking-[.1em]"
                />
                <PortalTickButton label="Join the team" disabled />
              </div>
            </div>
          </div>
          <PortalError message={null} reserve />
          <p className="mt-7 inline-flex items-center gap-1 rounded-full bg-wash/45 px-3.5 py-1.5 text-[12.5px] text-fg/80 backdrop-blur-[6px]">
            can't find a team? join our{" "}
            <a
              href="https://discord.gg/hPkhtMcHq8"
              target="_blank"
              rel="noreferrer"
              className="text-rose-light underline decoration-rose-light/70 decoration-1 underline-offset-2 transition-colors hover:decoration-rose-light"
            >
              Discord
            </a>
          </p>
        </div>
      </PortalScene>
    ),
  ],
  [
    "f0e",
    () => (
      <ImportedTeamChoiceView
        header={account}
        importedTeam={{
          id: "imported-team-assignment",
          version: 2,
          teamName: "Byte Bloom",
          role: "member",
          status: "pending",
          assignees: [
            {
              displayName: "Rohan Mehta",
              role: "lead",
              signedIn: true,
              accepted: false,
              isYou: false,
            },
            {
              displayName: "Ananya Iyer",
              role: "member",
              signedIn: true,
              accepted: false,
              isYou: true,
            },
            {
              displayName: "Sara Thomas",
              role: "member",
              signedIn: false,
              accepted: false,
              isYou: false,
            },
            {
              displayName: "Dev Patel",
              role: "member",
              signedIn: true,
              accepted: true,
              isYou: false,
            },
            {
              displayName: "Nikhil Rao",
              role: "member",
              signedIn: false,
              accepted: false,
              isYou: false,
            },
          ],
        }}
        joining={false}
        keeping={false}
        error={null}
        onJoin={noop}
        onKeep={noop}
      />
    ),
  ],
  [
    "f1b",
    () => (
      <PortalScene tree="left" backdrop={<GpuSky />} onSignOut={noop} header={cluster}>
        <div className="flex w-full max-w-[1048px] flex-1 flex-col items-end justify-center pb-56 sm:pb-40">
          <div className="flex max-w-[680px] flex-col items-end text-right">
            <h1 className="mb-8 font-display font-light tracking-[-.01em] text-balance text-5xl leading-none lg:text-7xl">
              Start with the idea.
            </h1>
            <PortalButton>Write it</PortalButton>
            <div className="mt-9 flex flex-col items-end gap-2.5">
              <p className="m-0 text-[12.5px] text-fg/55">
                Just you so far · 3 seats open ·{" "}
                <span className="text-rose-light">manage team</span>
              </p>
              <JoinCodeBar code="C2C-PCRN" />
            </div>
          </div>
        </div>
        <div className="absolute inset-x-5 bottom-8 z-[3] flex flex-col gap-3 sm:flex-row sm:gap-[18px] lg:inset-x-24 lg:bottom-14">
          <div className="flex-1 rounded-petal-sm glass-tile px-5 py-4">
            <p className="mb-[5px] text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
              deadline
            </p>
            <p className="m-0 font-display font-light tracking-[-.01em] text-[26px] text-rose-light">
              12 <span className="text-sm">days</span>
            </p>
          </div>
          <div className="hidden flex-1 rounded-petal-sm glass-tile px-5 py-4 sm:block">
            <p className="mb-2 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
              journey · 1 of 5
            </p>
            <div className="flex items-start pt-1">
              {(["idea", "q1", "q2", "review", "submit"] as const).map((label, index) => (
                <div
                  key={label}
                  className="flex flex-1 flex-col items-center first:flex-none first:items-start last:flex-none last:items-end"
                >
                  <div className="flex w-full items-center">
                    {index > 0 ? <span aria-hidden className="h-px flex-1 bg-rose/25" /> : null}
                    <Petal size={15} state={index === 0 ? "current" : "todo"} />
                    {index < 4 ? <span aria-hidden className="h-px flex-1 bg-rose/25" /> : null}
                  </div>
                  <span
                    className={`mt-1 text-[9.5px] leading-none ${index === 0 ? "font-semibold text-rose-light" : "text-fg/35"}`}
                  >
                    {label}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex-[1.4] rounded-petal-sm glass-tile px-5 py-4">
            <p className="mb-[5px] text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
              editable until
            </p>
            <p className="m-0 font-ui text-[14.5px] text-fg">Thu, Sep 25, 6:00 PM</p>
          </div>
        </div>
      </PortalScene>
    ),
  ],
  ["dashboard", () => <DashboardFixture variant="build" />],
  ["dashboardQueued", () => <DashboardFixture variant="queued" />],
  ["dashboardNext", () => <DashboardFixture variant="next" />],
  ["dashboardArriving", () => <DashboardFixture variant="arriving" />],
  ["dashboardReview", () => <DashboardFixture variant="review" />],
  ["dashboardPaused", () => <DashboardFixture variant="paused" />],
  ["dashboardScoring", () => <DashboardFixture variant="scoring" />],
  ["dashboardQuiet", () => <DashboardFixture variant="quiet" />],
  ["music", () => <MusicRoomFixture key="playing" />],
  ["musicQuiet", () => <MusicRoomFixture key="quiet" quiet />],
  ["showcase", () => <ShowcaseScreen team={team} members={members} teamEditable onSignOut={noop} projects={showcaseSamples} />],
  ["showcaseEmpty", () => <ShowcaseScreen team={team} members={members} teamEditable onSignOut={noop} projects={[]} />],
  ["photos", () => <PhotoGalleryFixture />],
  ["photosUpload", () => <PhotoGalleryFixture canUpload />],
  ["photosEmpty", () => <PhotoGalleryFixture empty />],
  ["integrations", () => <IntegrationsFixture key="linked" connected />],
  ["integrationsEmpty", () => <IntegrationsFixture key="empty" connected={false} />],
  ["chill", () => <><DashboardFixture variant="build" /><ChillMode active /></>],
  ["display", () => <DisplayFixture />],
  [
    "f2",
    () => (
      <PortalScene tree="left" onSignOut={noop} header={cluster}>
        <div className="flex w-full max-w-[820px] flex-col items-center lg:mb-[8vh]">
          <h1 className="mb-6 max-w-[760px] text-center font-display font-light tracking-[-.01em] text-[26px] leading-tight lg:text-[42px]">
            What do you want to build?
          </h1>
          <IdeaCard
            footer={
              <>
                <NoveltyPill
                  state={{ status: "ready", signal: { score: 87, band: "distinct" } }}
                  currentLength={420}
                  minimumLength={80}
                />
                <div className="ml-auto flex items-center gap-4.5">
                  <span className="hidden text-xs text-fg/45 sm:inline">
                    saved · editable until Sep 25
                  </span>
                  <PortalButton size="sm">Next</PortalButton>
                </div>
              </>
            }
          >
            <PortalTextarea
              rows={7}
              maxLength={300}
              defaultValue="A campus lost-and-found where finders post a photo and owners describe what they lost. On-device image matching pairs the two; pickup at verified hostel desks."
              className="bare-field min-h-[180px] border-0 bg-transparent px-0 py-0 text-[17px] leading-[1.7]"
            />
            <div className="mt-1 flex items-center justify-between gap-4">
              <IdeaPromptsLink />
              <span className="font-mono text-[11px] tracking-[.04em] text-fg/45">
                159 / 300
              </span>
            </div>
          </IdeaCard>
        </div>
      </PortalScene>
    ),
  ],
  [
    "f3",
    () => (
      <PortalScene tree="left" onSignOut={noop} header={cluster}>
        <div className="flex w-full max-w-[820px] flex-col items-center lg:mb-[8vh]">
          <h1 className="mb-6 max-w-[760px] text-center font-display font-light tracking-[-.01em] text-[26px] leading-tight lg:text-[38px]">
            Who will use Foundling on day one?
          </h1>
          <div className="flex w-full flex-col">
            <StackedSheet
              depth={2}
              aria-label="Edit your idea"
              label={
                <>
                  your idea{" "}
                  <span className="text-fg/60">
                    · A campus lost-and-found where finders post a photo and owners describe what
                    they lost.
                  </span>
                </>
              }
            />
            <StackedSheet depth={1} aria-expanded label="How will your solution work in practice?">
              <span className="mt-1 line-clamp-4 text-[13px] leading-relaxed whitespace-pre-line wrap-anywhere text-fg/85">
                Finders post a photo and a rough location from their phone. Owners describe what they
                lost in their own words, and a small matcher compares the two lists every few minutes,
                weighting location and time far above wording. Likely matches are surfaced to both
                sides, and a pickup is only marked done once the owner scans the finder’s handover
                code at a security desk. The desk keeps a log of every handover so disputes can be
                settled later, and unclaimed items age out after two weeks.
              </span>
              <span className="mt-1.5 block text-[11px] text-fg/55">
                rewritable at review, after the last question
              </span>
            </StackedSheet>
            <IdeaCard
              footer={
                <>
                  <span className="font-mono text-[11px] tracking-[.04em] text-fg/45">
                    148 / 600
                  </span>
                  <PortalButton size="sm">Next</PortalButton>
                </>
              }
            >
              <p className="m-0 mb-3 text-[13px] leading-relaxed text-fg/70">
                Who will use Foundling on day one?
              </p>
              <PortalTextarea
                rows={6}
                defaultValue="Hostellers first · most losses happen in messes and reading halls. Security desks join in week two once verified pickup is proven."
                className="bare-field min-h-[174px] border-0 bg-transparent px-0 py-0 text-[16.5px] leading-[1.7]"
              />
            </IdeaCard>
          </div>
        </div>
      </PortalScene>
    ),
  ],
  [
    "f4",
    () => (
      <PortalScene tree="left" onSignOut={noop} header={cluster}>
        <div className="flex w-full max-w-[820px] flex-col items-center lg:mb-[8vh]">
          <h1 className="mb-6 max-w-[760px] text-center font-display font-light tracking-[-.01em] text-[26px] leading-tight lg:text-[38px]">
            What will you build during the 48 hours?
          </h1>
          <div className="flex w-full flex-col">
            <StackedSheet
              depth={3}
              aria-label="Edit your idea"
              label={
                <>
                  your idea{" "}
                  <span className="text-fg/60">
                    · A campus lost-and-found where finders post a photo and owners describe what
                    they lost.
                  </span>
                </>
              }
            />
            <StackedSheet
              depth={2}
              aria-expanded={false}
              label="Who will use Foundling on day one?"
            />
            <StackedSheet
              depth={1}
              aria-expanded={false}
              label="Which hostels does the pilot start in?"
            />
            <IdeaCard
              footer={
                <>
                  <span className="text-xs text-fg/45">a sentence or two is plenty</span>
                  <PortalButton size="sm" disabled>
                    Review
                  </PortalButton>
                </>
              }
            >
              <PortalTextarea
                rows={6}
                placeholder="Scope the demo: which parts are live, which are mocked, what a reviewer can touch…"
                className="bare-field min-h-[174px] border-0 bg-transparent px-0 py-0 text-[16.5px] leading-[1.7]"
              />
            </IdeaCard>
          </div>
        </div>
      </PortalScene>
    ),
  ],
  [
    "f5",
    () => (
      <PortalScene tree="left" onSignOut={noop} header={cluster}>
        <div className="flex w-full max-w-[760px] flex-col items-center">
          <h1 className="mb-7 text-center font-display font-light tracking-[-.01em] text-3xl lg:text-[44px]">
            Paper Cranes
          </h1>
          <PetalCard className="px-6 py-2 sm:px-8">
            <NoveltyReviewRow
              state={{ status: "ready", signal: { score: 87, band: "distinct" } }}
            />
            <AccordionRoot allowMultiple defaultValue={["idea", "q1", "q2"]}>
              {(
                [
                  {
                    id: "idea",
                    label: "The idea",
                    body: "A campus lost-and-found where finders post a photo and owners describe what they lost. On-device image matching pairs the two; pickup at verified hostel desks.",
                  },
                  {
                    id: "q1",
                    label: "who will use Foundling on day one?",
                    body: "Hostellers first · most losses happen in messes and reading halls.",
                  },
                  {
                    id: "q2",
                    label: "what will you build during the 48 hours?",
                    body: "Live photo-match pipeline and posting flow; desk verification mocked.",
                  },
                ] as const
              ).map(({ id, label, body }) => (
                <AccordionItem key={id} value={id}>
                  <AccordionItemTrigger>
                    <AccordionItemHeader>
                      <span className="text-[15px] font-semibold text-fg/85">{label}</span>
                    </AccordionItemHeader>
                  </AccordionItemTrigger>
                  <AccordionItemContent className="text-[15px] leading-relaxed wrap-anywhere text-fg">
                    <p className="whitespace-pre-line">{body}</p>
                    <div className="mt-3 flex justify-end">
                      <button className="text-[12.5px] text-rose-light underline-offset-4 hover:underline">
                        edit
                      </button>
                    </div>
                  </AccordionItemContent>
                </AccordionItem>
              ))}
            </AccordionRoot>
          </PetalCard>
          <div className="mt-8 flex justify-center">
            <PortalButton>Continue to submit</PortalButton>
          </div>
        </div>
      </PortalScene>
    ),
  ],
  [
    "f6",
    () => (
      <PortalScene tree="left" branch onSignOut={noop} header={cluster}>
        <div className="flex w-full max-w-[600px] flex-col items-center lg:mb-[8vh]">
          <h1 className="mb-6 text-center font-display font-light tracking-[-.01em] text-[26px] lg:text-[42px]">
            Ready to submit?
          </h1>
          <PetalCard className="px-8 pt-6 pb-4">
            <div className="flex items-baseline justify-between gap-4">
              <FadeText as="p" className="m-0 min-w-0 text-left text-[15.5px] font-semibold">
                Paper Cranes{" "}
                <span className="font-normal text-fg/55">· idea + 2 answers · novelty 87/100</span>
              </FadeText>
              <button
                type="button"
                className="flex-none text-xs text-fg/55 transition-colors hover:text-rose-light"
              >
                review idea
              </button>
            </div>
            <div className="mt-4 flex gap-2 border-t border-petal-line pt-4">
              {members.map((member) => {
                const lead = member.role === "lead";
                return (
                  <div key={member.membershipId} className="flex-1 text-center">
                    <div
                      className={`mx-auto flex size-[52px] items-center justify-center rounded-full ${lead ? "border-2 border-ring-lead bg-avatar-lead shadow-[0_0_16px_var(--avatar-glow)]" : "border-[1.5px] border-rose/70 bg-avatar"}`}
                    >
                      <Flower seed={member.membershipId} lead={lead} size={26} />
                    </div>
                    <p className="mt-[7px] mb-px truncate text-xs font-semibold">
                      {member.displayName.split(" ")[0]}
                    </p>
                    <p className={`m-0 text-[10px] ${lead ? "text-rose-light" : "text-fg/50"}`}>
                      {lead ? "lead · you" : "ready"}
                    </p>
                  </div>
                );
              })}
            </div>
            <div className="mt-7">
              <PortalCheckRow checked onChange={noop}>
                We adhere to the Code2Create rules.
              </PortalCheckRow>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-petal-line pt-3.5">
              <PortalTextButton>back</PortalTextButton>
              <PortalButton size="sm" variant="solid">
                Submit
              </PortalButton>
            </div>
          </PetalCard>
        </div>
      </PortalScene>
    ),
  ],
  ["f6b", () => <BloomFixture />],
  [
    "f7",
    () => (
      <PortalScene
        tree="left"
        header={<TeamCluster team={team} members={members} editable canManage />}
      >
        <div className="flex w-full max-w-[760px] flex-col items-center text-center">
          <h1 className="mb-3.5 font-display font-light tracking-[-.01em] text-5xl leading-none lg:text-[70px]">
            Submitted.
          </h1>
          <p className="mb-8 font-ui font-normal text-base text-rose-light lg:text-[19px]">
            Paper Cranes is in the review queue
          </p>
          <PortalButton>Edit submission</PortalButton>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-[13px] text-fg/65">
            <span>
              status <span className="text-fg">application received</span>
            </span>
            <span aria-hidden className="hidden h-3.5 w-px bg-rose/40 sm:block" />
            <span>
              team <span className="text-rose-light">manage team</span>
            </span>
            <span aria-hidden className="hidden h-3.5 w-px bg-rose/40 sm:block" />
            <span>
              editable until <span className="text-fg">25 Sep, 6:00 pm</span>
            </span>
          </div>
        </div>
      </PortalScene>
    ),
  ],
  [
    "gate",
    () => (
      <PortalScene tree="both" logo="none">
        <a
          href="https://acmvit.in"
          className="absolute top-7 left-6 z-[6] opacity-85 lg:top-9 lg:left-11"
        >
          <img
            src="/assets/acm-mark.svg"
            alt="ACM-VIT"
            className="size-8 [filter:var(--mark-filter)] lg:size-9"
          />
        </a>
        <div className="flex w-full max-w-[640px] flex-col items-center text-center">
          <img
            src="/assets/logo.svg"
            alt=""
            className="mb-3.5 w-11 drop-shadow-[0_0_20px_var(--logo-glow)] lg:mb-[18px] lg:w-[52px]"
          />
          <h1 className="mb-8 flex justify-center lg:mb-10">
            <img
              src="/assets/wordmark.svg"
              alt="Code2Create"
              className="h-9 w-auto [filter:var(--wordmark-filter)] sm:h-12 lg:h-[68px]"
            />
          </h1>
          <p className="mb-2 font-display font-light tracking-[-.01em] text-[26px] text-rose-light lg:text-[32px]">
            it’s cooking.
          </p>
          <p className="text-[13px] text-fg/50">come back in a little while</p>
        </div>
      </PortalScene>
    ),
  ],
  [
    "loading",
    () => (
      <PortalScene tree="both">
        <TreeLoader label="Loading your portal…" />
      </PortalScene>
    ),
  ],
  [
    "notice",
    () => (
      <PortalScene tree="right" header={account}>
        <div className="w-full max-w-[560px]">
          <PetalCard className="px-8 py-7">
            <h1 className="mb-3 font-display font-light tracking-[-.01em] text-2xl lg:text-3xl">
              Team access is unavailable.
            </h1>
            <p className="text-[13px] leading-relaxed text-fg/60">
              You are still on your team. You cannot create or join another team until an organizer
              restores access.
            </p>
          </PetalCard>
        </div>
      </PortalScene>
    ),
  ],
  [
    "f1",
    () => (
      <PortalScene tree="left" backdrop={<GpuSky />} onSignOut={noop} header={cluster}>
        <div className="flex w-full max-w-[1048px] flex-1 flex-col items-start justify-center pb-40 sm:items-end">
          <div className="flex max-w-[680px] flex-col items-start text-left sm:items-end sm:text-right">
            <h1 className="mb-8 font-display font-light tracking-[-.01em] text-balance text-5xl leading-none lg:text-7xl">
              One answer left.
            </h1>
            <PortalButton>Answer it</PortalButton>
          </div>
        </div>
        <div className="absolute inset-x-5 bottom-8 z-[3] flex flex-col gap-3 sm:flex-row sm:gap-[18px] lg:inset-x-24 lg:bottom-14">
          <div className="flex-1 rounded-petal-sm glass-tile px-5 py-4">
            <p className="mb-[5px] text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
              deadline
            </p>
            <p className="m-0 font-display font-light tracking-[-.01em] text-[26px] text-rose-light">
              5 <span className="text-sm">days</span>
            </p>
          </div>
          <div className="flex-1 rounded-petal-sm glass-tile px-5 py-4">
            <p className="mb-2 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
              journey · 3 of 5
            </p>
            <div className="flex items-start pt-1">
              {(["idea", "q1", "q2", "review", "submit"] as const).map((label, index) => {
                const state = index < 2 ? "done" : index === 2 ? "current" : "todo";
                return (
                  <div
                    key={label}
                    className="flex flex-1 flex-col items-center first:flex-none first:items-start last:flex-none last:items-end"
                  >
                    <div className="flex w-full items-center">
                      {index > 0 ? (
                        <span
                          aria-hidden
                          className={`h-px flex-1 ${index <= 2 ? "bg-rose/60" : "bg-rose/25"}`}
                        />
                      ) : null}
                      <Petal size={15} state={state} />
                      {index < 4 ? (
                        <span
                          aria-hidden
                          className={`h-px flex-1 ${index < 2 ? "bg-rose/60" : "bg-rose/25"}`}
                        />
                      ) : null}
                    </div>
                    <span
                      className={`mt-1 text-[9.5px] leading-none ${state === "current" ? "font-semibold text-rose-light" : state === "done" ? "text-fg/60" : "text-fg/35"}`}
                    >
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex-[1.4] rounded-petal-sm glass-tile px-5 py-4">
            <p className="mb-[5px] text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
              editable until
            </p>
            <p className="m-0 font-ui text-[14.5px] text-fg">Thu, Sep 25, 6:00 PM</p>
          </div>
        </div>
      </PortalScene>
    ),
  ],
  [
    "fs",
    () => (
      <SglangInterlude
        state={{ connected: false, completed: false }}
        callback={false}
        header={account}
      />
    ),
  ],
  [
    "fsb",
    () => (
      <SglangInterlude
        state={{ connected: true, completed: false, githubLogin: "freshman-builder" }}
        callback={false}
        header={account}
      />
    ),
  ],
  ["fsc", () => <StarredFixture />],
  [
    "f7b",
    () => (
      <PortalScene tree="left" onSignOut={noop} header={cluster}>
        <div className="flex w-full max-w-[840px] flex-col items-center">
          <h1 className="mb-2 text-center font-display font-light tracking-[-.01em] text-3xl lg:text-[44px]">
            Paper Cranes
          </h1>
          <p className="mb-7 text-xs text-fg/50">
            editable until Aug 31, 4:00 PM · <span className="text-rose-light">back</span>
          </p>
          <div className="w-full text-left">
            <PetalCard className="px-6 py-2 sm:px-8">
              <AccordionRoot allowMultiple defaultValue={["idea"]}>
                {[
                  {
                    id: "idea",
                    title: "The idea",
                    body: "A campus lost-and-found where finders post a photo and owners describe what they lost. On-device image matching pairs the two; pickup at verified hostel desks.",
                  },
                  {
                    id: "q1",
                    title: "Who will use Foundling on day one?",
                    body: "Hostellers first · most losses happen in messes and reading halls. Security desks join in week two once verified pickup is proven.",
                  },
                  {
                    id: "q2",
                    title: "What will you build during the 48 hours?",
                    body: "The finder flow, the matcher, and one hostel desk pickup screen.",
                  },
                  {
                    id: "extra",
                    title:
                      "Any additional information or links you want to share (please, no PPTs)",
                    body: "Nothing added.",
                  },
                ].map(({ id, title, body }) => (
                  <AccordionItem key={id} value={id}>
                    <AccordionItemTrigger>
                      <AccordionItemHeader>
                        <span className="text-[15px] font-semibold text-fg/85">{title}</span>
                      </AccordionItemHeader>
                    </AccordionItemTrigger>
                    <AccordionItemContent className="text-[15px] leading-relaxed wrap-anywhere text-fg">
                      <p className={id === "extra" ? "text-fg/45" : "whitespace-pre-line"}>
                        {body}
                      </p>
                      <ReviewEditRow busy={false} onEdit={noop} />
                    </AccordionItemContent>
                  </AccordionItem>
                ))}
              </AccordionRoot>
            </PetalCard>
          </div>
        </div>
      </PortalScene>
    ),
  ],
  [
    "f8",
    () => (
      <PortalScene
        tree="left"
        header={
          <p className="m-0 font-ui text-[13.5px] text-rose-light">Paper Cranes · view team</p>
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
          <p className="mb-2.5 font-ui text-xl text-rose-light">Selected for Code2Create 7.0</p>
          <h1 className="mb-[42px] font-display font-light tracking-[-.01em] text-6xl leading-[.96] text-shadow-[0_0_60px_var(--glow-rose-soft)] lg:text-[92px]">
            You’re in.
          </h1>
          <PetalCard className="flex">
            <div className="grid flex-1 grid-cols-3 px-7 py-[22px]">
              <div className="border-r border-rose/35 pr-5">
                <p className="mb-1 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
                  venue
                </p>
                <p className="m-0 font-display font-light tracking-[-.01em] text-[16.5px] leading-[1.3]">
                  Anna Auditorium, VIT Vellore
                </p>
              </div>
              <div className="border-r border-rose/35 px-5">
                <p className="mb-1 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">when</p>
                <p className="m-0 font-display font-light tracking-[-.01em] text-[16.5px] leading-[1.3]">
                  Oct 9, 6 PM – Oct 11, 6 PM
                </p>
              </div>
              <div className="pl-5">
                <p className="mb-1 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
                  confirm by
                </p>
                <p className="m-0 font-display font-light tracking-[-.01em] text-[16.5px] leading-[1.3] text-rose-light">
                  Thu, Oct 2
                </p>
              </div>
            </div>
            <div className="flex w-[140px] flex-none flex-col items-center justify-center gap-[7px] border-l-2 border-dashed border-rose/55">
              <div className="flex size-12 -rotate-4 items-center justify-center rounded-[10px] bg-rose text-[15px] font-bold text-wash shadow-[0_8px_20px_var(--shade-1)]">
                C2C
              </div>
              <p className="m-0 text-[11px] text-fg/60">admits four</p>
            </div>
          </PetalCard>
          <div className="mt-[42px] flex flex-col items-center gap-3.5">
            <PortalButton>Confirm your spot</PortalButton>
            <span className="text-[13.5px] text-rose-light">join the Discord</span>
          </div>
        </div>
      </PortalScene>
    ),
  ],
  [
    "f10",
    () => (
      <PortalScene
        tree="right"
        header={<p className="m-0 font-ui text-[13.5px] text-rose-light/80">4 of 4 seats</p>}
      >
        <div className="flex w-full max-w-[860px] flex-col items-center text-center">
          <h1 className="mb-11 font-display font-light tracking-[-.01em] text-4xl lg:text-[54px]">
            Paper Cranes
          </h1>
          <div className="mb-10 flex flex-wrap items-start justify-center gap-[34px]">
            {members.map((member) => {
              const lead = member.role === "lead";
              return (
                <div key={member.teamMemberId} className="w-[120px]">
                  <div
                    className={`relative mx-auto flex size-[88px] items-center justify-center rounded-full text-2xl font-semibold ${lead ? "border-[2.5px] border-ring-lead bg-avatar-lead shadow-[0_0_26px_var(--avatar-glow)]" : "border-2 border-rose/70 bg-avatar"}`}
                  >
                    <Flower seed={member.membershipId} lead={lead} size={38} />
                    {lead ? (
                      <span className="absolute -top-1.5 -right-1">
                        <Petal size={20} />
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-3 mb-0.5 text-sm font-semibold">
                    {member.displayName.split(" ")[0]}
                  </p>
                  <p className={`m-0 text-[11.5px] ${lead ? "text-rose-light" : "text-fg/50"}`}>
                    {lead ? "lead · you" : "ready"}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3 rounded-petal-sm glass-tile glass-active px-5 py-3 lg:gap-3.5 lg:px-6">
            <span className="whitespace-nowrap font-mono text-[17px] tracking-[.14em] text-rose-light lg:text-[19px]">
              C2C-PCRN
            </span>
            <span aria-hidden className="h-[18px] w-px bg-rose/40" />
            <span className="text-[13px]">copy</span>
            <span className="whitespace-nowrap text-[13px]">share link</span>
          </div>
          <div className="mt-7 flex flex-wrap items-baseline justify-center gap-x-3.5 gap-y-1 text-[13.5px] text-fg/45">
            <span className="text-fg/65">edit team name</span>
            <span aria-hidden className="text-fg/30">
              ·
            </span>
            <span className="text-fg/65">change leader</span>
            <span aria-hidden className="text-fg/30">
              ·
            </span>
            <span className="text-fg/65">remove a member</span>
            <span aria-hidden className="text-fg/30">
              ·
            </span>
            <span className="text-fg/65">leave team</span>
            <span aria-hidden className="text-fg/30">
              ·
            </span>
            <span>changes close Aug 31, 4:00 PM</span>
            <span aria-hidden className="text-fg/30">
              ·
            </span>
            <span className="text-rose-light">back home</span>
          </div>
        </div>
      </PortalScene>
    ),
  ],
  ["f10c", () => <RenameTeamFixture />],
  [
    "f10b",
    () => (
      <PortalScene
        tree="right"
        header={<p className="m-0 font-ui text-[13.5px] text-rose-light/80">4 of 4 seats</p>}
      >
        <div className="flex w-full max-w-[860px] flex-col items-center text-center">
          <h1 className="mb-11 font-display font-light tracking-[-.01em] text-4xl lg:text-[54px]">
            Paper Cranes
          </h1>
          <div className="mb-10 flex flex-wrap items-start justify-center gap-[34px]">
            {members.map((member, index) => {
              const lead = member.role === "lead";
              const target = index >= 2;
              return (
                <div
                  key={member.teamMemberId}
                  className={`w-[120px] ${target ? "" : "opacity-40 saturate-[.65]"}`}
                >
                  <div
                    className={`group relative mx-auto flex size-[88px] items-center justify-center rounded-full text-2xl font-semibold ${lead ? "border-[2.5px] border-ring-lead bg-avatar-lead shadow-[0_0_26px_var(--avatar-glow)]" : "border-2 border-rose/70 bg-avatar"} ${target ? "cursor-pointer transition-all duration-250 hover:-translate-y-1 hover:border-rose-light" : ""}`}
                  >
                    <Flower seed={member.membershipId} lead={lead} size={38} />
                    {lead ? (
                      <span className="absolute -top-1.5 -right-1">
                        <Petal size={20} />
                      </span>
                    ) : null}
                    {target ? (
                      <span className="absolute -top-1 -right-1 flex size-[22px] items-center justify-center rounded-full border border-rose/70 bg-wash text-rose-light shadow-[0_4px_12px_var(--shade-1)] transition-all duration-250 group-hover:border-rose-light group-hover:bg-rose group-hover:text-wash">
                        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
                          <path
                            d="M1.5 1.5l7 7M8.5 1.5l-7 7"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                          />
                        </svg>
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-3 mb-0.5 text-sm font-semibold">
                    {member.displayName.split(" ")[0]}
                  </p>
                  <p
                    className={`m-0 text-[11.5px] ${lead || index === 1 ? "text-rose-light" : "text-fg/50"}`}
                  >
                    {lead ? "lead" : index === 1 ? "you" : "ready"}
                  </p>
                </div>
              );
            })}
          </div>
          <ConfirmCard
            question="Remove Sara from the team?"
            detail="Their access ends and the join code changes."
            primaryLabel="Remove them"
            onPrimary={() => {}}
            secondaryLabel="back"
            onSecondary={() => {}}
            busy={false}
          />
        </div>
      </PortalScene>
    ),
  ],
  [
    "f12",
    () => (
      <PortalScene tree="left" onSignOut={noop} header={cluster}>
        <div className="flex w-full max-w-[480px] flex-col items-center">
          <h1 className="mb-7 font-display font-light tracking-[-.01em] text-3xl lg:text-[40px]">
            More
          </h1>
          <PetalCard className="w-full px-6 py-2">
            <div className="flex items-center gap-4 border-b border-petal-line py-4">
              <span className="flex size-11 flex-none items-center justify-center rounded-full border-2 border-rose/70 bg-avatar">
                <Flower seed="m1" className="size-[62%]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="m-0 text-[15px] text-fg">Ananya Iyer</p>
                <p className="m-0 mt-0.5 text-[12px] leading-snug wrap-anywhere text-fg/55">
                  ananya@vitstudent.ac.in
                </p>
                <p className="m-0 mt-0.5 text-[11.5px] text-rose-light/80">
                  VIT student · 23BCE1847
                </p>
              </div>
              <span className="flex-none text-[12.5px] text-rose-light">Edit profile</span>
            </div>
            {(
              [
                ["Notifications", "Email · delivered"],
                ["Integrations", "Repos and Figma"],
                ["Discord", "joined"],
                ["Support", "Help desk"],
                ["Privacy", "Notice"],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="flex items-center justify-between gap-4 border-b border-petal-line py-3.5 last:border-b-0"
              >
                <span className="text-[14px] text-fg/90">{label}</span>
                <span className="text-[12px] text-fg/50">{value}</span>
              </div>
            ))}
          </PetalCard>
          <p className="mt-5 text-[11.5px] text-fg/45">
            <span className="text-rose-light">back home</span>
          </p>
        </div>
      </PortalScene>
    ),
  ],
  ["f13", () => <HelpThreadFixture />],
  ["f13b", () => <HelpEmptyFixture />],
  // The board on its own, with no round recorded: the arcade screen around it
  // needs the leaderboard query, and the gallery is meant to run offline.
  [
    "arcade",
    () => (
      <div className="flex min-h-dvh flex-1 bg-black p-4"><div className="m-auto flex w-full justify-center">
        <PacmanBoard onRoundEnd={noop} />
      </div></div>
    ),
  ],
  [
    "arcade-stack",
    () => (
      <div className="flex min-h-dvh flex-1 bg-black p-4"><div className="m-auto flex w-full justify-center">
        <StackBoard onRoundStart={noop} onRoundEnd={noop} />
      </div></div>
    ),
  ],
  // The arcade, full of standings. The live screen reads these from the backend;
  // the names here are invented and reach nothing.
  ["arcade-screen", () => <ArcadeFixture />],
  // One screen with the mode switch on it, the way the arcade shows it.
  ["arcade-memory", () => <MemoryFixture />],
] as const);

/** The memory board with its own mode switch, as the arcade wires it. */
function MemoryFixture() {
  // The modes come from the catalogue, so the fixture opens on whichever one the
  // arcade opens on rather than a copy that can drift from it.
  const memory = gameCatalogue.find((game) => game.key === "memory");
  const modes = memory?.modes ?? [];
  const [mode, setMode] = useState(modes[0]?.key ?? "memory");
  return (
    <div className="flex min-h-dvh flex-1 bg-black p-4"><div className="m-auto flex w-full justify-center">
      <MemoryBoard
        key={mode}
        mode={mode}
        modes={modes}
        onModeChange={setMode}
        onRoundStart={noop}
        onRoundEnd={noop}
      />
    </div></div>
  );
}

/**
 * The arcade with standings behind it, so the screen can be read without a
 * backend or a played round. The names are invented; nothing here reaches the
 * database, and the live screen carries none of it.
 */
// oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Convex ids are branded strings minted by the database; the gallery has none, so its invented rows need one made up.
const asPersonId = (value: string) => value as unknown as BoardView["entries"][number]["personId"];

const sampleBoards: Record<string, BoardView> = {
  pacman: {
    entries: [
      { personId: asPersonId("p1"), displayName: "Ananya Iyer", bestScore: 18_240, playedAt: 0, isYou: false },
      { personId: asPersonId("p2"), displayName: "Rahul Menon", bestScore: 15_110, playedAt: 0, isYou: true },
      { personId: asPersonId("p3"), displayName: "Sneha Kulkarni", bestScore: 12_980, playedAt: 0, isYou: false },
      // A name past the column's width, and one a provider shouted, so the board's
      // own shortening and casing are both visible in the gallery.
      { personId: asPersonId("p4"), displayName: "Venkata Naga Sai Krishna Prasad", bestScore: 9_450, playedAt: 0, isYou: false },
      { personId: asPersonId("p5"), displayName: "PRIYA NAIR", bestScore: 6_310, playedAt: 0, isYou: false },
    ],
    yourBestScore: 15_110,
  },
  stack: {
    entries: [
      { personId: asPersonId("p6"), displayName: "Kabir Shah", bestScore: 4_200, playedAt: 0, isYou: false },
      { personId: asPersonId("p7"), displayName: "Meera Pillai", bestScore: 3_900, playedAt: 0, isYou: false },
      { personId: asPersonId("p8"), displayName: "Arjun Deshpande", bestScore: 3_100, playedAt: 0, isYou: false },
      { personId: asPersonId("p2"), displayName: "Rahul Menon", bestScore: 2_750, playedAt: 0, isYou: true },
    ],
    yourBestScore: 2_750,
  },
  memory: {
    entries: [
      { personId: asPersonId("p3"), displayName: "Sneha Kulkarni", bestScore: 4_615, playedAt: 0, isYou: false },
      { personId: asPersonId("p8"), displayName: "Arjun Deshpande", bestScore: 3_940, playedAt: 0, isYou: false },
      { personId: asPersonId("p1"), displayName: "Ananya Iyer", bestScore: 3_205, playedAt: 0, isYou: false },
    ],
    yourBestScore: 0,
  },
  "memory-grid": {
    entries: [
      { personId: asPersonId("p5"), displayName: "Priya Nair", bestScore: 17, playedAt: 0, isYou: false },
      { personId: asPersonId("p8"), displayName: "Arjun Deshpande", bestScore: 14, playedAt: 0, isYou: false },
      { personId: asPersonId("p2"), displayName: "Rahul Menon", bestScore: 11, playedAt: 0, isYou: true },
    ],
    yourBestScore: 11,
  },
};

function ArcadeFixture() {
  const boards = boardsOf(gameCatalogue);
  const [active, setActive] = useState(boards[0]?.key ?? "pacman");
  return (
    <ArcadeView
      header={account}
      tiles={gameCatalogue.map((game) => (
        <GameTile
          key={game.key}
          game={game}
          standing={standingOf(sampleBoards[game.modes?.[0]?.key ?? game.key])}
          onPlay={() => {}}
        />
      ))}
      standings={
        <StandingsColumn
          boards={boards}
          active={active}
          onSelect={setActive}
          board={sampleBoards[active]}
        />
      }
    />
  );
}

/** Renders one gallery screen's fixture content. */
export function ScreenFixture({ id }: { id: string }) {
  const render = screens[id];
  return render ? <>{render()}</> : null;
}
