import { api } from '@code2create/backend/api'
import type { GameKey } from '@code2create/domain'
import { useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'

import { PortalScene } from '../components/portal/PortalScene'
import { games, type GameEntry, type GameMode } from '../games/catalog'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { createRoundRecorder } from '../lib/gameRounds'

/**
 * The arcade.
 *
 * The games sit on the left and every board's standings on the right, so a
 * person can read where they stand across all of them without opening
 * anything. A game itself opens over the screen rather than replacing it: the
 * arcade is somewhere to pass a few minutes, and coming back out of one should
 * not feel like navigating.
 *
 * Standings are per person, not per team, and a person may replay as often as
 * they like — the board keeps their best single round, so replaying can improve
 * a place but never inflate one.
 */
export function GamesScreen({ header }: { header: ReactNode }) {
  const [playing, setPlaying] = useState<GameEntry | null>(null)

  return (
    <PortalScene tree="left" header={header}>
      <div className="flex w-full max-w-[1080px] flex-col items-center">
        <h1 className="mb-2 text-center font-display font-light tracking-[-.01em] text-3xl text-shadow-[0_6px_40px_var(--scene-text-glow)] lg:text-[44px]">
          Games to play while your agent cooks
        </h1>
        <p className="mb-7 text-xs text-fg/50">
          <Link to="/" viewTransition className="text-rose-light underline-offset-4 hover:underline">
            back home
          </Link>
        </p>

        <div className="grid w-full gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section aria-label="Games">
            <h2 className="mb-3 font-ui text-[15px] text-rose-light">Pick a game</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {games.map((game) => (
                <GameTile key={game.key} game={game} onPlay={() => setPlaying(game)} />
              ))}
            </div>
          </section>

          <section aria-label="Leaderboards">
            <h2 className="mb-3 font-ui text-[15px] text-rose-light">Leaderboards</h2>
            <div className="flex flex-col gap-4">
              {games.flatMap((game) =>
                game.modes
                  ? game.modes.map((mode) => (
                      <LeaderboardCard
                        key={mode.key}
                        gameKey={mode.key}
                        title={`${game.title} · ${mode.label}`}
                      />
                    ))
                  : [
                      <LeaderboardCard
                        key={game.key}
                        gameKey={game.key}
                        title={game.title}
                      />,
                    ],
              )}
            </div>
          </section>
        </div>
      </div>

      {playing ? <GameDialog game={playing} onClose={() => setPlaying(null)} /> : null}
    </PortalScene>
  )
}

/** The glass card a game is picked from, in the dashboard's own shape. */
function GameTile({ game, onPlay }: { game: GameEntry; onPlay: () => void }) {
  return (
    <button
      type="button"
      onClick={onPlay}
      className="flex min-h-[132px] cursor-pointer flex-col justify-between gap-3 rounded-[18px] border border-petal-edge/70 bg-fg/5 p-[18px] text-left shadow-[0_20px_44px_-30px_var(--shade-2),inset_0_1px_0_color-mix(in_srgb,var(--color-fg)_14%,transparent)] backdrop-blur-[22px] backdrop-saturate-[1.35] transition-[border-color,background-color,transform] duration-300 hover:border-rose-light/70 hover:bg-fg/8 focus-visible:border-rose-light focus-visible:outline-none active:scale-[.995]"
    >
      <div>
        <p className="m-0 font-ui text-[15px] text-rose-light">{game.title}</p>
        <p className="mt-1.5 text-[12.5px] leading-snug text-fg/60">{game.blurb}</p>
      </div>
      <span className="font-ui text-[12.5px] text-fg/45">
        {game.modes ? `${game.modes.length} ways to play · play` : 'play'}
      </span>
    </button>
  )
}

/** One board's standings. */
function LeaderboardCard({ gameKey, title }: { gameKey: GameKey; title: string }) {
  const board = useQuery(api.games.leaderboard, { eventSlug, gameKey })

  return (
    <div className="rounded-[18px] border border-petal-edge/70 bg-fg/5 px-5 py-4 shadow-[0_20px_44px_-30px_var(--shade-2),inset_0_1px_0_color-mix(in_srgb,var(--color-fg)_14%,transparent)] backdrop-blur-[22px] backdrop-saturate-[1.35]">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="font-ui text-[15px] text-rose-light">{title}</span>
        <span className="font-ui text-[10.5px] tracking-[.08em] lowercase text-fg/50">
          best round
        </span>
      </div>
      {board === undefined ? (
        <p className="py-4 text-center text-[12.5px] text-fg/50">Loading…</p>
      ) : board.entries.length === 0 ? (
        <p className="py-4 text-center text-[12.5px] text-fg/50">
          No rounds yet. Play one and take the top spot.
        </p>
      ) : (
        <ol className="m-0 list-none p-0">
          {board.entries.map((entry, index) => (
            <li
              key={entry.personId}
              className={`flex items-center gap-3 py-1.5 ${entry.isYou ? 'text-rose-light' : 'text-fg/80'}`}
            >
              <span className="w-6 flex-none text-right font-ui text-[12px] tabular-nums text-fg/45">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px]">
                {entry.displayName}
                {entry.isYou ? ' · you' : ''}
              </span>
              <span className="flex-none font-ui text-[13px] tabular-nums">{entry.bestScore}</span>
            </li>
          ))}
        </ol>
      )}
      {board && board.yourBestScore > 0 ? (
        <p className="mt-3 border-t border-petal-line pt-3 text-[12px] text-fg/55">
          Your best: <span className="font-ui tabular-nums text-fg/85">{board.yourBestScore}</span>
        </p>
      ) : null}
    </div>
  )
}

type RunId = FunctionReturnType<typeof api.games.startRound>['runId']

/**
 * A game, open over the arcade.
 *
 * Escape closes it, as does the backdrop, because a game is a diversion and
 * getting out of one should cost nothing.
 */
function GameDialog({ game, onClose }: { game: GameEntry; onClose: () => void }) {
  const [mode, setMode] = useState<GameKey>(game.modes?.[0]?.key ?? game.key)
  const gameKey = game.modes ? mode : game.key
  const startRound = useMutation(api.games.startRound)
  const recordRound = useMutation(api.games.recordRound)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    // The arcade behind the dialog must not scroll while a game is open.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose])

  // Pairing the round with its run is the same waiting problem on every game,
  // so it lives in `createRoundRecorder` where it can be tested without a
  // browser. One recorder per board, kept across renders so a round in progress
  // keeps the run it was opened with.
  const recorder = useMemo(
    () =>
      createRoundRecorder<RunId>({
        openRun: () => startRound({ eventSlug, gameKey }).then((opened) => opened.runId),
        recordRound: (round) =>
          recordRound({ eventSlug, gameKey, score: round.score, runId: round.runId }),
        // A lost round is not worth interrupting play for; the message sits
        // under the board and the next round tries again.
        onError: (cause) => setError(readableError(cause)),
      }),
    [gameKey, recordRound, startRound],
  )

  const onRoundStart = useCallback(() => {
    setError(null)
    recorder.start()
  }, [recorder])
  const onRoundEnd = useCallback((score: number) => recorder.end(score), [recorder])

  const { Board } = game
  const modes: readonly GameMode[] | undefined = game.modes

  return (
    <div
      className="fixed inset-0 z-[40] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={game.title}
        className="relative flex max-h-[92vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[18px] border border-petal-edge/70 bg-fg/5 shadow-[0_20px_44px_-30px_var(--shade-2),inset_0_1px_0_color-mix(in_srgb,var(--color-fg)_14%,transparent)] backdrop-blur-[22px] backdrop-saturate-[1.35]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-petal-line px-5 py-3">
          <p className="m-0 font-ui text-[15px] text-rose-light">{game.title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-8 flex-none items-center justify-center rounded-full border border-rose/50 bg-wash/60 text-fg/80 backdrop-blur-md transition-colors hover:border-rose-light hover:text-fg"
          >
            <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
              <path
                d="M3 3l10 10M13 3L3 13"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="flex min-h-[420px] flex-1 items-center justify-center overflow-auto bg-black/40 p-4">
          <Suspense fallback={<p className="font-arcade text-sm text-[#F1CEDF]">LOADING…</p>}>
            {/* Keyed by mode so changing it deals a fresh game rather than
                carrying one mode's state into the other. */}
            <Board
              key={gameKey}
              mode={gameKey}
              {...(modes ? { modes, onModeChange: setMode } : {})}
              onRoundStart={onRoundStart}
              onRoundEnd={onRoundEnd}
            />
          </Suspense>
        </div>

        <div className="px-5 py-3">
          <p className="m-0 text-center text-[12.5px] text-fg/55">{game.blurb}</p>
          {error ? (
            <p className="mt-1.5 text-center text-[12.5px] text-rose-light">{error}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
