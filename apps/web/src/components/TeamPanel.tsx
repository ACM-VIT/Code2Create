import { api } from '@code2create/backend/api'
import { useMutation } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useEffect, useState } from 'react'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import type { CurrentTeam, CurrentTeamMember } from '../types'
import { ErrorNotice } from './Form'

type PendingAction =
  | { kind: 'leave' }
  | { kind: 'remove'; teamMemberId: CurrentTeamMember['teamMemberId']; displayName: string }
type TeamOperationResult =
  | FunctionReturnType<typeof api.teams.requestLeadershipTransfer>
  | FunctionReturnType<typeof api.teams.respondToLeadershipTransfer>
  | FunctionReturnType<typeof api.teams.leave>
  | FunctionReturnType<typeof api.teams.removeMember>

export function TeamPanel({
  team,
  members,
  rosterStatus,
  loadMore,
  editable,
}: {
  team: CurrentTeam
  members: CurrentTeamMember[]
  rosterStatus: 'LoadingFirstPage' | 'CanLoadMore' | 'LoadingMore' | 'Exhausted'
  loadMore: (numItems: number) => void
  editable: boolean
}) {
  const requestTransfer = useMutation(api.teams.requestLeadershipTransfer)
  const respondToTransfer = useMutation(api.teams.respondToLeadershipTransfer)
  const leaveTeam = useMutation(api.teams.leave)
  const removeMember = useMutation(api.teams.removeMember)
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null)
  const [pendingTransferResponse, setPendingTransferResponse] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentTransfer = team.pendingLeadershipTransfer
  const operations = useOperationRunner<TeamOperationResult>()
  const transferPending = operations.hasPending('lead-transfer')
  const responsePending = operations.hasPending('lead-transfer-response')
  const leavePending = operations.hasPending('team-leave')
  const removePending = operations.hasPending('team-member-remove')
  const actionPending = leavePending || removePending
  const operationPending = transferPending || responsePending || actionPending
  const canManage = editable && team.currentRole === 'lead'

  useEffect(() => {
    if (
      !transferPending
      || transferTargetId === null
      || !members.some(
        (member) => member.membershipId === transferTargetId && member.role === 'lead',
      )
    ) {
      return
    }
    operations.confirmExactObservation('lead-transfer')
    setTransferTargetId(null)
    setError(null)
  }, [members, operations, transferPending, transferTargetId])

  const copyJoinLink = async () => {
    const link = `${window.location.origin}/join/${team.publicCode}`
    setError(null)
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setError(`Copy failed. Share code ${team.publicCode} instead.`)
    }
  }

  const transfer = async (membershipId: CurrentTeamMember['membershipId']) => {
    if (transferPending && transferTargetId !== membershipId) return
    if (!transferPending) setTransferTargetId(membershipId)
    setBusyMemberId(membershipId)
    setError(null)
    try {
      await operations.run('lead-transfer', (clientOperationId) => () => requestTransfer({ eventSlug, toMembershipId: membershipId, expectedTeamVersion: team.version, clientOperationId }))
      setTransferTargetId(null)
    } catch (caught) {
      if (!operations.hasPending('lead-transfer')) setTransferTargetId(null)
      setError(readableError(caught))
    } finally {
      setBusyMemberId(null)
    }
  }

  const respond = async (accept: boolean) => {
    if (responsePending && pendingTransferResponse !== accept) return
    if (!responsePending && !currentTransfer) return
    if (!responsePending) setPendingTransferResponse(accept)
    setBusyMemberId(team.currentMembershipId)
    setError(null)
    try {
      await operations.run('lead-transfer-response', (clientOperationId) => {
        if (!currentTransfer) throw new Error('The leadership transfer is no longer available.')
        return () => respondToTransfer({
          eventSlug,
          transferId: currentTransfer.id,
          accept,
          clientOperationId,
        })
      })
      setPendingTransferResponse(null)
    } catch (caught) {
      if (!operations.hasPending('lead-transfer-response')) setPendingTransferResponse(null)
      setError(readableError(caught))
    } finally {
      setBusyMemberId(null)
    }
  }

  const confirmPendingAction = async () => {
    if (!actionPending && !pendingAction) return
    if (!pendingAction) return
    const busyId = pendingAction.kind === 'leave' ? team.currentMembershipId : pendingAction.teamMemberId
    setBusyMemberId(busyId)
    setError(null)
    try {
      if (pendingAction.kind === 'leave') {
        await operations.run('team-leave', (clientOperationId) => () => leaveTeam({ eventSlug, teamId: team.id, expectedTeamVersion: team.version, clientOperationId }))
      } else {
        await operations.run('team-member-remove', (clientOperationId) => () => removeMember({
            eventSlug,
            teamId: team.id,
            targetTeamMemberId: pendingAction.teamMemberId,
            expectedTeamVersion: team.version,
            clientOperationId,
          }))
      }
      setPendingAction(null)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusyMemberId(null)
    }
  }

  const canLeaveByTeamRule = team.currentRole === 'member' || team.activeMemberCount === 1

  return (
    <aside className="team-panel" aria-label="Team">
      <div className="team-panel-heading">
        <div>
          <p className="muted">Team</p>
          <h2>{team.name}</h2>
        </div>
        <span className="lock-state">{canManage ? 'Manage team' : 'View team'}</span>
      </div>

      <p className="fine-print">
        {team.activeMemberCount} of {team.teamMaximumSize} members
        {team.teamMinimumSize > 1 ? ` · ${team.teamMinimumSize} needed to submit` : ''}
      </p>

      {editable ? (
        <div className="team-code-row">
          <div>
            <span className="field-label">Join code</span>
            <code>{team.publicCode}</code>
          </div>
          <button type="button" className="secondary compact" onClick={copyJoinLink}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      ) : null}

      <ul className="member-list">
        {members.map((member) => {
          const canTransferToMember =
            team.currentRole === 'lead' && team.canTransferLeadership && member.role === 'member'
          const canRemoveMember =
            team.canManageMembers &&
            member.role === 'member' &&
            member.membershipId !== team.currentMembershipId
          return (
            <li key={member.teamMemberId}>
              <div>
                <span>{member.displayName}</span>
                <small>
                  {member.role === 'lead' ? 'Team lead' : 'Member'}
                  {member.membershipId === team.currentMembershipId ? ' · You' : ''}
                </small>
              </div>
              {editable && (canTransferToMember || canRemoveMember) ? (
                <div className="member-actions">
                  {canTransferToMember ? (
                    <button
                      type="button"
                      className="text-button"
                      disabled={
                        busyMemberId !== null ||
                        responsePending ||
                        actionPending ||
                        (transferPending && transferTargetId !== member.membershipId)
                      }
                      onClick={() => transfer(member.membershipId)}
                    >
                      {transferPending && transferTargetId === member.membershipId
                        ? 'Confirm earlier transfer'
                        : 'Make lead'}
                    </button>
                  ) : null}
                  {canRemoveMember ? (
                    <button
                      type="button"
                      className="text-button quiet-danger"
                      disabled={busyMemberId !== null || operationPending}
                      onClick={() =>
                        setPendingAction({
                          kind: 'remove',
                          teamMemberId: member.teamMemberId,
                          displayName: member.displayName,
                        })
                      }
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {rosterStatus === 'CanLoadMore' || rosterStatus === 'LoadingMore' ? (
        <button
          type="button"
          className="secondary compact"
          disabled={rosterStatus === 'LoadingMore'}
          onClick={() => loadMore(25)}
        >
          {rosterStatus === 'LoadingMore' ? 'Loading members…' : 'Load more members'}
        </button>
      ) : null}

      {(editable && currentTransfer?.toMembershipId === team.currentMembershipId && team.canRespondToLeadershipTransfer) || responsePending ? (
        <div className="transfer-card">
          <p>The current lead asked you to take over.</p>
          <div className="button-row">
            <button
              type="button"
              className="primary compact"
              disabled={busyMemberId !== null || transferPending || actionPending || (responsePending && pendingTransferResponse !== true)}
              onClick={() => respond(true)}
            >
              {responsePending && pendingTransferResponse === true ? 'Confirm earlier acceptance' : 'Accept'}
            </button>
            <button
              type="button"
              className="secondary compact"
              disabled={busyMemberId !== null || transferPending || actionPending || (responsePending && pendingTransferResponse !== false)}
              onClick={() => respond(false)}
            >
              {responsePending && pendingTransferResponse === false ? 'Confirm earlier decline' : 'Decline'}
            </button>
          </div>
        </div>
      ) : editable && currentTransfer?.toMembershipId === team.currentMembershipId ? (
        <p className="fine-print">A leadership transfer is waiting, but this account cannot respond.</p>
      ) : editable && currentTransfer ? (
        <p className="fine-print">A leadership transfer is waiting for acceptance.</p>
      ) : null}

      {editable ? (
        <div className="team-exit">
          {team.canLeave && canLeaveByTeamRule ? (
            <button
              type="button"
              className="text-button quiet-danger"
              disabled={operationPending || busyMemberId !== null}
              onClick={() => setPendingAction({ kind: 'leave' })}
            >
              Leave team
            </button>
          ) : team.canLeave ? (
            <p className="fine-print">Transfer leadership before leaving.</p>
          ) : (
            <p className="fine-print">Leaving this team is unavailable.</p>
          )}
        </div>
      ) : null}

      <p className="fine-print">
        {editable
          ? `Team changes close ${new Date(team.membershipEditableUntil).toLocaleString()}.`
          : 'Team changes are closed.'}
      </p>

      {pendingAction ? (
        <div className="transfer-card action-confirmation">
          <p>
            {pendingAction.kind === 'remove'
              ? `Remove ${pendingAction.displayName}? Their access ends and the join code will change.`
              : team.activeMemberCount === 1
                ? 'Leave and close this team?'
                : 'Leave this team? You can create or join another before submissions close.'}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="primary compact"
              disabled={busyMemberId !== null || transferPending || responsePending}
              onClick={confirmPendingAction}
            >
              {busyMemberId !== null
                ? 'Working…'
                : actionPending
                  ? 'Confirm earlier action'
                  : 'Confirm'}
            </button>
            <button
              type="button"
              className="secondary compact"
              disabled={busyMemberId !== null || operationPending}
              onClick={() => setPendingAction(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <ErrorNotice message={error} />
    </aside>
  )
}
