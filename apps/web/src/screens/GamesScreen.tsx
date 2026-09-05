import { api } from '@code2create/backend/api'
import { useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { Suspense, useCallback, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { PetalCard } from '../components/portal/PetalCard'
import { PortalScene } from '../components/portal/PortalScene'
import { games, type GameEntry } from '../games/catalog'
import type { GameKey } from '@code2create/domain'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { createRoundRecorder } from '../lib/gameRounds'

/**
 * The arcade: one game at a time, with the board above and its leaderboard
 * beside it.
 *
 * Standings are per person, not per team, and a person may replay as often as
 * they like — the board keeps their best single round, so replaying can improve
 * a place but never inflate one.
 */
export function GamesScreen({ header }: { header: ReactNode }) {
  const [activeKey, setActiveKey] = useState(games[0]?.key ?? null)
  const active = games.find((game) => game.key === activeKey) ?? null

  return (
    <PortalScene tree="left" header={header}>
      <div className="flex w-full max-w-[1080px] flex-col items-center">
        <h1 className="mb-2 text-center font-display font-light tracking-[-.01em] text-3xl text-shadow-[0_6px_40px_var(--scene-text-glow)] lg:text-[44px]">
          Arcade
        </h1>
        <p className="mb-6 text-xs text-fg/50">
          <Link to="/" viewTransition className="text-rose-light underline-offset-4 hover:underline">
            back home
          </Link>
        </p>

        {games.length > 1 ? (
          <div className="mb-6 flex flex-wrap justify-center gap-2">
            {games.map((game) => (
              <button
                key={game.key}
                type="button"
                onClick={() => setActiveKey(game.key)}
                className={`rounded-petal-sm border-2 px-4 py-1.5 text-[13px] transition-colors ${
                  game.key === activeKey
                    ? 'border-petal-edge bg-rose-light/15 text-fg'
                    : 'border-petal-line text-fg/60 hover:text-fg'
                }`}
              >
                {game.title}
              </button>
            ))}
          </div>
        ) : null}

        {active ? <GamePanel game={active} /> : <p className="text-fg/60">No games are published yet.</p>}
      </div>
    </PortalScene>
  )
}

/** The run id `startRound` hands back, read off the API so it stays in step. */
type RunId = FunctionReturnType<typeof api.games.startRound>['runId']

/** One game: its board, and the standings for it. */
function GamePanel({ game }: { game: GameEntry }) {
  // A game played more than one way keeps a board per mode: the modes measure
  // different things, so one ranking over both would say nothing. The switch
  // below moves the leaderboard with it.
  const [mode, setMode] = useState<GameKey>(game.modes?.[0]?.key ?? game.key)
  const gameKey = game.modes ? mode : game.key
  const board = useQuery(api.games.leaderboard, { eventSlug, gameKey })
  const startRound = useMutation(api.games.startRound)
  const recordRound = useMutation(api.games.recordRound)
  const [error, setError] = useState<string | null>(null)
  // Pairing the round with its run is the same waiting problem on every game,
  // so it lives in `createRoundRecorder` where it can be tested without a
  // browser. One recorder per game, kept across renders so a round in progress
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
  return (
    <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col items-center">
        {game.modes ? (
          <div className="mb-3 flex gap-2">
            {game.modes.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setMode(option.key)}
                className={`rounded-petal-sm border-2 bg-transparent px-3 py-1 font-ui text-[12.5px] transition-colors ${
                  option.key === gameKey
                    ? 'border-petal-edge bg-rose-light/15 text-fg'
                    : 'border-petal-line text-fg/60 hover:text-fg'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex min-h-[420px] w-full items-center justify-center bg-black p-4">
          <Suspense fallback={<p className="font-arcade text-sm text-[#F1CEDF]">LOADING…</p>}>
            {/* Keyed by mode so switching deals a fresh board rather than
                carrying one game's state into the other. */}
            <Board key={gameKey} mode={gameKey} onRoundStart={onRoundStart} onRoundEnd={onRoundEnd} />
          </Suspense>
        </div>
        <p className="mt-3 text-center text-[12.5px] text-fg/55">{game.blurb}</p>
        {error ? <p className="mt-2 text-[12.5px] text-rose-light">{error}</p> : null}
      </div>

      <PetalCard className="px-5 py-4">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="font-ui font-normal text-base text-rose-light">Leaderboard</span>
          <span className="text-[10.5px] font-semibold tracking-[.08em] text-fg/50">BEST ROUND</span>
        </div>
        {board === undefined ? (
          <p className="py-6 text-center text-[12.5px] text-fg/50">Loading…</p>
        ) : board.entries.length === 0 ? (
          <p className="py-6 text-center text-[12.5px] text-fg/50">
            No rounds yet. Play one and take the top spot.
          </p>
        ) : (
          <ol className="m-0 list-none p-0">
            {board.entries.map((entry, index) => (
              <li
                key={entry.personId}
                className={`flex items-center gap-3 py-1.5 ${entry.isYou ? 'text-rose-light' : 'text-fg/80'}`}
              >
                <span className="w-6 flex-none text-right font-mono text-[12px] text-fg/45">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {entry.displayName}
                  {entry.isYou ? ' · you' : ''}
                </span>
                <span className="flex-none font-mono text-[13px]">{entry.bestScore}</span>
              </li>
            ))}
          </ol>
        )}
        {board && board.yourBestScore > 0 ? (
          <p className="mt-3 border-t border-petal-line pt-3 text-[12px] text-fg/55">
            Your best: <span className="font-mono text-fg/85">{board.yourBestScore}</span>
          </p>
        ) : null}
      </PetalCard>
    </div>
  )
}
