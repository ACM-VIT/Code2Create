import { useCallback, useEffect, useRef, useState } from 'react'

import {
  concealMismatch,
  createGame,
  matchedPairs,
  PAIR_COUNT,
  selectCard,
  type Card,
  type MemoryGame,
} from './game/engine.ts'
import {
  beginPlay,
  cellCount,
  chooseSquare,
  createPatternGame,
  gridSize,
  nextLevel,
  replayLevel,
  revealMs,
  STARTING_LIVES,
  targetCount,
  type PatternGame,
} from './game/pattern.ts'
import { roundScore } from './game/score.ts'

const assetBase = '/games/memory'
const mismatchRevealMs = 900
const clearedPauseMs = 850
const wrongPauseMs = 700

function formatTime(totalMs: number) {
  const totalSeconds = Math.floor(totalMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0')
  const seconds = (totalSeconds % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
}

/** One reading on the control row, in the portal's own type. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col leading-tight">
      <span className="font-ui text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
        {label}
      </span>
      <span className="font-ui text-[15px] tabular-nums text-fg/85">{value}</span>
    </div>
  )
}

/**
 * A control on the board's one row.
 *
 * The background is set explicitly because the portal loads Tailwind's
 * utilities without its preflight, so a button otherwise keeps the browser's
 * own grey.
 */
function ControlButton({
  children,
  onClick,
  disabled = false,
}: {
  children: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-petal-sm border-2 border-petal-line bg-transparent px-3 py-1.5 font-ui text-[13px] text-fg/70 transition-colors hover:border-petal-edge hover:bg-rose-light/10 hover:text-fg disabled:opacity-40 disabled:hover:border-petal-line disabled:hover:bg-transparent disabled:hover:text-fg/70"
    >
      {children}
    </button>
  )
}

/** Lives, drawn the way the pattern game draws them. */
function Hearts({ lives }: { lives: number }) {
  return (
    <span className="flex items-center gap-1" aria-label={`${lives} lives remaining`}>
      {Array.from({ length: STARTING_LIVES }, (_, index) => (
        <svg
          key={index}
          viewBox="0 0 24 24"
          aria-hidden="true"
          className={`size-3.5 ${index < lives ? 'text-rose-light' : 'text-fg/15'}`}
          fill="currentColor"
        >
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
        </svg>
      ))}
    </span>
  )
}

/**
 * Memory, played either way.
 *
 * The two modes are separate games to the server — separate keys, separate
 * bounds, separate leaderboards — because one ranks moves and a clock and the
 * other ranks levels survived. The arcade presents them as one game with a
 * switch, which is how they are actually played.
 */
export default function Board(props: {
  mode?: string
  onRoundStart?: () => void
  onRoundEnd?: (score: number) => void
}) {
  return props.mode === 'memory-grid' ? <PatternBoard {...props} /> : <PairsBoard {...props} />
}

/* ------------------------------------------------------------------ pattern */

/**
 * Pattern mode: squares light up, go dark, and are asked for back in any order.
 *
 * The round scores the levels cleared, so it ends when the last life goes. An
 * abandoned board reports nothing, the same as the pairs mode.
 */
function PatternBoard({
  onRoundStart,
  onRoundEnd,
}: {
  onRoundStart?: () => void
  onRoundEnd?: (score: number) => void
}) {
  const [game, setGame] = useState<PatternGame>(() => createPatternGame())
  const reported = useRef(false)
  const opened = useRef(false)

  const { phase, level, lives, pattern, picked, wrong } = game
  const columns = gridSize(level)
  const remaining = targetCount(level) - picked.size

  // Show the pattern, then hand the board over. A wrong square rests a shorter
  // moment and replays the same level rather than dealing a new one.
  useEffect(() => {
    if (phase !== 'showing') return
    const delay = wrong === null ? revealMs(level) : wrongPauseMs
    const timer = window.setTimeout(() => {
      setGame((current) =>
        current.wrong === null ? beginPlay(current) : beginPlay(replayLevel(current)),
      )
    }, delay)
    return () => window.clearTimeout(timer)
  }, [phase, level, wrong])

  // A cleared level rests so the finished pattern can be seen.
  useEffect(() => {
    if (phase !== 'levelCleared') return
    const timer = window.setTimeout(() => setGame((current) => nextLevel(current)), clearedPauseMs)
    return () => window.clearTimeout(timer)
  }, [phase])

  // The round's score is the levels cleared, reported once when lives run out.
  useEffect(() => {
    if (phase !== 'failed' || reported.current) return
    reported.current = true
    onRoundEnd?.(game.cleared)
  }, [phase, game.cleared, onRoundEnd])

  const newGame = useCallback(() => {
    reported.current = false
    opened.current = false
    setGame(createPatternGame())
  }, [])

  const choose = useCallback(
    (index: number) => {
      // The run opens with the first square answered, not when the board is
      // dealt: a pattern nobody answers is not a round.
      if (!opened.current) {
        opened.current = true
        onRoundStart?.()
      }
      setGame((current) => chooseSquare(current, index))
    },
    [onRoundStart],
  )

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="flex w-full max-w-[420px] flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <ControlButton onClick={newGame}>New game</ControlButton>
        <div className="flex items-center gap-5">
          <Stat label="LEVEL" value={String(level)} />
          <Stat label="CLEARED" value={String(game.cleared)} />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="font-ui text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
              LIVES
            </span>
            <Hearts lives={lives} />
          </div>
        </div>
      </div>

      <div className="relative">
        <div
          className="grid gap-1.5"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          role="grid"
          aria-label="Memory squares"
        >
          {Array.from({ length: cellCount(level) }, (_, index) => {
            const lit = phase === 'showing' && pattern.has(index)
            const chosen = picked.has(index)
            const missed = wrong === index
            return (
              <button
                key={index}
                type="button"
                role="gridcell"
                aria-label={`Square ${index + 1}`}
                disabled={phase !== 'playing'}
                onClick={() => choose(index)}
                className={`size-[46px] rounded-petal-sm border-2 transition-colors sm:size-[52px] ${
                  missed
                    ? 'border-transparent bg-[#e11d48]'
                    : lit
                      ? 'border-transparent bg-rose-light'
                      : chosen
                        ? 'border-transparent bg-rose-light/60'
                        : 'border-petal-line bg-black/40 enabled:hover:border-petal-edge'
                }`}
              />
            )
          })}
        </div>

        {phase === 'failed' ? (
          <div className="absolute inset-0 grid place-items-center rounded-petal-sm bg-black/75 backdrop-blur-sm">
            <div className="text-center">
              <p className="font-ui text-[15px] text-rose-light">Game over</p>
              <p className="mt-1 font-ui text-[12.5px] text-fg/70">You reached level {level}.</p>
            </div>
          </div>
        ) : null}
      </div>

      <p className="text-center font-ui text-[12.5px] text-fg/60">
        {phase === 'showing'
          ? 'Memorise the squares…'
          : phase === 'playing'
            ? `${remaining} square${remaining === 1 ? '' : 's'} remaining`
            : phase === 'levelCleared'
              ? 'Correct.'
              : 'Press New game to try again.'}
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------- pairs */

/**
 * Pairs mode: twelve pairs face down on the original five-by-five map, with the
 * event mark holding the centre tile the twenty-four cards leave over.
 *
 * A finished board is scored on how few moves and milliseconds it took — see
 * `game/score.ts`. An unfinished board reports nothing, because a round that
 * was abandoned is not a result.
 */
function PairsBoard({
  onRoundStart,
  onRoundEnd,
}: {
  onRoundStart?: () => void
  onRoundEnd?: (score: number) => void
}) {
  const [game, setGame] = useState<MemoryGame>(() => createGame())
  const [elapsedMs, setElapsedMs] = useState(0)
  const [paused, setPaused] = useState(false)

  // The clock runs from the first card turned to the last pair found, kept in
  // milliseconds because that is the precision the score is spent at.
  const startedAt = useRef<number | null>(null)
  const bankedMs = useRef(0)
  const reported = useRef(false)
  const opened = useRef(false)

  const complete = game.status === 'complete'
  const pairs = matchedPairs(game)

  /** Milliseconds of play, not counting time spent paused. */
  const playedMs = useCallback(() => {
    const running = startedAt.current === null ? 0 : Date.now() - startedAt.current
    return bankedMs.current + running
  }, [])

  useEffect(() => {
    if (complete || paused || startedAt.current === null) return
    const tick = window.setInterval(() => setElapsedMs(playedMs()), 250)
    return () => window.clearInterval(tick)
  }, [complete, paused, playedMs])

  // The round's score is reported once, on the move that finishes the board.
  useEffect(() => {
    if (!complete || reported.current) return
    reported.current = true
    if (startedAt.current !== null) {
      bankedMs.current += Date.now() - startedAt.current
      startedAt.current = null
    }
    const finishedIn = bankedMs.current
    setElapsedMs(finishedIn)
    onRoundEnd?.(roundScore({ moves: game.moves, milliseconds: finishedIn }))
  }, [complete, game.moves, onRoundEnd])

  const newGame = useCallback(() => {
    setGame(createGame())
    setElapsedMs(0)
    setPaused(false)
    startedAt.current = null
    bankedMs.current = 0
    reported.current = false
    opened.current = false
  }, [])

  const togglePause = useCallback(() => {
    setPaused((wasPaused) => {
      if (wasPaused) {
        startedAt.current = Date.now()
        return false
      }
      if (startedAt.current !== null) {
        bankedMs.current += Date.now() - startedAt.current
        startedAt.current = null
      }
      return true
    })
  }, [])

  const choose = useCallback(
    (cardId: string) => {
      if (paused) return
      const result = selectCard(game, cardId)
      if (result.event.type === 'ignored') return

      // The run opens with the first card, not when the board is dealt: a board
      // nobody touches is not a round.
      if (!opened.current) {
        opened.current = true
        startedAt.current = Date.now()
        onRoundStart?.()
      }
      setGame(result.state)

      if (result.event.type === 'mismatch') {
        window.setTimeout(() => setGame((current) => concealMismatch(current)), mismatchRevealMs)
      }
    },
    [game, onRoundStart, paused],
  )

  /** Where the event mark sits: the middle of the five-by-five map. */
  const centreIndex = 12

  return (
    <div className="flex w-full flex-col items-center gap-4">
      {/* Pause, new game and the readings share one line. */}
      <div className="flex w-full max-w-[440px] flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <div className="flex items-center gap-2">
          <ControlButton onClick={togglePause} disabled={complete || !opened.current}>
            {paused ? 'Resume' : 'Pause'}
          </ControlButton>
          <ControlButton onClick={newGame}>New game</ControlButton>
        </div>
        <div className="flex items-center gap-5">
          <Stat label="PAIRS" value={`${pairs}/${PAIR_COUNT}`} />
          <Stat label="MOVES" value={String(game.moves)} />
          <Stat label="TIME" value={formatTime(elapsedMs)} />
        </div>
      </div>

      <div className="relative">
        <div className="grid grid-cols-5 gap-2" role="grid" aria-label="Memory cards">
          {game.cards.map((card, index) => (
            <PairCard
              key={card.id}
              card={card}
              position={index + 1}
              disabled={paused || card.isMatched}
              onSelect={() => choose(card.id)}
              beforeCentre={index === centreIndex}
            />
          ))}
        </div>

        {paused ? (
          <div className="absolute inset-0 grid place-items-center rounded-petal-sm bg-black/70 backdrop-blur-sm">
            <p className="font-ui text-[15px] text-rose-light">Paused</p>
          </div>
        ) : null}
      </div>

      {complete ? (
        <p className="text-center font-ui text-[12.5px] text-fg/70">
          All {PAIR_COUNT} pairs in <span className="tabular-nums text-fg/90">{game.moves}</span>{' '}
          moves and <span className="tabular-nums text-fg/90">{formatTime(elapsedMs)}</span>.
        </p>
      ) : null}
    </div>
  )
}

function PairCard({
  card,
  position,
  disabled,
  onSelect,
  beforeCentre,
}: {
  card: Card
  position: number
  disabled: boolean
  onSelect: () => void
  beforeCentre: boolean
}) {
  const label = card.isMatched
    ? `Card ${position}: ${card.motif}, matched`
    : card.isFaceUp
      ? `Card ${position}: ${card.motif}, face up`
      : `Card ${position}, face down`
  const shown = card.isFaceUp || card.isMatched

  return (
    <>
      {beforeCentre ? (
        <div
          role="gridcell"
          aria-label="Code2Create"
          className="grid size-[58px] place-items-center sm:size-[64px]"
        >
          <img
            src={`${assetBase}/C2C-Logo.svg`}
            alt=""
            draggable={false}
            className="size-[38px] object-contain opacity-80 sm:size-[42px]"
          />
        </div>
      ) : null}
      <button
        type="button"
        role="gridcell"
        aria-label={label}
        disabled={disabled}
        onClick={onSelect}
        className={`grid size-[58px] place-items-center rounded-petal-sm border-2 transition-colors sm:size-[64px] ${
          shown
            ? 'border-petal-edge bg-black/40'
            : // Face down is a plain pink tile: no motif on it, nothing to read.
              'border-transparent bg-rose-light enabled:hover:bg-rose-light/80'
        }`}
      >
        {shown ? (
          <img
            src={`${assetBase}/${card.asset}`}
            alt=""
            draggable={false}
            className={`size-[42px] object-contain sm:size-[46px] ${
              card.isMatched ? 'opacity-70' : 'opacity-100'
            }`}
          />
        ) : null}
      </button>
    </>
  )
}
