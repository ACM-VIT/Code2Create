import { api } from '@code2create/backend/api'
import { useQuery } from 'convex/react'

import { eventSlug } from '../lib/config'

export function IncidentBanner() {
  const incidents = useQuery(api.incidents.active, { eventSlug })

  if (incidents === undefined || incidents.length === 0) return null

  const hasCriticalIncident = incidents.some((incident) => incident.severity === 'critical')

  return (
    <section
      aria-live="polite"
      className={hasCriticalIncident ? 'incident-banner critical' : 'incident-banner'}
    >
      <div className="incident-banner-heading">
        <strong>{incidents.length === 1 ? 'Active incident' : `${incidents.length} active incidents`}</strong>
        <span>Only the work that depends on the affected service needs to stop.</span>
      </div>
      <ul>
        {incidents.slice(0, 3).map((incident) => (
          <li key={incident.id}>
            <strong>{incident.title}</strong>
            <span>{serviceName(incident.affectedService)} · {incident.summary}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function serviceName(service: 'attendance_backend' | 'review_backend') {
  return service === 'attendance_backend' ? 'Attendance' : 'Reviews'
}
