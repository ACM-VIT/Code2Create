import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation } from 'convex/react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Petal } from '../components/portal/Petal'
import { PortalButton, PortalTextButton } from '../components/portal/PortalButton'
import { PortalError } from '../components/portal/PortalField'
import { PortalScene } from '../components/portal/PortalScene'
import { TeamCluster } from '../components/portal/TeamCluster'
import { JoinCodeBar } from '../components/portal/JoinCodeBar'
import { Flower } from '../components/portal/FlowerAvatar'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import { canLeaveCurrentTeam } from '../lib/teamLeave'
import type { CurrentTeam, CurrentTeamMember } from '../types'

type TeamOperationResult =
  | FunctionReturnType<typeof api.teams.requestLeadershipTransfer>
  | FunctionReturnType<typeof api.teams.respondToLeadershipTransfer>
  | FunctionReturnType<typeof api.teams.leave>
  | FunctionReturnType<typeof api.teams.removeMember>

type LobbyMode = 'view' | 'transfer' | 'remove' | 'leave'

// Every decision in the lobby — hand over the lead, remove someone, leave —
// takes the same shape in the same place: question, one full-width button,
// the way out underneath.
export function ConfirmCard({
  question,
  detail,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  busy,
}: {
  question: string
  detail: string | null
  primaryLabel: string
  onPrimary: () => void
  secondaryLabel: string
  onSecondary: () => void
  busy: boolean
}) {
  return (
    <div className="w-full max-w-[380px] rounded-petal-sm glass-menu px-7 pt-6 pb-4 text-center">
      <p className={`m-0 text-[15px] text-fg/90 ${detail ? 'mb-1.5' : 'mb-5'}`}>{question}</p>
      {detail ? <p className="mb-5 text-xs leading-relaxed text-fg/50">{detail}</p> : null}
      <PortalButton type="button" size="sm" disabled={busy} onClick={onPrimary} className="w-full">
        {primaryLabel}
      </PortalButton>
      <PortalTextButton
        type="button"
        disabled={busy}
        onClick={onSecondary}
        className="mx-auto mt-2 block px-4 py-2"
      >
        {secondaryLabel}
      </PortalTextButton>
    </div>
  )
}

/**
 * Mockup f10: the squad lobby as a full page — big roster, the join code with
 * copy/share, and the quiet management links underneath.
 */
export function TeamLobbyScreen({
  team,
  members,
  rosterStatus,
  loadMore,
  editable,
  onSignOut,
}: {
  team: CurrentTeam
  members: CurrentTeamMember[]
  rosterStatus: 'LoadingFirstPage' | 'CanLoadMore' | 'LoadingMore' | 'Exhausted'
  loadMore: (numItems: number) => void
  editable: boolean
  onSignOut: () => void
}) {
  const requestTransfer = useMutation(api.teams.requestLeadershipTransfer)
  const respondToTransfer = useMutation(api.teams.respondToLeadershipTransfer)
  const leaveTeam = useMutation(api.teams.leave)
  const removeMember = useMutation(api.teams.removeMember)
  const operations = useOperationRunner<TeamOperationResult>()
  const [mode, setMode] = useState<LobbyMode>('view')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedMemberId, setSelectedMemberId] = useState<CurrentTeamMember['membershipId'] | null>(null)
  const currentTransfer = team.pendingLeadershipTransfer

  const run = async (command: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await command()
      setMode('view')
      setSelectedMemberId(null)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const transferTo = (membershipId: CurrentTeamMember['membershipId']) =>
    run(() =>
      operations.run('lead-transfer', (clientOperationId) => () => requestTransfer({
        eventSlug,
        toMembershipId: membershipId,
        expectedTeamVersion: team.version,
        clientOperationId,
      })),
    )

  const removeTeamMember = (teamMemberId: CurrentTeamMember['teamMemberId']) =>
    run(() =>
      operations.run('team-member-remove', (clientOperationId) => () => removeMember({
        eventSlug,
        teamId: team.id,
        targetTeamMemberId: teamMemberId,
        expectedTeamVersion: team.version,
        clientOperationId,
      })),
    )

  const respond = (accept: boolean) =>
    run(() =>
      operations.run('lead-transfer-response', (clientOperationId) => {
        if (!currentTransfer) throw new Error('The leadership transfer is no longer available.')
        return () => respondToTransfer({
          eventSlug,
          transferId: currentTransfer.id,
          accept,
          clientOperationId,
        })
      }),
    )

  const leave = () =>
    run(() =>
      operations.run('team-leave', (clientOperationId) => () => leaveTeam({
        eventSlug,
        teamId: team.id,
        expectedTeamVersion: team.version,
        clientOperationId,
      })),
    )

  const openSeats = Math.max(0, team.teamMaximumSize - team.activeMemberCount)
  const picking = mode === 'transfer' || mode === 'remove'
  const selectedMember = members.find((member) => member.membershipId === selectedMemberId)
  const canManage = editable && team.currentRole === 'lead'
  const transferInbound =
    currentTransfer && currentTransfer.toMembershipId === team.currentMembershipId

  return (
    <PortalScene
      tree="right"
      onSignOut={onSignOut}
      header={<TeamCluster team={team} members={members} editable={editable} canManage={canManage} />}
    >
      <div className="flex w-full max-w-[860px] flex-col items-center text-center">
        <p className="mb-2 text-[12px] text-rose-light/70">
          {canManage ? 'manage team' : 'view team'}
        </p>
        <h1 className="mb-11 font-display font-light tracking-[-.01em] wrap-anywhere text-4xl text-shadow-[0_6px_40px_var(--scene-text-glow)] lg:text-[54px]">
          {team.name}
        </h1>

        <div className="mb-10 flex flex-wrap items-start justify-center gap-6 lg:gap-[34px]">
          {members.map((member) => {
            const lead = member.role === 'lead'
            const you = member.membershipId === team.currentMembershipId
            const pickTarget = picking && canManage && !you && !lead
            const pickable = pickTarget && !busy
            return (
              <div
                key={member.teamMemberId}
                className={`w-[104px] transition-opacity duration-250 lg:w-[120px] ${
                  picking && !pickTarget ? 'opacity-40 saturate-[.65]' : ''
                }`}
              >
                <button
                  type="button"
                  disabled={!pickable}
                  onClick={() => {
                    if (pickable) setSelectedMemberId(member.membershipId)
                  }}
                  aria-label={pickable
                    ? `${mode === 'transfer' ? 'Choose' : 'Remove'} ${member.displayName}`
                    : member.displayName}
                  className={`group relative mx-auto flex size-[72px] items-center justify-center rounded-full text-xl font-semibold transition-all duration-250 lg:size-[88px] lg:text-2xl ${
                    lead
                      ? 'border-[2.5px] border-ring-lead bg-avatar-lead shadow-[0_0_26px_var(--avatar-glow),0_14px_30px_var(--shade-1)]'
                      : 'border-2 border-rose/70 bg-avatar shadow-[0_14px_30px_var(--shade-1)]'
                  } ${
                    pickable
                      ? mode === 'transfer'
                        ? 'cursor-pointer hover:-translate-y-1 hover:border-ring-lead hover:bg-avatar-lead hover:shadow-[0_0_26px_var(--avatar-glow),0_14px_30px_var(--shade-1)]'
                        : 'cursor-pointer hover:-translate-y-1 hover:border-rose-light'
                      : 'cursor-default'
                  }`}
                >
                  <Flower seed={member.membershipId} lead={lead} size={38} />
                  {lead ? (
                    <span className="absolute -top-1.5 -right-1">
                      <Petal size={20} />
                    </span>
                  ) : null}
                  {/* What tapping does, worn on the avatar: a petal for the
                      handover, an ✕ for removal. Hovering a transfer target
                      previews them with the lead's ring. */}
                  {pickTarget ? (
                    <span
                      className={`absolute -top-1 -right-1 flex size-[22px] items-center justify-center rounded-full border bg-wash shadow-[0_4px_12px_var(--shade-1)] transition-all duration-250 ${
                        mode === 'remove'
                          ? 'border-rose/70 text-rose-light group-hover:border-rose-light group-hover:bg-rose group-hover:text-wash'
                          : 'border-ring-lead/70 group-hover:border-ring-lead'
                      }`}
                    >
                      {mode === 'remove' ? (
                        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
                          <path
                            d="M1.5 1.5l7 7M8.5 1.5l-7 7"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                          />
                        </svg>
                      ) : (
                        <Petal size={13} />
                      )}
                    </span>
                  ) : null}
                </button>
                <p className="mt-3 mb-0.5 truncate text-sm font-semibold">
                  {member.displayName.split(/\s+/)[0]}
                </p>
                <p
                  className={`m-0 text-[11.5px] ${
                    lead || you ? 'text-rose-light' : 'text-fg/50'
                  }`}
                >
                  {[lead ? 'lead' : null, you ? 'you' : null].filter(Boolean).join(' · ') ||
                    'ready'}
                </p>
              </div>
            )
          })}
          {Array.from({ length: openSeats }, (_, index) => (
            <div key={`open-${index}`} className="w-[104px] lg:w-[120px]">
              <div className="mx-auto flex size-[72px] items-center justify-center rounded-full border-2 border-dashed border-rose/55 bg-avatar/40 text-xl font-semibold text-fg/40 lg:size-[88px]">
                ·
              </div>
              <p className="mt-3 mb-0.5 text-sm font-semibold text-fg/50">
                {editable ? 'open' : 'unused'}
              </p>
            </div>
          ))}
        </div>

        {rosterStatus === 'CanLoadMore' ? (
          <PortalTextButton type="button" className="mb-6" onClick={() => loadMore(25)}>
            show everyone
          </PortalTextButton>
        ) : null}

        {mode === 'leave' ? (
          <ConfirmCard
            question={
              team.activeMemberCount === 1 ? `Leave and close ${team.name}?` : `Leave ${team.name}?`
            }
            detail={null}
            primaryLabel={busy ? 'Leaving…' : 'Leave team'}
            onPrimary={() => void leave()}
            secondaryLabel="stay"
            onSecondary={() => setMode('view')}
            busy={busy}
          />
        ) : picking && selectedMember ? (
          <ConfirmCard
            question={
              mode === 'transfer'
                ? `Make ${selectedMember.displayName} the team lead?`
                : `Remove ${selectedMember.displayName} from the team?`
            }
            detail={
              mode === 'transfer'
                ? 'They take over once they accept.'
                : 'Their access ends and the join code changes.'
            }
            primaryLabel={busy ? 'Working…' : mode === 'transfer' ? 'Send the request' : 'Remove them'}
            onPrimary={() => {
              if (mode === 'transfer') void transferTo(selectedMember.membershipId)
              else void removeTeamMember(selectedMember.teamMemberId)
            }}
            secondaryLabel="back"
            onSecondary={() => setSelectedMemberId(null)}
            busy={busy}
          />
        ) : picking ? (
          <div>
            <p className="mb-1.5 text-[13.5px] text-rose-light">
              {mode === 'transfer' ? 'tap who takes the lead' : 'tap who to remove'}
            </p>
            <PortalTextButton
              type="button"
              disabled={busy}
              className="px-4 py-2"
              onClick={() => {
                setMode('view')
                setSelectedMemberId(null)
              }}
            >
              never mind
            </PortalTextButton>
          </div>
        ) : transferInbound && editable ? (
          <ConfirmCard
            question={`You’ve been asked to lead ${team.name}.`}
            detail={null}
            primaryLabel={busy ? 'Working…' : 'Accept the lead'}
            onPrimary={() => void respond(true)}
            secondaryLabel="decline"
            onSecondary={() => void respond(false)}
            busy={busy}
          />
        ) : (
          <>
            {currentTransfer && editable ? (
              <p className="mb-4 text-[12.5px] text-fg/55">
                Waiting for{' '}
                {members.find((member) => member.membershipId === currentTransfer.toMembershipId)
                  ?.displayName ?? 'a teammate'}{' '}
                to accept the lead.
              </p>
            ) : null}
            {editable ? (
          <JoinCodeBar code={team.publicCode} />
            ) : null}
          </>
        )}

        <PortalError message={error} />
        {mode !== 'view' ? null : editable ? (
          <div className="mt-7 flex flex-wrap items-baseline justify-center gap-x-3.5 gap-y-1 text-[13.5px] text-fg/45">
            {team.canTransferLeadership && members.length > 1 ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  className="py-1 text-fg/65 transition-colors hover:text-rose-light"
                  onClick={() => {
                    setMode('transfer')
                    setSelectedMemberId(null)
                  }}
                >
                  change leader
                </button>
                <span aria-hidden className="text-fg/30">·</span>
              </>
            ) : null}
            {team.canManageMembers && members.length > 1 ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  className="py-1 text-fg/65 transition-colors hover:text-rose-light"
                  onClick={() => {
                    setMode('remove')
                    setSelectedMemberId(null)
                  }}
                >
                  remove a member
                </button>
                <span aria-hidden className="text-fg/30">·</span>
              </>
            ) : null}
            {canLeaveCurrentTeam(team) ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  className="py-1 text-fg/65 transition-colors hover:text-rose-light"
                  onClick={() => setMode('leave')}
                >
                  leave team
                </button>
                <span aria-hidden className="text-fg/30">·</span>
              </>
            ) : null}
            <span>
              {`changes close ${new Date(team.membershipEditableUntil).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}`}
            </span>
            <span aria-hidden className="text-fg/30">·</span>
            <Link to="/" viewTransition className="py-1 text-rose-light">
              back home
            </Link>
          </div>
        ) : (
          <p className="mt-7 text-[13px] text-fg/45">
            changes closed{' · '}
            <Link to="/" viewTransition className="text-rose-light">
              back home
            </Link>
          </p>
        )}
      </div>
    </PortalScene>
  )
}
