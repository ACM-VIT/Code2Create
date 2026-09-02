import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AccountBadge } from './AccountBadge'
import { Petal } from './Petal'
import { PortalNavigation } from './PortalNavigation'
import { usePortalSignOut } from './portalSceneContext'
import { Flower } from './FlowerAvatar'
import { assignFlowerVariants } from './flowerVariants'

// Structural props rather than the generated Convex views: this is a
// presentational component, and Convex `Id<T>` widens to `string`, so real
// query results still satisfy these while fixtures stay constructible.
export type ClusterTeam = {
  name: string
  publicCode: string
  activeMemberCount: number
  teamMaximumSize: number
  currentMembershipId: string
}

export type ClusterMember = {
  teamMemberId: string
  membershipId: string
  role: string
  displayName: string
}

function Avatar({
  displayName,
  seed,
  lead,
  variant,
  size = 'md',
  className = '',
}: {
  displayName: string
  seed: string
  lead: boolean
  variant?: number
  size?: 'sm' | 'md'
  className?: string
}) {
  // The mockup's 48px stack crowds a 390px header, so it steps down on mobile.
  const box = size === 'md' ? 'size-10 lg:size-12' : 'size-[34px]'
  return (
    <div
      title={displayName}
      className={`flex flex-none items-center justify-center rounded-full ${box} ${
        lead
          ? 'border-2 border-ring-lead bg-avatar-lead shadow-[0_0_18px_var(--avatar-glow)]'
          : 'border-2 border-rose/70 bg-avatar'
      } ${className}`}
    >
      <Flower
        seed={seed}
        lead={lead}
        {...(variant === undefined ? {} : { variant })}
        className="size-[62%]"
      />
    </div>
  )
}

/**
 * The top-right team presence: an overlapping avatar stack that opens team
 * details on click. Global destinations and account actions remain separate,
 * predictable controls beside it.
 */
export function TeamCluster({
  team,
  members,
  editable = true,
  canManage = false,
}: {
  team: ClusterTeam
  members: readonly ClusterMember[]
  editable?: boolean
  canManage?: boolean
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const shown = members.slice(0, 3)
  const currentMember = members.find((member) => member.membershipId === team.currentMembershipId)
  const onSignOut = usePortalSignOut()
  // One deal for the whole roster so no two members share a bloom.
  const flowerVariants = assignFlowerVariants(
    members.filter((member) => member.role !== 'lead').map((member) => member.membershipId),
  )

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="flex items-start gap-2.5">
      <PortalNavigation hasTeam />
      <div
        ref={anchor}
        className="relative text-right"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Team ${team.name}, ${team.activeMemberCount} of ${team.teamMaximumSize} members`}
          onClick={() => setOpen((value) => !value)}
          className={`flex min-h-10 items-center rounded-full border px-1.5 py-1 shadow-[0_8px_24px_var(--shade-1)] transition-colors duration-200 lg:min-h-12 lg:px-2 ${
            open ? 'border-rose-light/80 bg-rose/15' : 'border-petal-line bg-tile hover:border-rose/70'
          }`}
        >
          <div className="flex justify-end">
            {shown.map((member, index) => {
              const variant = flowerVariants.get(member.membershipId)
              return (
                <Avatar
                  key={member.teamMemberId}
                  displayName={member.displayName}
                  seed={member.membershipId}
                  lead={member.role === 'lead'}
                  {...(variant === undefined ? {} : { variant })}
                  size="sm"
                  className={index > 0 ? '-ml-2' : ''}
                />
              )
            })}
          </div>
          <span className="mr-2 ml-2.5 hidden max-w-32 min-w-0 text-left lg:block">
            <span className="block truncate text-[12px] font-medium text-fg/85">{team.name}</span>
            <span className="block text-[10px] text-fg/45">
              {team.activeMemberCount} of {team.teamMaximumSize} members
            </span>
          </span>
        </button>

        {open ? (
          <div className="fixed top-[84px] right-3 left-3 z-10 mx-auto w-auto max-w-[420px] text-left shadow-[0_18px_54px_var(--shade-1)] lg:absolute lg:top-[calc(100%+12px)] lg:right-0 lg:left-auto lg:mx-0 lg:w-[320px]">
          <TeamRosterPanel
            team={team}
            members={members}
            editable={editable}
            canManage={canManage}
          />
          </div>
        ) : null}
      </div>
      {onSignOut && currentMember ? (
        <AccountBadge
          name={currentMember.displayName}
          seed={currentMember.membershipId}
          detail={`${currentMember.role === 'lead' ? 'Team lead' : 'Team member'} · ${team.name}`}
          onSignOut={onSignOut}
          showNavigation={false}
        />
      ) : null}
    </div>
  )
}

/** The join code as a one-tap copy. */
function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title="Copy the join code"
      onClick={() => {
        void navigator.clipboard.writeText(code).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        })
      }}
      className="font-mono text-[12.5px] tracking-[.12em] text-rose-light transition-colors hover:text-fg"
    >
      {copied ? 'copied' : code}
    </button>
  )
}

/**
 * The team details card: name, seat count, the roster, and the join code or
 * sealed line with the team-page link. The cluster shows it as its popover;
 * the mobile menu takeover shows the same card full-width.
 */
export function TeamRosterPanel({
  team,
  members,
  editable = true,
  canManage = false,
}: {
  team: ClusterTeam
  members: readonly ClusterMember[]
  editable?: boolean
  canManage?: boolean
}) {
  const flowerVariants = assignFlowerVariants(
    members.filter((member) => member.role !== 'lead').map((member) => member.membershipId),
  )
  return (
    <section aria-label="Team details" className="rounded-petal-sm glass-menu px-5 py-4 text-left">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <p className="m-0 text-[10.5px] font-semibold tracking-[.1em] text-fg/45 uppercase">Your team</p>
          <p className="mt-1.5 mb-0 font-ui font-normal text-base text-rose-light">{team.name}</p>
        </div>
        <span className="mt-0.5 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
          {team.activeMemberCount} of {team.teamMaximumSize}
        </span>
      </div>
      {/* Preflight is off, so a bare ul keeps the UA's 40px indent. */}
      <ul className="m-0 list-none p-0">
        {members.map((member) => {
          const isYou = member.membershipId === team.currentMembershipId
          const variant = flowerVariants.get(member.membershipId)
          return (
            <li key={member.teamMemberId} className="flex items-center gap-3 py-2">
              <Avatar
                displayName={member.displayName}
                seed={member.membershipId}
                lead={member.role === 'lead'}
                {...(variant === undefined ? {} : { variant })}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-semibold">{member.displayName}</div>
                <div
                  className={`text-[10.5px] ${
                    member.role === 'lead' || isYou
                      ? 'font-ui font-normal text-rose-light'
                      : 'text-fg/50'
                  }`}
                >
                  {[member.role === 'lead' ? 'lead' : null, isYou ? 'you' : null]
                    .filter(Boolean)
                    .join(' · ') || 'member'}
                </div>
              </div>
              {member.role === 'lead' ? <Petal size={13} /> : null}
            </li>
          )
        })}
      </ul>
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-petal-line pt-3">
        {editable ? (
          <CopyCode code={team.publicCode} />
        ) : (
          <p className="m-0 flex items-center gap-1.5 text-[11.5px] text-fg/50">
            <Petal size={12} />
            changes closed
          </p>
        )}
        <Link
          to="/team"
          viewTransition
          className="flex-none text-[11.5px] text-fg/55 no-underline transition-colors hover:text-rose-light"
        >
          {canManage && editable ? 'manage team' : 'view team'}
        </Link>
      </div>
    </section>
  )
}
