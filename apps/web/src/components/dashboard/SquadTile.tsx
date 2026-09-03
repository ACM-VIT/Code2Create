import { useState } from "react";
import { Link } from "react-router-dom";

import { MemberAvatarVisual } from "../portal/MemberAvatarVisual";
import type { ClusterMember, ClusterTeam } from "../portal/TeamCluster";
import { Reveal, Tile, TileEyebrow } from "./Tile";

/** The squad tile: the team as a cluster of avatars; a tap names them. */
export function SquadTile({
  team,
  members,
}: {
  team: ClusterTeam;
  members: readonly ClusterMember[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tile area="team" open={open} onToggle={() => setOpen((value) => !value)}>
      <div className="flex flex-1 flex-col justify-between gap-3 p-[18px]">
        <div className="flex items-baseline justify-between gap-3">
          <TileEyebrow>squad</TileEyebrow>
          <span className="text-[11px] text-fg/50">
            {team.activeMemberCount} of {team.teamMaximumSize}
          </span>
        </div>
        {open ? (
          <Reveal key="names" className="flex flex-col">
            {members.map((member) => (
              <div
                key={member.teamMemberId}
                className="flex items-center gap-2.5 border-b border-rose/20 py-1.5 text-[12.5px] last:border-b-0"
              >
                <span
                  className={`flex size-6 flex-none items-center justify-center rounded-full ${member.role === "lead" ? "border border-ring-lead bg-avatar-lead" : "border border-rose/60 bg-avatar"}`}
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
            <Link
              to="/team"
              viewTransition
              className="mt-2 self-start text-[12px] text-rose-light underline-offset-4 hover:underline"
            >
              view team
            </Link>
          </Reveal>
        ) : (
          <Reveal key="cluster" className="flex flex-col gap-2.5">
            <span className="flex">
              {members.slice(0, 6).map((member, index) => (
                <span
                  key={member.teamMemberId}
                  title={member.displayName}
                  className={`relative flex size-10 items-center justify-center rounded-full ${
                    member.role === "lead"
                      ? "border-[1.5px] border-ring-lead bg-avatar-lead"
                      : "border-[1.5px] border-rose/70 bg-avatar"
                  } ${index > 0 ? "-ml-2.5" : ""}`}
                  style={{ zIndex: 6 - index }}
                >
                  <MemberAvatarVisual
                    displayName={member.displayName}
                    githubAvatarUrl={member.githubAvatarUrl}
                    seed={member.membershipId}
                    lead={member.role === "lead"}
                    flowerSize={20}
                  />
                </span>
              ))}
            </span>
            <p className="m-0 truncate font-display text-[19px] leading-tight text-shadow-[0_6px_30px_var(--scene-text-glow)]">
              {team.name}
            </p>
          </Reveal>
        )}
      </div>
    </Tile>
  );
}
