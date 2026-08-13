export type WorkspaceGrant = {
  permissionKey: string
  scopeType: string
}

const attendanceOverviewPermissions = new Set([
  'configuration.manage',
  'attendance.plan.publish',
  'attendance.venue_check_in.read',
  'attendance.station.read',
  'attendance.station.manage',
  'attendance.history.read',
  'attendance.session.manage',
  'attendance.presence.reconcile',
  'attendance.remedy.read',
  'attendance.remedy.open',
  'attendance.remedy.decide',
  'attendance.roll_call.read',
  'attendance.roll_call.start',
  'attendance.roll_call.close',
  'attendance.export.identifiable',
  'attendance.manual_sheet.read',
  'attendance.manual_sheet.enter',
  'attendance.manual_sheet.verify',
  'attendance.manual_sheet.source.read',
])

const floorConfigurationPermissions = new Set([
  'floor.plan.create',
  'floor.plan.read',
  'floor.plan.publish',
  'floor.plan.freeze',
])

export function workspaceAccess(grants: readonly WorkspaceGrant[]) {
  const has = (permissionKey: string) => grants.some((grant) => grant.permissionKey === permissionKey)
  const hasEvent = (permissionKey: string) => grants.some(
    (grant) => grant.permissionKey === permissionKey && grant.scopeType === 'event',
  )

  return {
    admissions: has('application.read') || has('application.review.read'),
    attendance: grants.some((grant) => attendanceOverviewPermissions.has(grant.permissionKey)),
    roster: has('access.roster.read'),
    projectCheckpoints: has('project.checkpoint.read'),
    reviews: has('round.read'),
    synesthesia:
      hasEvent('synesthesia.catalog.read') ||
      hasEvent('synesthesia.catalog.manage') ||
      has('synesthesia.window.read') ||
      hasEvent('synesthesia.window.manage'),
    rehearsal: has('rehearsal.read'),
    floorConfiguration: grants.some((grant) => floorConfigurationPermissions.has(grant.permissionKey)),
    intelligence:
      hasEvent('operations.intelligence.read') ||
      hasEvent('operations.intelligence.generate'),
    emergencyRecovery:
      hasEvent('emergency_pack.read') ||
      hasEvent('emergency_pack.prepare'),
  }
}

export function firstAvailablePath(
  ...options: readonly (readonly [enabled: boolean, path: string])[]
) {
  return options.find(([enabled]) => enabled)?.[1] ?? null
}
