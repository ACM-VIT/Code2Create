import { Link } from "react-router-dom";

import { ProjectCheckpointsPanel } from "../components/ProjectCheckpointsPanel";
import { OutlineHeading } from "../components/portal/OutlineHeading";
import { PetalCard } from "../components/portal/PetalCard";
import { PortalScene } from "../components/portal/PortalScene";
import { TeamCluster, type ClusterMember, type ClusterTeam } from "../components/portal/TeamCluster";

/** Team updates: the checkpoints as a timeline on one sheet, one tap from the dashboard. */
export function UpdatesScreen({
  team,
  members,
  teamEditable,
  timezone,
  onSignOut,
}: {
  team: ClusterTeam;
  members: readonly ClusterMember[];
  teamEditable: boolean;
  timezone: string;
  onSignOut: () => void;
}) {
  return (
    <PortalScene
      tree="left"
      onSignOut={onSignOut}
      header={<TeamCluster team={team} members={members} editable={teamEditable} />}
    >
      <div className="relative flex w-full max-w-[1000px] flex-1 flex-col gap-7 text-left">
        <header className="flex flex-col gap-3 lg:-mt-12">
          <OutlineHeading word="updates" />
          <p className="m-0 text-[12.5px] text-fg/55">
            <Link to="/" viewTransition className="text-rose-light underline-offset-4 hover:underline">
              back home
            </Link>
          </p>
        </header>
        <PetalCard className="mx-auto w-full max-w-[760px] px-5 py-4 sm:px-7">
          <ProjectCheckpointsPanel timezone={timezone} />
        </PetalCard>
      </div>
    </PortalScene>
  );
}
