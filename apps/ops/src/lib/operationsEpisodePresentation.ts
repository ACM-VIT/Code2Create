import type { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'

export type OperationsEpisode = FunctionReturnType<typeof api.operationsEpisodes.relevant>[number]

export function episodeStateLabel(state: OperationsEpisode['state']) {
  if (state === 'forming') return 'Forming'
  if (state === 'active') return 'Active'
  if (state === 'escalating') return 'Escalating'
  return 'Recovering'
}

export function episodeSeverityLabel(severity: OperationsEpisode['severity']) {
  if (severity === 'critical') return 'Critical'
  if (severity === 'attention') return 'Needs attention'
  return 'Watch'
}

export function episodeSeverityDot(severity: OperationsEpisode['severity']) {
  if (severity === 'critical') return 'bg-red'
  if (severity === 'attention') return 'bg-amber'
  return 'bg-ink-3'
}

export function episodeAnalysisLabel(status: OperationsEpisode['analysisStatus']) {
  if (status === 'ready') return 'analysis ready'
  if (status === 'failed') return 'analysis failed'
  return 'analysis in progress'
}

export function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}
