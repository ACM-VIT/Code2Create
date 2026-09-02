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
type SupportSummary = FunctionReturnType<typeof api.support.mineSummary>

function supportRowValue(summary: SupportSummary | undefined) {
  if (summary === undefined) return '…'
  if (summary.openCount === 0) return 'Help desk'
  return `${summary.countIsLowerBound ? '20+' : summary.openCount} open`
}

function Row({
  label,
  value,
  to,
  href,
}: {
  label: string
  value?: ReactNode
  to?: string
  href?: string
}) {
  const body = (
    <>
      <span className="text-[14px] text-fg/90">{label}</span>
      <span className="min-w-0 truncate text-right text-[12px] text-fg/50">{value}</span>
    </>
  )
  const base =
    'flex w-full items-center justify-between gap-4 border-b border-petal-line py-3.5 text-left no-underline transition-colors last:border-b-0'
  if (to) {
    return (
      <Link to={to} viewTransition className={`${base} hover:text-rose-light`}>
        {body}
      </Link>
    )
  }
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={`${base} hover:text-rose-light`}>
        {body}
      </a>
    )
  }
  return <div className={base}>{body}</div>
}

/**
 * Secondary destinations in one quiet list. Account and team actions stay in
 * their dedicated header controls instead of being mixed into this page.
 */
export function MoreScreen({
  me,
  capabilities,
  showIntegrations,
  showMusic,
  header,
  onSignOut,
}: {
  me: ParticipantMe
  capabilities: ParticipantCapabilities
  showIntegrations: boolean
  showMusic: boolean
  header: ReactNode
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
  const support = useQuery(api.support.mineSummary, capabilities?.supportRead ? { eventSlug } : 'skip')
  const policy = me.participantPolicy.policy
  return (
    <PortalScene tree="left" header={header} onSignOut={onSignOut}>
      <div className="flex w-full max-w-[480px] flex-col items-center">
        <h1 className="mb-7 font-display font-light tracking-[-.01em] text-3xl text-shadow-[0_4px_30px_var(--scene-text-glow)] lg:text-[40px]">
          More
        </h1>
        <PetalCard className="w-full px-6 py-2">
          {capabilities?.notifications ? (
            <Row
              label="Notifications"
              value={
                delivery === undefined
                  ? '…'
                  : delivery === null
                    ? 'Email updates'
                    : `Email · ${delivery.state.replace(/_/g, ' ')}`
              }
            />
          ) : null}
          {showIntegrations ? <Row label="Integrations" value="Repos and Figma" to="/integrations" /> : null}
          {communications?.discordUrl ? (
            <Row label="Discord" value={communications.discordLabel} href={communications.discordUrl} />
          ) : null}
          {showMusic ? <Row label="Music" value="Synesthesia" to="/music" /> : null}
          {capabilities?.supportRead ? (
            <Row label="Support" value={supportRowValue(support)} to="/support" />
          ) : null}
          <Row label="Privacy" value="Notice" href={policy.privacyNoticeUrl} />
        </PetalCard>
      </div>
    </PortalScene>
  )
}
