import { useState, type ReactNode } from 'react'
import { Petal } from './Petal'
import { initialsOf } from './initials'

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
  lead,
  size = 'md',
  className = '',
}: {
  displayName: string
  lead: boolean
  size?: 'sm' | 'md'
  className?: string
}) {
  // The mockup's 44px stack crowds a 390px header, so it steps down on mobile.
  const box = size === 'md' ? 'size-9 text-[11px] lg:size-11 lg:text-[13px]' : 'size-[30px] text-[10.5px]'
  return (
    <div
      title={displayName}
      className={`flex flex-none items-center justify-center rounded-full font-semibold ${box} ${
        lead
          ? 'border-2 border-rose-light bg-avatar-lead shadow-[0_0_18px_rgba(254,180,203,.5)]'
          : 'border-2 border-[rgb(216_132_162/.7)] bg-avatar'
      } ${className}`}
    >
      {initialsOf(displayName)}
    </div>
  )
}

/**
 * The top-right team presence: an overlapping avatar stack that opens the
 * roster on hover or focus. The roster shows name, lead role, the join code,
 * and the seat count. Live screens can pass leave actions in `actions`.
 */
export function TeamCluster({
  team,
  members,
  locked = false,
  actions,
}: {
  team: ClusterTeam
  members: readonly ClusterMember[]
  locked?: boolean
  actions?: ReactNode
}) {
  // Hover previews the roster; a click (or keyboard focus) pins it open so it
  // survives the pointer leaving. Tracking them separately keeps a click on an
  // already-hovered cluster from closing it immediately.
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const open = pinned || hovered
  const shown = members.slice(0, 4)

  if (locked) {
    return (
      <p className="font-display text-[13.5px] italic text-rose-light">{team.name} · locked</p>
    )
  }

  return (
    <div
      className="relative text-right"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setPinned(true)}
      onBlurCapture={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) return
        setPinned(false)
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Team ${team.name}, ${team.activeMemberCount} of ${team.teamMaximumSize} members`}
        onClick={() => setPinned((value) => !value)}
        className="block cursor-pointer rounded-lg"
      >
        <div className="flex justify-end">
          {shown.map((member, index) => (
            <Avatar
              key={member.teamMemberId}
              displayName={member.displayName}
              lead={member.role === 'lead'}
              className={index > 0 ? '-ml-2 lg:-ml-2.5' : ''}
            />
          ))}
        </div>
        <p className="mt-2 font-display text-[13.5px] italic text-rose-light">{team.name}</p>
      </button>

      {open ? (
        <div className="absolute right-0 top-[92px] z-10 w-[300px] rounded-petal-sm border border-[rgb(254_180_203/.6)] bg-[linear-gradient(155deg,rgba(255,255,255,.1),rgba(12,0,4,.72)_55%,rgba(160,66,99,.22))] px-5 py-4 text-left shadow-[0_30px_60px_-18px_rgba(0,0,0,.9),0_0_34px_rgba(216,132,162,.22)] backdrop-blur-lg">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="font-display text-base italic text-rose-light">{team.name}</span>
            <span className="text-[10.5px] font-semibold tracking-[.14em] text-[rgb(248_248_248/.5)] uppercase">
              {team.activeMemberCount} of {team.teamMaximumSize}
            </span>
          </div>
          <ul>
            {members.map((member) => {
              const isYou = member.membershipId === team.currentMembershipId
              return (
                <li
                  key={member.teamMemberId}
                  className="flex items-center gap-3 border-b border-petal-line py-2.5 last:border-b-0"
                >
                  <Avatar displayName={member.displayName} lead={member.role === 'lead'} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-semibold">{member.displayName}</div>
                    <div
                      className={`text-[10.5px] ${
                        member.role === 'lead' || isYou
                          ? 'font-display italic text-rose-light'
                          : 'text-[rgb(248_248_248/.5)]'
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
          <div className="mt-3 border-t border-petal-line pt-3">
            <span className="font-mono text-[12.5px] tracking-[.12em] text-rose-light">
              {team.publicCode}
            </span>
          </div>
          {actions}
        </div>
      ) : null}
    </div>
  )
}
