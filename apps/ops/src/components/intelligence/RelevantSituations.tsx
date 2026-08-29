import { api } from '@code2create/backend/api'
import { useQuery } from 'convex/react'

import { eventSlug } from '../../lib/config'
import { formatCompactDateTime } from '../../lib/dateTime'
import { LoadingLabel } from '../Skeleton'

function percent(value: number) {
  return `${Math.round(value * 100)}%`
}

function stateLabel(state: 'forming' | 'active' | 'escalating' | 'recovering') {
  if (state === 'forming') return 'Forming'
  if (state === 'active') return 'Active'
  if (state === 'escalating') return 'Escalating'
  return 'Recovering'
}

export function RelevantSituations() {
  const episodes = useQuery(api.operationsEpisodes.relevant, { eventSlug, limit: 12 })
  const calibration = useQuery(api.operationsEpisodes.calibration, { eventSlug })

  if (episodes === undefined) return <LoadingLabel>Loading relevant situations</LoadingLabel>

  return (
    <section className="attention-section intelligence-situations">
      <div className="section-heading">
        <div>
          <h2>Relevant situations</h2>
          <p className="muted">
            Correlated operational episodes ranked by urgency, impact, confidence, and actionability.
          </p>
        </div>
        <span>
          {episodes.length}
          {calibration && calibration.resolvedCount > 0
            ? ` · ${calibration.confirmedCount}/${calibration.resolvedCount} forecasts confirmed`
            : ''}
        </span>
      </div>
      {episodes.length === 0 ? (
        <p className="notice">No operational episode is currently active.</p>
      ) : (
        <div className="intelligence-situation-list">
          {episodes.map((episode) => (
            <article className={`card-surface intelligence-situation ${episode.severity}`} key={episode.episodeId}>
              <header className="section-heading">
                <div>
                  <p className="eyebrow">Relevance {episode.relevanceScore} · revision {episode.revision}</p>
                  <h3>{episode.title}</h3>
                </div>
                <span className={`state-label ${episode.state === 'recovering' ? 'connected' : ''}`}>
                  {stateLabel(episode.state)}
                </span>
              </header>
              <p>{episode.analysisSummary ?? episode.summary}</p>
              <dl className="review-progress">
                <div><dt>Confidence</dt><dd>{percent(episode.confidence)}</dd></div>
                <div><dt>Signals</dt><dd>{episode.signalCount}</dd></div>
                <div><dt>Evidence facts</dt><dd>{episode.factCount}</dd></div>
                <div><dt>Last observed</dt><dd>{formatCompactDateTime(episode.lastObservedAt)}</dd></div>
                <div><dt>Analysis</dt><dd>{episode.analysisStatus}</dd></div>
              </dl>
              <p className="notice">
                <strong>Human next action:</strong>{' '}
                {episode.suggestedAction ?? episode.nextAction}
              </p>
              {episode.hypotheses.length === 0 ? null : (
                <div className="intelligence-situation-analysis">
                  <p className="board-section-label">Current hypotheses</p>
                  <ul>
                    {episode.hypotheses.map((hypothesis, index) => (
                      <li key={`${hypothesis.stance}-${index}`}>
                        <strong>{hypothesis.stance}</strong>{' '}
                        <span>{hypothesis.statement}</span>{' '}
                        <small>{percent(hypothesis.confidence)}</small>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {episode.predictions.length === 0 ? null : (
                <div className="intelligence-situation-analysis">
                  <p className="board-section-label">Forecasts</p>
                  <ul>
                    {episode.predictions.map((prediction, index) => (
                      <li key={`${prediction.horizonAt}-${index}`}>
                        <span>{prediction.statement}</span>{' '}
                        <small>
                          {percent(prediction.probability)} · {prediction.expectedState} by{' '}
                          {formatCompactDateTime(prediction.horizonAt)} · {prediction.outcome}
                        </small>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {episode.counterfactuals.length === 0 ? null : (
                <div className="intelligence-situation-analysis">
                  <p className="board-section-label">What-if interventions</p>
                  <ul>
                    {episode.counterfactuals.map((counterfactual, index) => (
                      <li key={`${counterfactual.expectedState}-${index}`}>
                        <span>{counterfactual.intervention}</span>{' '}
                        <small>
                          {percent(counterfactual.probability)} chance of {counterfactual.expectedState}
                        </small>{' '}
                        <span>{counterfactual.rationale}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
