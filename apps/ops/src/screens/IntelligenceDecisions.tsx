import { api } from '@code2create/backend/api'
import { usePaginatedQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'

import {
  RecommendationCard,
  recommendationPageSize,
  usePendingRecommendations,
} from '../components/intelligence'
import { LoadingLabel, SkeletonCard } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { useOperationRunner } from '../lib/operations'

type RecommendationDecisionResult = FunctionReturnType<
  typeof api.intelligenceRecommendations.approve
>

/** Every consequential command the agents want to run waits here for a person. */
export function IntelligenceDecisions() {
  const operations = useOperationRunner<RecommendationDecisionResult>()
  const pending = usePendingRecommendations(true)
  const settled = usePaginatedQuery(
    api.intelligenceRecommendations.settled,
    { eventSlug },
    { initialNumItems: recommendationPageSize },
  )

  return (
    <div className="grid content-start gap-7">
      <p className="m-0 max-w-[620px] text-[13px] leading-6 text-ink-2">
        Approve a proposal to run it with your permissions, reject it with a reason, or send
        guidance. Nothing runs on its own.
      </p>

      <section aria-labelledby="pending-decisions-heading" className="attention-section">
        <div className="section-heading">
          <h2 id="pending-decisions-heading">Waiting for a decision</h2>
          {pending.loading || pending.count === 0
            ? null
            : <span>{pending.count}{pending.atLeast ? '+' : ''} waiting · oldest first</span>}
        </div>
        {pending.loading ? (
          <>
            <LoadingLabel>Loading proposals awaiting a decision</LoadingLabel>
            <SkeletonCard lines={4} />
          </>
        ) : pending.count === 0 ? (
          <div className="health-empty">
            <strong>Nothing is waiting for you.</strong>
            <span>New proposals appear here the moment the agent makes them.</span>
          </div>
        ) : (
          <div className="grid gap-3">
            {pending.results.map((recommendation) => (
              <RecommendationCard
                key={recommendation.id}
                operations={operations}
                recommendation={recommendation}
              />
            ))}
          </div>
        )}
        {pending.status === 'CanLoadMore' ? (
          <button
            className="secondary mt-3"
            onClick={() => pending.loadMore(recommendationPageSize)}
            type="button"
          >
            Load more pending recommendations
          </button>
        ) : null}
        {pending.status === 'LoadingMore' ? <LoadingLabel>Loading more proposals</LoadingLabel> : null}
      </section>

      <section aria-labelledby="settled-decisions-heading" className="attention-section">
        <div className="section-heading">
          <h2 id="settled-decisions-heading">Decided</h2>
          {settled.status === 'LoadingFirstPage' || settled.results.length === 0
            ? null
            : <span>{settled.results.length} loaded · newest first</span>}
        </div>
        {settled.status === 'LoadingFirstPage' ? (
          <>
            <LoadingLabel>Loading decided recommendations</LoadingLabel>
            <SkeletonCard lines={2} />
          </>
        ) : settled.results.length === 0 ? (
          <div className="health-empty">
            <strong>No decision has been recorded yet.</strong>
          </div>
        ) : (
          <div className="grid gap-2">
            {settled.results.map((recommendation) => (
              <RecommendationCard
                collapsed
                key={recommendation.id}
                operations={operations}
                recommendation={recommendation}
              />
            ))}
          </div>
        )}
        {settled.status === 'CanLoadMore' ? (
          <button
            className="secondary mt-3"
            onClick={() => settled.loadMore(recommendationPageSize)}
            type="button"
          >
            Load older decisions
          </button>
        ) : null}
        {settled.status === 'LoadingMore' ? <LoadingLabel>Loading older decisions</LoadingLabel> : null}
      </section>
    </div>
  )
}
