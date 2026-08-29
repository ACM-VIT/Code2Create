export type TeamLeaveRule = {
  canLeave: boolean
  currentRole: 'lead' | 'member'
  activeMemberCount: number
}

export function canLeaveByTeamRule(team: Pick<TeamLeaveRule, 'currentRole' | 'activeMemberCount'>) {
  return team.currentRole === 'member' || team.activeMemberCount === 1
}

export function canLeaveCurrentTeam(team: TeamLeaveRule) {
  return team.canLeave && canLeaveByTeamRule(team)
}

export function leaveTeamPrompt(activeMemberCount: number) {
  return activeMemberCount === 1
    ? 'Leave and close this team?'
    : 'Leave this team? You can create or join another before submissions close.'
}
