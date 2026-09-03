import type { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'

type RecommendationPage = FunctionReturnType<typeof api.intelligenceRecommendations.proposed>
export type Recommendation = RecommendationPage['page'][number]
export type RecommendationArguments = Recommendation['arguments']
export type RecommendationStatus = Recommendation['status']
export type RecommendationProvenance = Recommendation['provenance']

export type RecommendationCommandRow = {
  label: string
  value: number | string
  code?: boolean
}

export function recommendationKindLabel(kind: RecommendationArguments['kind']) {
  if (kind === 'hold_review_team') return 'Hold a review team'
  if (kind === 'page_reserve_reviewer') return 'Page a reserve reviewer'
  if (kind === 'open_support_case') return 'Open a support case'
  if (kind === 'set_admission_minimum_human_reviews') return 'Change the admission review minimum'
  return 'Dismiss an attention item'
}

export function recommendationSourceLabel(provenance: RecommendationProvenance) {
  return provenance.kind === 'autonomy' ? 'Autonomous review' : 'Copilot conversation'
}

export function recommendationStatusLabel(status: RecommendationStatus) {
  if (status === 'proposed') return 'Needs decision'
  if (status === 'approved') return 'Executed'
  if (status === 'rejected') return 'Rejected'
  return 'Revision requested'
}

export function recommendationStatusTone(status: RecommendationStatus) {
  if (status === 'proposed') return 'bg-amber/10 text-amber'
  if (status === 'approved') return 'bg-green/10 text-green'
  if (status === 'rejected') return 'bg-red/10 text-red'
  return 'bg-field text-ink-2'
}

/** The exact, typed command an operator is approving, in plain rows. */
export function recommendationCommandRows(command: RecommendationArguments): RecommendationCommandRow[] {
  if (command.kind === 'hold_review_team') {
    return [
      { label: 'Command', value: 'review.team.hold', code: true },
      { label: 'Team-round state', value: command.teamRoundStateId, code: true },
      { label: 'Expected version', value: command.expectedTeamRoundStateVersion },
      { label: 'Reason', value: command.reason },
    ]
  }
  if (command.kind === 'page_reserve_reviewer') {
    return [
      { label: 'Command', value: 'review.reserve_reviewer.page', code: true },
      { label: 'Vacant panel seat', value: command.missingPanelMemberId, code: true },
      { label: 'Expected panel version', value: command.expectedPanelVersion },
      { label: 'Reason', value: command.reason },
    ]
  }
  if (command.kind === 'open_support_case') {
    return [
      { label: 'Command', value: 'support.case.open', code: true },
      { label: 'Category', value: command.category.replaceAll('_', ' ') },
      { label: 'Description', value: command.description },
      ...(command.roundId === undefined ? [] : [{ label: 'Linked round', value: command.roundId, code: true }]),
      ...(command.teamId === undefined ? [] : [{ label: 'Linked team', value: command.teamId, code: true }]),
    ]
  }
  if (command.kind === 'dismiss_attention_item') {
    return [
      { label: 'Command', value: 'operations.attention.dismiss', code: true },
      { label: 'Attention item', value: command.itemId, code: true },
      { label: 'Expected item version', value: command.expectedItemVersion },
      { label: 'Reason', value: command.reason },
    ]
  }
  return [
    { label: 'Command', value: 'configuration.admission.minimum_human_reviews.set', code: true },
    { label: 'New review minimum', value: command.minimumHumanReviews },
    { label: 'Expected event version', value: command.expectedEventVersion },
    { label: 'Base admission policy', value: command.expectedBasePolicyId, code: true },
    { label: 'New release', value: command.releaseVersion },
    { label: 'Reason', value: command.reason },
  ]
}
