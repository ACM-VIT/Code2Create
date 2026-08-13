export type DutySurface =
  | 'reviews'
  | 'attendance'
  | 'floor'
  | 'support'
  | 'operations'
  | 'incidents'

export function dutySubscriptionPlan(shown: readonly DutySurface[]) {
  return {
    attendance: shown.includes('attendance'),
    floor: shown.includes('floor'),
    support: shown.includes('support'),
    operations: shown.includes('operations'),
    incidents: shown.includes('incidents'),
  }
}
