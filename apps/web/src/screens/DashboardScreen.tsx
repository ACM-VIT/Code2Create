import { useEffect, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";

import { BenefitsTile } from "../components/dashboard/BenefitsTile";
import { EventTile } from "../components/dashboard/EventTile";
import { HelpTile } from "../components/dashboard/HelpTile";
import { IntegrationsTile } from "../components/dashboard/IntegrationsTile";
import { MusicTile } from "../components/dashboard/MusicTile";
import { ReviewTile } from "../components/dashboard/ReviewTile";
import { ServiceQueuesTile } from "../components/dashboard/ServiceQueuesTile";
import { SquadTile } from "../components/dashboard/SquadTile";
import { UpdatesTile } from "../components/dashboard/UpdatesTile";
import {
  areasValue,
  composeDashboard,
  gridTemplates,
  type Slot,
  type TileKey,
} from "../components/dashboard/dashboardLayout";
import { tileRelevance, type DashboardModels } from "../components/dashboard/relevance";
import { useReducedMotion } from "../components/dashboard/useReducedMotion";
import { PortalScene } from "../components/portal/PortalScene";
import { RoomNav } from "../components/portal/RoomNav";
import { TeamCluster, type ClusterMember, type ClusterTeam } from "../components/portal/TeamCluster";

type DashboardGridStyle = CSSProperties & Record<`--dash-${string}`, string>;

type Seating = Partial<Record<TileKey, Slot>>;

function useStableSeating(proposed: Seating): Seating {
  const board = Object.keys(proposed).sort().join(",");
  const [held, setHeld] = useState({ board, seating: proposed });
  if (held.board !== board) {
    setHeld({ board, seating: proposed });
    return proposed;
  }
  return held.seating;
}

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
  const seating = useStableSeating(composeDashboard(tileRelevance(models)));
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
      onSignOut={onSignOut}
      header={<TeamCluster team={team} members={members} editable={teamEditable} />}
      nav={<RoomNav current="home" />}
    >
      <div className="flex w-full max-w-[1200px] flex-1 flex-col justify-center pt-10 lg:pt-8 lg:pb-6">
        <h1 className="sr-only">Dashboard</h1>
        <div
          style={gridStyle}
          className={`relative grid h-[max(1080px,calc(100dvh-216px))] grid-cols-[var(--dash-cols)] grid-rows-[var(--dash-rows)] gap-4 [grid-template-areas:var(--dash-areas)] md:h-[max(640px,calc(100dvh-216px))] md:grid-cols-[var(--dash-cols-md)] md:grid-rows-[var(--dash-rows-md)] md:[grid-template-areas:var(--dash-areas-md)] lg:h-[max(460px,min(880px,calc(100dvh-232px)))] lg:grid-cols-[var(--dash-cols-lg)] lg:grid-rows-[var(--dash-rows-lg)] lg:gap-[18px] lg:[grid-template-areas:var(--dash-areas-lg)] ${seating.review === "hero" ? "[--dash-hero-min:300px] md:[--dash-hero-min:280px]" : ""}`}
        >
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
          {seating.review && models.review ? <ReviewTile slot={seating.review} model={models.review} /> : null}
          {seating.queues ? <ServiceQueuesTile slot={seating.queues} model={models.queues} /> : null}
          {seating.help ? <HelpTile slot={seating.help} model={models.help} /> : null}
          {seating.benefits ? <BenefitsTile slot={seating.benefits} model={models.benefits} /> : null}
        </div>
      </div>
    </PortalScene>
  );
}
