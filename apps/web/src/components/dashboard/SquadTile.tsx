import { LiveNumber } from "../LiveNumber";
import { useState } from "react";
import { Link } from "react-router-dom";

import { MemberAvatarVisual } from "../portal/MemberAvatarVisual";
import type { ClusterMember, ClusterTeam } from "../portal/TeamCluster";
import { Reveal, Tile, TileEyebrow } from "./Tile";
import { hiddenWhenShort, tileBody } from "./tileClasses";
import type { Slot } from "./dashboardLayout";

/** The squad tile: the team as a cluster of avatars; a tap names them. */
export function SquadTile({ slot, team,
  members,
}: {
  slot: Slot;
  team: ClusterTeam;
  members: readonly ClusterMember[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tile slot={slot} open={open} onToggle={() => setOpen((value) => !value)}>
      <div className={tileBody}>
        <div className={`flex items-baseline justify-between gap-3 ${hiddenWhenShort}`}>
          <TileEyebrow>squad</TileEyebrow>
          <span className="text-[11px] text-fg/50">
            <LiveNumber value={team.activeMemberCount} /> of {team.teamMaximumSize}
          </span>
        </div>
        {open ? (
          <Reveal key="names" className="flex min-h-0 flex-col">
            {members.map((member) => (
              <div
                key={member.teamMemberId}
                className="flex items-center gap-2.5 border-b border-rose/20 py-1.5 text-[12.5px] last:border-b-0"
              >
                <span
                  className={`relative flex size-6 flex-none items-center justify-center overflow-hidden rounded-full ${member.role === "lead" ? "border border-ring-lead bg-avatar-lead" : "border border-rose/60 bg-avatar"}`}
                >
                  <MemberAvatarVisual
                    displayName={member.displayName}
                    githubAvatarUrl={member.githubAvatarUrl}
                    seed={member.membershipId}
                    lead={member.role === "lead"}
                    flowerSize={12}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate text-fg/85">{member.displayName}</span>
                {member.role === "lead" ? (
                  <span className="text-[11px] text-rose-light">lead</span>
                ) : null}
              </div>
            ))}
            <span className="mt-2 flex gap-4 self-start text-[12px]">
              <Link
                to="/team"
                viewTransition
                className="text-rose-light underline-offset-4 hover:underline"
              >
                view team
              </Link>
              <Link
                to="/idea"
                viewTransition
                className="text-rose-light underline-offset-4 hover:underline"
              >
                your idea
              </Link>
            </span>
          </Reveal>
        ) : (
          <Reveal key="cluster" className="flex min-w-0 items-center gap-3">
            <span className="flex flex-none">
              {members.slice(0, 5).map((member, index) => (
                <span
                  key={member.teamMemberId}
                  title={member.displayName}
                  className={`relative flex size-8 items-center justify-center overflow-hidden rounded-full ${
                    member.role === "lead" ? "border-[1.5px] border-ring-lead bg-avatar-lead" : "border-[1.5px] border-rose/70 bg-avatar"
                  } ${index > 0 ? "-ml-2" : ""}`}
                  style={{ zIndex: 5 - index }}
                >
                  <MemberAvatarVisual displayName={member.displayName} githubAvatarUrl={member.githubAvatarUrl} seed={member.membershipId} lead={member.role === "lead"} flowerSize={16} />
                </span>
              ))}
            </span>
            <p className="m-0 min-w-0 truncate font-display text-[19px] leading-tight text-shadow-[0_6px_30px_var(--scene-text-glow)]">{team.name}</p>
          </Reveal>
        )}
      </div>
    </Tile>
  );
}
