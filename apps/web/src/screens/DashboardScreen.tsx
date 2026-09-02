import {
  TeamCluster,
  type ClusterMember,
  type ClusterTeam,
} from '../components/portal/TeamCluster'
import { PortalScene } from '../components/portal/PortalScene'
import './DashboardScreen.css'

export function DashboardScreen({
  team,
  members,
  teamEditable,
  onSignOut,
}: {
  team: ClusterTeam
  members: readonly ClusterMember[]
  teamEditable: boolean
  onSignOut: () => void
}) {
  return (
    <PortalScene
      tree="both"
      branch
      onSignOut={onSignOut}
      header={
        <TeamCluster
          team={team}
          members={members}
          editable={teamEditable}
        />
      }
    >
      <div className="dashboard-page">
        <h1 className="sr-only">Dashboard</h1>
        <div className="dashboard-grid" aria-hidden="true">
          <div className="dashboard-top">
            <img
              src="/assets/branch-plate.png"
              alt=""
              aria-hidden
              className="dashboard-hero-blossoms"
            />
            <div className="dashboard-box dashboard-box--hero" />
            <div className="dashboard-box dashboard-box--blossom" />
          </div>
          <div className="dashboard-lower">
            <div className="dashboard-column dashboard-column--left">
              <div className="dashboard-box dashboard-box--rose" />
              <div className="dashboard-box dashboard-box--small" />
            </div>
            <div className="dashboard-column dashboard-column--middle">
              <div className="dashboard-box dashboard-box--center" />
              <div className="dashboard-box dashboard-box--garden" />
            </div>
            <div className="dashboard-box dashboard-box--feature" />
          </div>
        </div>
      </div>
    </PortalScene>
  )
}
