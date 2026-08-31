import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Petal } from './Petal'
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
 * The top-right team presence: an overlapping avatar stack that opens the
 * roster on hover or focus. Only data the roster query actually returns is
 * shown — name, lead role, the join code, and the seat count.
 */
export function TeamCluster({
  team,
  members,
  editable = true,
  canManage = false,
  onSignOut,
}: {
  team: ClusterTeam
  members: readonly ClusterMember[]
  editable?: boolean
  canManage?: boolean
  onSignOut?: () => void
}) {
  // Hover previews the roster; a click (or keyboard focus) pins it open so it
  // survives the pointer leaving. Tracking them separately keeps a click on an
  // already-hovered cluster from closing it immediately.
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const open = pinned || hovered
  const shown = members.slice(0, 4)
  // One deal for the whole roster so no two members share a bloom.
  const flowerVariants = assignFlowerVariants(
    members.filter((member) => member.role !== 'lead').map((member) => member.membershipId),
  )

  return (
    <div
      className="relative text-right"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setPinned(true)}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
        setPinned(false)
      }}
    >
      <div className="flex items-start justify-end">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Team ${team.name}, ${team.activeMemberCount} of ${team.teamMaximumSize} members`}
          onClick={() => setPinned((value) => !value)}
          className="block cursor-pointer rounded-lg"
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
                  className={index > 0 ? '-ml-2 lg:-ml-2.5' : ''}
                />
              )
            })}
          </div>
          <p className="mt-2 hidden font-ui font-normal text-[13.5px] text-rose-light sm:block">
            {team.name}
          </p>
        </button>
        {onSignOut ? (
          /* Sign-out rides the stack as one more circle — an exit door, not a person. */
          <button
            type="button"
            title="Sign out"
            aria-label="Sign out"
            onClick={onSignOut}
            className="-ml-2 flex size-10 flex-none items-center justify-center rounded-full border-2 border-dashed border-rose/45 bg-avatar/60 text-fg/50 transition-all duration-250 hover:border-rose-light hover:text-rose-light lg:-ml-2.5 lg:size-12"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
              <path d="M10 17l5-5-5-5" />
              <path d="M15 12H3" />
            </svg>
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="absolute right-0 top-[96px] z-10 w-[300px] max-w-[calc(100vw-40px)] rounded-petal-sm border border-rose-light/60 bg-[image:var(--roster-bg)] px-5 py-4 text-left shadow-[0_30px_60px_-18px_var(--shade-2),0_0_34px_var(--glow-rose-soft)] backdrop-blur-lg lg:top-[104px]">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="font-ui font-normal text-base text-rose-light">{team.name}</span>
            <span className="text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
              {team.activeMemberCount} of {team.teamMaximumSize}
            </span>
          </div>
          {/* Preflight is off, so a bare ul keeps the UA's 40px indent. */}
          <ul className="m-0 list-none p-0">
            {members.map((member) => {
              const isYou = member.membershipId === team.currentMembershipId
              const variant = flowerVariants.get(member.membershipId)
              return (
                <li
                  key={member.teamMemberId}
                  className="flex items-center gap-3 border-b border-petal-line py-2.5 last:border-b-0"
                >
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
              <span className="font-mono text-[12.5px] tracking-[.12em] text-rose-light">
                {team.publicCode}
              </span>
            ) : (
              <p className="m-0 flex items-center gap-1.5 text-[11.5px] text-fg/50">
                <Petal size={12} />
                changes closed
              </p>
            )}
            <Link
              to="/team"
              viewTransition
              className="flex-none text-[11.5px] text-fg/55 transition-colors hover:text-rose-light"
            >
              {canManage && editable ? 'manage team' : 'view team'} →
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  )
}
