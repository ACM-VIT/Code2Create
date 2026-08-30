import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation } from 'convex/react'
import { useState } from 'react'
import { eventSlug } from '../../lib/config'
import { readableError } from '../../lib/errors'
import { useOperationRunner } from '../../lib/operations'
import { canLeaveByTeamRule, canLeaveCurrentTeam } from '../../lib/teamLeave'
import type { CurrentTeam, CurrentTeamMember } from '../../types'
import { TeamCluster } from './TeamCluster'

/** TeamCluster wired to the real leave mutation — the header on live screens. */
export function LiveTeamCluster({
  team,
  members,
  onSignOut,
}: {
  team: CurrentTeam
  members: readonly CurrentTeamMember[]
  onSignOut: () => void
}) {
  const leaveTeam = useMutation(api.teams.leave)
  const operations = useOperationRunner<FunctionReturnType<typeof api.teams.leave>>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const leavePending = operations.hasPending('team-leave')
  const leadMustTransfer = team.canLeave && !canLeaveByTeamRule(team)

  const leave = async () => {
    setBusy(true)
    setError(null)
    try {
      await operations.run('team-leave', (clientOperationId) => () => leaveTeam({
        eventSlug,
        teamId: team.id,
        expectedTeamVersion: team.version,
        clientOperationId,
      }))
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TeamCluster
      team={team}
      members={members}
      onSignOut={onSignOut}
      leaveAction={{
        available: canLeaveCurrentTeam(team),
        ...(leadMustTransfer
          ? { blockedMessage: 'Transfer leadership before leaving this team.' }
          : !team.canLeave
            ? { blockedMessage: 'Leaving this team is unavailable.' }
            : {}),
        pending: busy,
        retrying: leavePending,
        error,
        onConfirm: leave,
      }}
    />
  )
}
