import { useEffect, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";

import {
  IntegrationsTile,
  type IntegrationsTileModel,
} from "../components/dashboard/IntegrationsTile";
import { MusicTile, type MusicTileModel } from "../components/dashboard/MusicTile";
import { Tile, TileEyebrow } from "../components/dashboard/Tile";
import { areasValue, gridTemplates, type TileKey } from "../components/dashboard/dashboardLayout";
import { useReducedMotion } from "../components/dashboard/useReducedMotion";
import { PortalScene } from "../components/portal/PortalScene";
import {
  TeamCluster,
  type ClusterMember,
  type ClusterTeam,
} from "../components/portal/TeamCluster";

const plainTiles: readonly { area: TileKey; label: string; note: string }[] = [
  { area: "status", label: "event", note: "Schedule and what is next." },
  { area: "team", label: "squad", note: "Who is on the team." },
  { area: "updates", label: "updates", note: "Checkpoints as they open." },
  { area: "queue", label: "review", note: "Where the team stands." },
  { area: "help", label: "help", note: "Discord and the desk." },
];

/**
 * The dashboard bento: seven glass tiles on one named-area grid that remaps
 * itself around whichever tile is open. Tiles take plain data and callbacks,
 * so the live app and the gallery render the same screen.
 */
export function DashboardScreen({
  team,
  members,
  teamEditable,
  onSignOut,
  music,
  integrations,
}: {
  team: ClusterTeam;
  members: readonly ClusterMember[];
  teamEditable: boolean;
  onSignOut: () => void;
  music: MusicTileModel;
  integrations: IntegrationsTileModel;
}) {
  const [focus, setFocus] = useState<TileKey | null>(null);
  const reducedMotion = useReducedMotion();

  const changeFocus = (next: TileKey | null) => {
    if (next === focus) return;
    const update = () => flushSync(() => setFocus(next));
    if (!reducedMotion && document.startViewTransition) {
      document.startViewTransition(update);
    } else {
      update();
    }
  };

  useEffect(() => {
    if (focus === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") changeFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const templates = gridTemplates(focus);
  const gridStyle = {
    "--dash-cols": templates.base.columns,
    "--dash-rows": templates.base.rows,
    "--dash-areas": areasValue(templates.base),
    "--dash-cols-md": templates.md.columns,
    "--dash-rows-md": templates.md.rows,
    "--dash-areas-md": areasValue(templates.md),
    "--dash-cols-lg": templates.lg.columns,
    "--dash-rows-lg": templates.lg.rows,
    "--dash-areas-lg": areasValue(templates.lg),
  } as CSSProperties;

  const tileProps = (area: TileKey) => ({
    focused: focus === area,
    onFocus: () => changeFocus(area),
    onRelease: () => changeFocus(null),
  });

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
          className="relative grid min-h-[720px] flex-1 grid-cols-[var(--dash-cols)] grid-rows-[var(--dash-rows)] gap-4 [grid-template-areas:var(--dash-areas)] md:min-h-[640px] md:grid-cols-[var(--dash-cols-md)] md:grid-rows-[var(--dash-rows-md)] md:[grid-template-areas:var(--dash-areas-md)] lg:max-h-[880px] lg:min-h-[460px] lg:grid-cols-[var(--dash-cols-lg)] lg:grid-rows-[var(--dash-rows-lg)] lg:gap-[18px] lg:[grid-template-areas:var(--dash-areas-lg)]"
        >
          <img
            src="/assets/branch-plate.png"
            alt=""
            aria-hidden
            className="pointer-events-none absolute -top-13 -left-16 z-0 w-[min(680px,70%)] max-w-none opacity-90 [filter:var(--scene-branch-filter)]"
          />
          <MusicTile model={music} {...tileProps("music")} />
          <IntegrationsTile model={integrations} {...tileProps("integrations")} />
          {plainTiles.map((tile) => (
            <Tile key={tile.area} area={tile.area} {...tileProps(tile.area)}>
              <div className="flex flex-1 flex-col justify-between gap-3 p-[18px]">
                <div className="flex items-baseline justify-between gap-3">
                  <TileEyebrow>{tile.label}</TileEyebrow>
                  {focus !== tile.area ? (
                    <span className="text-[11px] text-fg/50">tap to open</span>
                  ) : null}
                </div>
                <p className="m-0 text-[13px] leading-snug text-fg/60">{tile.note}</p>
              </div>
            </Tile>
          ))}
        </div>
      </div>
    </PortalScene>
  );
}
