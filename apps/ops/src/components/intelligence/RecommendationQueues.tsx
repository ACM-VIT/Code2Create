import { api } from '@code2create/backend/api'
import { usePaginatedQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'

import { eventSlug } from '../../lib/config'
import { type OperationRunner, useOperationRunner } from '../../lib/operations'
import { LoadingLabel, SkeletonList } from '../Skeleton'
import { RecommendationCard } from './RecommendationCard'

const recommendationPageSize = 12
type RecommendationDecisionResult = FunctionReturnType<
  typeof api.intelligenceRecommendations.approve
>

export function RecommendationQueues() {
  const operations = useOperationRunner<RecommendationDecisionResult>()
  const proposed = usePaginatedQuery(
    api.intelligenceRecommendations.proposed,
    { eventSlug },
    { initialNumItems: recommendationPageSize },
  )
  const settled = usePaginatedQuery(
    api.intelligenceRecommendations.settled,
    { eventSlug },
    { initialNumItems: recommendationPageSize },
  )

  return (
    <>
      <section className="attention-section">
        <div className="section-heading">
          <div>
            <h2>Recommendations awaiting a decision</h2>
            <p className="muted">Oldest first, so no proposal can be hidden behind newer work.</p>
          </div>
          {proposed.results.length > 0 ? <span>{proposed.results.length}</span> : null}
        </div>
        <RecommendationList
          empty="No recommendation is awaiting a human decision."
          loading="Loading recommendation queue"
          operations={operations}
          recommendations={proposed.results}
          status={proposed.status}
        />
        {proposed.status === 'CanLoadMore' ? (
          <button
            className="secondary"
            onClick={() => proposed.loadMore(recommendationPageSize)}
            type="button"
          >
            Load more pending recommendations
          </button>
        ) : null}
      </section>

      <section className="attention-section">
        <div className="section-heading">
          <div>
            <h2>Recommendation history</h2>
            <p className="muted">Newest decisions first, with their original evidence and outcome.</p>
          </div>
          {settled.results.length > 0 ? <span>{settled.results.length}</span> : null}
        </div>
        <RecommendationList
          empty="No recommendation has been decided yet."
          loading="Loading recommendation history"
          operations={operations}
          recommendations={settled.results}
          status={settled.status}
        />
        {settled.status === 'CanLoadMore' ? (
          <button
            className="secondary"
            onClick={() => settled.loadMore(recommendationPageSize)}
            type="button"
          >
            Load older decisions
          </button>
        ) : null}
      </section>
    </>
  )
}

type RecommendationPage = FunctionReturnType<typeof api.intelligenceRecommendations.proposed>
type Recommendation = RecommendationPage['page'][number]
type PaginationStatus = 'LoadingFirstPage' | 'CanLoadMore' | 'LoadingMore' | 'Exhausted'

function RecommendationList({
  empty,
  loading,
  recommendations,
  operations,
  status,
}: {
  empty: string
  loading: string
  operations: OperationRunner<RecommendationDecisionResult>
  recommendations: Recommendation[]
  status: PaginationStatus
}) {
  if (status === 'LoadingFirstPage') {
    return (
      <>
        <LoadingLabel>{loading}</LoadingLabel>
        <SkeletonList rows={3} />
      </>
    )
  }
  if (recommendations.length === 0) {
    return (
      <div className="health-empty">
        <strong>{empty}</strong>
        <span>The agent can observe freely; every consequential command remains human-controlled.</span>
      </div>
    )
  }
  return (
    <div className="configuration-card-stack">
      {recommendations.map((recommendation) => (
        <RecommendationCard
          key={recommendation.id}
          operations={operations}
          recommendation={recommendation}
        />
      ))}
      {status === 'LoadingMore' ? <LoadingLabel>Loading more recommendations</LoadingLabel> : null}
    </div>
  )
}
