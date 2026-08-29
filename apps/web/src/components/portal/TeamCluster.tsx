import { useState } from 'react'
import { Petal } from './Petal'
import { PortalButton, PortalTextButton } from './PortalButton'
import { PortalError } from './PortalField'
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

export type TeamClusterLeaveAction = {
  available: boolean
  blockedMessage?: string
  pending: boolean
  retrying: boolean
  error: string | null
  onConfirm: () => Promise<void>
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
 * roster on hover or focus. Only data the roster query actually returns is
 * shown — name, lead role, the join code, and the seat count.
 */
export function TeamCluster({
  team,
  members,
  locked = false,
  leaveAction,
}: {
  team: ClusterTeam
  members: readonly ClusterMember[]
  locked?: boolean
  leaveAction?: TeamClusterLeaveAction
}) {
  // Hover previews the roster; a click (or keyboard focus) pins it open so it
  // survives the pointer leaving. Tracking them separately keeps a click on an
  // already-hovered cluster from closing it immediately.
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [confirmingLeave, setConfirmingLeave] = useState(false)
  const open = pinned || hovered
  const shown = members.slice(0, 4)

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
        setConfirmingLeave(false)
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Team ${team.name}, ${team.activeMemberCount} of ${team.teamMaximumSize} members${locked ? ', locked' : ''}`}
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
        <p className="mt-2 font-display text-[13.5px] italic text-rose-light">
          {team.name}{locked ? ' · locked' : ''}
        </p>
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
          {!locked ? (
            <div className="mt-3 border-t border-petal-line pt-3">
              <span className="font-mono text-[12.5px] tracking-[.12em] text-rose-light">
                {team.publicCode}
              </span>
            </div>
          ) : null}
          {!locked && leaveAction ? (
            <div className="mt-3 border-t border-petal-line pt-3">
              {confirmingLeave ? (
                <div
                  role="alertdialog"
                  aria-label={`Confirm leaving ${team.name}`}
                  className="rounded-petal-xs border border-petal-edge-soft bg-[linear-gradient(155deg,rgba(255,255,255,.08),rgba(12,0,4,.78)_62%)] px-4 py-3.5 shadow-[0_18px_36px_-16px_rgba(0,0,0,.9)]"
                >
                  <p className="mb-3 text-[12.5px] leading-relaxed text-[rgb(248_248_248/.72)]">
                    {team.activeMemberCount === 1
                      ? `Leave and close ${team.name}?`
                      : `Leave ${team.name}? You can create or join another team before submissions close.`}
                  </p>
                  <PortalButton
                    type="button"
                    size="sm"
                    className="w-full"
                    disabled={leaveAction.pending}
                    onClick={() => void leaveAction.onConfirm()}
                  >
                    {leaveAction.pending
                      ? 'Leaving…'
                      : leaveAction.retrying
                        ? 'Confirm earlier leave'
                        : 'Confirm leave'}
                  </PortalButton>
                  <PortalTextButton
                    type="button"
                    className="mt-3 w-full"
                    disabled={leaveAction.pending}
                    onClick={() => setConfirmingLeave(false)}
                  >
                    Keep team
                  </PortalTextButton>
                  <PortalError message={leaveAction.error} />
                </div>
              ) : leaveAction.available ? (
                <button
                  type="button"
                  className="rounded-sm text-[12px] text-[rgb(248_248_248/.45)] underline-offset-4 transition-colors hover:text-rose-light hover:underline"
                  disabled={leaveAction.pending}
                  onClick={() => {
                    setPinned(true)
                    setConfirmingLeave(true)
                  }}
                >
                  Leave team
                </button>
              ) : leaveAction.blockedMessage ? (
                <p className="m-0 text-[11px] leading-relaxed text-[rgb(248_248_248/.42)]">
                  {leaveAction.blockedMessage}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
