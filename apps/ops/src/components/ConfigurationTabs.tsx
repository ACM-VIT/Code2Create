import { Link, useMatch } from 'react-router-dom'

export type ConfigurationTabsVisibility = {
  showLifecycle: boolean
  showAttendance: boolean
  showTracks: boolean
  showIntake: boolean
  showNovelty: boolean
  showParticipants: boolean
  showAdmissions: boolean
  showCommunications: boolean
  showFloor: boolean
  showIntegrations: boolean
  showIntelligence: boolean
  showPhases: boolean
  showCheckpoints: boolean
}

export function ConfigurationTabs({ visibility }: { visibility: ConfigurationTabsVisibility }) {
  const overview = useMatch('/configuration')
  const hasVisibleSection = Object.values(visibility).some(Boolean)
  if (overview || !hasVisibleSection) return null

  return (
    <nav className="configuration-back" aria-label="Event setup">
      <Link to="/configuration">← Event setup</Link>
    </nav>
  )
}
