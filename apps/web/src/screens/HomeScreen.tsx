import { LiveNumber, LiveDuration } from "../components/LiveNumber";
import { api } from "@code2create/backend/api";
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { GpuSky } from "../components/portal/GpuSky";
import { TeamCluster } from "../components/portal/TeamCluster";
import { JoinCodeBar } from "../components/portal/JoinCodeBar";
import { Petal } from "../components/portal/Petal";
import { PortalButton } from "../components/portal/PortalButton";
import { PortalScene } from "../components/portal/PortalScene";
import { QuietCard } from "../components/portal/QuietCard";
import { eventSlug } from "../lib/config";
import type { CurrentTeam, CurrentTeamMember } from "../types";

const JOURNEY_STAGES = 4;
const JOURNEY_LABELS = ["idea", "questions", "review", "submit"] as const;

function journeyState(draft: { stage: string } | null) {
  if (!draft || draft.stage === "opening") {
    return { current: 0, headline: "Start with the idea.", action: "Write it" };
  }
  if (draft.stage === "follow_up") {
    return {
      current: 1,
      headline: "Shape the idea.",
      action: "Answer it",
    };
  }
  return { current: 2, headline: "Read it together.", action: "Open the review" };
}

/** The live tick to the writing deadline — the countdown every ACM portal owes its participants. */
function Countdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.max(0, deadline - now);
  const days = Math.floor(left / 86_400_000);
  const clock = <LiveDuration seconds={Math.floor(left / 1000) % 86_400} hours />;
  return (
    <p className="m-0 font-display font-light tracking-[-.01em] text-[26px] text-rose-light [font-variant-numeric:tabular-nums]">
      {days > 0 ? (
        <>
          <LiveNumber value={days} />
          <span className="text-sm">d</span> {clock}
        </>
      ) : (
        clock
      )}
    </p>
  );
}

export function HomeScreen({
  team,
  members,
  teamEditable,
  onSignOut,
  onPrepareIntake,
}: {
  team: CurrentTeam;
  members: CurrentTeamMember[];
  teamEditable: boolean;
  onSignOut: () => void;
  onPrepareIntake: () => void;
}) {
  const navigate = useNavigate();
  const intake = useQuery(api.intake.current, { eventSlug });

  const draft = intake?.draft ?? null;
  const journey = journeyState(draft);
  const openSeats = Math.max(0, team.teamMaximumSize - team.activeMemberCount);
  const showInvite = teamEditable && openSeats > 0;

  return (
    <PortalScene
      onSignOut={onSignOut}
      tree="left"
      backdrop={<GpuSky />}
      header={
        <TeamCluster
          team={team}
          members={members}
          editable={teamEditable}
          canManage={team.currentRole === "lead" && teamEditable}
        />
      }
    >
      <div className="flex w-full max-w-[1048px] flex-1 flex-col items-start justify-center pb-56 sm:items-end sm:pb-40">
        <div className="flex max-w-[680px] flex-col items-start text-left sm:items-end sm:text-right">
          <h1 className="mb-8 font-display font-light tracking-[-.01em] text-balance text-5xl leading-none text-shadow-[0_8px_50px_var(--scene-text-glow)] lg:text-7xl">
            {journey.headline}
          </h1>
          <PortalButton
            type="button"
            onPointerEnter={onPrepareIntake}
            onFocus={onPrepareIntake}
            onClick={() => navigate("/write", { viewTransition: true })}
          >
            {journey.action}
          </PortalButton>

          {showInvite ? (
            <div className="mt-9 flex flex-col items-start gap-2.5 sm:items-end">
              <p className="m-0 text-[12.5px] text-fg/55">
                {team.activeMemberCount === 1
                  ? <>Just you so far · <LiveNumber value={openSeats} /> {openSeats === 1 ? "seat" : "seats"} open</>
                  : <><LiveNumber value={team.activeMemberCount} /> of {team.teamMaximumSize} on the team · <LiveNumber value={openSeats} /> {openSeats === 1 ? "seat" : "seats"} open</>}
                {" · "}
                <Link
                  to="/team"
                  viewTransition
                  className="text-rose-light no-underline hover:underline"
                >
                  manage team
                </Link>
              </p>
              <JoinCodeBar code={team.publicCode} />
            </div>
          ) : null}
        </div>
      </div>

      <div className="absolute inset-x-5 bottom-8 z-[3] flex flex-col gap-3 sm:flex-row sm:gap-[18px] lg:inset-x-24 lg:bottom-14">
        <QuietCard label="deadline">
          {intake ? (
            <Countdown deadline={intake.applicationsCloseAt} />
          ) : (
            <p className="m-0 font-display font-light tracking-[-.01em] text-[26px] text-rose-light">
              ·
            </p>
          )}
        </QuietCard>
        <QuietCard
          label={`journey · ${journey.current + 1} of ${JOURNEY_STAGES}`}
          className={showInvite ? "hidden sm:block" : ""}
        >
          <div className="flex items-start pt-1">
            {JOURNEY_LABELS.map((label, index) => {
              const state =
                index < journey.current ? "done" : index === journey.current ? "current" : "todo";
              return (
                <div
                  key={label}
                  className="flex flex-1 flex-col items-center first:flex-none first:items-start last:flex-none last:items-end"
                >
                  <div className="flex w-full items-center">
                    {index > 0 ? (
                      <span
                        aria-hidden
                        className={`h-px flex-1 ${index <= journey.current ? "bg-rose/60" : "bg-rose/25"}`}
                      />
                    ) : null}
                    <Petal size={15} state={state} />
                    {index < JOURNEY_LABELS.length - 1 ? (
                      <span
                        aria-hidden
                        className={`h-px flex-1 ${index < journey.current ? "bg-rose/60" : "bg-rose/25"}`}
                      />
                    ) : null}
                  </div>
                  <span
                    className={`mt-1 text-[9.5px] leading-none ${
                      state === "current"
                        ? "font-semibold text-rose-light"
                        : state === "done"
                          ? "text-fg/60"
                          : "text-fg/35"
                    }`}
                  >
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        </QuietCard>
        <QuietCard label="editable until" grow>
          <p className="m-0 font-ui text-[14.5px] text-fg">
            {intake
              ? new Date(intake.applicationsCloseAt).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : "—"}
          </p>
        </QuietCard>
      </div>
    </PortalScene>
  );
}
