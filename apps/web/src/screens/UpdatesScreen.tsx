import { Link } from 'react-router-dom'

import { ProjectCheckpointsPanel } from '../components/ProjectCheckpointsPanel'
import { PetalCard } from '../components/portal/PetalCard'
import { PortalScene } from '../components/portal/PortalScene'
import { TeamCluster, type ClusterMember, type ClusterTeam } from '../components/portal/TeamCluster'

/** Team updates: the checkpoint forms, on the scene, one tap from the dashboard. */
export function UpdatesScreen({
  team,
  members,
  teamEditable,
  timezone,
  onSignOut,
}: {
  team: ClusterTeam
  members: readonly ClusterMember[]
  teamEditable: boolean
  timezone: string
  onSignOut: () => void
}) {
  return (
    <PortalScene tree="left" onSignOut={onSignOut} header={<TeamCluster team={team} members={members} editable={teamEditable} />}>
      <div className="flex w-full max-w-[720px] flex-col items-center">
        <h1 className="mb-2 text-center font-display font-light tracking-[-.01em] text-3xl text-shadow-[0_6px_40px_var(--scene-text-glow)] lg:text-[44px]">
          Team updates
        </h1>
        <p className="mb-7 text-xs text-fg/50">
          <Link to="/" viewTransition className="text-rose-light underline-offset-4 hover:underline">back home</Link>
        </p>
        <div className="w-full text-left">
          <PetalCard className="px-6 py-4 sm:px-8">
            <ProjectCheckpointsPanel timezone={timezone} />
          </PetalCard>
        </div>
      </div>
    </PortalScene>
  )
}
