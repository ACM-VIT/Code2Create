import assert from 'node:assert/strict'
import test from 'node:test'

import {
  firstAvailablePath,
  workspaceAccess,
  type WorkspaceGrant,
} from './workspaceAccess.ts'

const eventGrant = (permissionKey: string): WorkspaceGrant => ({ permissionKey, scopeType: 'event' })
const scopedGrant = (permissionKey: string, scopeType: string): WorkspaceGrant => ({ permissionKey, scopeType })

test('navigation accepts permissions that each workspace query can use', () => {
  const cases: readonly {
    grant: WorkspaceGrant
    workspace: keyof ReturnType<typeof workspaceAccess>
  }[] = [
    { grant: scopedGrant('application.read', 'application'), workspace: 'admissions' },
    { grant: scopedGrant('application.review.read', 'application'), workspace: 'admissions' },
    { grant: scopedGrant('attendance.station.read', 'attendance_station'), workspace: 'attendance' },
    { grant: eventGrant('access.roster.read'), workspace: 'roster' },
    { grant: scopedGrant('project.checkpoint.read', 'team'), workspace: 'projectCheckpoints' },
    { grant: scopedGrant('round.read', 'round'), workspace: 'reviews' },
    { grant: scopedGrant('synesthesia.window.read', 'synesthesia_window'), workspace: 'synesthesia' },
    { grant: scopedGrant('rehearsal.read', 'rehearsal_run'), workspace: 'rehearsal' },
    { grant: scopedGrant('floor.plan.read', 'floor_plan'), workspace: 'floorConfiguration' },
    { grant: eventGrant('operations.intelligence.read'), workspace: 'intelligence' },
    { grant: eventGrant('operations.intelligence.generate'), workspace: 'intelligence' },
    { grant: eventGrant('emergency_pack.read'), workspace: 'emergencyRecovery' },
    { grant: eventGrant('emergency_pack.prepare'), workspace: 'emergencyRecovery' },
  ]

  for (const { grant, workspace } of cases) {
    assert.equal(workspaceAccess([grant])[workspace], true, `${grant.permissionKey} should open ${workspace}`)
  }
})

test('action-only and unrelated prefix permissions do not open empty workspaces', () => {
  const cases: readonly {
    grant: WorkspaceGrant
    workspace: keyof ReturnType<typeof workspaceAccess>
  }[] = [
    { grant: eventGrant('application.decide'), workspace: 'admissions' },
    { grant: eventGrant('attendance.portal_qr.issue'), workspace: 'attendance' },
    { grant: eventGrant('access.roster.manage'), workspace: 'roster' },
    { grant: eventGrant('project.checkpoint.submit'), workspace: 'projectCheckpoints' },
    { grant: eventGrant('review.configuration.publish'), workspace: 'reviews' },
    { grant: eventGrant('synesthesia.report.resolve'), workspace: 'synesthesia' },
    { grant: eventGrant('rehearsal.execute'), workspace: 'rehearsal' },
    { grant: eventGrant('floor.plan.delete'), workspace: 'floorConfiguration' },
    { grant: eventGrant('emergency_pack.print'), workspace: 'emergencyRecovery' },
  ]

  for (const { grant, workspace } of cases) {
    assert.equal(workspaceAccess([grant])[workspace], false, `${grant.permissionKey} must not open ${workspace}`)
  }
})

test('event-only workspaces reject scoped versions of their permissions', () => {
  assert.equal(
    workspaceAccess([scopedGrant('operations.intelligence.read', 'team')]).intelligence,
    false,
  )
  assert.equal(
    workspaceAccess([scopedGrant('operations.intelligence.generate', 'team')]).intelligence,
    false,
  )
  assert.equal(
    workspaceAccess([scopedGrant('emergency_pack.read', 'team')]).emergencyRecovery,
    false,
  )
  assert.equal(
    workspaceAccess([scopedGrant('emergency_pack.prepare', 'team')]).emergencyRecovery,
    false,
  )
})

test('the first accessible standalone workspace becomes the default path', () => {
  assert.equal(
    firstAvailablePath(
      [false, '/'],
      [true, '/intelligence'],
      [true, '/emergency-pack'],
    ),
    '/intelligence',
  )
  assert.equal(firstAvailablePath([false, '/'], [true, '/emergency-pack']), '/emergency-pack')
  assert.equal(firstAvailablePath([false, '/']), null)
})

test('scoped management alone does not open Synesthesia without a readable window', () => {
  assert.equal(
    workspaceAccess([scopedGrant('synesthesia.window.manage', 'synesthesia_window')]).synesthesia,
    false,
  )
  assert.equal(workspaceAccess([eventGrant('synesthesia.window.manage')]).synesthesia, true)
})

test('every attendance session action that exposes a session opens its workspace', () => {
  const actionPermissions = [
    'attendance.remedy.open',
    'attendance.remedy.decide',
    'attendance.roll_call.start',
    'attendance.roll_call.close',
    'attendance.manual_sheet.enter',
    'attendance.manual_sheet.verify',
    'attendance.manual_sheet.source.read',
  ] as const

  for (const permissionKey of actionPermissions) {
    assert.equal(
      workspaceAccess([scopedGrant(permissionKey, 'attendance_session')]).attendance,
      true,
      `${permissionKey} should open attendance`,
    )
  }
})
