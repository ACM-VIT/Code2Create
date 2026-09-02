import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { DaybreakToggle } from './DaybreakToggle'
import { Flower } from './FlowerAvatar'
import { assignFlowerVariants } from './flowerVariants'
import { Petal } from './Petal'
import { usePortalSignOut } from './portalSceneContext'

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

/** The signed-in portal's one header control. The avatar stack opens a menu
 * with the team, primary destinations, appearance, and account exit. */
export function TeamCluster({
  team,
  members,
}: {
  team: ClusterTeam
  members: readonly ClusterMember[]
  editable?: boolean
  canManage?: boolean
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const shown = members.slice(0, 3)
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
    <div ref={anchor} data-team-cluster className="relative text-right">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Team ${team.name}, ${team.activeMemberCount} of ${team.teamMaximumSize} members`}
        onClick={() => setOpen((value) => !value)}
        className={`flex min-h-10 items-center rounded-full border px-1.5 py-1 shadow-[0_8px_24px_var(--shade-1)] transition-colors duration-200 lg:min-h-12 lg:px-2 ${
          open ? 'border-rose-light/80 bg-rose/15' : 'border-petal-line bg-tile hover:border-rose/70'
        }`}
      >
        <span className="flex justify-end">
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
        </span>
        <span className="mr-2 ml-2.5 block max-w-28 min-w-0 text-left">
          <span className="block truncate text-[12px] font-medium text-fg/85">{team.name}</span>
          <span className="block text-[10px] text-fg/45">
            {team.activeMemberCount} of {team.teamMaximumSize} members
          </span>
        </span>
      </button>

      {open ? (
        <div className="fixed top-[84px] right-3 left-3 z-10 mx-auto max-h-[calc(100dvh-96px)] w-auto max-w-[420px] overflow-y-auto text-left shadow-[0_18px_54px_var(--shade-1)] lg:absolute lg:top-[calc(100%+12px)] lg:right-0 lg:left-auto lg:mx-0 lg:w-[360px]">
          <TeamRosterPanel
            team={team}
            members={members}
            onNavigate={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  )
}

/** Team context and the participant's complete navigation, grouped into one
 * compact menu without turning the roster itself into navigation. */
export function TeamRosterPanel({
  team,
  members,
  onNavigate,
}: {
  team: ClusterTeam
  members: readonly ClusterMember[]
  onNavigate: () => void
}) {
  const { pathname } = useLocation()
  const onSignOut = usePortalSignOut()
  const flowerVariants = assignFlowerVariants(
    members.filter((member) => member.role !== 'lead').map((member) => member.membershipId),
  )
  const navigation = [
    {
      label: 'Home (ideas)',
      to: '/',
      galleryScreen: 'f1',
      active: pathname === '/' || pathname === '/write',
    },
    {
      label: 'Team',
      to: '/team',
      galleryScreen: 'f10',
      active: pathname === '/team',
    },
    {
      label: 'Resources',
      to: '/more',
      galleryScreen: 'f12',
      active:
        pathname === '/more' ||
        pathname.startsWith('/integrations') ||
        pathname === '/music' ||
        pathname === '/support',
    },
    {
      label: 'Your profile',
      to: '/more/profile',
      galleryScreen: 'f12p',
      active: pathname === '/more/profile',
    },
  ] as const

  return (
    <section aria-label="Team menu" className="rounded-petal-sm glass-menu px-5 py-4 text-left">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <p className="m-0 text-[10.5px] font-semibold tracking-[.1em] text-fg/45 uppercase">Your team</p>
          <p className="mt-1.5 mb-0 font-ui font-normal text-base text-rose-light">{team.name}</p>
        </div>
        <span className="mt-0.5 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
          {team.activeMemberCount} of {team.teamMaximumSize}
        </span>
      </div>
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
      <nav aria-label="Participant navigation" className="mt-2 border-t border-petal-line pt-2">
        {navigation.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            viewTransition
            data-gallery-screen={item.galleryScreen}
            aria-current={item.active ? 'page' : undefined}
            onClick={onNavigate}
            className={`flex min-h-10 items-center rounded-lg px-3 py-1.5 no-underline transition-colors duration-200 ${
              item.active ? 'bg-rose/15 text-rose-light' : 'text-fg/80 hover:bg-fg/5 hover:text-fg'
            }`}
          >
            <span className="min-w-0 text-[13px] font-medium">{item.label}</span>
          </Link>
        ))}
      </nav>

      <div className="mt-2 flex min-h-12 items-center justify-between gap-4 border-t border-petal-line px-3 pt-2">
        <p className="m-0 text-[13px] font-medium text-fg/80">Appearance</p>
        <DaybreakToggle />
      </div>

      {onSignOut ? (
        <button
          type="button"
          onClick={onSignOut}
          className="mt-3 flex w-full items-center justify-between border-t border-petal-line px-3 pt-3 pb-1 text-left text-[12px] text-fg/45 transition-colors hover:text-rose-light"
        >
          Sign out
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
            <path d="m10 17 5-5-5-5M15 12H3" />
          </svg>
        </button>
      ) : null}
    </section>
  )
}
