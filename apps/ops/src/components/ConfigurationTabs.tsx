import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'

export type ConfigurationTabsVisibility = {
  showLifecycle: boolean
  showAttendance: boolean
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
  const location = useLocation()
  const navigate = useNavigate()
  const overview = location.pathname === '/configuration'
  const hasVisibleSection = Object.values(visibility).some(Boolean)
  if (overview || !hasVisibleSection) return null

  const group = configurationGroups.find((candidate) => candidate.items.some(
    (item) => item.to === location.pathname,
  ))
  const visibleItems = group?.items.filter((item) => visibility[item.visibility]) ?? []

  return (
    <nav className="configuration-context" aria-label="Event setup">
      <Link className="configuration-context-home" to="/configuration">Event setup</Link>
      {group && visibleItems.length > 0 ? (
        <div className="configuration-context-group">
          <span>{group.label}</span>
          <select
            aria-label={`${group.label} setup section`}
            className="configuration-context-select"
            value={location.pathname}
            onChange={(event) => {
              const destination = visibleItems.find((item) => item.to === event.target.value)
              if (destination) navigate(destination.to)
            }}
          >
            {visibleItems.map((item) => (
              <option key={item.to} value={item.to}>{item.label}</option>
            ))}
          </select>
          <div className="configuration-context-links">
            {visibleItems.map((item) => (
              <NavLink end key={item.to} to={item.to}>{item.label}</NavLink>
            ))}
          </div>
        </div>
      ) : null}
    </nav>
  )
}

type ConfigurationItem = {
  label: string
  to: string
  visibility: keyof ConfigurationTabsVisibility
}

const configurationGroups: readonly {
  label: string
  items: readonly ConfigurationItem[]
}[] = [
  {
    label: 'Applications',
    items: [
      { label: 'Participant form', to: '/configuration/participants', visibility: 'showParticipants' },
      { label: 'Idea questions', to: '/configuration/intake', visibility: 'showIntake' },
      { label: 'Idea originality', to: '/configuration/novelty', visibility: 'showNovelty' },
      { label: 'Admissions', to: '/configuration/admissions', visibility: 'showAdmissions' },
    ],
  },
  {
    label: 'Participant experience',
    items: [
      { label: 'Accepted teams', to: '/configuration/communications', visibility: 'showCommunications' },
      { label: 'Schedule', to: '/configuration/phases', visibility: 'showPhases' },
      { label: 'Team updates', to: '/configuration/checkpoints', visibility: 'showCheckpoints' },
    ],
  },
  {
    label: 'Event day',
    items: [
      { label: 'Check-in plan', to: '/attendance-setup', visibility: 'showAttendance' },
      { label: 'Hall layout', to: '/floor-setup', visibility: 'showFloor' },
      { label: 'Code and design', to: '/configuration/integrations', visibility: 'showIntegrations' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Operations agent', to: '/configuration/intelligence', visibility: 'showIntelligence' },
    ],
  },
]
