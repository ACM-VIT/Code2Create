import { Link } from 'react-router-dom'
import { Flower } from './FlowerAvatar'
import { assignFlowerVariants } from './flowerVariants'
import type { ClusterMember, ClusterTeam } from './TeamCluster'

export function TeamMenu({
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
  const flowerVariants = assignFlowerVariants(
    members.filter((member) => member.role !== 'lead').map((member) => member.membershipId),
  )
  return (
    <div className="flex w-full max-w-[320px] flex-col items-center gap-8 text-center">
      <div>
        <p className="m-0 font-display font-light tracking-[-.01em] text-[30px] leading-tight text-balance wrap-anywhere text-rose-light">
          {team.name}
        </p>
        <p className="m-0 mt-1.5 text-[11.5px] text-fg/55">
          {team.activeMemberCount} of {team.teamMaximumSize} ·{' '}
          {editable ? (
            <span className="font-mono tracking-[.1em]">{team.publicCode}</span>
          ) : (
            'changes closed'
          )}
        </p>
      </div>

      {/* Rows align left inside a centred, shrink-wrapped block so the
          blooms form a straight column instead of zigzagging. */}
      <ul className="m-0 flex list-none flex-col items-start gap-3.5 p-0">
        {members.map((member) => {
          const lead = member.role === 'lead'
          const isYou = member.membershipId === team.currentMembershipId
          const variant = flowerVariants.get(member.membershipId)
          return (
            <li key={member.teamMemberId} className="flex items-center gap-3">
              <span
                className={`flex size-[28px] flex-none items-center justify-center rounded-full ${
                  lead
                    ? 'border-[1.5px] border-ring-lead bg-avatar-lead'
                    : 'border border-rose/70 bg-avatar'
                }`}
              >
                <Flower
                  seed={member.membershipId}
                  lead={lead}
                  {...(variant === undefined ? {} : { variant })}
                  className="size-[62%]"
                />
              </span>
              <span className="text-[14.5px] text-fg/90">{member.displayName}</span>
              {lead || isYou ? (
                <span className="text-[10.5px] text-rose-light">
                  {[lead ? 'lead' : null, isYou ? 'you' : null].filter(Boolean).join(' · ')}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>

      <nav className="flex flex-col items-center gap-4">
        <Link
          to="/team"
          className="font-display font-light tracking-[-.01em] text-[22px] text-fg no-underline transition-colors hover:text-rose-light"
        >
          {canManage && editable ? 'manage team' : 'view team'}
        </Link>
        <Link
          to="/more"
          className="font-display font-light tracking-[-.01em] text-[22px] text-fg no-underline transition-colors hover:text-rose-light"
        >
          more
        </Link>
        {onSignOut ? (
          <button
            type="button"
            onClick={onSignOut}
            className="font-display font-light tracking-[-.01em] text-[22px] text-fg transition-colors hover:text-rose-light"
          >
            sign out
          </button>
        ) : null}
      </nav>
    </div>
  )
}
