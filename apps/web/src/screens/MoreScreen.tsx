import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useQuery } from 'convex/react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { PetalCard } from '../components/portal/PetalCard'
import { PortalScene } from '../components/portal/PortalScene'
import { eventSlug } from '../lib/config'
import type { ParticipantMe } from '../types'

type ParticipantCapabilities = FunctionReturnType<typeof api.access.participantCapabilities>

function Row({
  label,
  value,
  to,
  href,
  onClick,
  accent = false,
}: {
  label: string
  value?: ReactNode
  to?: string
  href?: string
  onClick?: () => void
  accent?: boolean
}) {
  const body = (
    <>
      <span className={`text-sm ${accent ? 'text-rose-light' : ''}`}>{label}</span>
      <span className="text-xs text-[rgb(248_248_248/.5)]">{value}</span>
    </>
  )
  const rowClass =
    'flex w-full items-center justify-between gap-4 border-b border-petal-line py-[15px] text-left last:border-b-0'
  if (to) {
    return (
      <Link to={to} className={`${rowClass} transition-colors hover:text-rose-light`}>
        {body}
      </Link>
    )
  }
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={`${rowClass} transition-colors hover:text-rose-light`}
      >
        {body}
      </a>
    )
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${rowClass} cursor-pointer`}>
        {body}
      </button>
    )
  }
  return <div className={rowClass}>{body}</div>
}

/** Mockup f12: everything else, one quiet list. */
export function MoreScreen({
  me,
  capabilities,
  showIntegrations,
  showMusic,
  onSignOut,
}: {
  me: ParticipantMe
  capabilities: ParticipantCapabilities
  showIntegrations: boolean
  showMusic: boolean
  onSignOut: () => void
}) {
  const delivery = useQuery(
    api.participantNotifications.mine,
    capabilities?.notifications ? { eventSlug } : 'skip',
  )
  const communications = useQuery(
    api.participantCommunications.current,
    showIntegrations || showMusic ? { eventSlug } : 'skip',
  )
  const policy = me.participantPolicy.policy
  const profileDetail = [
    me.profile?.fullName ?? me.person.displayName,
    me.profile?.vitRegistrationNumber,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <PortalScene tree="left">
      <div className="flex w-full max-w-[480px] flex-col items-center">
        <p className="mb-6 font-ui text-lg text-rose-light">more</p>
        <PetalCard className="px-6 py-1.5">
          <Row label="Profile" value={profileDetail} to="/more/profile" />
          {capabilities?.notifications ? (
            <Row
              label="Notifications"
              value={
                delivery === undefined
                  ? '…'
                  : delivery === null
                    ? 'email updates'
                    : `email · ${delivery.state.replace(/_/g, ' ')}`
              }
            />
          ) : null}
          {showIntegrations ? <Row label="Integrations" value="repos + Figma" to="/integrations" /> : null}
          {communications?.discordUrl ? (
            <Row label="Discord" value={communications.discordLabel} href={communications.discordUrl} />
          ) : null}
          {showMusic ? <Row label="Music" value="synesthesia" to="/music" /> : null}
          {capabilities?.supportRead ? <Row label="Support" to="/support" /> : null}
          <Row label="Event policy" value={policy.label} />
          <Row label="Privacy" href={policy.privacyNoticeUrl} />
          <Row label="Sign out" accent onClick={onSignOut} />
        </PetalCard>
        <p className="mt-5 text-[11.5px] text-[rgb(248_248_248/.4)]">
          <Link to="/" className="text-rose-light">
            back home
          </Link>
        </p>
      </div>
    </PortalScene>
  )
}
