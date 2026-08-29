import { api } from '@code2create/backend/api'
import { useMutation } from 'convex/react'
import { useState } from 'react'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import { canLeaveCurrentTeam, leaveTeamPrompt } from '../lib/teamLeave'
import type { CurrentTeam } from '../types'
import { ErrorNotice } from './Form'
import { PortalButton, PortalTextButton } from './portal/PortalButton'
import { PortalError } from './portal/PortalField'

export function LeaveTeamControl({
  team,
  variant,
  disabled = false,
}: {
  team: CurrentTeam
  variant: 'panel' | 'cluster'
  disabled?: boolean
}) {
  const leaveTeam = useMutation(api.teams.leave)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operations = useOperationRunner()
  const leavePending = operations.hasPending('team-leave')
  const allowed = canLeaveCurrentTeam(team)

  const confirmLeave = async () => {
    if (!confirming && !leavePending) return
    setError(null)
    try {
      await operations.run(
        'team-leave',
        (clientOperationId) => () =>
          leaveTeam({
            eventSlug,
            teamId: team.id,
            expectedTeamVersion: team.version,
            clientOperationId,
          }),
      )
      setConfirming(false)
    } catch (caught) {
      setError(readableError(caught))
    }
  }

  const prompt = leaveTeamPrompt(team.activeMemberCount)
  const unavailable = team.canLeave
    ? 'Transfer leadership before leaving.'
    : 'Leaving this team is unavailable.'

  if (variant === 'cluster') {
    return (
      <div className="mt-3 border-t border-petal-line pt-3">
        {allowed ? (
          confirming || leavePending ? (
            <div>
              <p className="text-[12.5px] text-[rgb(248_248_248/.7)]">{prompt}</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <PortalButton
                  type="button"
                  size="sm"
                  disabled={disabled}
                  onClick={() => void confirmLeave()}
                >
                  {leavePending ? 'Confirm earlier action' : 'Confirm'}
                </PortalButton>
                <PortalTextButton
                  type="button"
                  disabled={disabled || leavePending}
                  onClick={() => {
                    setConfirming(false)
                    setError(null)
                  }}
                >
                  Cancel
                </PortalTextButton>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="text-[12px] text-[rgb(248_248_248/.4)] underline-offset-4 hover:text-rose-light hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              disabled={disabled}
              onClick={() => {
                setConfirming(true)
                setError(null)
              }}
            >
              Leave team
            </button>
          )
        ) : (
          <p className="text-[11.5px] text-[rgb(248_248_248/.45)]">{unavailable}</p>
        )}
        <PortalError message={error} />
      </div>
    )
  }

  return (
    <div className="team-exit">
      {allowed ? (
        <button
          type="button"
          className="text-button quiet-danger"
          disabled={disabled || leavePending}
          onClick={() => {
            setConfirming(true)
            setError(null)
          }}
        >
          Leave team
        </button>
      ) : (
        <p className="fine-print">{unavailable}</p>
      )}
      {confirming || leavePending ? (
        <div className="transfer-card action-confirmation">
          <p>{prompt}</p>
          <div className="button-row">
            <button
              type="button"
              className="primary compact"
              disabled={disabled}
              onClick={() => void confirmLeave()}
            >
              {leavePending ? 'Confirm earlier action' : 'Confirm'}
            </button>
            <button
              type="button"
              className="secondary compact"
              disabled={disabled || leavePending}
              onClick={() => {
                setConfirming(false)
                setError(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <ErrorNotice message={error} />
    </div>
  )
}
