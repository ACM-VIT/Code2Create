import { api } from '@code2create/backend/api'
import { useQuery } from 'convex/react'
import { type FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { Icon } from '../components/Icon'
import { OperationsBrief } from '../components/OperationsBrief'
import type { usePendingRecommendations } from '../components/intelligence'
import { SkeletonList } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { copilotSuggestedPrompts } from '../lib/copilotPrompts'
import { formatRelativeTime } from '../lib/dateTime'
import {
  type OperationsEpisode,
  episodeStateLabel,
} from '../lib/operationsEpisodePresentation'
import {
  recommendationKindLabel,
  recommendationSourceLabel,
} from '../lib/recommendationPresentation'

type PendingRecommendations = ReturnType<typeof usePendingRecommendations>

const overviewEpisodeLimit = 6
const previewRows = 3
const overviewPrompts = copilotSuggestedPrompts.slice(0, 3)

/** Where an operator lands: ask, decide, see what is being watched, read the brief. */
export function IntelligenceOverview({
  canGenerate,
  canRead,
  pending,
}: {
  canGenerate: boolean
  canRead: boolean
  pending: PendingRecommendations
}) {
  const navigate = useNavigate()
  const episodes = useQuery(
    api.operationsEpisodes.relevant,
    canRead ? { eventSlug, limit: overviewEpisodeLimit } : 'skip',
  )
  const askWith = (prompt: string) => navigate('/intelligence/ask', { state: { prompt } })

  return (
    <div className="intelligence-overview grid content-start gap-7">
      <p className="m-0 max-w-[620px] text-[13px] leading-6 text-ink-2">
        Ask it about the live event, decide on what it proposes, and see what it is watching.
        It never changes the event on its own.
      </p>

      <AskComposer canGenerate={canGenerate} onAsk={askWith} />

      {canRead ? (
        <>
          <DecisionsPreview pending={pending} />
          <SituationsPreview episodes={episodes} />
        </>
      ) : (
        <p className="notice">
          Reading answers, proposals, and runs needs the intelligence read permission.
        </p>
      )}

      <OperationsBrief canGenerate={canGenerate} canRead={canRead} />
    </div>
  )
}

function AskComposer({
  canGenerate,
  onAsk,
}: {
  canGenerate: boolean
  onAsk: (prompt: string) => void
}) {
  const [draft, setDraft] = useState('')
  const ready = canGenerate && draft.trim().length > 0

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!ready) return
    onAsk(draft.trim())
  }

  return (
    <div className="grid gap-2.5">
      <form
        className="flex items-center gap-2 rounded-[14px] border border-line bg-field p-2 pl-4 transition-[border-color] duration-150 focus-within:border-line-strong"
        onSubmit={submit}
      >
        <label className="visually-hidden" htmlFor="overview-ask-input">Ask the operations copilot</label>
        <input
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-ink outline-none placeholder:text-ink-3 focus-visible:outline-none disabled:opacity-60"
          disabled={!canGenerate}
          id="overview-ask-input"
          maxLength={4_000}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={canGenerate
            ? 'Ask about the live event…'
            : 'Asking needs the intelligence generate permission'}
          value={draft}
        />
        <button
          aria-label="Ask"
          className="flex size-8 shrink-0 items-center justify-center rounded-[8px] border-0 bg-ink text-canvas transition-[background-color,color] duration-200 enabled:cursor-pointer disabled:bg-line-strong disabled:text-ink-2"
          disabled={!ready}
          type="submit"
        >
          <Icon name="arrow" size={14} />
        </button>
      </form>
      {canGenerate ? (
        <div aria-label="Suggested questions" className="flex flex-wrap items-center gap-2" role="group">
          {overviewPrompts.map((prompt) => (
            <button
              className="cursor-pointer rounded-full border border-line bg-transparent px-3 py-1 text-[12px] leading-normal text-ink-3 transition-colors duration-100 hover:border-line-strong hover:text-ink"
              key={prompt}
              onClick={() => onAsk(prompt)}
              type="button"
            >
              {prompt}
            </button>
          ))}
          <Link className="px-1 text-[12px] text-ink-3 no-underline hover:text-ink" to="/intelligence/ask">
            Open the conversation →
          </Link>
        </div>
      ) : null}
    </div>
  )
}

function DecisionsPreview({ pending }: { pending: PendingRecommendations }) {
  const visible = pending.results.slice(0, previewRows)
  const hidden = pending.count - visible.length
  const more = hidden > 0 || pending.atLeast

  return (
    <section aria-labelledby="overview-decisions-heading" className="attention-section">
      <div className="section-heading">
        <h2 id="overview-decisions-heading">Needs your decision</h2>
        {pending.loading || pending.count === 0
          ? null
          : <span>{pending.count}{pending.atLeast ? '+' : ''} waiting</span>}
      </div>
      {pending.loading ? (
        <SkeletonList rows={2} />
      ) : visible.length === 0 ? (
        <div className="health-empty">
          <strong>Nothing is waiting for you.</strong>
        </div>
      ) : (
        <>
          <div className="health-list">
            {visible.map((recommendation) => (
              <article className="list-row" key={recommendation.id}>
                <span className="row-glyph attention"><Icon name="inbox" /></span>
                <div className="row-text">
                  <strong>{recommendation.statement}</strong>
                  <small>
                    {recommendationKindLabel(recommendation.arguments.kind)}
                    {' · '}
                    {recommendationSourceLabel(recommendation.provenance)}
                    {' · '}
                    {formatRelativeTime(recommendation.proposedAt)}
                  </small>
                </div>
                <Link className="row-action" to="/intelligence/decisions">
                  Decide
                  <Icon name="arrow" size={13} />
                </Link>
              </article>
            ))}
          </div>
          {more ? (
            <Link className="attention-view-all" to="/intelligence/decisions">
              All proposals
              <span>{hidden}{pending.atLeast ? '+' : ''} more</span>
            </Link>
          ) : null}
        </>
      )}
    </section>
  )
}

function SituationsPreview({ episodes }: { episodes: OperationsEpisode[] | undefined }) {
  const visible = episodes?.slice(0, previewRows) ?? []
  const hidden = (episodes?.length ?? 0) - visible.length

  return (
    <section aria-labelledby="overview-situations-heading" className="attention-section">
      <div className="section-heading">
        <h2 id="overview-situations-heading">Watching</h2>
        {episodes === undefined || episodes.length === 0
          ? null
          : <span>{episodes.length} {episodes.length === 1 ? 'situation' : 'situations'}</span>}
      </div>
      {episodes === undefined ? (
        <SkeletonList rows={2} />
      ) : episodes.length === 0 ? (
        <div className="health-empty">
          <strong>No active situation.</strong>
        </div>
      ) : (
        <>
          <div className="health-list">
            {visible.map((episode) => (
              <article className={`list-row ${episode.severity}`} key={episode.episodeId}>
                <span className={`row-glyph ${episode.severity}`}>
                  <Icon name={episode.severity === 'watch' ? 'pulse' : 'alert'} />
                </span>
                <div className="row-text">
                  <strong>{episode.title}</strong>
                  <small>{episode.suggestedAction ?? episode.nextAction}</small>
                </div>
                <span className="row-controls">
                  <span className="state-label">{episodeStateLabel(episode.state)}</span>
                  <Link className="row-action" to="/intelligence/situations">
                    Details
                    <Icon name="arrow" size={13} />
                  </Link>
                </span>
              </article>
            ))}
          </div>
          {hidden > 0 ? (
            <Link className="attention-view-all" to="/intelligence/situations">
              All situations
              <span>{hidden} more</span>
            </Link>
          ) : null}
        </>
      )}
    </section>
  )
}
