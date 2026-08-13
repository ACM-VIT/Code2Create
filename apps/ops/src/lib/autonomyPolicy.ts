import { api } from '@code2create/backend/api'
import type { FunctionArgs } from 'convex/server'

export type AutonomyPolicy = FunctionArgs<
  typeof api.operationsAutonomyPolicyConfiguration.createDraft
>['policy']

export const allAutonomyRecommendationKinds = [
  'hold_review_team',
  'page_reserve_reviewer',
  'open_support_case',
  'dismiss_attention_item',
] as const satisfies readonly AutonomyPolicy['allowedRecommendationKinds'][number][]

export function cloneAutonomyPolicy(policy: AutonomyPolicy): AutonomyPolicy {
  return {
    ...policy,
    triggerSeverities: [...policy.triggerSeverities],
    triggerAreas: [...policy.triggerAreas],
    allowedReadTools: [...policy.allowedReadTools],
    allowedRecommendationKinds: [...policy.allowedRecommendationKinds],
  }
}
