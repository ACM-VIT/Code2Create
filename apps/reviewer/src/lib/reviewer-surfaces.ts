import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'

export type Surface =
  | 'reviews'
  | 'attendance'
  | 'floor'
  | 'support'
  | 'operations'
  | 'incidents'

type ReviewerCapabilities = Pick<
  NonNullable<FunctionReturnType<typeof api.access.reviewerCapabilities>>,
  Surface
>

const surfaceCapability = [
  ['reviews', 'reviews'],
  ['attendance', 'attendance'],
  ['floor', 'floor'],
  ['support', 'support'],
  ['operations', 'operations'],
  ['incidents', 'incidents'],
] as const satisfies readonly [Surface, keyof ReviewerCapabilities][]

export function reviewerSurfaces(capabilities: ReviewerCapabilities): Surface[] {
  return surfaceCapability
    .filter(([, capability]) => capabilities[capability] === true)
    .map(([surface]) => surface)
}
