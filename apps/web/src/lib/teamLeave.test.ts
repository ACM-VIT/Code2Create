import assert from 'node:assert/strict'
import test from 'node:test'
import { canLeaveByTeamRule, canLeaveCurrentTeam, leaveTeamPrompt } from './teamLeave.ts'

test('lets a sole lead or any member leave', () => {
  assert.equal(canLeaveByTeamRule({ currentRole: 'lead', activeMemberCount: 1 }), true)
  assert.equal(canLeaveByTeamRule({ currentRole: 'member', activeMemberCount: 3 }), true)
  assert.equal(canLeaveByTeamRule({ currentRole: 'lead', activeMemberCount: 2 }), false)
})

test('still requires the leave grant', () => {
  assert.equal(
    canLeaveCurrentTeam({ canLeave: false, currentRole: 'lead', activeMemberCount: 1 }),
    false,
  )
  assert.equal(
    canLeaveCurrentTeam({ canLeave: true, currentRole: 'lead', activeMemberCount: 1 }),
    true,
  )
})

test('names sole-member leave as closing the team', () => {
  assert.equal(leaveTeamPrompt(1), 'Leave and close this team?')
  assert.match(leaveTeamPrompt(2), /create or join another/)
})
