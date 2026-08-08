import { api } from '@code2create/backend/api'
import { useMutation } from 'convex/react'
import { useState } from 'react'
import { eventSlug } from '../lib/config'
import { operationId, readableError } from '../lib/errors'
import type { CurrentTeam } from '../types'
import { ErrorNotice } from './Form'

type PendingAction =
  | { kind: 'leave' }
  | { kind: 'remove'; teamMemberId: CurrentTeam['members'][number]['teamMemberId']; displayName: string }

export function TeamPanel({ team }: { team: CurrentTeam }) {
  const requestTransfer = useMutation(api.teams.requestLeadershipTransfer)
  const respondToTransfer = useMutation(api.teams.respondToLeadershipTransfer)
  const leaveTeam = useMutation(api.teams.leave)
  const removeMember = useMutation(api.teams.removeMember)
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentTransfer = team.pendingLeadershipTransfer

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

  const transfer = async (membershipId: CurrentTeam['members'][number]['membershipId']) => {
    setBusyMemberId(membershipId)
    setError(null)
    try {
      await requestTransfer({
        eventSlug,
        toMembershipId: membershipId,
        expectedTeamVersion: team.version,
        clientOperationId: operationId('lead-transfer'),
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusyMemberId(null)
    }
  }

  const respond = async (accept: boolean) => {
    if (!currentTransfer) return
    setBusyMemberId(team.currentMembershipId)
    setError(null)
    try {
      await respondToTransfer({
        eventSlug,
        transferId: currentTransfer.id,
        accept,
        clientOperationId: operationId('lead-transfer-response'),
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusyMemberId(null)
    }
  }

  const confirmPendingAction = async () => {
    if (!pendingAction) return
    const busyId = pendingAction.kind === 'leave' ? team.currentMembershipId : pendingAction.teamMemberId
    setBusyMemberId(busyId)
    setError(null)
    try {
      if (pendingAction.kind === 'leave') {
        await leaveTeam({
          eventSlug,
          teamId: team.id,
          expectedTeamVersion: team.version,
          clientOperationId: operationId('team-leave'),
        })
      } else {
        await removeMember({
          eventSlug,
          teamId: team.id,
          targetTeamMemberId: pendingAction.teamMemberId,
          expectedTeamVersion: team.version,
          clientOperationId: operationId('team-member-remove'),
        })
      }
      setPendingAction(null)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusyMemberId(null)
    }
  }

  const canLeave = team.currentRole === 'member' || team.members.length === 1

  return (
    <aside className="team-panel" aria-label="Team">
      <div className="team-panel-heading">
        <div>
          <p className="muted">Team</p>
          <h2>{team.name}</h2>
        </div>
        <span className={team.membershipLocked ? 'lock-state locked' : 'lock-state'}>
          {team.membershipLocked ? 'Locked' : 'Open'}
        </span>
      </div>

      <p className="fine-print">
        {team.members.length} of {team.teamMaximumSize} members
        {team.teamMinimumSize > 1 ? ` · ${team.teamMinimumSize} needed to submit` : ''}
      </p>

      {!team.membershipLocked ? (
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
        {team.members.map((member) => (
          <li key={member.teamMemberId}>
            <div>
              <span>{member.displayName}</span>
              <small>
                {member.role === 'lead' ? 'Team lead' : 'Member'}
                {member.membershipId === team.currentMembershipId ? ' · You' : ''}
              </small>
            </div>
            {team.currentRole === 'lead' && member.role === 'member' && !team.membershipLocked ? (
              <div className="member-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={busyMemberId === member.membershipId}
                  onClick={() => transfer(member.membershipId)}
                >
                  Make lead
                </button>
                <button
                  type="button"
                  className="text-button quiet-danger"
                  disabled={busyMemberId === member.teamMemberId}
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
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {currentTransfer?.toMembershipId === team.currentMembershipId ? (
        <div className="transfer-card">
          <p>The current lead asked you to take over.</p>
          <div className="button-row">
            <button type="button" className="primary compact" onClick={() => respond(true)}>
              Accept
            </button>
            <button type="button" className="secondary compact" onClick={() => respond(false)}>
              Decline
            </button>
          </div>
        </div>
      ) : currentTransfer ? (
        <p className="fine-print">A leadership transfer is waiting for acceptance.</p>
      ) : null}

      {!team.membershipLocked ? (
        <div className="team-exit">
          {canLeave ? (
            <button
              type="button"
              className="text-button quiet-danger"
              onClick={() => setPendingAction({ kind: 'leave' })}
            >
              Leave team
            </button>
          ) : (
            <p className="fine-print">Transfer leadership before leaving.</p>
          )}
        </div>
      ) : null}

      {pendingAction ? (
        <div className="transfer-card action-confirmation">
          <p>
            {pendingAction.kind === 'remove'
              ? `Remove ${pendingAction.displayName}? Their access ends and the join code will change.`
              : team.members.length === 1
                ? 'Leave and close this team?'
                : 'Leave this team? You can create or join another before submissions close.'}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="primary compact"
              disabled={busyMemberId !== null}
              onClick={confirmPendingAction}
            >
              {busyMemberId !== null ? 'Working…' : 'Confirm'}
            </button>
            <button
              type="button"
              className="secondary compact"
              disabled={busyMemberId !== null}
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
