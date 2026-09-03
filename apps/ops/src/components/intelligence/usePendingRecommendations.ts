import { api } from '@code2create/backend/api'
import { usePaginatedQuery } from 'convex/react'

import { eventSlug } from '../../lib/config'

export const recommendationPageSize = 12

export function usePendingRecommendations(enabled: boolean) {
  const proposed = usePaginatedQuery(
    api.intelligenceRecommendations.proposed,
    enabled ? { eventSlug } : 'skip',
    { initialNumItems: recommendationPageSize },
  )
  return {
    loading: enabled && proposed.status === 'LoadingFirstPage',
    results: proposed.results,
    count: proposed.results.length,
    atLeast: proposed.status === 'CanLoadMore' || proposed.status === 'LoadingMore',
    status: proposed.status,
    loadMore: proposed.loadMore,
  }
}
