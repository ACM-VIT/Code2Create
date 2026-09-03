import { useEffect, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";

import { BenefitsTile } from "../components/dashboard/BenefitsTile";
import { EventTile } from "../components/dashboard/EventTile";
import { HelpTile } from "../components/dashboard/HelpTile";
import { IntegrationsTile } from "../components/dashboard/IntegrationsTile";
import { MusicTile } from "../components/dashboard/MusicTile";
import { ReviewTile } from "../components/dashboard/ReviewTile";
import { SquadTile } from "../components/dashboard/SquadTile";
import { UpdatesTile } from "../components/dashboard/UpdatesTile";
import { areasValue, composeDashboard, gridTemplates } from "../components/dashboard/dashboardLayout";
import { tileRelevance, type DashboardModels } from "../components/dashboard/relevance";
import { useReducedMotion } from "../components/dashboard/useReducedMotion";
import { PortalScene } from "../components/portal/PortalScene";
import { TeamCluster, type ClusterMember, type ClusterTeam } from "../components/portal/TeamCluster";

type DashboardGridStyle = CSSProperties & Record<`--dash-${string}`, string>;

/**
 * The dashboard bento: the mockup's seven slots, filled by whichever tiles
 * matter most right now. Every tile answers a tap in place; only music takes
 * the big slot, and the grid remaps around it. Tiles take plain data and
 * callbacks, so the live app and the gallery render the same screen.
 */
export function DashboardScreen({
  team,
  members,
  teamEditable,
  onSignOut,
  ...models
}: {
  team: ClusterTeam;
  members: readonly ClusterMember[];
  teamEditable: boolean;
  onSignOut: () => void;
} & DashboardModels) {
  const [musicOpen, setMusicOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const seating = composeDashboard(tileRelevance(models));
  const musicSlot = seating.music ?? null;
  const focus = musicOpen && musicSlot ? musicSlot : null;

  const setMusic = (next: boolean) => {
    if (next === musicOpen) return;
    const update = () => flushSync(() => setMusicOpen(next));
    if (!reducedMotion && document.startViewTransition) {
      document.startViewTransition(update);
    } else {
      update();
    }
  };

  useEffect(() => {
    if (!musicOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMusic(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const templates = gridTemplates(focus);
  const gridStyle: DashboardGridStyle = {
    "--dash-cols": templates.base.columns,
    "--dash-rows": templates.base.rows,
    "--dash-areas": areasValue(templates.base),
    "--dash-cols-md": templates.md.columns,
    "--dash-rows-md": templates.md.rows,
    "--dash-areas-md": areasValue(templates.md),
    "--dash-cols-lg": templates.lg.columns,
    "--dash-rows-lg": templates.lg.rows,
    "--dash-areas-lg": areasValue(templates.lg),
  };

  return (
    <PortalScene
      tree="both"
      branch
      onSignOut={onSignOut}
      header={<TeamCluster team={team} members={members} editable={teamEditable} />}
    >
      <div className="flex w-full max-w-[1200px] flex-1 flex-col justify-center lg:pt-8 lg:pb-6">
        <h1 className="sr-only">Dashboard</h1>
        <div
          style={gridStyle}
          className="relative grid h-[max(720px,calc(100dvh-176px))] grid-cols-[var(--dash-cols)] grid-rows-[var(--dash-rows)] gap-4 [grid-template-areas:var(--dash-areas)] md:h-[max(640px,calc(100dvh-176px))] md:grid-cols-[var(--dash-cols-md)] md:grid-rows-[var(--dash-rows-md)] md:[grid-template-areas:var(--dash-areas-md)] lg:h-[max(460px,min(880px,calc(100dvh-232px)))] lg:grid-cols-[var(--dash-cols-lg)] lg:grid-rows-[var(--dash-rows-lg)] lg:gap-[18px] lg:[grid-template-areas:var(--dash-areas-lg)]"
        >
          <img
            src="/assets/branch-plate.png"
            alt=""
            aria-hidden
            className="pointer-events-none absolute -top-13 -left-16 z-0 w-[min(680px,70%)] max-w-none opacity-90 [filter:var(--scene-branch-filter)]"
          />
          {seating.event ? <EventTile slot={seating.event} model={models.event} /> : null}
          {seating.squad ? <SquadTile slot={seating.squad} team={team} members={members} /> : null}
          {musicSlot ? (
            <MusicTile
              slot={musicSlot}
              model={models.music}
              focused={musicOpen}
              onFocus={() => setMusic(true)}
              onRelease={() => setMusic(false)}
            />
          ) : null}
          {seating.integrations ? <IntegrationsTile slot={seating.integrations} model={models.integrations} /> : null}
          {seating.updates ? <UpdatesTile slot={seating.updates} model={models.updates} /> : null}
          {seating.review ? <ReviewTile slot={seating.review} model={models.review} /> : null}
          {seating.help ? <HelpTile slot={seating.help} model={models.help} /> : null}
          {seating.benefits ? <BenefitsTile slot={seating.benefits} model={models.benefits} /> : null}
        </div>
      </div>
    </PortalScene>
  );
}
