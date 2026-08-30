import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation } from 'convex/react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Petal } from '../components/portal/Petal'
import { PortalButton, PortalTextButton } from '../components/portal/PortalButton'
import { PortalError } from '../components/portal/PortalField'
import { PortalScene } from '../components/portal/PortalScene'
import { initialsOf } from '../components/portal/initials'
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

/**
 * Mockup f10: the squad lobby as a full page — big roster, the join code with
 * copy/share, and the quiet management links underneath.
 */
export function TeamLobbyScreen({
  team,
  members,
  rosterStatus,
  loadMore,
  locked,
  onSignOut,
}: {
  team: CurrentTeam
  members: CurrentTeamMember[]
  rosterStatus: 'LoadingFirstPage' | 'CanLoadMore' | 'LoadingMore' | 'Exhausted'
  loadMore: (numItems: number) => void
  locked: boolean
  onSignOut: () => void
}) {
  const requestTransfer = useMutation(api.teams.requestLeadershipTransfer)
  const respondToTransfer = useMutation(api.teams.respondToLeadershipTransfer)
  const leaveTeam = useMutation(api.teams.leave)
  const removeMember = useMutation(api.teams.removeMember)
  const operations = useOperationRunner<TeamOperationResult>()
  const [mode, setMode] = useState<LobbyMode>('view')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentTransfer = team.pendingLeadershipTransfer

  const run = async (command: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await command()
      setMode('view')
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

  const copyCode = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('Copying is unavailable in this browser.')
    }
  }

  const joinLink = `${window.location.origin}/join/${team.publicCode}`
  const openSeats = Math.max(0, team.teamMaximumSize - team.activeMemberCount)
  const picking = mode === 'transfer' || mode === 'remove'
  const transferInbound =
    currentTransfer && currentTransfer.toMembershipId === team.currentMembershipId

  return (
    <PortalScene
      tree="right"
      header={
        <div className="flex flex-col items-end gap-1">
          <p className="m-0 font-ui text-[13.5px] text-[rgb(254_180_203/.8)]">
            {team.activeMemberCount} of {team.teamMaximumSize} seats
          </p>
          <button
            type="button"
            onClick={onSignOut}
            className="text-[11.5px] text-[rgb(248_248_248/.45)] transition-colors hover:text-rose-light"
          >
            sign out
          </button>
        </div>
      }
    >
      <div className="flex w-full max-w-[860px] flex-col items-center text-center">
        <p className="mb-2 font-ui text-lg text-rose-light">your squad</p>
        <h1 className="mb-11 font-display font-light tracking-[-.01em] text-4xl text-shadow-[0_6px_40px_rgba(0,0,0,.6)] lg:text-[54px]">
          {team.name}
        </h1>

        {transferInbound ? (
          <div className="mb-8 w-full max-w-[520px] rounded-petal-sm border border-petal-edge bg-[rgb(12_0_4/.6)] px-6 py-4 backdrop-blur-md">
            <p className="mb-3 text-[13px] text-[rgb(248_248_248/.85)]">
              You’ve been asked to lead {team.name}.
            </p>
            <div className="flex justify-center gap-3">
              <PortalButton type="button" size="xs" disabled={busy} onClick={() => void respond(true)}>
                Accept the lead
              </PortalButton>
              <PortalTextButton type="button" disabled={busy} onClick={() => void respond(false)}>
                decline
              </PortalTextButton>
            </div>
          </div>
        ) : currentTransfer ? (
          <p className="mb-8 text-[12.5px] text-[rgb(248_248_248/.55)]">
            Waiting for{' '}
            {members.find((member) => member.membershipId === currentTransfer.toMembershipId)
              ?.displayName ?? 'a teammate'}{' '}
            to accept the lead.
          </p>
        ) : null}

        <div className="mb-10 flex flex-wrap items-start justify-center gap-6 lg:gap-[34px]">
          {members.map((member) => {
            const lead = member.role === 'lead'
            const you = member.membershipId === team.currentMembershipId
            const pickable =
              picking &&
              !you &&
              (mode === 'transfer' ? !lead : true) &&
              !busy
            return (
              <div key={member.teamMemberId} className="w-[104px] lg:w-[120px]">
                <button
                  type="button"
                  disabled={!pickable}
                  onClick={() => {
                    if (mode === 'transfer') void transferTo(member.membershipId)
                    else if (mode === 'remove') void removeTeamMember(member.teamMemberId)
                  }}
                  className={`relative mx-auto flex size-[72px] items-center justify-center rounded-full text-xl font-semibold transition-all duration-250 lg:size-[88px] lg:text-2xl ${
                    lead
                      ? 'border-[2.5px] border-rose-light bg-avatar-lead shadow-[0_0_26px_rgba(254,180,203,.5),0_14px_30px_rgba(0,0,0,.6)]'
                      : 'border-2 border-[rgb(216_132_162/.7)] bg-avatar shadow-[0_14px_30px_rgba(0,0,0,.6)]'
                  } ${pickable ? 'cursor-pointer hover:-translate-y-1 hover:border-rose-light' : 'cursor-default'}`}
                >
                  {initialsOf(member.displayName)}
                  {lead ? (
                    <span className="absolute -top-1.5 -right-1">
                      <Petal size={20} />
                    </span>
                  ) : null}
                </button>
                <p className="mt-3 mb-0.5 truncate text-sm font-semibold">
                  {member.displayName.split(/\s+/)[0]}
                </p>
                <p
                  className={`m-0 text-[11.5px] ${
                    lead || you ? 'text-rose-light' : 'text-[rgb(248_248_248/.5)]'
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
              <div className="mx-auto flex size-[72px] items-center justify-center rounded-full border-2 border-dashed border-[rgb(216_132_162/.55)] bg-[rgb(42_14_24/.4)] text-xl font-semibold text-[rgb(248_248_248/.4)] lg:size-[88px]">
                ·
              </div>
              <p className="mt-3 mb-0.5 text-sm font-semibold text-[rgb(248_248_248/.5)]">open</p>
              <p className="m-0 text-[11.5px] text-[rgb(248_248_248/.4)]">share the code</p>
            </div>
          ))}
        </div>

        {rosterStatus === 'CanLoadMore' ? (
          <PortalTextButton type="button" className="mb-6" onClick={() => loadMore(25)}>
            show everyone
          </PortalTextButton>
        ) : null}

        {picking ? (
          <div className="mb-6">
            <p className="mb-2 text-[12.5px] text-rose-light">
              {mode === 'transfer' ? 'pick who should lead' : 'pick who to remove'}
            </p>
            <PortalTextButton type="button" disabled={busy} onClick={() => setMode('view')}>
              never mind
            </PortalTextButton>
          </div>
        ) : null}

        {mode === 'leave' ? (
          <div className="mb-6 w-full max-w-[420px] rounded-petal-sm border border-petal-edge-soft bg-[rgb(12_0_4/.6)] px-6 py-4 backdrop-blur-md">
            <p className="mb-3 text-[13px] text-[rgb(248_248_248/.85)]">
              {team.activeMemberCount === 1
                ? `Leave and close ${team.name}?`
                : `Leave ${team.name}?`}
            </p>
            <div className="flex justify-center gap-3">
              <PortalButton type="button" size="xs" disabled={busy} onClick={() => void leave()}>
                {busy ? 'Leaving…' : 'Confirm leave'}
              </PortalButton>
              <PortalTextButton type="button" disabled={busy} onClick={() => setMode('view')}>
                stay
              </PortalTextButton>
            </div>
          </div>
        ) : null}

        {!locked ? (
          <div className="flex items-center gap-3.5 rounded-petal-sm border border-petal-edge bg-[linear-gradient(155deg,rgba(255,255,255,.09),rgba(12,0,4,.5)_55%)] px-6 py-3 shadow-[0_24px_50px_-18px_rgba(0,0,0,.8)] backdrop-blur-md">
            <span className="font-mono text-[17px] tracking-[.14em] text-rose-light lg:text-[19px]">
              {team.publicCode}
            </span>
            <span aria-hidden className="h-[18px] w-px bg-[rgb(216_132_162/.4)]" />
            <button
              type="button"
              onClick={() => void copyCode(team.publicCode)}
              className="text-[13px] text-paper transition-colors hover:text-rose-light"
            >
              {copied ? 'copied' : 'copy'}
            </button>
            <button
              type="button"
              onClick={() => void copyCode(joinLink)}
              className="text-[13px] text-paper transition-colors hover:text-rose-light"
            >
              share link
            </button>
          </div>
        ) : (
          <p className="font-ui text-[13.5px] text-rose-light">team locked</p>
        )}

        {!locked ? (
          <div className="mt-6 flex flex-wrap justify-center gap-x-7 gap-y-2 text-[12.5px]">
            {team.canTransferLeadership && members.length > 1 ? (
              <PortalTextButton type="button" disabled={busy} onClick={() => setMode('transfer')}>
                transfer lead
              </PortalTextButton>
            ) : null}
            {team.canManageMembers && members.length > 1 ? (
              <PortalTextButton type="button" disabled={busy} onClick={() => setMode('remove')}>
                remove a member
              </PortalTextButton>
            ) : null}
            {canLeaveCurrentTeam(team) ? (
              <PortalTextButton type="button" disabled={busy} onClick={() => setMode('leave')}>
                leave team
              </PortalTextButton>
            ) : null}
          </div>
        ) : null}

        <PortalError message={error} />
        <p className="mt-4.5 text-[11.5px] text-[rgb(248_248_248/.4)]">
          {locked ? 'membership locked at submission' : 'editable until you submit'} ·{' '}
          <Link to="/" className="text-rose-light">
            back home
          </Link>
        </p>
      </div>
    </PortalScene>
  )
}
