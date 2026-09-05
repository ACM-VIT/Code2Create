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

/** The dashboard's glass, so the arcade reads as part of the portal. */
const glass =
  'rounded-[18px] border border-petal-edge/70 bg-fg/5 shadow-[0_20px_44px_-30px_var(--shade-2),inset_0_1px_0_color-mix(in_srgb,var(--color-fg)_14%,transparent)] backdrop-blur-[22px] backdrop-saturate-[1.35]'

const columnHeight = 'max-h-[min(58vh,460px)]'

/** How many places the standings column shows. */
const leaderboardDepth = 5

/** Every board the arcade keeps: a game, or one of a game's modes. */
export type BoardRef = { readonly key: GameKey; readonly label: string }

export function boardsOf(entries: readonly GameEntry[]): readonly BoardRef[] {
  return entries.flatMap((game) =>
    game.modes
      ? game.modes.map((mode) => ({ key: mode.key, label: `${game.title} · ${mode.label}` }))
      : [{ key: game.key, label: game.title }],
  )
}

/** Where a person stands on one board. `position` is null until they place. */
export type Standing = { readonly position: number | null; readonly points: number }

export type BoardView = FunctionReturnType<typeof api.games.leaderboard>

export function standingOf(board: BoardView | undefined): Standing {
  if (board === undefined) return { position: null, points: 0 }
  const index = board.entries.findIndex((entry) => entry.isYou)
  return { position: index >= 0 ? index + 1 : null, points: board.yourBestScore }
}

/* ------------------------------------------------------------------ layout */

/**
 * The arcade's frame, given its two columns.
 *
 * Separate from the queries so the screen gallery can show it full of standings
 * without a backend behind it, and without the live screen carrying sample data
 * of its own.
 */
export function ArcadeView({
  header,
  tiles,
  standings,
  children,
}: {
  header: ReactNode
  tiles: ReactNode
  standings: ReactNode
  children?: ReactNode
}) {
  return (
    <PortalScene tree="left" header={header}>
      <div className="flex w-full max-w-[1120px] flex-col items-center lowercase">
        <h1 className="mb-1.5 text-center font-display font-light lowercase tracking-[-.01em] text-3xl text-shadow-[0_6px_40px_var(--scene-text-glow)] lg:text-[42px]">
          games to play while your agent cooks!
        </h1>
        <p className="mb-6 text-xs lowercase text-fg/50">
          <Link to="/" viewTransition className="text-rose-light underline-offset-4 hover:underline">
            back home
          </Link>
        </p>

        <div className="grid w-full gap-5 lg:grid-cols-[minmax(0,330px)_minmax(0,1fr)_minmax(0,330px)]">
          <section aria-label="Games" className="flex min-w-0 flex-col">
            <h2 className="mb-2.5 font-ui text-[15px] lowercase text-rose-light">pick a game</h2>
            <div className={`flex flex-col gap-3.5 overflow-y-auto pr-1 ${columnHeight}`}>
              {tiles}
            </div>
          </section>

          {/* The mark, holding the middle the way it holds the memory board. */}
          <div className="hidden items-center justify-center lg:flex" aria-hidden>
            <img
              src="/assets/logo.svg"
              alt=""
              className="w-[104px] opacity-70 drop-shadow-[0_0_28px_var(--logo-glow)]"
            />
          </div>

          <section aria-label="Leaderboards" className="flex min-w-0 flex-col">
            <h2 className="mb-2.5 font-ui text-[15px] lowercase text-rose-light">leaderboards</h2>
            {standings}
          </section>
        </div>
      </div>
      {children}
    </PortalScene>
  )
}

/* ------------------------------------------------------------------- tiles */

/**
 * The rank's size, so a place in the hundreds still sits inside its box.
 *
 * Three digits at the size a single one wears would run over the edge, and a
 * box wide enough for the widest case would leave the common one swimming.
 */
function rankSize(rank: string): string {
  if (rank.length <= 3) return 'text-[26px]'
  if (rank.length === 4) return 'text-[21px]'
  return 'text-[17px]'
}

/**
 * The card a game is picked from: its name, and where you stand on it.
 *
 * The rank sits on the right, apart from the name, because it is the thing you
 * come back to check rather than the thing you read. A dash says "not yet"
 * without a sentence, so an unplayed game shows no score rather than a zero.
 *
 * Reaching for the card puts it out of focus: the name and the rank stay where
 * they are but blur behind the one word that says what the card does.
 */
export function GameTile({
  game,
  standing,
  onPlay,
}: {
  game: GameEntry
  standing: Standing
  onPlay: () => void
}) {
  const played = standing.points > 0
  const rank = `#${standing.position ?? '—'}`
  return (
    <button
      type="button"
      onClick={onPlay}
      className={`group relative flex flex-none cursor-pointer items-stretch overflow-hidden p-3.5 text-left lowercase transition-[border-color,background-color,transform] duration-300 hover:border-rose-light/70 focus-visible:border-rose-light focus-visible:outline-none active:scale-[.995] ${glass}`}
    >
      <span className="flex flex-1 items-center gap-3.5">
        <span className="min-w-0 flex-1 font-ui text-[15px] lowercase text-rose-light">
          {game.title}
        </span>

        <span className="flex w-[70px] flex-none flex-col items-center justify-center gap-0.5 rounded-petal-sm border border-petal-line bg-black/25 px-1.5 py-2">
          <span
            className={`font-display leading-none tabular-nums ${rankSize(rank)} ${
              played && standing.position !== null ? 'text-rose-light' : 'text-fg/35'
            }`}
          >
            {rank}
          </span>
          <span className="w-full truncate text-center font-ui text-[10.5px] leading-none lowercase text-fg/45 tabular-nums">
            {played ? `${standing.points} pts` : '— pts'}
          </span>
        </span>
      </span>

      {/* The card stays where it is and goes out of focus behind the word. The
          blur is deep enough that the name and rank read as texture rather than
          as something still being offered. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 grid place-items-center bg-black/45 opacity-0 backdrop-blur-[10px] transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
      >
        <span className="font-display text-[22px] lowercase text-white drop-shadow-[0_2px_14px_rgba(0,0,0,.55)]">
          play
        </span>
      </span>
    </button>
  )
}

/** The card, reading its own standing from the board it belongs to. */
function GameTileLive({ game, onPlay }: { game: GameEntry; onPlay: () => void }) {
  // A game played more than one way stands on its first board; the rest are a
  // tab away in the standings column.
  const gameKey = game.modes?.[0]?.key ?? game.key
  const board = useQuery(api.games.leaderboard, { eventSlug, gameKey })
  return <GameTile game={game} standing={standingOf(board)} onPlay={onPlay} />
}

/* -------------------------------------------------------------- standings */

/** The standings column: one board at a time, chosen by the tabs above it. */
export function StandingsColumn({
  boards,
  active,
  onSelect,
  board,
}: {
  boards: readonly BoardRef[]
  active: GameKey
  onSelect: (key: GameKey) => void
  board: BoardView | undefined
}) {
  return (
    <div className={`flex min-h-0 flex-col ${columnHeight} ${glass}`}>
      <div className="flex flex-none flex-wrap gap-1.5 border-b border-petal-line p-3">
        {boards.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => onSelect(option.key)}
            className={`rounded-petal-sm border-2 bg-transparent px-2.5 py-1 font-ui text-[11.5px] lowercase transition-colors ${
              option.key === active
                ? 'border-petal-edge bg-rose-light/15 text-fg'
                : 'border-petal-line text-fg/55 hover:text-fg'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <LeaderboardPanel board={board} />
      </div>
    </div>
  )
}

/** The standings column, reading the board it is showing. */
function StandingsColumnLive({ boards }: { boards: readonly BoardRef[] }) {
  const [active, setActive] = useState<GameKey>(boards[0]?.key ?? 'pacman')
  const board = useQuery(api.games.leaderboard, { eventSlug, gameKey: active })
  return <StandingsColumn boards={boards} active={active} onSelect={setActive} board={board} />
}

/** One board's standings, given the data. */
export function LeaderboardPanel({ board }: { board: BoardView | undefined }) {
  if (board === undefined) {
    return <p className="py-4 text-center text-[12.5px] lowercase text-fg/50">loading…</p>
  }
  if (board.entries.length === 0) {
    return (
      <p className="py-4 text-center text-[12.5px] lowercase text-fg/50">
        no rounds yet. play one and take the top spot.
      </p>
    )
  }
  // The column shows the front of the field; a person's own place is on the line
  // beneath it whether or not they are in it.
  const shown = board.entries.slice(0, leaderboardDepth)
  return (
    <>
      <ol className="m-0 list-none p-0">
        {shown.map((entry, index) => (
          <li
            key={entry.personId}
            className={`flex items-center gap-3 py-1.5 lowercase ${entry.isYou ? 'text-rose-light' : 'text-fg/80'}`}
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
      {board.yourBestScore > 0 ? (
        <p className="mt-3 border-t border-petal-line pt-3 text-[12px] lowercase text-fg/55">
          your best: <span className="font-ui tabular-nums text-fg/85">{board.yourBestScore}</span>
        </p>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ screen */

/**
 * The arcade.
 *
 * Three columns: the games to pick from, the mark in the middle, and the
 * standings. The two outer columns scroll on their own, so a long list of games
 * never pushes the standings off the screen and neither one moves the page.
 *
 * A game opens over the screen rather than replacing it. The arcade is somewhere
 * to pass a few minutes while something else finishes, and coming back out of a
 * game should not feel like navigating.
 *
 * Standings are per person, not per team, and a person may replay as often as
 * they like — the board keeps their best single round, so replaying can improve
 * a place but never inflate one.
 */
export function GamesScreen({ header }: { header: ReactNode }) {
  const [playing, setPlaying] = useState<GameEntry | null>(null)
  const boards = useMemo(() => boardsOf(games), [])

  return (
    <ArcadeView
      header={header}
      tiles={games.map((game) => (
        <GameTileLive key={game.key} game={game} onPlay={() => setPlaying(game)} />
      ))}
      standings={<StandingsColumnLive boards={boards} />}
    >
      {playing ? <GameDialog game={playing} onClose={() => setPlaying(null)} /> : null}
    </ArcadeView>
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
        className={`relative flex max-h-[92vh] w-full max-w-[760px] flex-col overflow-hidden lowercase ${glass}`}
      >
        <div className="flex flex-none items-center justify-between gap-3 border-b border-petal-line px-5 py-3">
          <p className="m-0 font-ui text-[15px] lowercase text-rose-light">{game.title}</p>
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
          <Suspense fallback={<p className="font-arcade text-sm text-[#F1CEDF]">loading…</p>}>
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

        <div className="flex-none px-5 py-3">
          <p className="m-0 text-center text-[12.5px] lowercase text-fg/55">{game.blurb}</p>
          {error ? (
            <p className="mt-1.5 text-center text-[12.5px] lowercase text-rose-light">{error}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
