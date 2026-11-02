import { api } from '@code2create/backend/api'
import { gameDefinition, type GameKey } from '@code2create/domain'
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

import { Flower } from '../components/portal/FlowerAvatar'
import { OutlineHeading } from '../components/portal/OutlineHeading'
import { PortalButton } from '../components/portal/PortalButton'
import { PortalScene } from '../components/portal/PortalScene'
import { RoomNav } from '../components/portal/RoomNav'
import { games, type GameEntry, type GameMode } from '../games/catalog'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useMediaQuery } from '../lib/useMediaQuery'
import { createRoundRecorder } from '../lib/gameRounds'
import { shortPlayerName } from '../lib/playerName'

const glass = 'rounded-petal glass'
const leaderboardDepth = 5

export type BoardRef = { readonly key: GameKey; readonly label: string }

export function boardsOf(entries: readonly GameEntry[]): readonly BoardRef[] {
  return entries.flatMap((game) =>
    game.modes
      ? game.modes.map((mode) => ({ key: mode.key, label: `${game.title} · ${mode.label}` }))
      : [{ key: game.key, label: game.title }],
  )
}

  export type Standing = { readonly position: number | null; readonly points: number }

export type BoardView = FunctionReturnType<typeof api.games.leaderboard>

export function standingOf(board: BoardView | undefined): Standing {
  if (board === undefined) return { position: null, points: 0 }
  const index = board.entries.findIndex((entry) => entry.isYou)
  return { position: index >= 0 ? index + 1 : null, points: board.yourBestScore }
}

const points = new Intl.NumberFormat('en-IN')

/**
 * The arcade's frame: the heading, the three cabinets in a row, the standings
 * beneath them. Separate from the queries so the screen gallery can show it
 * full of standings without a backend behind it.
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
    <PortalScene fill tree="left" header={header} nav={<RoomNav current="games" />}>
      {/* The room owns its height: on a desktop nothing here scrolls but the
          standings, and on a phone the whole column does. */}
      <div className="flex h-full min-h-0 w-full max-w-[1200px] flex-col overflow-y-auto text-left lg:overflow-visible">
        <header className="showcase-heading arcade-heading relative z-[1] flex flex-none flex-col gap-3">
          <OutlineHeading word="arcade" />
          <p className="arcade-sub m-0 text-[13px] text-fg/60">
            Something to play while your agent cooks. Only your best round counts.
          </p>
        </header>

        <section aria-label="Games" className="mt-5 grid flex-none grid-cols-1 gap-4 sm:grid-cols-3 lg:gap-5">
          {tiles}
        </section>
        <section aria-label="Leaderboards" className="mt-4 flex min-h-0 flex-col lg:mt-5">
          {standings}
        </section>
      </div>
      {children}
    </PortalScene>
  )
}

const art = '/games'

/**
 * A still from each game, built from the game's own sprites, so a cabinet
 * shows what it plays before it is opened. Hover nudges the scene along.
 */
const scenes: Partial<Record<GameKey, ReactNode>> = {
  pacman: (
    <div className="arcade-stage arcade-stage-maze">
      <img src={`${art}/pacman/pacman-open.svg`} alt="" className="arcade-pacman" />
      <span className="arcade-pellets" aria-hidden>
        {Array.from({ length: 5 }, (_, index) => (
          <img key={index} src={`${art}/pacman/pellet.svg`} alt="" className="arcade-pellet" />
        ))}
        <img src={`${art}/pacman/power-pellet.svg`} alt="" className="arcade-power" />
      </span>
      <img src={`${art}/pacman/cherry.svg`} alt="" className="arcade-cherry" />
      <img src={`${art}/pacman/ghosts/blinky-left-0.svg`} alt="" className="arcade-ghost" />
    </div>
  ),
  stack: (
    <div className="arcade-stage">
      <img src={`${art}/stack/sakura-stone-platform.svg`} alt="" className="arcade-platform" />
      <img src={`${art}/stack/origami.svg`} alt="" className="arcade-piece arcade-piece-base" />
      <img src={`${art}/stack/lantern.svg`} alt="" className="arcade-piece arcade-piece-mid" />
      <img src={`${art}/stack/petal.svg`} alt="" className="arcade-piece arcade-piece-top" />
      <img src={`${art}/stack/butterfly.svg`} alt="" className="arcade-butterfly" />
    </div>
  ),
  memory: (
    <div className="arcade-stage">
      <span className="arcade-card arcade-card-left" aria-hidden>
        <img src={`${art}/memory/C2C-Logo.svg`} alt="" />
      </span>
      <span className="arcade-card arcade-card-mid arcade-card-face" aria-hidden>
        <img src={`${art}/memory/Turtle.png`} alt="" />
      </span>
      <span className="arcade-card arcade-card-right" aria-hidden>
        <img src={`${art}/memory/C2C-Logo.svg`} alt="" />
      </span>
      <img src={`${art}/memory/Jellyfish.png`} alt="" className="arcade-drifter" />
    </div>
  ),
}

/**
 * The cabinet a game is picked from: a still from the game, its name and a
 * line on how it plays, where you stand on it and the way in. The whole card
 * opens the game; the button is there so the way in is never in doubt.
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
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onPlay()
        }
      }}
      className={`arcade-cabinet group flex min-w-0 cursor-pointer flex-col gap-5 p-5 text-left transition-[border-color,transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:border-rose-light hover:shadow-[0_24px_50px_-28px_var(--glow-rose)] focus-visible:border-rose-light focus-visible:outline-none ${glass}`}
    >
      {scenes[game.key]}
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-1">
        <div className="min-w-0">
          <p className="m-0 text-[12px] text-rose-light">
            {played && standing.position !== null ? (
              <>
                You stand #{standing.position}
                <span className="text-fg/35"> · best {points.format(standing.points)}</span>
              </>
            ) : (
              'Not played yet'
            )}
          </p>
          <h2 className="m-0 mt-1 font-display font-light text-[26px] leading-tight tracking-[-.015em] text-fg transition-colors duration-300 group-hover:text-rose-light">
            {game.title}
          </h2>
          <p className="arcade-blurb m-0 mt-2 text-[13px] leading-snug text-fg/65">{game.blurb}</p>
        </div>
        <PortalButton size="xs" className="mt-auto self-start" tabIndex={-1}>
          Play
        </PortalButton>
      </div>
    </article>
  )
}

/** The cabinet, reading its own standing from the board it belongs to. */
function GameTileLive({ game, onPlay }: { game: GameEntry; onPlay: () => void }) {
  // A game played more than one way stands on its first board; the rest are a
  // pill away in the standings.
  const gameKey = game.modes?.[0]?.key ?? game.key
  const board = useQuery(api.games.leaderboard, { eventSlug, gameKey })
  return <GameTile game={game} standing={standingOf(board)} onPlay={onPlay} />
}

/**
 * The list of boards, one row each. A game played more than one way shows its
 * name once and its modes beneath it, so the list reads as the games do.
 */
function BoardPicker({
  boards,
  active,
  onSelect,
  compact = false,
}: {
  boards: readonly BoardRef[]
  active: GameKey
  onSelect: (key: GameKey) => void
  /** A short screen: one row of pills, with no room for the nested list. */
  compact?: boolean
}) {
  if (compact) {
    return (
      <div role="group" aria-label="Board" className="flex flex-wrap gap-1.5">
        {boards.map((option) => {
          const lit = option.key === active
          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={lit}
              onClick={() => onSelect(option.key)}
              className={`rounded-full border px-3 py-1 font-ui text-[11.5px] font-semibold transition-[background,color,border-color] duration-250 ${
                lit
                  ? 'border-rose bg-rose text-wash'
                  : 'border-petal-line text-rose-light hover:border-rose-light hover:text-fg'
              }`}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    )
  }
  const groups = new Map<string, { key: GameKey; label: string }[]>()
  for (const board of boards) {
    const [game, mode] = board.label.split(' · ')
    const name = game ?? board.label
    const rows = groups.get(name) ?? []
    rows.push({ key: board.key, label: mode ?? name })
    groups.set(name, rows)
  }
  const row = (option: { key: GameKey; label: string }, nested: boolean) => {
    const lit = option.key === active
    return (
      <li key={option.key}>
        <button
          type="button"
          aria-pressed={lit}
          onClick={() => onSelect(option.key)}
          className={`flex w-full items-center rounded-full py-1.5 pr-3 text-left font-ui text-[13px] transition-[background,color] duration-250 ${
            nested ? 'pl-6' : 'pl-3'
          } ${lit ? 'bg-rose font-semibold text-wash' : 'text-rose-light hover:bg-fg/6 hover:text-fg'}`}
        >
          {option.label}
        </button>
      </li>
    )
  }
  return (
    <ul role="group" aria-label="Board" className="m-0 flex list-none flex-col gap-0.5 p-0">
      {[...groups].map(([name, rows]) =>
        rows.length === 1 && rows[0] ? (
          row(rows[0], false)
        ) : (
          <li key={name}>
            <p className="m-0 py-1.5 pl-3 font-ui text-[13px] text-fg/55">{name}</p>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{rows.map((option) => row(option, true))}</ul>
          </li>
        ),
      )}
    </ul>
  )
}

/** The standings: one board at a time, chosen from the list, its front five in a row. */
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
  // On a short desktop screen the panel is the part that gives: the picker
  // becomes a row of pills across the top and the list sits beneath it.
  const compact = useMediaQuery('(min-width: 1024px) and (max-height: 760px)')
  return (
    <div
      className={`arcade-standings flex flex-col gap-6 p-6 lg:min-h-0 lg:overflow-y-auto ${
        compact ? 'lg:gap-4 lg:p-5' : 'lg:flex-row lg:items-center lg:gap-10 lg:p-7'
      } ${glass}`}
    >
      <div className={`flex flex-none flex-col gap-4 ${compact ? 'lg:flex-row lg:items-center lg:justify-between' : 'lg:w-[220px]'}`}>
        <div className={compact ? 'flex items-center gap-4' : ''}>
          <p className="m-0 text-[12px] text-rose-light">Standings</p>
          <div className={compact ? '' : 'mt-3'}>
            <BoardPicker boards={boards} active={active} onSelect={onSelect} compact={compact} />
          </div>
        </div>
        <p className="m-0 text-[12.5px] text-fg/55">
          Your best{' '}
          <span className="font-ui tabular-nums text-fg/85">
            {board !== undefined && board.yourBestScore > 0 ? points.format(board.yourBestScore) : '—'}
          </span>
        </p>
      </div>
      <div className="min-w-0 flex-1">
        <LeaderboardPanel board={board} />
      </div>
    </div>
  )
}

/** The standings, reading the board it is showing. */
function StandingsColumnLive({ boards }: { boards: readonly BoardRef[] }) {
  const [active, setActive] = useState<GameKey>(boards[0]?.key ?? 'pacman')
  const board = useQuery(api.games.leaderboard, { eventSlug, gameKey: active })
  // The board just left stays up until the next one lands, so switching pills
  // never drops the panel to a loading line and back.
  const [shown, setShown] = useState<{ key: GameKey; board: BoardView } | null>(null)
  if (board !== undefined && (shown === null || shown.key !== active || shown.board !== board)) {
    setShown({ key: active, board })
  }
  return (
    <StandingsColumn boards={boards} active={active} onSelect={setActive} board={board ?? shown?.board} />
  )
}

/**
 * One board's front five, given the data: a flower and a rank for each. The
 * grid always holds five places, empty ones drawn faint, so the panel keeps
 * its height whichever board is showing.
 */
function LeaderboardPanel({ board }: { board: BoardView | undefined }) {
  const entries = board?.entries.slice(0, leaderboardDepth) ?? []
  const slots = Array.from({ length: leaderboardDepth }, (_, index) => entries[index] ?? null)
  const note =
    board === undefined ? 'Loading…' : board.entries.length === 0 ? 'No rounds yet. Play one and take the top spot.' : null
  return (
    <div className="relative">
      <ol
        aria-hidden={note !== null}
        className={`m-0 grid list-none grid-cols-2 gap-x-4 gap-y-5 p-0 sm:grid-cols-3 lg:grid-cols-5 ${note ? 'opacity-40' : ''}`}
      >
        {slots.map((entry, index) =>
          entry ? (
            <li key={entry.personId} className={`flex min-w-0 flex-col items-start gap-2.5 ${entry.isYou ? 'text-rose-light' : 'text-fg/85'}`}>
              <span className="relative flex size-11 items-center justify-center rounded-full border-2 border-rose/70 bg-avatar">
                <Flower seed={String(entry.personId)} className="size-[62%]" />
                <span
                  aria-hidden
                  className={`absolute -right-1.5 -bottom-1 flex size-5 items-center justify-center rounded-full border font-ui text-[10px] font-semibold tabular-nums ${
                    index === 0 ? 'border-rose bg-rose text-wash' : 'border-petal-line bg-wash text-fg/70'
                  }`}
                >
                  {index + 1}
                </span>
              </span>
              <span className="w-full min-w-0">
                <span className="block truncate text-[13.5px]" title={entry.displayName}>
                  {shortPlayerName(entry.displayName)}
                  {entry.isYou ? <span className="text-fg/40"> · you</span> : null}
                </span>
                <span className="block font-ui text-[12.5px] tabular-nums text-fg/55">{points.format(entry.bestScore)}</span>
              </span>
            </li>
          ) : (
            <li key={`open-${index}`} aria-hidden className="flex min-w-0 flex-col items-start gap-2.5">
              <span className="relative flex size-11 items-center justify-center rounded-full border-2 border-dashed border-petal-line">
                <span className="absolute -right-1.5 -bottom-1 flex size-5 items-center justify-center rounded-full border border-petal-line bg-wash font-ui text-[10px] tabular-nums text-fg/35">
                  {index + 1}
                </span>
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] text-fg/30">Open</span>
                <span className="block font-ui text-[12.5px] text-fg/25">—</span>
              </span>
            </li>
          ),
        )}
      </ol>
      {note ? (
        <p role="status" className="absolute inset-0 m-0 grid place-items-center text-center text-[13px] leading-relaxed text-fg/70">
          {note}
        </p>
      ) : null}
    </div>
  )
}

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
        recordRound: async (round) => {
          await recordRound({ eventSlug, gameKey, score: round.score, runId: round.runId })
        },
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
  const onRoundEnd = useCallback(
    (score: number) => {
      // The server refuses a score above the game's published maximum, which is
      // right for Pac-Man — its ceiling is the board's own and anything above it
      // was never played. The endless games carry a bound rather than a ceiling,
      // so an exceptional round is recorded at the cap instead of being thrown
      // away with an error.
      const maximum = gameDefinition(gameKey)?.maximumScore
      recorder.end(maximum === undefined ? score : Math.min(score, maximum))
    },
    [gameKey, recorder],
  )

  const { Board } = game
  const modes: readonly GameMode[] | undefined = game.modes

  return (
    <div
      className="fixed inset-0 z-[40] flex items-center justify-center bg-ink/60 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={game.title}
        className={`relative flex max-h-[92vh] w-full max-w-[760px] flex-col overflow-hidden bg-wash/70 ${glass}`}
      >
        <div className="flex flex-none items-center justify-between gap-3 border-b border-petal-line px-5 py-3">
          <p className="m-0 font-ui text-[15px] text-rose-light">{game.title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-8 flex-none items-center justify-center rounded-full border border-rose/50 text-fg/80 transition-colors hover:border-rose-light hover:text-fg"
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

        <div className="flex min-h-[420px] flex-1 overflow-auto bg-black/40 p-4">
          {/* Auto margins, not flex centring: a board taller than the dialog then
              scrolls from its top instead of losing its top edge off-screen. */}
          <div className="m-auto flex w-full justify-center">
          <Suspense fallback={<p className="font-arcade text-sm text-[#F1CEDF]">Loading…</p>}>
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
        </div>

        <div className="flex-none px-5 py-3">
          <p className="m-0 text-center text-[12.5px] text-fg/55">{game.blurb}</p>
          {error ? (
            <p className="mt-1.5 text-center text-[12.5px] text-rose-light">{error}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
