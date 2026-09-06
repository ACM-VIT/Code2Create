import { useCallback, useEffect, useRef, useState } from 'react'

import type { GameKey } from '@code2create/domain'
import type { GameMode } from '../catalog'

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
import './memory.css'

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
      <span className="font-ui text-[11px] lowercase text-fg/50">{label}</span>
      <span className="font-ui text-[15px] tabular-nums text-fg/85">{value}</span>
    </div>
  )
}

/** The switch between ways of playing, in the board's own control row. */
function ModeSwitch({
  modes,
  mode,
  onModeChange,
}: {
  modes: readonly GameMode[]
  mode: string | undefined
  onModeChange: ((next: GameKey) => void) | undefined
}) {
  return (
    <div className="flex items-center gap-1.5">
      {modes.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onModeChange?.(option.key)}
          className={`rounded-petal-sm border-2 bg-transparent px-2.5 py-1 font-ui text-[12.5px] lowercase transition-colors ${
            option.key === mode
              ? 'border-petal-edge bg-rose-light/15 text-fg'
              : 'border-petal-line text-fg/55 hover:text-fg'
          }`}
        >
          {option.label}
        </button>
      ))}
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
export type MemoryBoardProps = {
  mode?: string
  modes?: readonly GameMode[]
  onModeChange?: (next: GameKey) => void
  onRoundStart?: () => void
  onRoundEnd?: (score: number) => void
}

export default function Board(props: MemoryBoardProps) {
  return props.mode === 'memory-grid' ? <PatternBoard {...props} /> : <PairsBoard {...props} />
}

/* ------------------------------------------------------------------ pattern */

/**
 * Pattern mode: squares light up, go dark, and are asked for back in any order.
 *
 * The round scores the levels cleared, so it ends when the last life goes. An
 * abandoned board reports nothing, the same as the pairs mode.
 */
function PatternBoard({ mode, modes, onModeChange, onRoundStart, onRoundEnd }: MemoryBoardProps) {
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
    <div className="memory-game flex w-full flex-1 flex-col items-center justify-center gap-4">
      {modes ? <ModeSwitch modes={modes} mode={mode} onModeChange={onModeChange} /> : null}
      <div className="flex w-full max-w-[440px] flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <ControlButton onClick={newGame}>New game</ControlButton>
        <div className="flex items-center gap-5">
          <Stat label="level" value={String(level)} />
          <Stat label="cleared" value={String(game.cleared)} />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="font-ui text-[11px] lowercase text-fg/50">lives</span>
            <Hearts lives={lives} />
          </div>
        </div>
      </div>

      <div className="relative">
        <div
          className="memory-board"
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
                className={`memory-tile size-[42px] sm:size-[46px] ${
                  missed ? 'is-wrong' : lit ? 'is-lit' : chosen ? 'is-picked' : ''
                }`}
              />
            )
          })}
        </div>

        {phase === 'failed' ? (
          <div className="absolute inset-0 grid place-items-center rounded-petal bg-black/75 backdrop-blur-sm">
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
function PairsBoard({ mode, modes, onModeChange, onRoundStart, onRoundEnd }: MemoryBoardProps) {
  const [game, setGame] = useState<MemoryGame>(() => createGame())
  const [elapsedMs, setElapsedMs] = useState(0)
  const [paused, setPaused] = useState(false)

  // The clock runs from the first card turned to the last pair found, kept in
  // milliseconds because that is the precision the score is spent at.
  const startedAt = useRef<number | null>(null)
  const bankedMs = useRef(0)
  const reported = useRef(false)
  const opened = useRef(false)
  /**
   * The pending "turn the mismatch back over" timer.
   *
   * It belongs to the board that started it. Dealing a new one has to cancel it,
   * or it fires against the fresh board and hides a pair that has only just been
   * turned up — before the player has had their look at it.
   */
  const revealTimer = useRef<number | null>(null)

  const cancelReveal = useCallback(() => {
    if (revealTimer.current === null) return
    window.clearTimeout(revealTimer.current)
    revealTimer.current = null
  }, [])

  useEffect(() => cancelReveal, [cancelReveal])

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
    cancelReveal()
    setGame(createGame())
    setElapsedMs(0)
    setPaused(false)
    startedAt.current = null
    bankedMs.current = 0
    reported.current = false
    opened.current = false
  }, [cancelReveal])

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
        cancelReveal()
        revealTimer.current = window.setTimeout(() => {
          revealTimer.current = null
          setGame((current) => concealMismatch(current))
        }, mismatchRevealMs)
      }
    },
    [cancelReveal, game, onRoundStart, paused],
  )

  /** Where the event mark sits: the middle of the five-by-five map. */
  const centreIndex = 12

  return (
    <div className="memory-game flex w-full flex-1 flex-col items-center justify-center gap-4">
      {modes ? <ModeSwitch modes={modes} mode={mode} onModeChange={onModeChange} /> : null}
      {/* Pause, new game and the readings share one line. */}
      <div className="flex w-full max-w-[440px] flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <div className="flex items-center gap-2">
          <ControlButton onClick={togglePause} disabled={complete || !opened.current}>
            {paused ? 'Resume' : 'Pause'}
          </ControlButton>
          <ControlButton onClick={newGame}>New game</ControlButton>
        </div>
        <div className="flex items-center gap-5">
          <Stat label="pairs" value={`${pairs}/${PAIR_COUNT}`} />
          <Stat label="moves" value={String(game.moves)} />
          <Stat label="time" value={formatTime(elapsedMs)} />
        </div>
      </div>

      <div className="relative">
        <div
          className="memory-board"
          style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}
          role="grid"
          aria-label="Memory cards"
        >
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
          <div className="absolute inset-0 grid place-items-center rounded-petal bg-black/70 backdrop-blur-sm">
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
          className="grid size-[52px] place-items-center sm:size-[58px]"
        >
          <img
            src={`${assetBase}/C2C-Logo.svg`}
            alt=""
            draggable={false}
            className="size-[34px] object-contain opacity-80 sm:size-[38px]"
          />
        </div>
      ) : null}
      <button
        type="button"
        role="gridcell"
        aria-label={label}
        disabled={disabled}
        onClick={onSelect}
        className={`memory-tile grid size-[52px] place-items-center sm:size-[58px] ${
          card.isMatched
            ? 'is-picked'
            : card.isFaceUp
              ? ''
              : // Face down is a plain pink tile: no motif on it, nothing to read.
                'is-facedown'
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
