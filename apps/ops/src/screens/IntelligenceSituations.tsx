import { api } from '@code2create/backend/api'
import { useQuery } from 'convex/react'
import type { ReactNode } from 'react'

import { LoadingLabel, SkeletonCard } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { formatCompactDateTime, formatRelativeTime } from '../lib/dateTime'
import {
  type OperationsEpisode,
  episodeAnalysisLabel,
  episodeSeverityDot,
  episodeSeverityLabel,
  episodeStateLabel,
  formatPercent,
} from '../lib/operationsEpisodePresentation'

const situationLimit = 12

/** What the situation analyst is watching, each with a plain next step for a person. */
export function IntelligenceSituations() {
  const episodes = useQuery(api.operationsEpisodes.relevant, { eventSlug, limit: situationLimit })
  const calibration = useQuery(api.operationsEpisodes.calibration, { eventSlug })
  const aside = [
    ...(episodes === undefined || episodes.length === 0
      ? []
      : [`${episodes.length} ${episodes.length === 1 ? 'situation' : 'situations'}`]),
    ...(calibration !== undefined && calibration.resolvedCount > 0
      ? [`${calibration.confirmedCount} of ${calibration.resolvedCount} forecasts confirmed`]
      : []),
  ]

  return (
    <section aria-labelledby="situations-heading" className="attention-section">
      <div className="section-heading">
        <h2 id="situations-heading">Watching</h2>
        {aside.length === 0 ? null : <span>{aside.join(' · ')}</span>}
      </div>
      {episodes === undefined ? (
        <>
          <LoadingLabel>Loading situations</LoadingLabel>
          <SkeletonCard lines={3} />
          <SkeletonCard lines={3} />
        </>
      ) : episodes.length === 0 ? (
        <div className="health-empty">
          <strong>No active situation.</strong>
          <span>New ones appear here as soon as health signals correlate into one.</span>
        </div>
      ) : (
        <div className="grid gap-3">
          {episodes.map((episode) => <SituationCard episode={episode} key={episode.episodeId} />)}
        </div>
      )}
    </section>
  )
}

function SituationCard({ episode }: { episode: OperationsEpisode }) {
  const analysisCount = episode.hypotheses.length
    + episode.predictions.length
    + episode.counterfactuals.length
  const analysisPending = episode.analysisStatus !== 'ready'
  const stats = [
    `${formatPercent(episode.confidence)} confidence`,
    `${episode.signalCount} ${episode.signalCount === 1 ? 'signal' : 'signals'}`,
    `${episode.factCount} ${episode.factCount === 1 ? 'fact' : 'facts'}`,
    `relevance ${episode.relevanceScore}`,
    `first seen ${formatCompactDateTime(episode.firstObservedAt)}`,
    ...(analysisPending ? [episodeAnalysisLabel(episode.analysisStatus)] : []),
  ]

  return (
    <article className="grid gap-3 rounded-xl bg-surface p-4 sm:p-5">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="m-0 flex flex-wrap items-center gap-x-2 text-[12px] leading-5 text-ink-3">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className={`size-1.5 rounded-full ${episodeSeverityDot(episode.severity)}`} />
              {episodeSeverityLabel(episode.severity)}
            </span>
            <span aria-hidden>·</span>
            <span>Updated {formatRelativeTime(episode.lastObservedAt)}</span>
            <span aria-hidden>·</span>
            <span>{episode.owner}</span>
          </p>
          <h3 className="m-0 mt-1 text-[14px] leading-snug font-medium text-ink">{episode.title}</h3>
        </div>
        <span className="inline-flex h-5.5 shrink-0 items-center rounded-full bg-field px-2 text-[11px] text-ink-2">
          {episodeStateLabel(episode.state)}
        </span>
      </header>

      <p className="m-0 text-[13px] leading-6 text-ink-2">{episode.analysisSummary ?? episode.summary}</p>

      <p className="m-0 rounded-lg bg-canvas/60 px-3.5 py-2.5 text-[13px] leading-5 text-ink">
        <span className="text-ink-3">Next step · </span>
        {episode.suggestedAction ?? episode.nextAction}
      </p>

      <p className="m-0 text-[12px] leading-5 text-ink-3">{stats.join(' · ')}</p>

      {analysisCount === 0 ? null : (
        <details className="group rounded-lg border border-line">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2.5 text-[12px] text-ink-2 hover:bg-hover [&::-webkit-details-marker]:hidden">
            <span>Analyst reasoning · {analysisSummary(episode)}</span>
            <span aria-hidden className="font-mono text-[14px] text-ink-3 transition-transform group-open:rotate-45">+</span>
          </summary>
          <div className="grid gap-4 border-t border-line px-3.5 py-3.5">
            {episode.hypotheses.length === 0 ? null : (
              <AnalysisList title="Hypotheses">
                {episode.hypotheses.map((hypothesis, index) => (
                  <li className="grid gap-0.5" key={`${hypothesis.stance}-${index}`}>
                    <span className="text-[12.5px] leading-5 text-ink-2">{hypothesis.statement}</span>
                    <span className="text-[12px] text-ink-3">
                      {hypothesis.stance.replaceAll('_', ' ')} · {formatPercent(hypothesis.confidence)}
                    </span>
                  </li>
                ))}
              </AnalysisList>
            )}
            {episode.predictions.length === 0 ? null : (
              <AnalysisList title="Forecasts">
                {episode.predictions.map((prediction, index) => (
                  <li className="grid gap-0.5" key={`${prediction.horizonAt}-${index}`}>
                    <span className="text-[12.5px] leading-5 text-ink-2">{prediction.statement}</span>
                    <span className="text-[12px] text-ink-3">
                      {formatPercent(prediction.probability)} · {prediction.expectedState.replaceAll('_', ' ')} by{' '}
                      {formatCompactDateTime(prediction.horizonAt)} · {prediction.outcome.replaceAll('_', ' ')}
                    </span>
                  </li>
                ))}
              </AnalysisList>
            )}
            {episode.counterfactuals.length === 0 ? null : (
              <AnalysisList title="What an intervention could change">
                {episode.counterfactuals.map((counterfactual, index) => (
                  <li className="grid gap-0.5" key={`${counterfactual.expectedState}-${index}`}>
                    <span className="text-[12.5px] leading-5 text-ink-2">{counterfactual.intervention}</span>
                    <span className="text-[12px] leading-5 text-ink-3">
                      {formatPercent(counterfactual.probability)} chance of{' '}
                      {counterfactual.expectedState.replaceAll('_', ' ')} · {counterfactual.rationale}
                    </span>
                  </li>
                ))}
              </AnalysisList>
            )}
          </div>
        </details>
      )}
    </article>
  )
}

function analysisSummary(episode: OperationsEpisode) {
  const parts = [
    ...(episode.hypotheses.length > 0 ? [`${episode.hypotheses.length} ${episode.hypotheses.length === 1 ? 'hypothesis' : 'hypotheses'}`] : []),
    ...(episode.predictions.length > 0 ? [`${episode.predictions.length} ${episode.predictions.length === 1 ? 'forecast' : 'forecasts'}`] : []),
    ...(episode.counterfactuals.length > 0 ? [`${episode.counterfactuals.length} what-if`] : []),
  ]
  return parts.join(', ')
}

function AnalysisList({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="grid gap-2">
      <p className="m-0 text-[12px] font-medium text-ink-2">{title}</p>
      <ul className="m-0 grid list-none gap-2.5 p-0">{children}</ul>
    </div>
  )
}
